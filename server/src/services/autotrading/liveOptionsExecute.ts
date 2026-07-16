import { config } from '../../config';
import { AutotradeConfig, getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import {
  AccountState,
  evaluateGuardrails,
  GuardrailReport,
  OrderIntent,
  blockingFailures,
  TradingConfig,
} from '../trading/guardrails';
import { marketOpenContext } from '../trading/marketHours';
import { webullAccountState, webullAccountType } from '../../providers/webull/accountState';
import { newClientOrderId, webullPlaceOrder, webullOrderStatus } from '../../providers/webull/orders';
import { createIntent, transitionIntent, countTodaysOrders, getIntents, OrderIntentRecord } from '../../db/orders';
import { canTransition, isTerminal } from '../trading/orderLifecycle';
import { mapWebullStatus } from '../trading/reconcile';
import {
  recordLiveOptionsEntryOrder,
  recordLiveOptionsExitOrder,
  setLiveOptionsOrderPositionId,
  listPendingLiveOptionsOrders,
  countLiveOptionsOrdersSince,
  LiveOptionsOrderKind,
  LiveOptionsOrderMeta,
} from '../../db/autotradeLiveOptionsOrders';
import {
  hasOpenLiveOptionsPosition,
  listOpenLiveOptionsPositions,
  listLiveOptionsPositions,
  createLiveOptionsPosition,
  closeLiveOptionsPosition,
  LiveOptionsPosition,
} from '../../db/autotradeLiveOptionsPositions';
import { computeStreaksAndDrawdown } from '../pnl';
import { defaultExitConfig, evaluateExit } from '../../options/exitRules';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from './optionsRiskCheck';
import { correlatedNotional, RiskCheckContext } from './riskCheck';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';
import { fetchContractMark, validPremium } from './optionsExecute';
import { getLivePortfolioSnapshot, combinedLiveOpenRisk, ProbationStatus } from './liveExecute';
import { previewWebullPositions, contractKey } from '../../providers/webull/positions';

// ---------------------------------------------------------------------------
// Task #70: the LIVE counterpart to optionsExecute.ts's paper options
// execution -- every order here IS submitted to the real Webull account.
// Also the OPTIONS counterpart to liveExecute.ts's live equity execution:
// reuses the same lower-level pieces (guardrails, webullPlaceOrder, the order
// lifecycle) but keeps its own entry/exit functions, since options fills are
// per-CONTRACT (or per-spread) marks resolved from a chain, not a single
// getQuote() the way a stock is.
//
// No bracket, ever: autotrade's options signals never carried a price-based
// stop/target (Phase 12's confirmed close-only, time-based exit design), and
// buildOrderRequest() only attaches a bracket to a stock or a SINGLE-strategy
// option anyway (never a VERTICAL) -- so both an entry and an exit here are
// always plain orders. An exit (Step C) is a SEPARATE closing order this
// loop places itself when the time-exit trigger fires, tracked via the
// entry/exit `role` split (db/autotradeLiveOptionsOrders.ts) rather than a
// bracket child leg -- there's no existing "close a spread" precedent
// anywhere in this codebase (the human Trade page only ever builds fresh
// OPEN intents; closing a VERTICAL as one combo has never been built), so
// the closing intent below mirrors providers/webull/orders.ts's own
// optionBracketExit() flip rule (side === 'buy' ? 'SELL' : 'BUY') applied
// per-leg, the closest existing "flip an entry to close it" convention.
//
// Combined live budget (two-way, pending-inclusive): both this batch and
// equity's runLiveExecution seed their running risk/count from
// combinedLiveOpenRisk() (liveExecute.ts) -- open positions of BOTH books PLUS
// every placed-but-not-yet-materialized order. A live fill only becomes a
// position row on a LATER reconcile tick, so orders one batch places earlier in
// the SAME tick are invisible to a position-only snapshot; seeding from
// positions alone let the two batches jointly place ~2x the aggregate-risk /
// concurrent-position caps (fixed in the 2026-07-09 hardening deep-dive). Same
// "one real account, one combined budget" reasoning as optionsExecute.ts
// folding in equity's PAPER snapshot -- but for live it must count pending
// orders too, since live positions aren't synchronous the way paper's are.
// ---------------------------------------------------------------------------

/** Options bid/ask spreads run far wider, as a % of premium, than a stock's --
 *  a low-dollar OTM contract can have a spread that's already 5-10% of its
 *  own mark. Equity's own live path (MARKETABLE_LIMIT_BUFFER_PCT, 0.5%) would
 *  routinely miss a fill here, so this is 10x more generous -- while still
 *  comfortably under the default liveOptionsFatFingerPct (10%) so a fresh
 *  quote doesn't trip the guardrail that's meant to catch a STALE one. Used
 *  for BOTH entries (price above the mark to guarantee a buy) and exits
 *  (price below the mark to guarantee a sell). */
const OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT = 5;

/** The only exit rule this phase automates -- mirrors optionsExecute.ts's own
 *  AUTOTRADE_TIME_EXIT_DAYS constant exactly (duplicated per this codebase's
 *  established paper/live parallel-implementation convention). */
const AUTOTRADE_TIME_EXIT_DAYS = defaultExitConfig().timeExitDaysBeforeExpiry ?? 7;

/** Combine the autotrade-specific LIVE OPTIONS caps with BOTH kill switches
 *  and liveOptionsEnabled -- mirrors liveExecute.ts's buildLiveTradingConfig()
 *  exactly, over the dedicated liveOptions* cap fields instead of equity's. */
export function buildLiveOptionsTradingConfig(autotradeCfg: AutotradeConfig): TradingConfig {
  const humanCfg = getTradingConfig();
  return {
    enabled: humanCfg.enabled && autotradeCfg.liveTradingEnabled && autotradeCfg.liveOptionsEnabled,
    killSwitch: humanCfg.killSwitch || autotradeCfg.killSwitch,
    maxOrderUsd: autotradeCfg.liveOptionsMaxOrderUsd,
    // Same reasoning as liveExecute.ts's own: autotrade sizes options
    // risk-based (premium-based, defined-risk by strike construction), so a
    // raw contract-count cap per symbol doesn't scale sensibly the way
    // maxOrderUsd's notional cap already does.
    maxSymbolPositionQty: Number.MAX_SAFE_INTEGER,
    // Same real cash account as equity -- 100% of configured equity, shared.
    maxExposureUsd: autotradeCfg.accountEquityUsd ?? 0,
    maxOrdersPerDay: autotradeCfg.liveOptionsMaxOrdersPerDay,
    maxDailyLossUsd: autotradeCfg.liveOptionsMaxDailyLossUsd,
    fatFingerPct: autotradeCfg.liveOptionsFatFingerPct,
    // This system only ever BUYS options to open (long calls/puts, or a
    // net-debit spread) -- guardrails.ts's naked_short check can't actually
    // trigger for an order that only ever adds to a position, so which value
    // this holds is inert here; reusing equity's flag avoids a config field
    // with no observable effect.
    allowNakedShort: autotradeCfg.liveAllowNakedShort,
  };
}

/** Whether autotrade is still within its post-liveOptionsEnabled probation
 *  window, and the size cut to apply if so. Mirrors liveExecute.ts's
 *  getProbationStatus() exactly, anchored to liveOptionsEnabledAt/
 *  liveOptionsProbationTrades instead of equity's own fields -- a fully
 *  separate window, since options can go live weeks after equity. */
export function getOptionsProbationStatus(cfg: AutotradeConfig): ProbationStatus {
  if (!cfg.liveOptionsEnabledAt)
    return { active: false, multiplier: 1, tradesPlaced: 0, tradesRemaining: cfg.liveOptionsProbationTrades };
  const tradesPlaced = countLiveOptionsOrdersSince(cfg.liveOptionsEnabledAt);
  const active = tradesPlaced < cfg.liveOptionsProbationTrades;
  return {
    active,
    multiplier: active ? cfg.liveOptionsProbationSizeMultiplier : 1,
    tradesPlaced,
    tradesRemaining: Math.max(0, cfg.liveOptionsProbationTrades - tradesPlaced),
  };
}

function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Realized P&L for a CLOSED live options position -- identical formula to
 *  optionsExecute.ts's own optionsPnl(), duplicated rather than imported
 *  since it's keyed off LiveOptionsPosition, a distinct (if structurally
 *  similar) type from OptionsPaperPosition. */
function liveOptionsPnl(
  p: LiveOptionsPosition,
  exitPrice: number,
  shortExitPrice: number | null = p.shortExitPrice,
): number {
  if (p.kind === 'debit_spread') {
    const netDebitAtEntry = p.entryPrice - (p.shortEntryPrice ?? 0);
    const netCreditAtExit = exitPrice - (shortExitPrice ?? 0);
    return (netCreditAtExit - netDebitAtEntry) * p.quantity * 100;
  }
  return (exitPrice - p.entryPrice) * p.quantity * 100;
}

export interface LiveOptionsPortfolioSnapshot {
  today: string;
  openPositions: LiveOptionsPosition[];
  openRisk: number;
  openPositionsCount: number;
  dailyPnl: number;
  consecutiveLosses: number;
  tradesToday: number;
}

/** Current live options portfolio state -- mirrors optionsExecute.ts's
 *  getOptionsPaperPortfolioSnapshot() exactly, over
 *  autotrade_live_options_positions instead. Consumed by
 *  runLiveOptionsExecution()'s own batch below, and (from Step D onward) by
 *  the monitoring dashboard. */
export function getLiveOptionsPortfolioSnapshot(): LiveOptionsPortfolioSnapshot {
  const today = etDateStr();
  const openPositions = listOpenLiveOptionsPositions();
  const recent = listLiveOptionsPositions({ limit: 500 });
  const closedTodayChrono = recent
    .filter((p) => p.status === 'closed' && p.exitAt !== null && etDateStr(p.exitAt) === today)
    .sort((a, b) => a.exitAt! - b.exitAt!);
  const closedPnlsChrono = closedTodayChrono.map((p) => liveOptionsPnl(p, p.exitPrice!));
  const dailyPnl = closedPnlsChrono.reduce((s, p) => s + p, 0);
  const { currentStreak } = computeStreaksAndDrawdown(closedPnlsChrono);
  const consecutiveLosses = currentStreak.type === 'loss' ? currentStreak.count : 0;
  const tradesToday = recent.filter((p) => etDateStr(p.entryAt) === today).length;
  const openRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);

  return {
    today,
    openPositions,
    openRisk,
    openPositionsCount: openPositions.length,
    dailyPnl,
    consecutiveLosses,
    tradesToday,
  };
}

interface BrokerPlacementResult {
  intentId: number;
  ok: boolean;
  reason?: string;
  brokerOrderId?: string;
}

/** Create the intent, check it against the guardrails, and either reject or
 *  walk it through validated -> confirmed -> submitted -> acknowledged/rejected,
 *  calling the broker for real. Shared by both the entry (below) and exit
 *  (Step C) paths -- what happens AFTER a successful placement (which table
 *  gets a row, which notification fires) differs meaningfully by role, so
 *  only this mechanical "walk the lifecycle, call the broker" core is
 *  factored out. */
async function placeLiveOptionsOrder(
  intent: OrderIntent,
  guardrails: GuardrailReport,
  accountId: string,
  symbol: string,
  blockedAction: string,
  failedAction: string,
  riskProfile: string,
): Promise<BrokerPlacementResult> {
  const clientOrderId = newClientOrderId();
  const intentRec = createIntent(intent, clientOrderId);

  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
    logAutotradeEvent({ symbol, stage: 'execution', action: blockedAction, detail: { reasons }, riskProfile });
    return { intentId: intentRec.id, ok: false, reason: `Guardrails blocked: ${reasons}` };
  }

  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live options)' });
  transitionIntent(intentRec.id, 'confirmed', {
    detail: 'autotrade — no per-order confirmation, per confirmed design',
  });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId);
  if (!broker.ok) {
    transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: failedAction,
      detail: { reason: broker.error },
      riskProfile,
    });
    return { intentId: intentRec.id, ok: false, reason: `Broker rejected: ${broker.error}` };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  return { intentId: intentRec.id, ok: true, brokerOrderId: broker.orderId };
}

/** Fetch account state + (spreads only) account type, and run the guardrails
 *  for an about-to-be-placed intent. Shared by entry and exit.
 *
 * `currentPositionQtyOverride` (exit only): webullAccountState()'s currentPositionQty
 * aggregates ALL positions matching the underlying symbol -- stock and option alike,
 * with no filter on asset type, strike, or expiration (providers/webull/accountState.ts's
 * summing loop discards those fields even though mapWebullPosition parses them). For a
 * single-leg CLOSE, that means the naked_short check could be fed a number contaminated
 * by an unrelated stock position (this file's own combined-budget book holds live EQUITY
 * positions on the same account) or a different option contract on the same underlying --
 * an adversarial review confirmed this can fail OPEN (wrongly ALLOW a sell), not just
 * closed, contradicting an earlier version of this comment. Passing our own
 * authoritative ledger quantity (the position being closed, not the broker's aggregate)
 * makes the check depend only on what we ourselves recorded opening -- immune to
 * contamination from anything else on the account. */
async function loadAccountAndGuardrails(
  intent: OrderIntent,
  accountId: string,
  symbol: string,
  liveCfg: TradingConfig,
  isSpread: boolean,
  currentPositionQtyOverride?: number,
): Promise<{ ok: true; guardrails: GuardrailReport } | { ok: false; reason: string }> {
  const acct = await webullAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { ok: false, reason: acct.error ?? 'Could not load account state' };
  }
  // Account type gates spreads (margin only) -- fetch it only for a spread,
  // same convention as livePreview.ts / placeOrder.ts.
  const accountType = isSpread ? await webullAccountType(accountId) : undefined;
  const accountState: AccountState = {
    ...acct.state,
    ordersToday: countTodaysOrders(),
    accountType,
    ...(currentPositionQtyOverride !== undefined ? { currentPositionQty: currentPositionQtyOverride } : {}),
  };
  const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
  return { ok: true, guardrails };
}

export interface LiveOptionsExecutionOutcome {
  symbol: string;
  ok: boolean;
  reason?: string;
  intentId?: number;
}

/**
 * Attempt to place a real options order (single-leg or debit-spread) for an
 * approved (already risk-checked) signal. Idempotent per underlying, same as
 * paper: a symbol with an already-open live options position is skipped.
 * Sizing is the risk-checked quantity cut by the probation multiplier (if
 * still active), rounding DOWN and skipping entirely if that rounds to zero.
 *
 * A debit spread fills as ONE combo order (VERTICAL) or not at all -- if
 * either leg's quote fetch fails, or the net debit has vanished/inverted
 * between screening and this attempt (stale quotes), the whole entry is
 * rejected before an intent is even created, same as paper's own guard.
 */
export async function attemptLiveOptionsEntry(
  signal: OptionsTradeSignal,
  riskResult: OptionsRiskCheckResult,
  riskProfile: RiskProfileName,
  autotradeCfg: AutotradeConfig,
): Promise<LiveOptionsExecutionOutcome> {
  const symbol = signal.symbol.toUpperCase();
  if (!config.trading.placeEnabled) {
    return { symbol, ok: false, reason: 'Order placement is disabled on the server (TRADING_ENABLED is not set).' };
  }
  if (!riskResult.ok) return { symbol, ok: false, reason: 'Risk check did not pass' };

  const accountId = autotradeCfg.liveAccountId;
  if (!accountId) return { symbol, ok: false, reason: 'No liveAccountId configured' };

  if (hasOpenLiveOptionsPosition(signal.symbol)) {
    return { symbol, ok: false, reason: 'Already has an open live options position' };
  }
  // Idempotency: also block a second entry while a prior ENTRY order for this
  // symbol is still working / not yet materialized into a position. A live
  // options position is created ONLY when a full fill reconciles, so
  // hasOpenLiveOptionsPosition() alone misses an entry order resting across a
  // loop-tick boundary — the next tick re-emits the same signal and places a
  // SECOND real order. Mirrors the exit path, which already dedups against
  // pending exit orders (checkLiveOptionsExits' pendingExitPositionIds).
  if (listPendingLiveOptionsOrders().some((o) => o.role === 'entry' && o.symbol === symbol)) {
    return { symbol, ok: false, reason: 'A live options entry order for this symbol is already in flight' };
  }

  const probation = getOptionsProbationStatus(autotradeCfg);
  const rawQuantity =
    'suggestedContracts' in riskResult.sizing
      ? riskResult.sizing.suggestedContracts
      : riskResult.sizing.suggestedQuantity;
  const quantity = Math.floor(rawQuantity * probation.multiplier);
  if (quantity <= 0) {
    return {
      symbol,
      ok: false,
      reason: `Probation-adjusted quantity rounded to 0 (multiplier ${probation.multiplier})`,
    };
  }

  const liveCfg = buildLiveOptionsTradingConfig(autotradeCfg);
  const buffer = 1 + OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100;

  if (signal.kind === 'debit_spread') {
    let longFill: number;
    let shortFill: number;
    try {
      [longFill, shortFill] = await Promise.all([
        fetchContractMark(signal.symbol, signal.expiration, signal.longStrike, signal.side),
        fetchContractMark(signal.symbol, signal.expiration, signal.shortStrike, signal.side),
      ]);
    } catch (err) {
      return { symbol, ok: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }
    if (!validPremium(longFill) || !validPremium(shortFill)) {
      return { symbol, ok: false, reason: `Invalid premium: long=${longFill} short=${shortFill}` };
    }
    const netDebit = longFill - shortFill;
    if (netDebit <= 0) {
      return { symbol, ok: false, reason: `Net debit vanished at fill (long ${longFill} <= short ${shortFill})` };
    }
    const limitPrice = Math.round(netDebit * buffer * 100) / 100;

    const intent: OrderIntent = {
      symbol,
      assetKind: 'option',
      side: 'buy', // net debit — order-level side is the net direction
      openClose: 'open',
      quantity,
      orderType: 'limit',
      limitPrice,
      referencePrice: netDebit,
      optionStrategy: 'VERTICAL',
      optionLegs: [
        { side: 'buy', optionType: signal.side, strike: signal.longStrike, expiration: signal.expiration },
        { side: 'sell', optionType: signal.side, strike: signal.shortStrike, expiration: signal.expiration },
      ],
    };

    const loaded = await loadAccountAndGuardrails(intent, accountId, symbol, liveCfg, true);
    if (!loaded.ok) return { symbol, ok: false, reason: loaded.reason };

    const placed = await placeLiveOptionsOrder(
      intent,
      loaded.guardrails,
      accountId,
      symbol,
      'live_options_entry_blocked',
      'live_options_entry_failed',
      riskProfile,
    );
    if (!placed.ok) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };

    recordLiveOptionsEntryOrder({
      intentId: placed.intentId,
      symbol,
      kind: 'debit_spread',
      side: signal.side,
      contractSymbol: signal.longContractSymbol,
      strike: signal.longStrike,
      shortContractSymbol: signal.shortContractSymbol,
      shortStrike: signal.shortStrike,
      expiration: signal.expiration,
      riskAmount: riskResult.approvedRiskAmount,
      riskProfile,
    });
    return finishEntryPlacement(symbol, intent, 'debit_spread', placed, riskProfile);
  }

  let fillPremium: number;
  try {
    fillPremium = await fetchContractMark(signal.symbol, signal.expiration, signal.strike, signal.side);
  } catch (err) {
    return { symbol, ok: false, reason: `Quote fetch failed: ${(err as Error).message}` };
  }
  if (!validPremium(fillPremium)) {
    return { symbol, ok: false, reason: `Invalid premium: ${fillPremium}` };
  }
  const limitPrice = Math.round(fillPremium * buffer * 100) / 100;

  const intent: OrderIntent = {
    symbol,
    assetKind: 'option',
    side: 'buy',
    openClose: 'open',
    quantity,
    orderType: 'limit',
    limitPrice,
    referencePrice: fillPremium,
    optionType: signal.side,
    strike: signal.strike,
    expiration: signal.expiration,
  };

  const loaded = await loadAccountAndGuardrails(intent, accountId, symbol, liveCfg, false);
  if (!loaded.ok) return { symbol, ok: false, reason: loaded.reason };

  const placed = await placeLiveOptionsOrder(
    intent,
    loaded.guardrails,
    accountId,
    symbol,
    'live_options_entry_blocked',
    'live_options_entry_failed',
    riskProfile,
  );
  if (!placed.ok) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };

  recordLiveOptionsEntryOrder({
    intentId: placed.intentId,
    symbol,
    kind: 'single_leg',
    side: signal.side,
    contractSymbol: signal.contractSymbol,
    strike: signal.strike,
    expiration: signal.expiration,
    riskAmount: riskResult.approvedRiskAmount,
    riskProfile,
  });
  return finishEntryPlacement(symbol, intent, 'single_leg', placed, riskProfile);
}

/** Journal + notify once an entry order has been placed AND recorded — shared
 *  tail for both the single-leg and debit-spread branches above. */
async function finishEntryPlacement(
  symbol: string,
  intent: OrderIntent,
  kind: LiveOptionsOrderKind,
  placed: { intentId: number; brokerOrderId?: string },
  riskProfile: string,
): Promise<LiveOptionsExecutionOutcome> {
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_options_order_placed',
    detail: {
      kind,
      side: intent.side,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      orderId: placed.brokerOrderId,
    },
    riskProfile,
  });
  await dispatchNotifications([
    {
      title: symbol,
      message:
        kind === 'debit_spread'
          ? `Autotrade LIVE OPTIONS debit spread: ${intent.quantity} ${symbol} @ ~$${intent.limitPrice!.toFixed(2)} net`
          : `Autotrade LIVE OPTIONS BUY: ${intent.quantity} ${symbol} @ ~$${intent.limitPrice!.toFixed(2)}`,
    },
  ]);
  return { symbol, ok: true, intentId: placed.intentId };
}

/**
 * Risk-check, then attempt to place, a batch of already-decided options
 * signals -- sequentially against a RUNNING total combining THIS book's own
 * open live options positions with live EQUITY's CURRENT book
 * (getLivePortfolioSnapshot(), liveExecute.ts) -- the real-money combined
 * budget, mirroring optionsExecute.ts's runOptionsPaperExecution() batch
 * pattern exactly, over live snapshots instead of paper ones.
 */
export async function runLiveOptionsExecution(
  candidates: { signal: OptionsTradeSignal }[],
  /** Regime-aware sizing (2026-07-16) — same market-ATR% reading loop.ts
   *  already computed once this cycle for its volatility hard-cutoff, not
   *  re-fetched here. Defaults to null (regime cut inactive) for any caller
   *  that doesn't have/need one, e.g. a direct test call. */
  marketAtrPct: number | null = null,
): Promise<LiveOptionsExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const equity = cfg.accountEquityUsd ?? 0;

  const optSnapshot = getLiveOptionsPortfolioSnapshot();
  const eqSnapshot = getLivePortfolioSnapshot();

  const dailyPnl = optSnapshot.dailyPnl + eqSnapshot.dailyPnl;
  const tradesToday = optSnapshot.tradesToday + eqSnapshot.tradesToday;
  const consecutiveLosses = Math.max(optSnapshot.consecutiveLosses, eqSnapshot.consecutiveLosses);
  // Seed from the COMBINED live book (both books, positions AND placed-but-
  // unmaterialized orders) rather than optSnapshot+eqSnapshot POSITIONS alone.
  // Equity entries placed earlier in THIS tick have no position row yet (a live
  // fill materializes only on a later reconcile tick), so a position-only seed
  // let this batch re-spend the equity batch's just-committed headroom -- up to
  // 2x the aggregate-risk / concurrent-position caps.
  const combined = combinedLiveOpenRisk();
  let runningRisk = combined.risk;
  let runningCount = combined.count;
  // Options positions are always 'long' (see riskCheck.ts's
  // correlatedNotional() doc comment); equity positions folded in here carry
  // their REAL side so an options candidate (always effectively 'long', per
  // candidateSide below) correctly nets against an existing SHORT equity
  // position instead of piling onto it.
  const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = [
    ...optSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount, side: 'long' as const })),
    ...eqSnapshot.openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.entryPrice * p.quantity,
      side: p.side, // getLivePortfolioSnapshot() positions are already 'long'|'short'
    })),
  ];
  // Skip a symbol with an open position OR a still-working / not-yet-
  // materialized ENTRY order — see attemptLiveOptionsEntry's idempotency guard
  // (a position materializes only on a full-fill reconcile, so open positions
  // alone miss an order resting across a tick boundary). attemptLiveOptionsEntry
  // re-checks authoritatively; this just avoids risk-checking a known dup.
  const skipSymbols = new Set([
    ...optSnapshot.openPositions.map((p) => p.symbol),
    ...listPendingLiveOptionsOrders()
      .filter((o) => o.role === 'entry')
      .map((o) => o.symbol),
  ]);

  const outcomes: LiveOptionsExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open live options position' });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      'long', // options candidates are always a long-the-contract bet
      runningPositions,
      cfg.correlationLookbackDays,
      cfg.correlationThreshold,
    );
    const ctx: RiskCheckContext = {
      equity,
      dailyPnl,
      tradesToday,
      consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      maxConcurrentPositions: cfg.maxConcurrentPositions,
      correlatedNotional: correlated,
      riskPerTradePct: cfg.riskPerTradePct,
      maxDailyDrawdownPct: cfg.maxDailyDrawdownPct,
      stepDownAfterLosses: cfg.stepDownAfterLosses,
      stepDownSizeCutPct: cfg.stepDownSizeCutPct,
      maxAggregateOpenRiskPct: cfg.maxAggregateOpenRiskPct,
      maxCorrelatedExposurePct: cfg.maxCorrelatedExposurePct,
      maxTradesPerDay: cfg.maxTradesPerDay,
      correlationThreshold: cfg.correlationThreshold,
      marketAtrPct,
      regimeAtrThresholdPct: cfg.regimeAtrThresholdPct,
      regimeSizeCutPct: cfg.regimeSizeCutPct,
    };
    const result = evaluateOptionsRiskCheck(signal, ctx);
    if (!result.ok) {
      outcomes.push({ symbol, ok: false, reason: 'Risk check blocked' });
      continue;
    }

    // Re-fetch fresh config for the actual placement attempt, same reasoning
    // as liveExecute.ts's runLiveExecution() -- this loop awaits real broker
    // round-trips between candidates, and a kill switch engaged mid-batch
    // must stop the NEXT candidate immediately, not just the next cycle.
    const freshCfg = getAutotradeConfig();
    // Isolate each candidate (see runLiveExecution): a rare unexpected throw
    // must not abort the rest of the batch.
    let outcome: LiveOptionsExecutionOutcome;
    try {
      outcome = await attemptLiveOptionsEntry(signal, result, freshCfg.riskProfile, freshCfg);
    } catch (err) {
      const reason = `Unexpected error placing order: ${(err as Error).message}`;
      logAutotradeEvent({ symbol, stage: 'execution', action: 'live_options_entry_failed', detail: { reason } });
      outcome = { symbol, ok: false, reason };
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol, notional: result.approvedNotional, side: 'long' });
      skipSymbols.add(symbol);
    }
  }
  return outcomes;
}

export interface LiveOptionsExitCheckOutcome {
  symbol: string;
  requested: boolean;
  reason?: string;
  intentId?: number;
}

/** Build + place the real closing order for one triggered position, sharing
 *  the same account/guardrail/lifecycle pipeline as an entry. Mirrors
 *  providers/webull/orders.ts's optionBracketExit() flip rule (side flips to
 *  close) applied per-leg for a spread — there's no existing "close a
 *  VERTICAL" precedent anywhere else in this codebase to instead mirror.
 *
 * A single-leg SELL-to-close feeds the naked_short guardrail our OWN ledger
 * quantity (loadAccountAndGuardrails' currentPositionQtyOverride), not
 * webullAccountState()'s account-wide aggregate — an adversarial review found
 * that aggregate sums ALL same-symbol positions (stock and every option
 * contract alike) with no asset-type/strike/expiration filter, so trusting it
 * directly could let a sell reach the broker for contracts not actually held
 * (fails OPEN), not just incorrectly block a legitimate one (fails closed). */
async function placeLiveOptionsExit(
  pos: LiveOptionsPosition,
  accountId: string,
  cfg: AutotradeConfig,
): Promise<LiveOptionsExitCheckOutcome> {
  const symbol = pos.symbol;
  // Selling to close -- price BELOW the mark to guarantee a fill (the mirror
  // image of an entry's "pay slightly more to guarantee a buy").
  const buffer = 1 - OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100;
  const liveCfg = buildLiveOptionsTradingConfig(cfg);

  let intent: OrderIntent;
  if (pos.kind === 'debit_spread') {
    let longMark: number;
    let shortMark: number;
    try {
      [longMark, shortMark] = await Promise.all([
        fetchContractMark(symbol, pos.expiration, pos.strike, pos.side),
        fetchContractMark(symbol, pos.expiration, pos.shortStrike!, pos.side),
      ]);
    } catch (err) {
      return { symbol, requested: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }
    const netValue = longMark - shortMark;
    const limitPrice = Math.round(netValue * buffer * 100) / 100;
    // Same guard as the single-leg branch below: a crossed/stale spread quote
    // (short mark >= long mark), or a net value tiny enough that the sell-side
    // buffer rounds it to 0, makes limitPrice <= 0. The limit_price>0 guardrail
    // then rejects the close EVERY cycle, so the spread never auto-closes and
    // drifts to expiration -- the exact outcome the time-exit exists to prevent.
    // Skip this cycle with a precise, journaled reason instead of spinning on an
    // unplaceable order (mirrors attemptLiveOptionsEntry's premium guard).
    if (!validPremium(limitPrice)) {
      return {
        symbol,
        requested: false,
        reason: `No usable exit quote (net ${netValue}: long ${longMark}, short ${shortMark})`,
      };
    }
    intent = {
      symbol,
      assetKind: 'option',
      side: 'sell', // selling the spread to close — net credit
      openClose: 'close',
      quantity: pos.quantity,
      orderType: 'limit',
      limitPrice,
      referencePrice: netValue,
      optionStrategy: 'VERTICAL',
      optionLegs: [
        { side: 'sell', optionType: pos.side, strike: pos.strike, expiration: pos.expiration }, // was bought — now sold
        { side: 'buy', optionType: pos.side, strike: pos.shortStrike!, expiration: pos.expiration }, // was sold — now bought back
      ],
    };
  } else {
    let mark: number;
    try {
      mark = await fetchContractMark(symbol, pos.expiration, pos.strike, pos.side);
    } catch (err) {
      return { symbol, requested: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }
    const limitPrice = Math.round(mark * buffer * 100) / 100;
    // Mirror the entry-side premium guard (attemptLiveOptionsEntry). A
    // near-worthless or unquoted contract marks at 0 -- or a value tiny enough
    // that the sell-side marketable buffer rounds it to 0 -- so limitPrice
    // would be <= 0 and the limit_price>0 guardrail would reject the close
    // every cycle. The position then never auto-closes and drifts to
    // expiration, the exact outcome the time-exit exists to prevent. Skip with
    // a precise, journaled reason instead of spinning on an unplaceable order.
    if (!validPremium(limitPrice)) {
      return { symbol, requested: false, reason: `No usable exit quote (mark ${mark})` };
    }
    intent = {
      symbol,
      assetKind: 'option',
      side: 'sell',
      openClose: 'close',
      quantity: pos.quantity,
      orderType: 'limit',
      limitPrice,
      referencePrice: mark,
      optionType: pos.side,
      strike: pos.strike,
      expiration: pos.expiration,
    };
  }

  const loaded = await loadAccountAndGuardrails(
    intent,
    accountId,
    symbol,
    liveCfg,
    pos.kind === 'debit_spread',
    // Multi-leg spreads skip the naked_short check entirely (isMultiLeg in
    // guardrails.ts), so the override only matters -- and is only passed --
    // for a single-leg close.
    pos.kind === 'debit_spread' ? undefined : pos.quantity,
  );
  if (!loaded.ok) return { symbol, requested: false, reason: loaded.reason };

  const placed = await placeLiveOptionsOrder(
    intent,
    loaded.guardrails,
    accountId,
    symbol,
    'live_options_exit_blocked',
    'live_options_exit_failed',
    pos.riskProfile,
  );
  if (!placed.ok) return { symbol, requested: false, reason: placed.reason, intentId: placed.intentId };

  recordLiveOptionsExitOrder({
    intentId: placed.intentId,
    symbol,
    kind: pos.kind,
    riskProfile: pos.riskProfile,
    positionId: pos.id,
  });
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_options_exit_placed',
    detail: {
      kind: pos.kind,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      orderId: placed.brokerOrderId,
      positionId: pos.id,
    },
    riskProfile: pos.riskProfile,
  });
  await dispatchNotifications([
    {
      title: symbol,
      message: `Autotrade LIVE OPTIONS closing ${pos.kind === 'debit_spread' ? 'spread' : 'position'}: ${symbol} (time-exit)`,
    },
  ]);
  return { symbol, requested: true, intentId: placed.intentId };
}

/**
 * Check every open live options position for the time-exit trigger
 * (days-to-expiration <= AUTOTRADE_TIME_EXIT_DAYS) and PLACE a real closing
 * order for whichever fires -- the live counterpart to optionsExecute.ts's
 * checkOptionsPaperExits(), which just records a paper close. A position with
 * an exit order ALREADY in flight (pending, per listPendingLiveOptionsOrders())
 * is skipped -- the trigger condition doesn't change within the same day, so
 * without this guard every tick would submit ANOTHER closing order for the
 * same still-open (fill pending) position.
 */
export async function checkLiveOptionsExits(): Promise<LiveOptionsExitCheckOutcome[]> {
  // The deploy-level master gate, checked FIRST -- mirrors attemptLiveOptionsEntry()'s
  // own ordering exactly. Unlike equity (whose exits are 100% broker-bracket-driven --
  // reconcileLiveOrders() only ever OBSERVES a fill, never places one), this function
  // places a brand-new real closing order, so it needs the SAME deploy-level check an
  // entry gets -- without it, a deploy with TRADING_ENABLED unset would still let a
  // triggered position's close reach the broker.
  if (!config.trading.placeEnabled) return [];
  if (!getAutotradeConfig().liveAccountId) return [];

  const open = listOpenLiveOptionsPositions();
  if (open.length === 0) return [];

  const pendingExitPositionIds = new Set(
    listPendingLiveOptionsOrders()
      .filter((o) => o.role === 'exit' && o.positionId !== null)
      .map((o) => o.positionId!),
  );

  const outcomes: LiveOptionsExitCheckOutcome[] = [];
  for (const pos of open) {
    if (pendingExitPositionIds.has(pos.id)) continue;

    const ev = evaluateExit(
      { entryPrice: pos.entryPrice, currentPrice: null, side: 'long', expiration: pos.expiration },
      { timeExitDaysBeforeExpiry: AUTOTRADE_TIME_EXIT_DAYS },
    );
    if (!ev.triggered) continue;

    // Re-fetch fresh config for EACH triggered position, same reasoning as
    // runLiveOptionsExecution()'s own per-candidate refresh (an adversarial
    // review caught this file reusing one stale snapshot here) -- this loop
    // awaits real broker round-trips between positions, and a kill switch
    // engaged mid-loop must stop the NEXT position's close immediately, not
    // just the next cycle.
    const freshCfg = getAutotradeConfig();
    const accountId = freshCfg.liveAccountId;
    if (!accountId) continue; // account cleared mid-loop -- don't use a stale id
    outcomes.push(await placeLiveOptionsExit(pos, accountId, freshCfg));
  }
  return outcomes;
}

export interface LiveOptionsReconcileOutcome {
  intentId: number;
  symbol: string;
  changed: boolean;
  /** Set when this reconcile materialized a fill into a real
   *  autotrade_live_options_positions row (entry) or closed one (exit). */
  action?: 'entry_filled' | 'exit_filled';
  error?: string;
}

/**
 * Poll every non-terminal (or filled-but-not-yet-materialized) autotrade
 * LIVE OPTIONS intent for a status change, and materialize the result: an
 * ENTRY fill creates a live options position; an EXIT fill closes the one it
 * references. Runs every cycle regardless of either kill switch -- this only
 * detects and records what the broker already did, same read-only-toward-
 * the-broker posture as liveExecute.ts's own reconcileLiveOrders().
 */
export async function reconcileLiveOptionsOrders(): Promise<LiveOptionsReconcileOutcome[]> {
  const cfg = getAutotradeConfig();
  const accountId = cfg.liveAccountId;
  if (!accountId) return [];

  const pending = listPendingLiveOptionsOrders();
  const intentsById = getIntents(pending.map((p) => p.intentId));
  const outcomes: LiveOptionsReconcileOutcome[] = [];
  for (const meta of pending) {
    const intent = intentsById.get(meta.intentId);
    if (!intent) continue;
    const broker = await webullOrderStatus(accountId, intent.idempotencyKey);
    if (!broker.ok || !broker.found) {
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }

    const target = broker.status ? mapWebullStatus(broker.status) : undefined;

    // Forward-transition the intent if the broker moved it, and materialize a
    // fresh fill in the same pass.
    if (target && !isTerminal(intent.state) && target !== intent.state && canTransition(intent.state, target)) {
      transitionIntent(intent.id, target, {
        detail: `broker ${broker.status?.toLowerCase()}`,
        brokerOrderId: broker.brokerOrderId,
      });
      if (target !== 'filled') {
        outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: true });
        continue;
      }
      outcomes.push(materializeLiveOptionsFill(intent, meta, broker));
      continue;
    }

    // Retry path: an EXIT that already transitioned to 'filled' on an earlier
    // pass but whose close never materialized -- the ONLY reason it's still in
    // the pending set (its position is still 'open'). Without this, the
    // isTerminal short-circuit in the block above would skip it forever,
    // permanently stranding the position 'open' in our ledger while it's flat
    // at the broker (polluting open-risk / the combined budget and blocking any
    // new position on that symbol via hasOpenLiveOptionsPosition). Equity's
    // exit detection already re-runs every tick this way; options' single
    // post-transition materialize did not. closeLiveOptionsPosition() is
    // idempotent (a no-op once the position is closed), so re-attempting is
    // safe. ENTRY rows are deliberately NOT retried -- re-creating a position
    // isn't idempotent (a create-then-link that threw AFTER the create would
    // double-open), matching equity's own accepted one-shot entry precedent; a
    // failed entry-materialize stays loudly journaled for a human to notice.
    if (intent.state === 'filled' && meta.role === 'exit') {
      outcomes.push(materializeLiveOptionsFill(intent, meta, broker));
      continue;
    }

    outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false });
  }
  return outcomes;
}

/** Materialize a confirmed fill (entry -> open a position; exit -> close the
 *  referenced one), isolating any persistence error so one stuck row can't
 *  crash the reconcile batch, and journaling it loudly (nothing watches this
 *  path in real time). Extracted so both the first-pass and the exit-retry
 *  path share identical behavior. */
function materializeLiveOptionsFill(
  intent: OrderIntentRecord,
  meta: LiveOptionsOrderMeta,
  broker: Awaited<ReturnType<typeof webullOrderStatus>>,
): LiveOptionsReconcileOutcome {
  const filledQty = broker.filledQty ?? intent.quantity;
  const filledPrice = broker.filledPrice ?? intent.limitPrice ?? 0;
  try {
    const action =
      meta.role === 'entry'
        ? materializeOptionsEntryFill(intent, meta, filledQty, filledPrice)
        : materializeOptionsExitFill(intent, meta, filledPrice);
    return { intentId: intent.id, symbol: meta.symbol, changed: true, action };
  } catch (err) {
    const message = (err as Error).message;
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: 'live_options_materialization_failed',
      detail: { intentId: intent.id, role: meta.role, error: message },
      riskProfile: meta.riskProfile,
    });
    return {
      intentId: intent.id,
      symbol: meta.symbol,
      changed: true,
      error: `Broker fill recorded but failed to materialize: ${message}`,
    };
  }
}

function materializeOptionsEntryFill(
  intent: OrderIntentRecord,
  meta: LiveOptionsOrderMeta,
  filledQty: number,
  filledPrice: number,
): 'entry_filled' {
  const position = createLiveOptionsPosition({
    symbol: intent.symbol,
    side: meta.side!,
    kind: meta.kind,
    contractSymbol: meta.contractSymbol!,
    strike: meta.strike!,
    shortContractSymbol: meta.shortContractSymbol ?? undefined,
    shortStrike: meta.shortStrike ?? undefined,
    expiration: meta.expiration!,
    quantity: filledQty,
    entryPrice: filledPrice,
    riskAmount: meta.riskAmount ?? 0,
    riskProfile: meta.riskProfile,
    // Live combo fills report one NET price, not a per-leg breakdown (see
    // this file's header comment on WebullOrderLeg) -- no original signal
    // rationale is available at reconcile time either, so this mirrors
    // liveExecute.ts's own materializeEntryFill() generated note exactly,
    // rather than inventing a synthetic per-leg split.
    rationale: `Auto-placed by autotrade — order #${intent.id}${intent.brokerOrderId ? ` (broker ${intent.brokerOrderId})` : ''}`,
  });
  setLiveOptionsOrderPositionId(intent.id, position.id);
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_options_position_opened',
    detail: { kind: meta.kind, quantity: filledQty, entryPrice: filledPrice, riskAmount: meta.riskAmount },
    riskProfile: meta.riskProfile,
  });
  return 'entry_filled';
}

/** Materialize a confirmed exit fill against the position this intent's
 *  positionId references. A live combo fill reports one NET price (see
 *  header comment) -- stored as exitPrice with shortExitPrice left at its
 *  default (null), same "whole spread as one number" convention
 *  materializeOptionsEntryFill() uses for entryPrice/shortEntryPrice. */
function materializeOptionsExitFill(
  intent: OrderIntentRecord,
  meta: LiveOptionsOrderMeta,
  filledPrice: number,
): 'exit_filled' | undefined {
  if (meta.positionId === null) return undefined;
  const closed = closeLiveOptionsPosition(meta.positionId, { exitPrice: filledPrice, exitReason: 'time_exit' });
  if (!closed) return undefined;
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_options_position_closed',
    detail: { exitPrice: filledPrice, pnl: liveOptionsPnl(closed, filledPrice) },
    riskProfile: meta.riskProfile,
  });
  return 'exit_filled';
}

export interface LiveOptionsPositionsSyncResult {
  ok: boolean;
  checked: number;
  closed: number;
  closedSymbols: string[];
  error?: string;
}

/**
 * Backstop for reconcileLiveOptionsOrders() above: that only detects a close
 * via the SPECIFIC order this app placed and is tracking — and, unlike
 * equity (whose bracket's exit legs exist for the position's entire open
 * life), an options position often has NO order watching it at all for most
 * of its life. checkLiveOptionsExits() only places a closing order inside
 * the final AUTOTRADE_TIME_EXIT_DAYS, and only when it can get a valid
 * quote — an illiquid near-expiry contract can keep failing that check and
 * leave the position invisible to reconcile even in principle, since
 * listPendingLiveOptionsOrders() only ever returns rows joined against an
 * order that actually exists.
 *
 * This instead diffs each open live options position's leg(s) against what
 * Webull's account currently holds, reusing previewWebullPositions() /
 * contractKey() — the SAME already-tested per-contract matching the equity
 * backstop (loop.ts's runWebullPositionsSync call) uses — applied once per
 * LEG rather than trying to reconstruct a whole spread from one raw payload
 * row (Webull's positions endpoint has no known concept of a multi-leg
 * strategy, and nothing in this codebase has ever confirmed one exists). A
 * debit spread only closes when BOTH legs are gone from the broker's
 * holdings — if just one leg is missing (e.g. early assignment on the short
 * leg), that's a materially different, ambiguous situation left open rather
 * than guessed, mirroring reconcileLiveOrders()'s own "don't guess" posture
 * for an ambiguous equity bracket exit.
 *
 * Unlike equity's silent broker-truth close (closePositionsFromPreview
 * never journals), this DOES log a 'live_options_position_closed' event
 * (detail.via: 'broker_sync') on every close it makes — deliberately more
 * visible than equity's precedent, since this per-leg matching is new and
 * hasn't been validated against a real account's multi-leg holdings the way
 * equity's has; the extra visibility costs nothing and lets a close be
 * sanity-checked rather than trusted silently. exitReason is stored as
 * 'manual' — the closer of the two values the exit_reason CHECK constraint
 * allows ('time_exit' would misleadingly imply checkLiveOptionsExits()
 * placed a real closing order); the journaled event's own detail.via is
 * what actually distinguishes it.
 */
export async function syncLiveOptionsPositionsFromBroker(accountId: string): Promise<LiveOptionsPositionsSyncResult> {
  const preview = await previewWebullPositions(accountId);
  if (!preview.ok) return { ok: false, checked: 0, closed: 0, closedSymbols: [], error: preview.error };

  const heldKeys = new Set(
    preview.positions
      .filter((p) => p.assetType === 'option')
      .map((p) =>
        contractKey({
          symbol: p.symbol,
          assetType: 'option',
          optionType: p.optionType,
          strike: p.strike,
          expiration: p.expiration,
        }),
      ),
  );

  const open = listOpenLiveOptionsPositions();
  const closedSymbols = new Set<string>();
  let closed = 0;
  for (const pos of open) {
    const longHeld = heldKeys.has(
      contractKey({
        symbol: pos.symbol,
        assetType: 'option',
        optionType: pos.side,
        strike: pos.strike,
        expiration: pos.expiration,
      }),
    );

    if (pos.kind === 'single_leg') {
      if (longHeld) continue; // still held at the broker
      const exitPrice = await safeContractMark(pos.symbol, pos.expiration, pos.strike, pos.side);
      if (exitPrice == null) continue; // can't price it — leave open, retry next sync
      if (closeLiveOptionsPositionFromBroker(pos, exitPrice, null)) {
        closed++;
        closedSymbols.add(pos.symbol);
      }
      continue;
    }

    // debit_spread — only close when BOTH legs are gone; see header comment
    // on why one leg missing is left open rather than guessed.
    const shortHeld = heldKeys.has(
      contractKey({
        symbol: pos.symbol,
        assetType: 'option',
        optionType: pos.side,
        strike: pos.shortStrike!,
        expiration: pos.expiration,
      }),
    );
    if (longHeld || shortHeld) continue;

    const [longExit, shortExit] = await Promise.all([
      safeContractMark(pos.symbol, pos.expiration, pos.strike, pos.side),
      safeContractMark(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
    ]);
    if (longExit == null || shortExit == null) continue; // can't price both legs — leave open, retry next sync
    if (closeLiveOptionsPositionFromBroker(pos, longExit, shortExit)) {
      closed++;
      closedSymbols.add(pos.symbol);
    }
  }
  return { ok: true, checked: open.length, closed, closedSymbols: Array.from(closedSymbols) };
}

/** A quote fetch failing (no current market for an illiquid/expired
 *  contract) means "can't price it yet," not "the position is gone" —
 *  mirrors positions.ts's own closePositionsFromPreview, which leaves a
 *  position open rather than guessing at $0 when priceMap can't resolve it,
 *  retrying on a later sync once pricing recovers. */
async function safeContractMark(
  symbol: string,
  expiration: string,
  strike: number,
  side: 'call' | 'put',
): Promise<number | null> {
  try {
    return await fetchContractMark(symbol, expiration, strike, side);
  } catch {
    return null;
  }
}

function closeLiveOptionsPositionFromBroker(
  pos: LiveOptionsPosition,
  exitPrice: number,
  shortExitPrice: number | null,
): boolean {
  const closed = closeLiveOptionsPosition(pos.id, {
    exitPrice,
    shortExitPrice: shortExitPrice ?? undefined,
    exitReason: 'manual',
  });
  if (!closed) return false; // already closed (e.g. by reconcileLiveOptionsOrders earlier this same tick) — not an error
  logAutotradeEvent({
    symbol: pos.symbol,
    stage: 'execution',
    action: 'live_options_position_closed',
    detail: {
      via: 'broker_sync',
      kind: pos.kind,
      exitPrice,
      shortExitPrice,
      pnl: liveOptionsPnl(closed, exitPrice, shortExitPrice),
      note: 'Auto-closed via Webull broker-truth sync — no longer held at the broker. Exit price is an ESTIMATE from the latest quote, not a confirmed fill.',
    },
    riskProfile: pos.riskProfile,
  });
  return true;
}
