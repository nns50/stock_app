import { config } from '../../config';
import { getProvider } from '../../providers';
import { db } from '../../db';
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
import { evaluateEndOfDayFlatten, minutesUntilClose } from './endOfDayFlatten';
import { evaluateShortDatedExit } from './shortDatedOptionsExit';
import { webullAccountState, webullAccountType } from '../../providers/webull/accountState';
import {
  newClientOrderId,
  webullPlaceOrder,
  webullOrderStatus,
  webullOrderStatusBatch,
} from '../../providers/webull/orders';
import {
  advanceMaterialized,
  createIntent,
  transitionIntent,
  countTodaysOrders,
  getIntents,
  recordIntentNoteOnce,
  OrderIntentRecord,
} from '../../db/orders';
import { canTransition, isTerminal } from '../trading/orderLifecycle';
import { ackUnknownPlacement, canRetireUnknownPlacement, mapWebullStatus } from '../trading/reconcile';
import { computeFillDelta } from '../trading/fillDelta';
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
  liveOptionsPnl,
  hasOpenLiveOptionsPosition,
  listOpenLiveOptionsPositions,
  listLiveOptionsPositions,
  createLiveOptionsPosition,
  blendLiveOptionsPositionEntry,
  closeLiveOptionsPosition,
  LiveOptionsPosition,
  LiveOptionsExitReason,
  getLiveOptionsPosition,
  reduceLiveOptionsPositionQuantity,
  raiseLiveOptionsPeakPremium,
} from '../../db/autotradeLiveOptionsPositions';
import { computeStreaksAndDrawdown } from '../pnl';
import { defaultExitConfig, evaluateExit } from '../../options/exitRules';
import { convictionGrade } from './decide';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from './optionsRiskCheck';
import { journalMethodMultipliers, methodOfOptionsSignal } from './methodSizing';
import { activeSymbolCooldowns, journalEntrySkipOncePerDay } from './symbolCooldown';
import { computeFinishLineFactor, finishLineScoreGate } from './finishLine';
import { evaluateDailyTarget } from './dailyTarget';
import { getDailyBaseline } from '../../db/dailyBaseline';
import { correlatedNotional, sectorNotional, buildSectorOf, RiskCheckContext } from './riskCheck';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';
import { fetchContractQuote, validPremium } from './optionsExecute';
import { getLivePortfolioSnapshot, combinedLiveOpenRisk, ProbationStatus } from './liveExecute';
import { previewWebullPositions, contractKey } from '../../providers/webull/positions';
import { bumpMissStreak, clearMissStreak, MISS_CONFIRM_THRESHOLD } from '../../db/webullMissStreak';

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
// stop/target (Phase 12's confirmed close-only exit design — originally
// time-based only; the configured stop-loss/take-profit percentages joined
// 2026-07-26, still as placed CLOSING orders, never bracket legs), and
// buildOrderRequest() only attaches a bracket to a stock or a SINGLE-strategy
// option anyway (never a VERTICAL) -- so both an entry and an exit here are
// always plain orders. An exit (Step C) is a SEPARATE closing order this
// loop places itself when an exit trigger (time / stop-loss / take-profit)
// fires, tracked via the
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

/** For the intraday maxHoldDays check in checkLiveOptionsExits — same constant
 *  liveExecute.ts uses for equity's own. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The always-on exit backstop -- mirrors optionsExecute.ts's own
 *  AUTOTRADE_TIME_EXIT_DAYS constant exactly (duplicated per this codebase's
 *  established paper/live parallel-implementation convention). Originally the
 *  ONLY exit rule this file automated; since 2026-07-26 the configured
 *  optionsStopLossPct/optionsTakeProfitPct price rules apply to LIVE
 *  positions too (checkLiveOptionsExits) -- this constant remains the
 *  quote-free floor under both. */
const AUTOTRADE_TIME_EXIT_DAYS = defaultExitConfig().timeExitDaysBeforeExpiry ?? 7;

/** The days-to-expiry backstop, resolved against the short-dated flag.
 *
 *  THE COUPLING THAT MUST NOT BE SPLIT (docs/SHORT_DATED_OPTIONS_SPEC.md): the
 *  7-day rule and a 0-2 DTE band are mutually exclusive. Widen the DTE band
 *  while this still reads 7 and every contract bought satisfies `dte <= 7` on
 *  the very first check, so the loop buys a 0DTE and sells it on the next tick,
 *  paying the round-trip spread for nothing, every time. Short-dated positions
 *  are governed by the hard 14:00 clock in shortDatedOptionsExit.ts instead,
 *  which is a real exit rather than an instant round trip. */
async function quoteOrNull(symbol: string): Promise<number | null> {
  try {
    return (await getProvider().getQuote(symbol)).last;
  } catch {
    return null;
  }
}

function timeExitDaysFor(cfg: AutotradeConfig): number {
  return cfg.shortDatedOptionsEnabled ? 0 : AUTOTRADE_TIME_EXIT_DAYS;
}

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
  /** The placement's outcome is UNKNOWN rather than known-rejected, so the
   *  intent has deliberately been left NON-terminal ('submitted'). The caller
   *  must still record its order row: that is what keeps it pollable by
   *  reconcileLiveOptionsOrders (which looks orders up by client order id) and
   *  what stops the next cycle placing the same real order again. */
  ambiguous?: boolean;
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
  if (!broker.ok && broker.ambiguous) {
    // Left at 'submitted', NOT rejected: we don't know whether this reached the
    // broker, and 'rejected' is terminal — it would drop the intent out of
    // listPendingLiveOrders() and out of the double-open guard, so the next
    // cycle would place the same real order again.
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_options_order_outcome_unknown',
      detail: { reason: broker.error, clientOrderId },
      riskProfile,
    });
    return {
      intentId: intentRec.id,
      ok: false,
      ambiguous: true,
      reason: `Placement outcome unknown (kept pending for reconcile): ${broker.error}`,
    };
  }
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
  /** At-entry context (2026-07-26), recorded on the entry order row and
   *  carried to the position at materialization — the market regime label +
   *  market ATR% the loop read this cycle. Nullable, defaulting to null for
   *  direct callers (e.g. tests). */
  marketRegime: string | null = null,
  marketAtrPct: number | null = null,
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
  // Scale the recorded risk to the contracts actually ORDERED. For options the
  // premium IS the risk, so an unscaled approvedRiskAmount overstates it by the
  // full probation cut — and unlike equity, whose position risk is re-derived
  // from the real fill by initialRiskOf, this figure is STORED on the position
  // and read for its whole life by getLiveOptionsPortfolioSnapshot and
  // combinedLiveOpenRisk. At the default 0.5x probation every live options
  // position claimed 2x its true risk against the shared aggregate-risk budget,
  // blocking equity and options entries that were actually within it.
  const orderedRiskAmount =
    rawQuantity > 0 ? (riskResult.approvedRiskAmount * quantity) / rawQuantity : riskResult.approvedRiskAmount;
  if (quantity <= 0) {
    return {
      symbol,
      ok: false,
      reason: `Probation-adjusted quantity rounded to 0 (multiplier ${probation.multiplier})`,
    };
  }

  const liveCfg = buildLiveOptionsTradingConfig(autotradeCfg);
  const buffer = 1 + OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100;

  // At-entry context recorded on the order row (either kind) and carried to
  // the position at materialization — mirrors equity's orderRow fields.
  const entryContext = {
    grade: convictionGrade(signal.score, {
      aMinScore: autotradeCfg.convictionGradeAMinScore,
      bMinScore: autotradeCfg.convictionGradeBMinScore,
    }) as string,
    entryScore: signal.score,
    ivRank: signal.ivRank,
    marketRegime,
    marketAtrPct,
    underlyingAtEntry: signal.underlyingPrice,
  };

  if (signal.kind === 'debit_spread') {
    let longFill: number;
    let shortFill: number;
    try {
      const [longQ, shortQ] = await Promise.all([
        fetchContractQuote(signal.symbol, signal.expiration, signal.longStrike, signal.side),
        fetchContractQuote(signal.symbol, signal.expiration, signal.shortStrike, signal.side),
      ]);
      // Refuse to open on a LAST-TRADE-only price. A contract with no usable
      // bid/ask is one nobody is currently quoting, so the only number
      // available describes a trade that may be hours or days old — and this
      // path is about to commit real money at a limit derived from it. An
      // entry is optional, so the cheap and correct move is not to take it.
      // (An EXIT is not optional and is handled the other way — see
      // placeLiveOptionsExit.)
      if (longQ.fromLastTrade || shortQ.fromLastTrade) {
        return {
          symbol,
          ok: false,
          reason: `No live two-sided quote for ${symbol} (only a last-trade price) — not opening on a stale mark`,
        };
      }
      [longFill, shortFill] = [longQ.price, shortQ.price];
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
    // Record the order row even when the outcome is UNKNOWN: that is what keeps
    // it pollable by reconcileLiveOptionsOrders and what stops the next cycle
    // placing the same real order again. Only a KNOWN refusal returns early.
    if (!placed.ok && !placed.ambiguous) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };

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
      riskAmount: orderedRiskAmount,
      riskProfile,
      accountId,
      ...entryContext,
    });

    if (!placed.ok) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };
    return finishEntryPlacement(symbol, intent, 'debit_spread', placed, riskProfile);
  }

  let fillPremium: number;
  try {
    const q = await fetchContractQuote(signal.symbol, signal.expiration, signal.strike, signal.side);
    // Same refusal as the spread branch above: don't open real risk at a limit
    // derived from a last trade of unknown age.
    if (q.fromLastTrade) {
      return {
        symbol,
        ok: false,
        reason: `No live two-sided quote for ${symbol} (only a last-trade price) — not opening on a stale mark`,
      };
    }
    fillPremium = q.price;
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
  // Record the order row even when the outcome is UNKNOWN: that is what keeps
  // it pollable by reconcileLiveOptionsOrders and what stops the next cycle
  // placing the same real order again. Only a KNOWN refusal returns early.
  if (!placed.ok && !placed.ambiguous) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };

  recordLiveOptionsEntryOrder({
    intentId: placed.intentId,
    symbol,
    kind: 'single_leg',
    side: signal.side,
    contractSymbol: signal.contractSymbol,
    strike: signal.strike,
    expiration: signal.expiration,
    riskAmount: orderedRiskAmount,
    riskProfile,
    accountId,
    ...entryContext,
  });

  if (!placed.ok) return { symbol, ok: false, reason: placed.reason, intentId: placed.intentId };
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
/** The live OPTIONS book's contribution to the live EQUITY batch's risk gates.
 *  Mirrors optionsExecute.ts's optionsSeedForEquity for the paper books.
 *
 *  Only the three cross-book figures: open risk and position count already come
 *  from combinedLiveOpenRisk(), which two-ways both books. Lives here (not in
 *  liveExecute.ts, which would need getLiveOptionsPortfolioSnapshot and create
 *  an import cycle) and is threaded in by loop.ts. */
export interface LiveOptionsRiskSeed {
  dailyPnl: number;
  /** Combined via max(), not sum — same reasoning as PaperPortfolioSeed's. */
  consecutiveLosses: number;
  tradesToday: number;
}

export function liveOptionsSeedForEquity(
  snapshot: ReturnType<typeof getLiveOptionsPortfolioSnapshot> = getLiveOptionsPortfolioSnapshot(),
): LiveOptionsRiskSeed {
  return {
    dailyPnl: snapshot.dailyPnl,
    consecutiveLosses: snapshot.consecutiveLosses,
    tradesToday: snapshot.tradesToday,
  };
}

export async function runLiveOptionsExecution(
  candidates: { signal: OptionsTradeSignal }[],
  /** Regime-aware sizing (2026-07-16) — same market-ATR% reading loop.ts
   *  already computed once this cycle for its volatility hard-cutoff, not
   *  re-fetched here. Defaults to null (regime cut inactive) for any caller
   *  that doesn't have/need one, e.g. a direct test call. */
  marketAtrPct: number | null = null,
  /** Market regime label the loop read this cycle (2026-07-26) — recorded on
   *  the entry order row and carried to the position at materialization as
   *  at-entry context; never used for sizing here. */
  marketRegime: string | null = null,
): Promise<LiveOptionsExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const equity = cfg.accountEquityUsd ?? 0;
  // One journal read per batch — the same recent-window per-method lean the
  // equity paths get from their snapshots (methodSizing.ts).
  const methodMultipliers = journalMethodMultipliers(cfg);

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
  // Slot budget. Options and equity share ONE combined risk pool by design
  // (phase 12) — sound for money, ruinous for slots at a small cap: equity
  // runs first in the loop tick, and on 2026-08-27 it held both of the two
  // slots all session while 184 options signals produced zero orders, every
  // one refused "2 open vs cap 2". With optionsMaxConcurrentPositions set,
  // this book counts only its OWN open positions against its own number.
  // runningRisk below is deliberately NOT split: that budget is about money,
  // and money genuinely is shared.
  const ownSlots = cfg.optionsMaxConcurrentPositions > 0;
  const slotCap = ownSlots ? cfg.optionsMaxConcurrentPositions : cfg.maxConcurrentPositions;
  let runningCount = ownSlots ? optSnapshot.openPositionsCount : combined.count;
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
  const sectorOf = buildSectorOf();

  // Finish-line discipline + symbol cooldown (2026-08-22) — same batch-level
  // computation as runLiveExecution's (see its comment). The options reward
  // multiple is what a winner pays per $1 of premium risked: the take-profit
  // % of premium, in R terms.
  const dailyTarget = evaluateDailyTarget(cfg, getDailyBaseline());
  const cooldowns = activeSymbolCooldowns(cfg);
  const finishLine = computeFinishLineFactor({
    enabled: cfg.finishLineSizingEnabled,
    dailyTarget,
    equity,
    riskPerTradePct: cfg.riskPerTradePct,
    rewardMultiple: cfg.optionsTakeProfitPct / 100,
  });

  // --- Short-dated entry gates (docs/SHORT_DATED_OPTIONS_SPEC.md) ----------
  // Both are batch-level: neither depends on which candidate is being looked
  // at, so evaluating them per-candidate would just repeat the same answer.
  if (cfg.shortDatedOptionsEnabled && cfg.optionsNoEntryMinutesBeforeClose > 0) {
    const left = minutesUntilClose(Date.now());
    if (left !== null && left <= cfg.optionsNoEntryMinutesBeforeClose) {
      // A short-dated contract opened this late has too little time for the
      // move to arrive, against a decay headwind that steepens all the way in:
      // flat premium is already -63% by 13:30 and -82% by 14:30. And the hard
      // 14:00 exit would close it almost immediately anyway.
      const reason = `${left}m to the close — past the ${cfg.optionsNoEntryMinutesBeforeClose}m short-dated entry cutoff`;
      logAutotradeEvent({ stage: 'execution', action: 'short_dated_entry_window_closed', detail: { reason, left } });
      return candidates.map(({ signal }) => ({ symbol: signal.symbol.toUpperCase(), ok: false, reason }));
    }
  }
  // One short-dated position at a time. Tighter than the shared 2-slot cap on
  // purpose: two 0DTE positions can both go to zero inside the same half hour
  // on a single adverse market move — a correlation stock positions do not
  // have, and one this account cannot absorb twice in a day.
  if (cfg.shortDatedOptionsEnabled && optSnapshot.openPositionsCount >= 1) {
    const reason = 'a short-dated options position is already open (max 1 at a time)';
    // Counted by the tuning plan's F7 -- see the paper path's twin for why a
    // silent return made that rule unmeasurable.
    logAutotradeEvent({
      stage: 'execution',
      action: 'short_dated_position_already_open',
      detail: { book: 'live', reason, refused: candidates.length, openPositions: optSnapshot.openPositionsCount },
    });
    return candidates.map(({ signal }) => ({ symbol: signal.symbol.toUpperCase(), ok: false, reason }));
  }

  const outcomes: LiveOptionsExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open live options position' });
      continue;
    }
    const cooldown = cooldowns.get(symbol);
    if (cooldown) {
      const reason = `Symbol cooling down after ${cooldown.losses} losses since ${cooldown.lastLossDate} — resumes ${cooldown.until}`;
      journalEntrySkipOncePerDay(symbol, 'symbol_cooldown_skipped', { ...cooldown, reason });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    const scoreGate = finishLineScoreGate(signal.score, dailyTarget, cfg);
    if (scoreGate.skip) {
      journalEntrySkipOncePerDay(symbol, 'finish_line_skipped', { score: signal.score, reason: scoreGate.detail });
      outcomes.push({ symbol, ok: false, reason: `Armed-day selectivity: ${scoreGate.detail}` });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      'long', // options candidates are always a long-the-contract bet
      runningPositions,
      cfg.correlationLookbackDays,
      cfg.correlationThreshold,
    );
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      'long',
      runningPositions,
      sectorOf,
    );
    const ctx: RiskCheckContext = {
      equity,
      dailyPnl,
      tradesToday,
      consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      maxConcurrentPositions: slotCap,
      correlatedNotional: correlated,
      riskPerTradePct: cfg.riskPerTradePct,
      maxDailyDrawdownPct: cfg.maxDailyDrawdownPct,
      stepDownAfterLosses: cfg.stepDownAfterLosses,
      stepDownSizeCutPct: cfg.stepDownSizeCutPct,
      maxAggregateOpenRiskPct: cfg.maxAggregateOpenRiskPct,
      maxCorrelatedExposurePct: cfg.maxCorrelatedExposurePct,
      maxTradesPerDay: cfg.maxTradesPerDay,
      correlationThreshold: cfg.correlationThreshold,
      sectorNotional: sectorAmount,
      maxSectorExposurePct: cfg.maxSectorExposurePct,
      candidateSector,
      marketAtrPct,
      regimeAtrThresholdPct: cfg.regimeAtrThresholdPct,
      regimeSizeCutPct: cfg.regimeSizeCutPct,
      methodMultiplier: methodMultipliers[methodOfOptionsSignal(signal.side)] ?? 1,
      finishLineFactor: finishLine.factor,
      finishLineDetail: finishLine.detail,
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
      outcome = await attemptLiveOptionsEntry(
        signal,
        result,
        freshCfg.riskProfile,
        freshCfg,
        marketRegime,
        marketAtrPct,
      );
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
/** Journal + return an exit that never reached the broker. Like equity's own
 *  timeExitFailure(), these bail-outs used to return a `reason` that died in
 *  the return value — unjournaled, so unalertable (liveFailureAlert reads the
 *  journal) and invisible. The time-exit trigger does not un-trigger, so each
 *  repeats every cycle for as long as its cause persists: an unpriceable
 *  contract silently retried forever is exactly how a position drifts to
 *  expiration, the outcome this exit exists to prevent. Reuses the same
 *  'live_options_exit_failed' action the broker-rejection path already
 *  journals, which FAILURE_ACTIONS already covers. */
function optionsExitFailure(
  pos: LiveOptionsPosition,
  reason: string,
  extra: Record<string, unknown> = {},
): LiveOptionsExitCheckOutcome {
  logAutotradeEvent({
    symbol: pos.symbol,
    stage: 'execution',
    action: 'live_options_exit_failed',
    detail: { reason, positionId: pos.id, ...extra },
    riskProfile: pos.riskProfile,
  });
  return { symbol: pos.symbol, requested: false, reason };
}

async function placeLiveOptionsExit(
  pos: LiveOptionsPosition,
  accountId: string,
  cfg: AutotradeConfig,
  /** Which rule fired — recorded on the exit order row (carried to the
   *  position's exit_reason at materialization) and named in the
   *  notification, so a stop-loss close is never journaled as a time-exit. */
  exitReason: LiveOptionsExitReason,
): Promise<LiveOptionsExitCheckOutcome> {
  const symbol = pos.symbol;
  // Selling to close -- price BELOW the mark to guarantee a fill (the mirror
  // image of an entry's "pay slightly more to guarantee a buy").
  const buffer = 1 - OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100;
  const liveCfg = buildLiveOptionsTradingConfig(cfg);

  // Naked-short guard: the exit quantity MUST NOT exceed what's actually held at
  // the broker. pos.quantity can be STALE — a prior closing order that partially
  // filled then cancelled/expired is never booked, so the ledger still shows the
  // original size while fewer contracts are really held. Selling pos.quantity
  // there would short the difference (an uncovered short option = unbounded
  // risk), and the naked_short guardrail can't catch it because it's fed this
  // same stale ledger qty as the override. Re-query the broker's real held
  // quantity (long leg for a spread — the leg the sell-to-close would short) and
  // cap to it; fail closed (skip, retry next cycle) if it can't be read or is 0.
  let heldQty: number;
  try {
    const preview = await previewWebullPositions(accountId);
    if (!preview.ok) return optionsExitFailure(pos, `Broker positions unavailable: ${preview.error}`);
    const wantKey = contractKey({
      symbol,
      assetType: 'option',
      optionType: pos.side,
      strike: pos.strike,
      expiration: pos.expiration,
    });
    heldQty = preview.positions
      .filter((p) => p.assetType === 'option')
      .filter(
        (p) =>
          contractKey({
            symbol: p.symbol,
            assetType: 'option',
            optionType: p.optionType,
            strike: p.strike,
            expiration: p.expiration,
          }) === wantKey,
      )
      .reduce((s, p) => s + (p.quantity ?? 0), 0);
  } catch (err) {
    return optionsExitFailure(pos, `Broker positions fetch failed: ${(err as Error).message}`);
  }
  if (heldQty <= 0) {
    return optionsExitFailure(pos, 'Broker shows 0 contracts held — nothing to close (sync reconciles)');
  }
  const exitQty = Math.min(pos.quantity, heldQty);

  // Unlike an ENTRY (which refuses a last-trade-only price outright — see
  // attemptLiveOptionsEntry), an exit priced off a stale print still goes
  // ahead. Refusing would guarantee the very outcome the time exit exists to
  // prevent: the position simply sits there and drifts to expiration. But a
  // stale-HIGH print produces a sell limit above where the contract can
  // actually be sold, so the close rests unfilled and looks, from the outside,
  // exactly like nothing happening — which is why it is journaled rather than
  // left to be inferred from a position that never closes.
  const noteStaleQuote = (detail: Record<string, unknown>) =>
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_options_exit_stale_quote',
      detail: { positionId: pos.id, ...detail },
      riskProfile: pos.riskProfile,
    });

  let intent: OrderIntent;
  if (pos.kind === 'debit_spread') {
    let longMark: number;
    let shortMark: number;
    try {
      const [longQ, shortQ] = await Promise.all([
        fetchContractQuote(symbol, pos.expiration, pos.strike, pos.side),
        fetchContractQuote(symbol, pos.expiration, pos.shortStrike!, pos.side),
      ]);
      if (longQ.fromLastTrade || shortQ.fromLastTrade) {
        noteStaleQuote({
          reason: 'exit priced off a last-trade price, not a two-sided mark — the close may rest unfilled',
          longFromLastTrade: longQ.fromLastTrade,
          shortFromLastTrade: shortQ.fromLastTrade,
        });
      }
      [longMark, shortMark] = [longQ.price, shortQ.price];
    } catch (err) {
      return optionsExitFailure(pos, `Quote fetch failed: ${(err as Error).message}`);
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
      return optionsExitFailure(pos, `No usable exit quote (net ${netValue}: long ${longMark}, short ${shortMark})`);
    }
    intent = {
      symbol,
      assetKind: 'option',
      side: 'sell', // selling the spread to close — net credit
      openClose: 'close',
      quantity: exitQty,
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
      const q = await fetchContractQuote(symbol, pos.expiration, pos.strike, pos.side);
      if (q.fromLastTrade) {
        noteStaleQuote({
          reason: 'exit priced off a last-trade price, not a two-sided mark — the close may rest unfilled',
          mark: q.price,
        });
      }
      mark = q.price;
    } catch (err) {
      return optionsExitFailure(pos, `Quote fetch failed: ${(err as Error).message}`);
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
      return optionsExitFailure(pos, `No usable exit quote (mark ${mark})`);
    }
    intent = {
      symbol,
      assetKind: 'option',
      side: 'sell',
      openClose: 'close',
      quantity: exitQty,
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
    // for a single-leg close. Use the capped exit qty (== broker-held), so the
    // naked_short check sees resultingQty 0 only when we truly hold what we sell.
    pos.kind === 'debit_spread' ? undefined : exitQty,
  );
  // Account-state failure only — a guardrail BLOCK comes back ok:true and is
  // journaled by placeLiveOptionsOrder's own blocked path below.
  if (!loaded.ok) return optionsExitFailure(pos, loaded.reason);

  const placed = await placeLiveOptionsOrder(
    intent,
    loaded.guardrails,
    accountId,
    symbol,
    'live_options_exit_blocked',
    'live_options_exit_failed',
    pos.riskProfile,
  );
  // Record the order row even when the outcome is UNKNOWN: that is what keeps
  // it pollable by reconcileLiveOptionsOrders and what stops the next cycle
  // placing the same real order again. Only a KNOWN refusal returns early.
  if (!placed.ok && !placed.ambiguous)
    return { symbol, requested: false, reason: placed.reason, intentId: placed.intentId };

  recordLiveOptionsExitOrder({
    intentId: placed.intentId,
    symbol,
    kind: pos.kind,
    riskProfile: pos.riskProfile,
    positionId: pos.id,
    exitReason,
  });

  if (!placed.ok) return { symbol, requested: false, reason: placed.reason, intentId: placed.intentId };
  const reasonLabel = exitReason.replace('_', '-');
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
      exitReason,
    },
    riskProfile: pos.riskProfile,
  });
  await dispatchNotifications([
    {
      title: symbol,
      message: `Autotrade LIVE OPTIONS closing ${pos.kind === 'debit_spread' ? 'spread' : 'position'}: ${symbol} (${reasonLabel})`,
    },
  ]);
  return { symbol, requested: true, intentId: placed.intentId };
}

/** Map exitRules.ts's kebab-case rule ids onto the live table's snake_case
 *  exit_reason values — same mapping (and same defensive default) as
 *  optionsExecute.ts's own exitReasonFor. 'delta-drift' is unreachable here
 *  (no delta band is ever configured on this path) but mapped rather than
 *  left to throw. */
function liveExitReasonFor(activeRule: string): LiveOptionsExitReason {
  switch (activeRule) {
    case 'stop-loss':
      return 'stop_loss';
    case 'take-profit':
      return 'take_profit';
    default:
      return 'time_exit';
  }
}

/**
 * Check every open live options position for an exit trigger and PLACE a real
 * closing order for whichever fires -- the live counterpart to
 * optionsExecute.ts's checkOptionsPaperExits(), which just records a paper
 * close. Two kinds of trigger, shared with paper via the same exitRules.ts
 * engine:
 *
 *   - time-exit (days-to-expiration <= AUTOTRADE_TIME_EXIT_DAYS) -- always on,
 *     quote-free, the original sole automated live options exit.
 *   - stop-loss / take-profit on the configured optionsStopLossPct /
 *     optionsTakeProfitPct (2026-07-26; 0/unset disables each, so an untouched
 *     config keeps the original time-only behavior AND the original provider
 *     load -- no quote is fetched unless a price rule is actually on). For a
 *     debit spread both rules read the NET basis (long mark minus short mark,
 *     at entry and now), the same basis paper P&L already uses. Before this,
 *     the configured stop/take-profit percentages applied to the PAPER book
 *     only -- a live long option could ride to zero with the 7-DTE time exit
 *     as the only automated brake.
 *
 * Evaluation quotes accept a last-trade-only price (unlike an ENTRY, which
 * refuses one): an exit is not optional, and a dying contract's vanishing
 * bid/ask is exactly when the stop most needs to be able to fire --
 * placeLiveOptionsExit already journals stale pricing when it places. A
 * failed or unusable (non-positive basis) quote skips the price rules for
 * that cycle -- never a fabricated trigger -- leaving the time exit as the
 * backstop, retried next cycle.
 *
 * A position with an exit order ALREADY in flight (pending, per
 * listPendingLiveOptionsOrders()) is skipped -- the trigger condition doesn't
 * change within the same day, so without this guard every tick would submit
 * ANOTHER closing order for the same still-open (fill pending) position.
 */
/** Positions whose triggered exit has already been journaled as held by the
 *  CURRENT kill-switch halt — cleared whenever the switch is observed off, so
 *  the next halt journals afresh. In-memory deliberately: this throttles feed
 *  NOISE, not an alert (live_options_exit_blocked is not in FAILURE_ACTIONS),
 *  so a restart re-journaling one extra line per held position is harmless. */
const killSwitchHeldPositions = new Set<number>();

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

    // Fresh config per POSITION (not one snapshot for the sweep), same
    // reasoning as runLiveOptionsExecution()'s own per-candidate refresh (an
    // adversarial review caught this file reusing one stale snapshot here) --
    // this loop awaits real broker round-trips between positions, and a kill
    // switch engaged (or a stop % changed) mid-loop must affect the NEXT
    // position immediately, not just the next cycle. Fetched BEFORE the
    // trigger evaluation now, since the stop/take-profit thresholds
    // themselves come from it.
    const freshCfg = getAutotradeConfig();
    // The ladder needs a mark every cycle regardless of the premium rules:
    // its give-back trail is only as good as the peak it has seen.
    const priceRulesActive =
      freshCfg.optionsStopLossPct > 0 || freshCfg.optionsTakeProfitPct > 0 || freshCfg.shortDatedOptionsEnabled;

    let currentBasis: number | null = null;
    if (priceRulesActive) {
      try {
        if (pos.kind === 'debit_spread') {
          const [longQ, shortQ] = await Promise.all([
            fetchContractQuote(pos.symbol, pos.expiration, pos.strike, pos.side),
            fetchContractQuote(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
          ]);
          const net = longQ.price - shortQ.price;
          // Crossed/stale legs can put the net at or below 0, which would read
          // as a <= -100% "loss" and fire the stop off a quote artifact every
          // cycle (the placement path would then refuse the same numbers as
          // "no usable exit quote" anyway). Non-positive net = no evaluation.
          currentBasis = net > 0 ? net : null;
        } else {
          const q = await fetchContractQuote(pos.symbol, pos.expiration, pos.strike, pos.side);
          currentBasis = validPremium(q.price) ? q.price : null;
        }
      } catch {
        currentBasis = null; // quote unavailable — time exit still evaluates below
      }
    }

    const entryBasis = pos.kind === 'debit_spread' ? pos.entryPrice - (pos.shortEntryPrice ?? 0) : pos.entryPrice;
    // With the short-dated ladder in charge the %-of-premium rules below must
    // go quiet — the ladder owns them, and leaving them live alongside it
    // reintroduces exactly the failure the ladder exists to prevent. At the
    // configured optionsStopLossPct of 40, a stop on the PREMIUM fires on a
    // FLAT tape by early afternoon (the premium is -11% at 10:30 and -63% at
    // 13:30 with the underlying perfectly still), pre-empting the underlying
    // stop that was supposed to be the real one and turning the whole
    // priority order in the spec into a fiction. The ladder's own disaster
    // backstop (optionsDisasterStopPct, ~70) is the premium floor instead.
    // Take-profit goes quiet with it because the ladder already reads
    // optionsTakeProfitPct itself — one rule set, not two racing.
    const ev = evaluateExit(
      { entryPrice: entryBasis, currentPrice: currentBasis, side: 'long', expiration: pos.expiration },
      {
        timeExitDaysBeforeExpiry: timeExitDaysFor(freshCfg),
        stopLossPct: freshCfg.shortDatedOptionsEnabled ? undefined : freshCfg.optionsStopLossPct || undefined,
        takeProfitPct: freshCfg.shortDatedOptionsEnabled ? undefined : freshCfg.optionsTakeProfitPct || undefined,
      },
    );
    // --- INTRADAY time exits (2026-08-25) -------------------------------
    // The only time rule above is exitRules' days-to-expiry, so a 14-60 DTE
    // contract could be held for WEEKS: no stagnation exit, no maxHoldDays, no
    // end-of-day flatten — all three were equity-only. And because options
    // share the concurrent-position budget with equity
    // (eq.openPositionsCount + optPositions.length), one such position could
    // hold half the account's slots for that whole time while the intraday
    // equity strategy that owns the daily target went short of room.
    //
    // A loop whose edge is intraday should not carry ANY position overnight,
    // whichever instrument it is in. These reuse the SAME settings equity
    // already honours rather than adding options-specific ones.
    //
    // Deliberately NOT added here: the stagnation exit. stagnationExit.ts's own
    // header explains why options are excluded — a stagnant long option is
    // already paying for its slot through theta and has its own %-of-premium
    // rules. That reasoning still holds; "held past the close" does not.
    //
    // One deliberate difference from equity's flatten: a position that already
    // has a CLOSING ORDER working is skipped above (pendingExitPositionIds) and
    // is NOT re-priced inside the window the way equity's is. Equity needs that
    // because its exits rest at a 0.5% marketable buffer and can be left behind
    // by the tape (GRMN, 2026-08-25); an options close here is priced 5% through
    // the mark, so a resting one is far likelier to fill than to be stranded —
    // and there is no "cancel a VERTICAL and re-place it" path in this codebase
    // to do the replacement safely. A close that is already working is left to
    // work.
    // --- SHORT-DATED ladder (docs/SHORT_DATED_OPTIONS_SPEC.md) -----------
    // Runs BEFORE the DTE/stop/take-profit rules above have a say, because on
    // a 0-2 DTE contract those rules are the wrong instrument entirely: a
    // %-of-premium stop measures decay rather than the thesis, and the equity
    // flatten fires ~2 hours after being right stops paying. When the flag is
    // off this is inert and the original rules stand unchanged.
    if (freshCfg.shortDatedOptionsEnabled) {
      // A failed quote disables only the rules that need it — the clock in
      // particular must still fire, since a quote outage near the close is
      // exactly when being stuck in a decaying contract is worst.
      //
      // try/catch rather than .catch(): a provider missing getQuote entirely
      // throws SYNCHRONOUSLY, before any promise exists, so a rejection
      // handler never sees it and the whole exit sweep dies. Found by a test
      // provider that only stubbed getOptionsChain.
      const underlying = await quoteOrNull(pos.symbol.toUpperCase());
      const sd = evaluateShortDatedExit(pos, currentBasis, underlying, freshCfg, Date.now());
      // Persist the high-water mark on EVERY tick, not just the ones that
      // exit — a give-back trail that only learns about peaks when it acts is
      // measuring the wrong thing.
      if (sd.peakPremium !== null && sd.peakPremium !== pos.peakPremium) {
        raiseLiveOptionsPeakPremium(pos.id, sd.peakPremium);
      }
      if (sd.exit) {
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'short_dated_options_exit',
          detail: {
            positionId: pos.id,
            rule: sd.rule,
            reason: sd.detail,
            premiumGainPct: sd.premiumGainPct,
            underlyingMovePct: sd.underlyingMovePct,
            expiration: pos.expiration,
          },
          riskProfile: pos.riskProfile,
        });
        const gateCfgSd = buildLiveOptionsTradingConfig(freshCfg);
        if (gateCfgSd.killSwitch) {
          outcomes.push({
            symbol: pos.symbol,
            requested: false,
            reason: 'kill_switch: kill switch is engaged — exit held until released',
          });
          continue;
        }
        const acct = freshCfg.liveAccountId;
        if (!acct) continue;
        // The six rules collapse onto the table's four stored reasons; the
        // precise rule lives in the journal above, which is what the daily
        // read joins on. Widening the CHECK constraint would mean a table
        // rebuild for data one analysis reads.
        const mapped: LiveOptionsExitReason =
          sd.rule === 'take_profit' || sd.rule === 'give_back'
            ? 'take_profit'
            : sd.rule === 'underlying_stop' || sd.rule === 'disaster_stop'
              ? 'stop_loss'
              : 'time_exit';
        outcomes.push(await placeLiveOptionsExit(pos, acct, freshCfg, mapped));
        continue;
      }
    }

    const flatten = evaluateEndOfDayFlatten(freshCfg, Date.now());
    const heldPastMaxDays = freshCfg.maxHoldDays > 0 && Date.now() - pos.entryAt >= freshCfg.maxHoldDays * MS_PER_DAY;
    const intradayTrigger = flatten.active ? 'end_of_day' : heldPastMaxDays ? 'max_hold_days' : null;
    const intradayReason = flatten.active
      ? `flattening ${flatten.minutesLeft}m before the close rather than carrying overnight`
      : heldPastMaxDays
        ? `held past maxHoldDays (${freshCfg.maxHoldDays})`
        : null;

    if (!ev.triggered && !intradayTrigger) continue;
    // Journaled only when an intraday rule is what got us here: a stop-loss or
    // take-profit that fired in the same tick owns the exit and journals its
    // own reason, and two competing explanations for one close is worse than
    // none. Either way the placed order carries exitReason 'time_exit' for an
    // intraday-only trigger, since no price rule chose it.
    if (intradayTrigger && !ev.triggered) {
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'live_options_intraday_exit',
        detail: {
          positionId: pos.id,
          reason: intradayReason,
          trigger: intradayTrigger,
          // Only meaningful for the flatten: FlattenDecision.minutesLeft is
          // minutes-until-close whether or not the window is open, so carrying
          // it on a maxHoldDays close would read as "300m to the bell" on an
          // exit the bell had nothing to do with.
          ...(flatten.active ? { minutesLeft: flatten.minutesLeft } : {}),
          expiration: pos.expiration,
        },
        riskProfile: pos.riskProfile,
      });
    }

    // Kill-switch short-circuit, BEFORE the broker round-trips. Previously a
    // triggered exit during a halt went all the way through placeLiveOptionsExit
    // -- a quote fetch, a broker positions preview, and the account-state fetch
    // (~4 rate-limited HTTP calls) -- only for the kill_switch guardrail to
    // refuse it at the very end, and journaled that refusal EVERY tick
    // (observed: 28 identical events in one ~30-minute halt, crowding the
    // Recent-activity window's fixed size). The switch means "hands off -- the
    // human is trading this account manually" (see the 2026-08-21 note in
    // docs/AUTOTRADING_SPEC.md), so during a halt: spend nothing at the broker,
    // journal the hold ONCE per position per halt, and keep re-evaluating every
    // tick so the close places the moment the switch is released. The reasons
    // string matches what the guardrail path journaled, so feed greps and any
    // downstream readers see a continuous vocabulary.
    const gateCfg = buildLiveOptionsTradingConfig(freshCfg);
    if (!gateCfg.killSwitch) {
      killSwitchHeldPositions.clear(); // halt over (or none) -- next halt journals afresh
    } else {
      if (!killSwitchHeldPositions.has(pos.id)) {
        killSwitchHeldPositions.add(pos.id);
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'live_options_exit_blocked',
          detail: {
            reasons: 'kill_switch: kill switch is engaged — trading halted',
            positionId: pos.id,
            heldOncePerHalt:
              'journaled once for this halt — the exit keeps re-evaluating every tick and places as soon as the switch is released',
          },
          riskProfile: pos.riskProfile,
        });
      }
      // Same rule-prefixed vocabulary the guardrail path used, so outcome
      // consumers (and an existing mid-loop-engage test) match unchanged.
      outcomes.push({
        symbol: pos.symbol,
        requested: false,
        reason: 'kill_switch: kill switch is engaged — exit held until released',
      });
      continue;
    }

    const accountId = freshCfg.liveAccountId;
    if (!accountId) continue; // account cleared mid-loop -- don't use a stale id
    outcomes.push(
      await placeLiveOptionsExit(
        pos,
        accountId,
        freshCfg,
        ev.activeRule ? liveExitReasonFor(ev.activeRule) : 'time_exit',
      ),
    );
  }
  return outcomes;
}

export interface LiveOptionsReconcileOutcome {
  intentId: number;
  symbol: string;
  changed: boolean;
  /** Set when this reconcile materialized a fill into a real
   *  autotrade_live_options_positions row (entry) or closed one (exit).
   *  'exit_partially_filled' means the closing order filled for fewer contracts
   *  than the position holds: the row was shrunk and left OPEN so the remainder
   *  stays tracked and keeps being worked, rather than being closed out from
   *  under contracts that are still held. */
  action?: 'entry_filled' | 'exit_filled' | 'exit_partially_filled';
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
  // One pair of list fetches for the whole set — see webullOrderStatusBatch.
  const statuses = await webullOrderStatusBatch(
    accountId,
    pending.map((p) => intentsById.get(p.intentId)?.idempotencyKey).filter((k): k is string => !!k),
  );
  const outcomes: LiveOptionsReconcileOutcome[] = [];
  for (const meta of pending) {
    const intent = intentsById.get(meta.intentId);
    if (!intent) continue;
    // Absent from the map only if the id was never asked about; treat that as
    // "couldn't ask", never as "the broker has no such order".
    const broker = statuses.get(intent.idempotencyKey) ?? {
      ok: false,
      found: false,
      error: 'no status returned for this order',
    };
    if (!broker.ok) {
      // Couldn't ask — say nothing and try again next tick.
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }
    if (!broker.found) {
      // Resolve an UNKNOWN placement: still 'submitted' with no broker id
      // because we never heard back. Both the open-orders and history endpoints
      // answered and neither knows this client order id, which is positive
      // evidence it never landed — retire it rather than leave it pending
      // forever holding the symbol's dedup slot and its risk. An ACKNOWLEDGED
      // order missing from both landed once and may just have aged out of the
      // history window, so that one is still left alone.
      //
      // Gated on the same grace period equity uses: absence is only evidence
      // once the broker has had time to record the order, and retiring early
      // frees the dedup slot that stops the next cycle re-placing it.
      if (canRetireUnknownPlacement(intent)) {
        transitionIntent(intent.id, 'rejected', {
          detail: 'placement outcome was unknown; broker reports no such order — never reached it',
        });
        logAutotradeEvent({
          symbol: meta.symbol,
          stage: 'execution',
          action: 'live_options_order_never_placed',
          detail: { intentId: intent.id, clientOrderId: intent.idempotencyKey },
          riskProfile: meta.riskProfile,
        });
        outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: true });
        continue;
      }
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }

    const target = broker.status ? mapWebullStatus(broker.status) : undefined;

    // The broker knows this order, so an unknown-outcome placement (left at
    // 'submitted' by placeLiveOptionsOrder's ambiguous branch) is resolved:
    // record the acknowledgement we never received before applying the status,
    // or a FILLED seen straight off an ambiguous place is an illegal transition
    // from 'submitted' and the order sits here forever, never materialized.
    // See ackUnknownPlacement.
    const { intent: current, acked } = ackUnknownPlacement(intent, broker.brokerOrderId);

    // Forward-transition the intent if the broker moved it, and materialize a
    // fresh fill in the same pass.
    const canMove =
      !!target && !isTerminal(current.state) && target !== current.state && canTransition(current.state, target);
    // A contract count resting at `partially_filled` across ticks hasn't changed
    // state but may have filled further.
    const restingPartial = target === 'partially_filled' && current.state === 'partially_filled';
    // Same reasoning as equity's own reconciler: an unrecognized status used to
    // make this a silent no-op, discarding any contracts the broker reported
    // filled alongside it. Book the fill (computeFillDelta's guards make that
    // safe), leave the lifecycle alone, and journal the status once.
    const unrecognizedFill = !!broker.status && target === undefined && (broker.filledQty ?? 0) > 0;
    if (!!broker.status && target === undefined) {
      const noted = recordIntentNoteOnce(
        current.id,
        `broker reported an unrecognized status "${broker.status}" — lifecycle left unchanged, ` +
          `any reported fill is still booked`,
      );
      if (noted) {
        logAutotradeEvent({
          symbol: current.symbol,
          stage: 'execution',
          action: 'live_options_broker_status_unrecognized',
          detail: { intentId: current.id, status: broker.status, filledQty: broker.filledQty ?? 0 },
          riskProfile: meta.riskProfile,
        });
      }
    }
    // A crash on an earlier tick (or a materialization failure before booking
    // and its mark were transactional) can leave a terminal 'filled' intent
    // whose booking never landed. listPendingLiveOptionsOrders keeps
    // re-selecting exactly that shape — but this gate used to turn each
    // re-selection into a no-op: canMove is false once the state is terminal,
    // so the stranded fill was re-polled forever and booked never. Let the
    // fill delta decide instead: computeFillDelta books only what's missing,
    // so a fully-booked filled intent still no-ops while a stranded one
    // finally lands (within one tick of the crash).
    const strandedFilled = current.state === 'filled' && current.materializedQty < current.quantity;
    if (canMove || restingPartial || unrecognizedFill || strandedFilled) {
      if (canMove) {
        transitionIntent(current.id, target!, {
          detail: `broker ${broker.status?.toLowerCase()}`,
          brokerOrderId: broker.brokerOrderId,
        });
      }
      // Materialize whenever the broker REPORTS contracts filled, not only on a
      // terminal `filled`: a partial that gets cancelled between ticks arrives
      // as one CANCELLED response still carrying its filled quantity, and that
      // intent then leaves listPendingLiveOptionsOrders() permanently (its WHERE
      // excludes cancelled/rejected/expired). A terminal FILLED implies the
      // whole order even when the quantity field is absent; any other status
      // with no quantity filled nothing.
      const observedQty = broker.filledQty ?? (target === 'filled' ? current.quantity : 0);
      if (observedQty <= 0) {
        outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: true });
        continue;
      }
      outcomes.push(materializeLiveOptionsFill(current, meta, broker, observedQty));
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
    if (current.state === 'filled' && meta.role === 'exit') {
      outcomes.push(materializeLiveOptionsFill(current, meta, broker));
      continue;
    }

    outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: acked });
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
  observedQty = broker.filledQty ?? intent.quantity,
): LiveOptionsReconcileOutcome {
  const observedPrice = broker.filledPrice ?? intent.limitPrice ?? 0;
  // Book only the contracts not already recorded, under the same shared guards
  // the equity and human paths use (trading/fillDelta.ts) — every ambiguous
  // case there resolves toward recording LESS, never toward inflating a
  // position's size or cost basis.
  const { qty, price, warning } = computeFillDelta(intent, observedQty, observedPrice);
  if (warning) {
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: 'live_options_fill_not_fully_materialized',
      detail: { intentId: intent.id, role: meta.role, observedQty, alreadyBooked: intent.materializedQty, warning },
      riskProfile: meta.riskProfile,
    });
  }
  if (qty <= 0) return { intentId: intent.id, symbol: meta.symbol, changed: true, error: warning };

  try {
    // Booking + the materialization mark commit atomically: a crash between
    // them left the position created with materialized_qty still 0, and the
    // NEXT reconcile's blend guard (`materializedQty > 0`) would then see a
    // first-instalment entry and book a SECOND position for the same real
    // fill — the exact double-booking every guard here exists to prevent.
    // Everything inside is synchronous (verified: no awaits in either
    // materialize path), so a better-sqlite3 transaction is safe.
    // Definite-assignment assertion: the transaction callback runs
    // synchronously before the return below (better-sqlite3), which TS's
    // flow analysis can't see through the closure.
    let action!: ReturnType<typeof materializeOptionsEntryFill> | ReturnType<typeof materializeOptionsExitFill>;
    db.transaction(() => {
      action =
        meta.role === 'entry'
          ? materializeOptionsEntryFill(intent, meta, qty, price)
          : materializeOptionsExitFill(intent, meta, price, qty);
      advanceMaterialized(intent.id, qty, qty * price);
    })();
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
  // A later instalment of an order that already opened a position BLENDS into
  // it — this table holds one row per entry order (its position id is a single
  // column), so a second row would have nothing to link it. Keyed on our own
  // materialization mark, which is only ever advanced after a successful book.
  if (intent.materializedQty > 0 && meta.positionId !== null) {
    const blended = blendLiveOptionsPositionEntry(meta.positionId, filledQty, filledPrice);
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: blended ? 'live_options_position_scaled' : 'live_options_partial_orphaned',
      detail: blended
        ? { positionId: meta.positionId, addQty: filledQty, addPrice: filledPrice, newQuantity: blended.quantity }
        : { positionId: meta.positionId, filledQty, reason: 'position not open at later-instalment fill time' },
      riskProfile: meta.riskProfile,
    });
    return 'entry_filled';
  }

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
    accountId: meta.accountId,
    grade: meta.grade,
    entryScore: meta.entryScore,
    ivRank: meta.ivRank,
    marketRegime: meta.marketRegime,
    marketAtrPct: meta.marketAtrPct,
    underlyingAtEntry: meta.underlyingAtEntry,
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
  filledQty?: number,
): 'exit_filled' | 'exit_partially_filled' | undefined {
  if (meta.positionId === null) return undefined;
  // A partial fill must NOT close the row. This used to ignore the filled
  // quantity entirely and close unconditionally, so a 3-contract exit that
  // filled 1 booked one contract's P&L, marked the position closed, and left
  // 2 real contracts with no ledger row at all — gone from
  // listOpenLiveOptionsPositions, so never re-priced, never re-exited, never
  // reconciled, drifting to expiry while realized P&L was overstated 3x.
  // Equity's materializeTimeExitFill already clamped correctly; this was the
  // outlier.
  if (filledQty !== undefined) {
    const pos = getLiveOptionsPosition(meta.positionId);
    if (pos && filledQty < pos.quantity) {
      const reduced = reduceLiveOptionsPositionQuantity(meta.positionId, filledQty);
      if (!reduced) return undefined;
      logAutotradeEvent({
        symbol: intent.symbol,
        stage: 'execution',
        action: 'live_options_exit_partially_filled',
        detail: {
          positionId: meta.positionId,
          filledQty,
          remainingQty: reduced.quantity,
          filledPrice,
        },
        riskProfile: meta.riskProfile,
      });
      return 'exit_partially_filled';
    }
  }
  const closed = closeLiveOptionsPosition(meta.positionId, {
    exitPrice: filledPrice,
    // A pre-2026-07-16 pending row (from before this column existed) has no
    // stored reason -- time_exit is the only trigger that existed back then,
    // so it's the correct fallback, not a guess.
    exitReason: meta.exitReason ?? 'time_exit',
  });
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
 *
 * Same consecutive-confirmation debounce as equity's closePositionsFromPreview
 * (webull_miss_streak, db/index.ts): a leg missing from a single preview
 * doesn't close anything by itself — an intermittent/incomplete broker
 * response is enough to trigger that — it only acts once the same position
 * has come up short on MISS_CONFIRM_THRESHOLD consecutive syncs.
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

  // Strictly this account's own rows — same conservative stance as equity's
  // closePositionsFromPreview (providers/webull/positions.ts): closing
  // something we're not certain belongs to THIS account is exactly the
  // false-close bug account_id exists to prevent. Deliberately no
  // includeUnassignedAccount here for the same reason.
  const open = listOpenLiveOptionsPositions({ accountId });
  const closedSymbols = new Set<string>();
  let closed = 0;
  for (const pos of open) {
    // Keyed per-position (not per-contract): each open row closes as a whole,
    // never FIFO-split like equity's lots, so there's no reason to share a
    // streak across two different positions that happen to reuse a contract.
    const streakKey = `opt:${pos.id}`;
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
      if (longHeld) {
        clearMissStreak(accountId, streakKey);
        continue; // still held at the broker
      }
      // Missing from THIS preview — don't act on a single miss; a single
      // incomplete/flaky preview response is enough to trigger one. Require
      // MISS_CONFIRM_THRESHOLD consecutive misses first — see
      // webull_miss_streak's table comment (db/index.ts) for the flapping
      // bug this guards against (equity's closePositionsFromPreview hit the
      // same shape).
      if (bumpMissStreak(accountId, streakKey) < MISS_CONFIRM_THRESHOLD) continue;
      const exitPrice = await safeContractMark(pos.symbol, pos.expiration, pos.strike, pos.side);
      if (exitPrice == null) continue; // can't price it — leave open, retry next sync
      if (closeLiveOptionsPositionFromBroker(pos, exitPrice, null)) {
        closed++;
        closedSymbols.add(pos.symbol);
        clearMissStreak(accountId, streakKey);
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
    if (longHeld || shortHeld) {
      clearMissStreak(accountId, streakKey);
      continue;
    }
    if (bumpMissStreak(accountId, streakKey) < MISS_CONFIRM_THRESHOLD) continue;

    const [longExit, shortExit] = await Promise.all([
      safeContractMark(pos.symbol, pos.expiration, pos.strike, pos.side),
      safeContractMark(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
    ]);
    if (longExit == null || shortExit == null) continue; // can't price both legs — leave open, retry next sync
    if (closeLiveOptionsPositionFromBroker(pos, longExit, shortExit)) {
      closed++;
      closedSymbols.add(pos.symbol);
      clearMissStreak(accountId, streakKey);
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
    // A last-trade fallback is fine here, unlike the order paths above: this
    // values a position for display and close-detection, it doesn't set a price
    // anything gets submitted at.
    return (await fetchContractQuote(symbol, expiration, strike, side)).price;
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
