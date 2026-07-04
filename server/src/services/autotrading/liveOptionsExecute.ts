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
import { newClientOrderId, webullPlaceOrder } from '../../providers/webull/orders';
import { createIntent, transitionIntent, countTodaysOrders } from '../../db/orders';
import {
  recordLiveOptionsEntryOrder,
  LiveOptionsOrderKind,
  countLiveOptionsOrdersSince,
} from '../../db/autotradeLiveOptionsOrders';
import {
  hasOpenLiveOptionsPosition,
  listOpenLiveOptionsPositions,
  listLiveOptionsPositions,
  LiveOptionsPosition,
} from '../../db/autotradeLiveOptionsPositions';
import { computeStreaksAndDrawdown } from '../pnl';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from './optionsRiskCheck';
import { correlatedNotional, RiskCheckContext } from './riskCheck';
import { RISK_PROFILES } from './riskProfiles';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';
import { fetchContractMark, validPremium } from './optionsExecute';
import { getLivePortfolioSnapshot, ProbationStatus } from './liveExecute';

// ---------------------------------------------------------------------------
// Task #70 Step B: the LIVE counterpart to optionsExecute.ts's paper options
// execution — every order here IS submitted to the real Webull account.
// Also the OPTIONS counterpart to liveExecute.ts's live equity execution:
// reuses the same lower-level pieces (guardrails, webullPlaceOrder, the order
// lifecycle) but keeps its own entry function, since options fills are
// per-CONTRACT (or per-spread) marks resolved from a chain, not a single
// getQuote() the way a stock is.
//
// No bracket, ever: autotrade's options signals never carried a price-based
// stop/target (Phase 12's confirmed close-only, time-based exit design), and
// buildOrderRequest() only attaches a bracket to a stock or a SINGLE-strategy
// option anyway (never a VERTICAL) — so a live options entry is always a
// plain order, mirroring paper's own shape. An exit will be a separate
// closing order Step C places itself when the time-exit trigger fires.
//
// Combined live budget (one-way for now): this file folds live EQUITY's own
// running risk/count/positions (getLivePortfolioSnapshot(), liveExecute.ts)
// into every live options risk-check, same "one real account, one combined
// budget" reasoning as optionsExecute.ts folding in equity's PAPER snapshot.
// The reverse (equity's own runLiveExecution seeing live options' book) is
// deferred to Step D, when loop.ts actually threads a seed both ways — this
// mirrors how paper's own bidirectional seeding was completed at the loop
// level, not when options paper execution was first built.
// ---------------------------------------------------------------------------

/** Options bid/ask spreads run far wider, as a % of premium, than a stock's —
 *  a low-dollar OTM contract can have a spread that's already 5-10% of its
 *  own mark. Equity's own live path (MARKETABLE_LIMIT_BUFFER_PCT, 0.5%) would
 *  routinely miss a fill here, so this is 10x more generous — while still
 *  comfortably under the default liveOptionsFatFingerPct (10%) so a fresh
 *  quote doesn't trip the guardrail that's meant to catch a STALE one. */
const OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT = 5;

/** Combine the autotrade-specific LIVE OPTIONS caps with BOTH kill switches
 *  and liveOptionsEnabled — mirrors liveExecute.ts's buildLiveTradingConfig()
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
    // Same real cash account as equity — 100% of configured equity, shared.
    maxExposureUsd: autotradeCfg.accountEquityUsd ?? 0,
    maxOrdersPerDay: autotradeCfg.liveOptionsMaxOrdersPerDay,
    maxDailyLossUsd: autotradeCfg.liveOptionsMaxDailyLossUsd,
    fatFingerPct: autotradeCfg.liveOptionsFatFingerPct,
    // This system only ever BUYS options (long calls/puts, or a net-debit
    // spread) — guardrails.ts's naked_short check can't actually trigger for
    // an order that only ever adds to a position, so which value this holds
    // is inert here; reusing equity's flag avoids a config field with no
    // observable effect.
    allowNakedShort: autotradeCfg.liveAllowNakedShort,
  };
}

/** Whether autotrade is still within its post-liveOptionsEnabled probation
 *  window, and the size cut to apply if so. Mirrors liveExecute.ts's
 *  getProbationStatus() exactly, anchored to liveOptionsEnabledAt/
 *  liveOptionsProbationTrades instead of equity's own fields — a fully
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

/** Realized P&L for a CLOSED live options position — identical formula to
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

/** Current live options portfolio state — mirrors optionsExecute.ts's
 *  getOptionsPaperPortfolioSnapshot() exactly, over
 *  autotrade_live_options_positions instead. Consumed by
 *  runLiveOptionsExecution()'s own batch below, and (from Step C onward) by
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

export interface LiveOptionsExecutionOutcome {
  symbol: string;
  ok: boolean;
  reason?: string;
  intentId?: number;
}

/** Shared tail once an OrderIntent + its guardrail report are built: create
 *  the intent, reject on a guardrail block, otherwise walk it through the
 *  lifecycle and place it for real. Identical for single-leg and
 *  debit-spread — only the intent shape differs upstream. */
async function placeLiveOptionsIntent(
  intent: OrderIntent,
  guardrails: GuardrailReport,
  accountId: string,
  symbol: string,
  kind: LiveOptionsOrderKind,
  riskAmount: number,
  riskProfile: RiskProfileName,
): Promise<LiveOptionsExecutionOutcome> {
  const clientOrderId = newClientOrderId();
  const intentRec = createIntent(intent, clientOrderId);

  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_options_entry_blocked',
      detail: { reasons, kind },
      riskProfile,
    });
    return { symbol, ok: false, reason: `Guardrails blocked: ${reasons}`, intentId: intentRec.id };
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
      action: 'live_options_entry_failed',
      detail: { reason: broker.error, kind },
      riskProfile,
    });
    return { symbol, ok: false, reason: `Broker rejected: ${broker.error}`, intentId: intentRec.id };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  recordLiveOptionsEntryOrder({ intentId: intentRec.id, symbol, kind, riskAmount, riskProfile });
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_options_order_placed',
    detail: {
      kind,
      side: intent.side,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      orderId: broker.orderId,
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
  return { symbol, ok: true, intentId: intentRec.id };
}

/**
 * Attempt to place a real options order (single-leg or debit-spread) for an
 * approved (already risk-checked) signal. Idempotent per underlying, same as
 * paper: a symbol with an already-open live options position is skipped.
 * Sizing is the risk-checked quantity cut by the probation multiplier (if
 * still active), rounding DOWN and skipping entirely if that rounds to zero.
 *
 * A debit spread fills as ONE combo order (VERTICAL) or not at all — if
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

    const acct = await webullAccountState(accountId, symbol);
    if (!acct.ok || !acct.state) {
      return { symbol, ok: false, reason: acct.error ?? 'Could not load account state' };
    }
    // Account type gates spreads (margin only) — fetch it only for a spread,
    // same convention as livePreview.ts / placeOrder.ts.
    const accountType = await webullAccountType(accountId);
    const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(), accountType };
    const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
    return placeLiveOptionsIntent(
      intent,
      guardrails,
      accountId,
      symbol,
      'debit_spread',
      riskResult.approvedRiskAmount,
      riskProfile,
    );
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

  const acct = await webullAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { symbol, ok: false, reason: acct.error ?? 'Could not load account state' };
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };
  const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
  return placeLiveOptionsIntent(
    intent,
    guardrails,
    accountId,
    symbol,
    'single_leg',
    riskResult.approvedRiskAmount,
    riskProfile,
  );
}

/**
 * Risk-check, then attempt to place, a batch of already-decided options
 * signals — sequentially against a RUNNING total combining THIS book's own
 * open live options positions with live EQUITY's CURRENT book
 * (getLivePortfolioSnapshot(), liveExecute.ts) — the real-money combined
 * budget, mirroring optionsExecute.ts's runOptionsPaperExecution() batch
 * pattern exactly, over live snapshots instead of paper ones.
 */
export async function runLiveOptionsExecution(
  candidates: { signal: OptionsTradeSignal }[],
): Promise<LiveOptionsExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const profile = RISK_PROFILES[cfg.riskProfile];
  const equity = cfg.accountEquityUsd ?? 0;

  const optSnapshot = getLiveOptionsPortfolioSnapshot();
  const eqSnapshot = getLivePortfolioSnapshot();

  const dailyPnl = optSnapshot.dailyPnl + eqSnapshot.dailyPnl;
  const tradesToday = optSnapshot.tradesToday + eqSnapshot.tradesToday;
  const consecutiveLosses = Math.max(optSnapshot.consecutiveLosses, eqSnapshot.consecutiveLosses);
  let runningRisk = optSnapshot.openRisk + eqSnapshot.openRisk;
  let runningCount = optSnapshot.openPositionsCount + eqSnapshot.openPositionsCount;
  const runningPositions: { symbol: string; notional: number }[] = [
    ...optSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount })),
    ...eqSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.entryPrice * p.quantity })),
  ];
  const skipSymbols = new Set(optSnapshot.openPositions.map((p) => p.symbol));

  const outcomes: LiveOptionsExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open live options position' });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(signal.symbol, runningPositions);
    const ctx: RiskCheckContext = {
      equity,
      dailyPnl,
      tradesToday,
      consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      correlatedNotional: correlated,
    };
    const result = evaluateOptionsRiskCheck(signal, ctx, profile);
    if (!result.ok) {
      outcomes.push({ symbol, ok: false, reason: 'Risk check blocked' });
      continue;
    }

    // Re-fetch fresh config for the actual placement attempt, same reasoning
    // as liveExecute.ts's runLiveExecution() — this loop awaits real broker
    // round-trips between candidates, and a kill switch engaged mid-batch
    // must stop the NEXT candidate immediately, not just the next cycle.
    const freshCfg = getAutotradeConfig();
    const outcome = await attemptLiveOptionsEntry(signal, result, freshCfg.riskProfile, freshCfg);
    outcomes.push(outcome);
    if (outcome.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol, notional: result.approvedNotional });
      skipSymbols.add(symbol);
    }
  }
  return outcomes;
}
