import { config } from '../../config';
import { strategyDayFor } from './dailyResults';
import { dayLossBudgetUsd, dayStartEquityUsd } from './dayLossBudget';
import { db } from '../../db';
import { AutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import {
  AccountState,
  evaluateGuardrails,
  OrderIntent,
  blockingFailures,
  TradingConfig,
  withinDailyOrderCap,
  wouldOpenShort,
} from '../trading/guardrails';
import { marketOpenContext, minutesIntoSession } from '../trading/marketHours';
import {
  webullAccountState,
  type OrderInstrument,
  type WebullAccountStateResult,
} from '../../providers/webull/accountState';
import {
  newClientOrderId,
  webullPlaceOrder,
  webullOrderStatus,
  webullOrderStatusBatch,
  webullCancelOrder,
  listWebullOpenOrders,
  webullReplaceOrder,
  webullReplaceOrders,
  webullPlaceStandaloneBracket,
  protectiveBracketIntent,
  isExitLeg,
  exitLegKind,
  isOptionOrder,
  buildBracketResizePatches,
  WebullOpenOrder,
} from '../../providers/webull/orders';
import { ackUnknownPlacement, canRetireUnknownPlacement, canStillFill, mapWebullStatus } from '../trading/reconcile';
import { computeFillDelta } from '../trading/fillDelta';
import { legExitReason } from '../exitPriceBackfill';
import {
  advanceMaterialized,
  createIntent,
  transitionIntent,
  countTodaysOrders,
  getIntent,
  getIntents,
  recordIntentNoteOnce,
  OrderIntentRecord,
} from '../../db/orders';
import { canTransition, isTerminal, positionsWithWorkingClose } from '../trading/orderLifecycle';
import {
  recordLiveOrder,
  recordLiveExitOrder,
  recordLiveAddOnOrder,
  countLiveAddOns,
  setLiveOrderPositionId,
  listPendingLiveOrders,
  countLiveOrdersSince,
  pendingLiveOrdersRisk,
  getLiveOrder,
  getLiveEntryOrderForPosition,
  entryIntentIdForPosition,
  setLiveOrderLegClientOrderIds,
  BracketLegIds,
  LiveOrderMeta,
} from '../../db/autotradeLiveOrders';
import { missStreakBrokerQty, missStreakOf } from '../../db/webullMissStreak';
import { contractKey } from '../../providers/webull/positions';
import { computeScaleIn } from './scaleIn';
import { checkSessionWindow } from './executionGuards';
import { computeEquityCurveDerisk } from './equityCurveDerisk';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { computeMethodMultipliers, methodOfEquitySignal } from './methodSizing';
import { activeSymbolCooldowns } from './symbolCooldown';
import { declinedSide, journalDeclinedEntry } from './declinedEntry';
import {
  MarketDirectionReading,
  directionRefuses,
  latestMarketDirection,
  liveShortPermitted,
  ShortRefusalCause,
} from './marketDirection';
import { isUnparseableSymbolError, markUnplaceableSymbol, unplaceableReason } from './unplaceableSymbols';
import { markShortRefused, shortRefusedReason } from './refusedShorts';
import { computeFinishLineFactor } from './finishLine';
import { regimeAdjustedTargets } from './regimeTargets';
import { liveEntryScoreGate } from './entryScoreGate';
import {
  cutFactor,
  NO_TICK_REGIME,
  preFinishLineFactors,
  preFinishLineRiskPct,
  regimeStamp,
  TickRegime,
} from './effectiveRisk';
import { evaluateStagnation, type SlotPressure } from './stagnationExit';
import { classifySecondBracketRefusal, lotTargetPrice, splitEntryForPerLot } from './perLotBrackets';
import { claimOncePerDay } from './oncePerDayEvents';
import {
  FilledBracketLegCandidate,
  resolveFilledLegsFromOrderDetail,
  resolveUnlistedFromOrderDetail,
} from './orderDetailFallback';
import { evaluateEndOfDayFlatten, evaluateEntryCutoff } from './endOfDayFlatten';
import { evaluateStopAdjust } from './stopAdjust';
import { evaluateScaleOut } from './scaleOut';
import { cancelOrderForLegs, stopWasCancelled, verifyLegsGone, verifyLegsResized } from './cancelReplace';
import { attributeByEntryOrder, groupExitLegsByCombo, isSingleBracket, summarizeGroups } from './bracketGroups';
import {
  resizeAttemptSignature,
  shouldSkipResize,
  recordResizeRefusal,
  clearResizeLatch,
  pruneResizeLatches,
} from './resizeRetryLatch';
import { fetchTodaySessionContext } from './vwap';
import { evaluateAbsorbedPrice } from './absorbedPrice';
import { evaluateEntryExtension, REFERENCE_MAX_PCT_OF_RANGE, REFERENCE_MAX_VWAP_EXT_PCT } from './entryExtension';
import { detectLevels } from '../../indicators/levels';
import { reentryCooldownFor, sameDaySymbolExits } from './reentryCooldown';
import { etToday } from '../../util/marketDate';
import { atr } from '../../indicators/indicators';
import { planAroundLevels } from './levelPlan';
import { MARKETABLE_LIMIT_BUFFER_PCT } from './marketableLimit';
import { buyingPowerBasis, type BuyingPowerBasis } from './buyingPowerBasis';
import {
  ceilingCappedQuantity,
  isInsufficientBuyingPowerError,
  learnedOpenNotionalCeiling,
  markBuyingPowerAccepted,
  markBuyingPowerRefusal,
} from './buyingPowerRefusals';
import { entryDriftPct, orderRiskAmount, riskBasisPrice, riskCappedQuantity } from './entryRisk';
import { applyExternalCashFlow, evaluateDailyTarget } from './dailyTarget';
import { evaluateEquitySync, freshEquityGuardState, EquityGuardState } from './equitySyncGuard';
import { getDailyBaseline } from '../../db/dailyBaseline';
// DB-layer reads only (NOT the options execution service) -- so the combined
// live budget can fold in the options book without a liveExecute <-> options
// service import cycle.
import { pendingLiveOptionsOrdersRisk } from '../../db/autotradeLiveOptionsOrders';
import { listLiveOptionsPositions, listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import type { LiveOptionsRiskSeed } from './liveOptionsExecute';
import { liveExposureCapUsd } from './liveCaps';
import {
  createPosition,
  getPosition,
  listKnownAccountIds,
  listPositions,
  updatePosition,
  addExit,
  Position,
  ratchetPositionStop,
  updatePositionBestPrice,
} from '../../db/positions';
import { realizedPnlOf, initialRiskOf, openRiskOf, computeStreaksAndDrawdown, tradesEnteredOn } from '../pnl';
import { etTimeOfDay } from '../../util/marketDate';
import { TradeSignal, convictionGrade } from './decide';
import {
  RiskCheckContext,
  RiskCheckResult,
  correlatedNotional,
  sectorNotional,
  buildSectorOf,
  dailyHaltVerdict,
  evaluateRiskCheck,
} from './riskCheck';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { getProvider } from '../../providers';
import { dispatchAutotradeNotification } from './notify';
import { UnprotectedReportState, unprotectedReportState } from './unprotectedReport';
import { liveDrawdownHaltedOn } from './dailyHaltMarker';
import { takeRowLimit } from '../../db/rowLimit';
import { atrReachRefuses } from './atrReach';

// ---------------------------------------------------------------------------
// The LIVE counterpart to execute.ts's paper execution (Phase 8 — see
// docs/AUTOTRADING_SPEC.md's Phase 8 design). Every order here IS submitted
// to the real Webull account. Deliberately NOT a modification of execute.ts —
// paper execution (autotrade_paper_positions) keeps running unmodified
// alongside this, as an ongoing live-vs-paper sanity check.
//
// Reuses the SAME lower-level pieces the human-confirmed Trade page's
// placeOrder() uses (guardrails, webullPlaceOrder, the order lifecycle) but
// does NOT call placeOrder() itself and has no `confirmation` parameter —
// placeOrder()'s type-to-confirm phrase is a pure function of the order
// (`${side} ${quantity} ${symbol}`), so an automated caller could trivially
// compute and pass it, but doing so would be hollow (confirming its own
// order proves nothing). Per the confirmed Phase 8 design, the ONLY gates
// here are: TRADING_ENABLED (env, checked by the caller's config wiring —
// see loop.ts Step C), liveTradingEnabled, both kill switches, and the
// guardrails — no per-order confirmation of any kind.
//
// Entries are placed as BRACKET orders (LIMIT entry + linked STOP_LOSS +
// linked STOP_PROFIT) so the stop/target are enforced by the BROKER directly,
// not by this loop noticing a quote breach on its next tick — categorically
// safer for real money than execute.ts's polling approach, which paper had no
// alternative to (there's no real broker in a simulation to enforce anything).
// The entry leg is DAY; the two exit legs are GTC (providers/webull/orders.ts's
// bracketExit()) — an exit protecting an already-open position has to outlive
// one trading session, unlike a still-unfilled entry. Fixes a real gap this
// had until 2026-07-13: at DAY, an exit that didn't fill by the close got
// cancelled by the broker with nothing here noticing or re-arming it, leaving
// the position open with literally no resting stop. GTC isn't unlimited
// either — Webull auto-expires it after 90 calendar days — so maxHoldDays
// (below) is still worth setting as a backstop, just no longer the only thing
// standing between an open position and an entire trading day of zero
// downside protection. Options can't use the same fix — see
// optionBracketExit()'s own doc comment for why.
// ---------------------------------------------------------------------------

/** Effective per-share/contract notional multiplier for a marketable limit —
 *  a LIMIT order priced this far beyond the last quote all but guarantees a
 *  fill without being a de facto unpriced market order (options don't support
 *  MARKET at all; guardrails.ts blocks it). */
// The constant itself now lives in marketableLimit.ts — the edge-leak scan
// needs it to read its own slippage rows, and two copies of a number that
// decides what a fill is measured against is the divergence CLAUDE.md's
// "agree by construction" rule exists to stop.

// buyingPowerBasis moved to its own leaf module on 2026-09-14 so the tune
// preview's funding warning can call the SAME derivation the live sizer does.
// Re-exported here because the journal writers below and the tests both reach
// for it through this module.
export { buyingPowerBasis };
export type { BuyingPowerBasis };

/** Today's session high-low for `symbol`, in price units, or null when the
 *  provider could not say. Reads the SAME cached context entryExtension uses
 *  later on the entry that proceeds, so the gate and the journal can never
 *  describe two different sessions. */
async function sessionRangeUsdFor(symbol: string): Promise<number | null> {
  const range = (await fetchTodaySessionContext(symbol)).range;
  if (!range || !Number.isFinite(range.high) || !Number.isFinite(range.low)) return null;
  return Math.max(0, range.high - range.low);
}

function withDayBuyingPower(state: AccountState, cfg: AutotradeConfig, accountId: string): AccountState {
  const learned = learnedOpenNotionalCeiling(accountId, etToday());
  return { ...state, buyingPowerUsd: buyingPowerBasis(state, cfg, learned?.ceilingUsd).usedUsd };
}

/**
 * Re-point the guardrail layer's daily-loss input at the LOOP's own realized
 * day (2026-09-15).
 *
 * `AccountState.realizedPnlTodayUsd` is deliberately account-wide — the worse
 * of the broker's day-minus-unrealized and EVERY exit our journal dates today,
 * `webull`-tagged operator rows included. That is the right input for a hand
 * order on the Trade page, which is why it stays that way there, and the wrong
 * one for `daily_loss_halt` on this path: it lets a trade the operator placed
 * themselves halt the loop's entries. Exactly the correction PR #610 made to
 * dailyTarget on 2026-09-14 — whose note checked riskCheck's percentage halt
 * and found it already loop-scoped, and never looked at this dollar twin, the
 * TIGHTER of the two and therefore the one that decides.
 *
 * `strategyDayFor` is the one derivation dailyTarget and the results calendar
 * already share (live stock closes + live options closes, autotrade-tagged),
 * so all three now halt on the same number rather than on three readings that
 * agree by coincidence.
 */
export function withLoopRealizedToday(state: AccountState, now: number = Date.now()): AccountState {
  return { ...state, realizedPnlTodayUsd: strategyDayFor(etToday(now)).pnlUsd };
}

/** Combine the autotrade-specific live caps with BOTH kill switches — the
 *  human Trade page's own (since live orders share the same real broker
 *  account) and autotrade's own. Either being engaged, or either "enabled"
 *  toggle being off, blocks new live orders. This is a defense-in-depth
 *  default, not something explicitly requested — see the Phase 8 "additional
 *  safety layer" resolved decision in the spec. */
export function buildLiveTradingConfig(autotradeCfg: AutotradeConfig): TradingConfig {
  const humanCfg = getTradingConfig();
  const dayStart = dayStartEquityUsd(getDailyBaseline(), etToday(), autotradeCfg.accountEquityUsd ?? 0).usd;
  return {
    enabled: humanCfg.enabled && autotradeCfg.liveTradingEnabled,
    killSwitch: humanCfg.killSwitch || autotradeCfg.killSwitch,
    maxOrderUsd: autotradeCfg.liveMaxOrderUsd,
    // Autotrade trades many different symbols at risk-based sizing, not one
    // known symbol a human is looking at — a raw share-count cap doesn't
    // scale sensibly across differently-priced symbols the way maxOrderUsd's
    // notional cap already does, so this check is effectively disabled here
    // rather than duplicating a backstop maxOrderUsd already provides.
    maxSymbolPositionQty: Number.MAX_SAFE_INTEGER,
    // liveMaxExposurePct % of configured equity. This was pinned at exactly
    // 100% on the reasoning that a cash account cannot hold more gross
    // exposure than its own equity — true, and it left no headroom at all:
    // on 2026-08-27 two correctly-sized positions summed to $2,284 against a
    // $2,283.61 cap and the second was refused by 39 cents. One shared helper
    // since 2026-09-18: the options sleeve's twin had stayed at 100% (see
    // liveCaps.ts). Still 0 when equity is unset, which fails closed.
    maxExposureUsd: liveExposureCapUsd(autotradeCfg),
    // Counts THIS sleeve's opening orders only (countTodaysOrders' own note).
    maxOrdersPerDay: autotradeCfg.liveMaxOrdersPerDay,
    // The day's loss budget, derived from the SAME function and the SAME
    // day-opening equity `riskCheck`'s percentage halt and the +3% goal use —
    // not the stored `liveMaxDailyLossUsd`, which is re-derived from whatever
    // net liquidation last re-anchored the caps. liveCaps.ts has always
    // described the two as agreeing "exactly"; they did not, and the stored
    // cap was the tighter, so it was the one that decided. On 2026-09-15 the
    // goal was 3% of a $3,694.39 baseline ($110.83) while this cap was $44 —
    // a day the loop could not win without first being stopped.
    //
    // `liveMaxDailyLossUsd` keeps its other jobs (the human Trade page's cap,
    // the dashboard, the tuner's suggestion). Nothing is loosened that
    // `maxDailyDrawdownPct` did not already permit: the percentage halt in
    // riskCheck reads the same budget and blocks first.
    maxDailyLossUsd: dayLossBudgetUsd(autotradeCfg.maxDailyDrawdownPct, dayStart),
    fatFingerPct: autotradeCfg.liveFatFingerPct,
    allowNakedShort: autotradeCfg.liveAllowNakedShort,
  };
}

export interface ProbationStatus {
  active: boolean;
  /** Effective risk-% multiplier to apply on top of the profile's normal
   *  sizing (and any loss-streak step-down already active) — 1 when not in
   *  probation. */
  multiplier: number;
  tradesPlaced: number;
  tradesRemaining: number;
}

/** Whether autotrade is still within its post-enable probation window, and
 *  the size cut to apply if so. Derived from REAL order_intents created
 *  at/after liveEnabledAt — never a separately-incremented counter that could
 *  drift from what was actually placed (see db/autotradeLiveOrders.ts). */
export function getProbationStatus(cfg: AutotradeConfig): ProbationStatus {
  if (!cfg.liveEnabledAt)
    return { active: false, multiplier: 1, tradesPlaced: 0, tradesRemaining: cfg.liveProbationTrades };
  const tradesPlaced = countLiveOrdersSince(cfg.liveEnabledAt);
  const active = tradesPlaced < cfg.liveProbationTrades;
  return {
    active,
    multiplier: active ? cfg.liveProbationSizeMultiplier : 1,
    tradesPlaced,
    tradesRemaining: Math.max(0, cfg.liveProbationTrades - tradesPlaced),
  };
}

/** The SHORT probation (2026-09-24, the tape plan's PR 9): whether the first
 *  live stock shorts after shorts were switched on are still being sized
 *  down, and by how much. The same derivation as getProbationStatus, over the
 *  short ENTRIES placed since liveShortsEnabledAt (countLiveOrdersSince with
 *  side 'sell'), so a long never spends a short's window, nor the reverse. */
export function getShortProbationStatus(cfg: AutotradeConfig): ProbationStatus {
  if (!cfg.liveShortsEnabledAt)
    return { active: false, multiplier: 1, tradesPlaced: 0, tradesRemaining: cfg.liveShortProbationTrades };
  const tradesPlaced = countLiveOrdersSince(cfg.liveShortsEnabledAt, 'sell');
  const active = tradesPlaced < cfg.liveShortProbationTrades;
  return {
    active,
    multiplier: active ? cfg.liveShortProbationSizeMultiplier : 1,
    tradesPlaced,
    tradesRemaining: Math.max(0, cfg.liveShortProbationTrades - tradesPlaced),
  };
}

/** The probation cut a live ENTRY takes: the book's window, times the short
 *  window for a short. One number, read by both the quantity and the risk
 *  budget in attemptLiveEntry, so the two cannot size the same order
 *  differently. `short` is null for a long. */
export function entryProbation(
  cfg: AutotradeConfig,
  side: 'buy' | 'sell',
): { multiplier: number; book: ProbationStatus; short: ProbationStatus | null } {
  const book = getProbationStatus(cfg);
  const short = side === 'sell' ? getShortProbationStatus(cfg) : null;
  return { multiplier: book.multiplier * (short?.multiplier ?? 1), book, short };
}

/** Today's date (YYYY-MM-DD) in US/Eastern — same convention as execute.ts's
 *  etDateStr(), duplicated rather than imported since execute.ts's version
 *  isn't exported (kept local to that file) and this is a one-line function. */
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

/**
 * The entry stamp an ADOPTED position is owed, or null when it already has one.
 *
 * A position autotrade opened can reach the `positions` table by a route that
 * cannot know when it was opened. The Webull position-sync backstop imports an
 * aggregate of current holdings — a quantity and an AVERAGE cost — so it
 * deliberately records `entry_date` as NULL rather than stamping the import
 * date over an unknown (see mapWebullPosition's own comment; that decision is
 * right for a generic import). But when AUTOTRADE adopts such a row it is no
 * longer unknown: we placed the order, and its placement moment is on the
 * order record. The importer is honest about not knowing; the adopter knew all
 * along and never wrote it down.
 *
 * The cost was silent. getLivePortfolioSnapshot() counts `p.entryDate === today`
 * for tradesToday, so a null makes a position invisible to maxTradesPerDay —
 * and since EVERY live entry currently reaches the table through adoption, the
 * cap was counting zero all along. On 2026-08-31 five entries were placed
 * against a cap of four, with only liveMaxOrdersPerDay (which counts order
 * rows, not positions) actually binding. The same null also drops the trade
 * from that function's equity-curve de-risk history, which filters undated
 * trades out, and empties the Journal's time-of-day session buckets, which
 * read entry_time. Same shape as the initial_stop_price gap PR #432 fixed: the
 * create path sets it, adoption forgot to.
 *
 * Dated from the ORDER's placement moment, exactly as materializeEntryFill's
 * create path dates a fresh fill and for the same reason — see its comment on
 * why a reconcile pass's wall clock drifts every entry later than it happened.
 *
 * `??` per field: an adopted position that already carries a stamp keeps it.
 * This heals a gap, it never overwrites a known truth. Shared by BOTH adoption
 * paths (adoptOrphanedLivePositions and materializeEntryFill) so the two cannot
 * drift into disagreeing about how an adopted entry is dated — either can run
 * first, and whichever gets there stamps the same values.
 */
function entryStampPatch(
  p: Pick<Position, 'entryDate' | 'entryTime'>,
  placedAtMs: number,
): { entryDate: string; entryTime: string } | null {
  if (p.entryDate !== null && p.entryTime !== null) return null;
  return {
    entryDate: p.entryDate ?? etDateStr(placedAtMs),
    entryTime: p.entryTime ?? etTimeOfDay(placedAtMs),
  };
}

const AUTOTRADE_TAGS = ['live', 'autotrade'];
export const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

/** The position an order's fill opens: a buy opens a long, a sell (a short
 *  sale) opens a short. ONE mapping for the create path and both adoption
 *  paths, so the row a fill creates and the row a fill may adopt cannot
 *  disagree about which side it is on. */
export const positionSideOf = (orderSide: 'buy' | 'sell'): 'long' | 'short' => (orderSide === 'buy' ? 'long' : 'short');

/**
 * The account, with `currentPositionQty` counting SHARES of `symbol` and
 * nothing else (2026-09-23).
 *
 * Asked without an instrument, webullAccountState sums every position on the
 * symbol, stock and option contracts alike (accountState.ts, matchesInstrument:
 * "legacy: per-underlying aggregate"). The manual order paths have passed their
 * instrument since that was found, and the options sleeve feeds the guardrails
 * its own ledger quantity; this sleeve asked for the aggregate at all six of its
 * reads. Its options sleeve trades the same names, so the number was wrong
 * whenever the two overlapped (CRWD 10:13-10:31 and MRNA 09:37 on 2026-09-23),
 * and wrong in the direction that matters:
 *
 *  - the protection sweep reads "the broker holds 0" as closed, not naked. With
 *    a stop just filled and three calls still held it read 3: it would page the
 *    position as naked and send a re-arm, or a close through the stop, for 3
 *    shares nobody held. Those go out as SELL, not SHORT, so the broker should
 *    refuse them rather than open a short — but that leaves the broker's refusal
 *    as the only thing in the way;
 *  - every sell this sleeve places is checked by the naked_short guardrail
 *    (current + delta < 0 blocks), and the contracts padded `current`. That rule
 *    exists so that no sell depends on the broker refusing it.
 *
 * One helper, so a seventh read cannot be written the old way by accident;
 * configReachability-style, a test scans this file for a two-argument call.
 */
const STOCK_SHARES: OrderInstrument = { assetKind: 'stock' };
function stockAccountState(accountId: string, symbol: string): Promise<WebullAccountStateResult> {
  return webullAccountState(accountId, symbol, STOCK_SHARES);
}

export interface LivePortfolioSnapshot {
  today: string;
  openPositions: Position[];
  openRisk: number;
  openPositionsCount: number;
  dailyPnl: number;
  consecutiveLosses: number;
  tradesToday: number;
  /** Equity-curve de-risk decision from the live book's own realized curve
   *  (2026-07-24) — false when disabled or above the average. */
  equityCurveDeriskActive: boolean;
  /** grade → sizing multiplier from the live book's realized per-grade edge
   *  (2026-07-24); empty when expectancy weighting is off. */
  gradeExpectancyMultipliers: Record<string, number>;
  /** method → sizing multiplier from recent per-method realized edge
   *  (methodSizing.ts); empty when method weighting is off. */
  methodMultipliers: Record<string, number>;
}

/** The real-money counterpart to execute.ts's getPaperPortfolioSnapshot() —
 *  same shape and math, read from the human `positions` table filtered to
 *  autotrade's own tag, not autotrade_paper_positions. Real position P&L math
 *  (realizedPnlOf/initialRiskOf) is reused from services/pnl.ts unchanged —
 *  the same functions the human Journal's own stats already use. */
export function getLivePortfolioSnapshot(): LivePortfolioSnapshot {
  const today = etDateStr();
  const openPositions = listPositions({ status: 'open' }).filter(isAutotradePosition);
  const closedAutotrade = listPositions({ status: 'closed' }).filter(isAutotradePosition);

  const closedTodayChrono = closedAutotrade
    .filter((p) => p.exits.some((e) => e.exitDate === today))
    .sort((a, b) => (a.exits[0]?.createdAt ?? 0) - (b.exits[0]?.createdAt ?? 0));
  const closedPnlsChrono = closedTodayChrono.map((p) => realizedPnlOf(p));
  const dailyPnl = closedPnlsChrono.reduce((s, p) => s + p, 0);
  const { currentStreak } = computeStreaksAndDrawdown(closedPnlsChrono);
  const consecutiveLosses = currentStreak.type === 'loss' ? currentStreak.count : 0;

  const tradesToday = tradesEnteredOn(openPositions, today) + tradesEnteredOn(closedAutotrade, today);
  // Current risk, not the frozen R denominator: a ratcheted stop really has
  // reduced exposure, and shares sold in a scale-out are no longer at risk.
  // See openRiskOf vs initialRiskOf in services/pnl.ts.
  const openRisk = openPositions.reduce((s, p) => s + (openRiskOf(p) ?? 0), 0);

  // Equity-curve de-risk from the live book's OWN full realized history — the
  // cumulative curve, dated by each trade's last exit, the MA filter needs.
  const config = getAutotradeConfig();
  const closedHistory = closedAutotrade
    .map((p) => ({
      date: p.exits.length
        ? p.exits
            .map((e) => e.exitDate)
            .sort()
            .slice(-1)[0]
        : p.entryDate,
      pnl: realizedPnlOf(p),
    }))
    // Undated trades have no place on a chronological curve — dropped rather
    // than anchored to a guessed date (see db/positions.ts on why entryDate
    // can be null at all).
    .filter((t): t is { date: string; pnl: number } => t.date !== null);
  const equityCurveDeriskActive = computeEquityCurveDerisk(closedHistory, {
    enabled: config.equityCurveDeriskEnabled,
    lookbackDays: config.equityCurveLookbackDays,
    cutPct: config.equityCurveDeriskCutPct,
  }).active;

  // Per-grade expectancy multipliers from the live book's OWN closed trades.
  const gradeExpectancyMultipliers = computeGradeExpectancyMultipliers(
    closedAutotrade.flatMap((p) => {
      const risk = initialRiskOf(p);
      return risk && risk > 0 ? [{ grade: p.grade, realizedR: realizedPnlOf(p) / risk }] : [];
    }),
    {
      enabled: config.expectancyWeightingEnabled,
      minTrades: config.expectancyMinTrades,
      minMultiplier: config.expectancyMinMultiplier,
      maxMultiplier: config.expectancyMaxMultiplier,
    },
  );

  return {
    today,
    openPositions,
    openRisk,
    openPositionsCount: openPositions.length,
    dailyPnl,
    consecutiveLosses,
    tradesToday,
    equityCurveDeriskActive,
    gradeExpectancyMultipliers,
    methodMultipliers: computeMethodMultipliers(
      closedAutotrade,
      config,
      listLiveOptionsPositions({ status: 'closed' }),
    ),
  };
}

/**
 * The COMBINED live open risk + position count across BOTH the equity and
 * options books, counting every materialized open position PLUS every
 * placed-but-not-yet-materialized order (working, or filled-not-yet-reconciled).
 *
 * "One real account, one combined budget" — and critically, a live fill only
 * becomes a position row on a LATER reconcile tick, so an order placed earlier
 * in THIS tick has no position row yet. The two execution batches run
 * sequentially within one tick (equity then options, loop.ts); seeding each
 * batch's running risk/count from this figure — instead of a position-only
 * snapshot — stops the second batch from re-spending headroom the first already
 * committed (which let combined open risk reach ~2× maxAggregateOpenRiskPct and
 * 2× maxConcurrentPositions). Position rows and pending-order rows never
 * overlap (a pending row's position_id is NULL until it materializes, at which
 * point it's counted as a position instead), so there's no double-count.
 */
export function combinedLiveOpenRisk(): { risk: number; count: number } {
  const eq = getLivePortfolioSnapshot(); // open equity positions
  const optPositions = listOpenLiveOptionsPositions();
  const pendingEq = pendingLiveOrdersRisk();
  const pendingOpt = pendingLiveOptionsOrdersRisk();
  const optPositionsRisk = optPositions.reduce((s, p) => s + p.riskAmount, 0);
  return {
    risk: eq.openRisk + optPositionsRisk + pendingEq.risk + pendingOpt.risk,
    count: eq.openPositionsCount + optPositions.length + pendingEq.count + pendingOpt.count,
  };
}

/**
 * Heal a position autotrade genuinely opened but that ended up NOT tagged
 * 'autotrade', via either of two known routes:
 *
 * 1. The generic Webull position-sync backstop (providers/webull/positions.ts's
 *    importFromPreview, tagged ['webull'] only) beat reconcileOneLiveOrder()
 *    to observing the fill and imported the real holding as an untracked
 *    position — no sourceIntentId (that backstop doesn't set one), matched
 *    below by SYMBOL against a still-pending entry order.
 * 2. The GENERIC, human-Trade-page-shaped order reconcile
 *    (services/trading/reconcile.ts's reconcileIntent/recordFillAsPosition)
 *    observed the fill FIRST — reachable for an autotrade-placed order too,
 *    since order_intents carries no "who placed this" column — and tagged the
 *    resulting position plain ['live'], WITH sourceIntentId set (that path
 *    does set it). Once that generic path transitions the intent to the
 *    terminal 'filled' state, reconcileOneLiveOrder()'s own
 *    `!isTerminal(intent.state)` guard permanently locks autotrade's own
 *    reconcile out of ever reaching this intent again — reconcileIntent() now
 *    refuses to touch an autotrade-owned intent at all (fixed at the source),
 *    but that fix doesn't retroactively heal a position ALREADY stuck this
 *    way, which is what this branch is for. Matched below by sourceIntentId
 *    (exact, since it's already set correctly) rather than symbol.
 *
 * A position stuck either way is invisible to isAutotradePosition() — the Auto
 * page's live-positions table, and getLivePortfolioSnapshot()'s own
 * aggregate-risk/P&L accounting — even though it's real capital the loop
 * itself is responsible for. runLiveExecution()'s skipSymbols check (above)
 * is already broadened to not place a DUPLICATE order against it regardless
 * of tag, so this function is about healing the bookkeeping, not preventing
 * a double-entry — that's already covered.
 *
 * Retags the matched position and backfills a missing stop/target from the
 * order's own intended levels, and links autotrade_live_orders.positionId —
 * needed here (unlike historically for route 1's orphans, which used to rely
 * on materializeEntryFill() to link it once reconcile caught up) because
 * route 2's intent is terminal and will NEVER be revisited by
 * reconcileOneLiveOrder() again to do that linking itself. Harmless to also
 * do eagerly for route 1. Runs every tick (not just right after a fresh
 * import), so it also heals any position already stuck before this existed,
 * not just new ones going forward.
 */
export function adoptOrphanedLivePositions(): { adopted: number } {
  // SHARES only (2026-09-23). Every pending order this can match is a stock
  // entry, and the generic sync imports the options sleeve's contracts here too
  // — untagged, under the UNDERLYING's symbol — so a symbol-only match could
  // hand a stock order an option row. See materializeEntryFill for the day it
  // did.
  const orphans = listPositions({ status: 'open' }).filter(
    (p) =>
      p.assetType === 'stock' &&
      !isAutotradePosition(p) &&
      (p.tags.includes('webull') || (p.tags.includes('live') && p.sourceIntentId !== null)),
  );
  if (orphans.length === 0) return { adopted: 0 };
  const pendingEntries = listPendingLiveOrders().filter((o) => o.role === 'entry' && o.positionId === null);
  if (pendingEntries.length === 0) return { adopted: 0 };
  // THE SAME SIDE (2026-09-23, shorts pre-flight). A buy fills a long and a
  // short sale fills a short, so an order can only be the fill of a holding on
  // its own side. Matching on the symbol alone would hand a live short order
  // the operator's own long in the name (or a long order their short) and book
  // its P&L with the sign reversed.
  const intentSides = getIntents(pendingEntries.map((o) => o.intentId));
  const sameSide = (o: { intentId: number }, p: { side: 'long' | 'short' }): boolean => {
    const side = intentSides.get(o.intentId)?.side;
    return side !== undefined && positionSideOf(side) === p.side;
  };

  let adopted = 0;
  for (const p of orphans) {
    const match =
      p.sourceIntentId !== null
        ? // Exact order-to-order link — no cross-account ambiguity possible.
          pendingEntries.find((o) => o.intentId === p.sourceIntentId && sameSide(o, p))
        : // Symbol-only match — could otherwise link a pending order for account A
          // to an orphan actually held in account B if both trade the same symbol
          // around an account switch. Require agreement when both sides know
          // their account; a null on either side (legacy data) still matches, same
          // permissive-for-linking-not-closing stance as positions.ts's own
          // includeUnassignedAccount.
          pendingEntries.find(
            (o) =>
              o.symbol === p.symbol &&
              sameSide(o, p) &&
              (o.accountId == null || p.accountId == null || o.accountId === p.accountId),
          );
    if (!match) continue;
    // One order, one holding (2026-09-23). The list is read once, before the
    // loop, and a match used to stay in it — so two untagged rows on one symbol
    // (a hand-bought lot imported beside the loop's own fill) were BOTH adopted
    // by the same order, and the second link overwrote the first. The order that
    // just matched is spoken for.
    pendingEntries.splice(pendingEntries.indexOf(match), 1);
    updatePosition(p.id, {
      tags: Array.from(new Set([...p.tags, ...AUTOTRADE_TAGS])),
      stopPrice: p.stopPrice ?? match.stopPrice,
      targetPrice: p.targetPrice ?? match.targetPrice,
      // Dated from the matched ORDER, not this tick — see entryStampPatch().
      // The webull-import route above records entry_date as NULL by design,
      // and this is the first moment anything knows the real answer.
      ...(entryStampPatch(p, match.createdAt) ?? {}),
    });
    setLiveOrderPositionId(match.intentId, p.id);
    logAutotradeEvent({
      symbol: p.symbol,
      stage: 'execution',
      action: 'live_position_adopted',
      detail: {
        positionId: p.id,
        intentId: match.intentId,
        reason:
          p.sourceIntentId !== null
            ? "A generic order reconcile (not autotrade's own) materialized this fill first, tagging it plain 'live'"
            : 'Webull position-sync import matched a pending autotrade entry order',
      },
      riskProfile: match.riskProfile,
    });
    adopted++;
  }
  return { adopted };
}

export interface ListAutotradeLivePositionsFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  /** Newest-first page size. OMIT FOR EVERY ROW, the same rule as
   *  listPaperPositions/listOptionsPaperPositions (db/rowLimit.ts). */
  limit?: number;
}

/** Real (live-money) positions the autotrade loop itself placed, filtered by
 *  the same 'autotrade' tag getLivePortfolioSnapshot() uses — from the SAME
 *  `positions` table a human's own manual trades live in, not a separate
 *  autotrade-only table (unlike paper trading, which is fully separate by
 *  design). Newest first (listPositions()'s own ordering, preserved through
 *  the tag filter). For the Auto-Trade page's own "Live positions" view —
 *  read-only, no execution here. */
export function listAutotradeLivePositions(filter: ListAutotradeLivePositionsFilter = {}): Position[] {
  const all = listPositions({ status: filter.status, symbol: filter.symbol }).filter(isAutotradePosition);
  return takeRowLimit(all, filter.limit);
}

export interface EquitySyncResult {
  ok: boolean;
  accountId?: string;
  previousEquityUsd?: number | null;
  netLiquidationUsd?: number;
  buyingPowerUsd?: number;
  config?: AutotradeConfig;
  error?: string;
}

/**
 * Pull the live net liquidation value from Webull for the configured
 * liveAccountId and use it to set accountEquityUsd — closes the "manually-set
 * number, no broker sync" gap (docs/AUTOTRADING_SPEC.md's Phase 4 writeup).
 * Net liquidation value, not buying power, is the correct broker figure for
 * "equity": buying power reflects available leverage (can be a multiple of
 * equity on margin, or less once positions are open), while every %-of-equity
 * risk cap downstream assumes the account's actual value. Read-only against
 * the broker (webullAccountState() places nothing) and independent of
 * liveTradingEnabled/either kill switch — those gate order placement, not
 * reading a balance, so equity can be synced and reviewed before ever going
 * live.
 *
 * `opts.log` (default true) gates the `equity_synced` journal entry on an
 * actual change. Left on for the manual "Sync from Webull" button — an
 * occasional, deliberate action worth a record. The automatic per-tick sync
 * (loop.ts) passes `log: false`: net liquidation value drifts with mark-to-
 * market on essentially every check once a minute, so logging on any change
 * there would flood the Recent Activity feed's fixed-size window with equity
 * noise, crowding out the screen/decide/execute events it exists to surface.
 */
/** Corroboration state for the equity guard, held across ticks. Module-level
 *  because it is a property of THIS process's view of the feed, not something
 *  worth a table: a restart simply costs a few more ticks before a genuinely
 *  changed balance is accepted, and never accepts a bad one. */
let equityGuard: EquityGuardState = freshEquityGuardState();

/**
 * Test seam for the corroboration state above (2026-09-12).
 *
 * In production the comment above is right: a restart costs a few extra ticks
 * before a genuinely changed balance is accepted, and never accepts a bad one.
 * Across TEST FILES it is the leak class CLAUDE.md and `setupProcessState.ts`
 * both describe, and this one had no way to be cleaned up at all — no reset
 * existed, so a file could not have reset it even knowing it should.
 *
 * What leaks: `autotradeLiveExecute.test.ts` drives the 2026-08-27 rejection
 * twice, leaving `{ pendingUsd: 2444.70, pendingCount: 2 }`. Under the pinned
 * path order `autotradeLoop.test.ts` runs next and also syncs equity. Any
 * out-of-band reading it makes within 1% of that level would be the THIRD
 * corroboration, so the guard would ACCEPT it — and acceptance-after-
 * corroboration additionally calls `applyExternalCashFlow`, which moves the
 * day's baseline. A test expecting a refusal would see a write and a rebased
 * day, on some runs and not others, depending on numbers in another file.
 *
 * Benign today only because the later figures (50k / 74k) are nowhere near
 * 2444.70. That is a coincidence, not a design, which is the whole argument
 * for the seam rather than for leaving it.
 */
export function resetEquitySyncGuardState(): void {
  equityGuard = freshEquityGuardState();
}

/**
 * One journal line a day when net liquidation has moved a long way from where
 * the day OPENED, with the cash/positions split that says which it was
 * (2026-09-15).
 *
 * The guard above compares each reading to the LAST ACCEPTED one, so it sees
 * jumps and not slides — which is right for what it does (it rejects, and a
 * slow decline is usually real, so rejecting one would freeze equity at a
 * stale figure). But it leaves the session's own shape unrecorded, and a feed
 * fault that arrives in sub-threshold steps is exactly as damaging as one that
 * arrives in a single lurch, while producing no row at all.
 *
 * On 2026-09-15 net liquidation went $3,699.78 -> $591.81, an 84% fall, in
 * steps of 5.4%, 7.5%, 14.8%, 11.4% — every one of them inside the 25% guard.
 * Nothing said so. The only trace was 143 `live_caps_reanchored` rows, which
 * record the CONSEQUENCE one step at a time and never the move.
 *
 * It does not reject anything and does not touch the caps: the reading is
 * written exactly as before. `marketValueUsd` / `cashBalanceUsd` are the whole
 * point — a real move shows up in one of them, and a feed contradicting itself
 * does not.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function reportCumulativeEquityMove(acct: WebullAccountStateResult, maxJumpPct: number): void {
  const netLiq = acct.netLiquidationUsd;
  if (!(maxJumpPct > 0) || netLiq === undefined || !(netLiq > 0)) return;
  const baseline = getDailyBaseline();
  const today = etToday();
  if (!baseline || baseline.etDate !== today || !(baseline.equityUsd > 0)) return;

  const movePct = ((netLiq - baseline.equityUsd) / baseline.equityUsd) * 100;
  if (Math.abs(movePct) <= maxJumpPct) return;
  if (!claimOncePerDay('equity_moved_far_from_open', today)) return;

  logAutotradeEvent({
    stage: 'config',
    action: 'equity_moved_far_from_open',
    detail: {
      etDate: today,
      openingEquityUsd: round2(baseline.equityUsd),
      currentEquityUsd: round2(netLiq),
      movePct: round2(movePct),
      maxJumpPct,
      marketValueUsd: acct.state ? round2(acct.state.exposureUsd) : null,
      cashBalanceUsd: acct.state?.cashBalanceUsd ?? null,
      brokerDayPnlUsd: acct.realizedToday?.brokerDayPnlUsd ?? null,
      note:
        'Net liquidation is a long way from where the day opened. The per-tick guard only sees JUMPS, so a ' +
        'move that arrives in small steps leaves no trace — this is that trace. Positions or cash will show ' +
        'which it was; if neither moved, suspect the feed. Nothing was rejected and no cap was held.',
    },
  });
}

export async function syncAccountEquityFromBroker(opts?: { log?: boolean }): Promise<EquitySyncResult> {
  const cfg = getAutotradeConfig();
  const accountId = cfg.liveAccountId;
  if (!accountId) {
    return { ok: false, error: 'No liveAccountId configured — set one under Live trading first.' };
  }

  const acct = await webullAccountState(accountId);
  if (!acct.ok) return { ok: false, accountId, error: acct.error ?? 'Could not load account state' };
  if (!acct.netLiquidationUsd || acct.netLiquidationUsd <= 0) {
    return { ok: false, accountId, error: 'Webull did not return a usable net liquidation value' };
  }

  const previousEquityUsd = cfg.accountEquityUsd;

  // Sanity-check before writing. The feed can contradict itself (2026-08-27:
  // $1,907-$2,317 on a ~$2,230 account holding one position that moved cents),
  // and BOTH readers of this number are damaged by that — the daily target
  // banked a fictional +9.69% day and halted live entries, and every
  // %-of-equity cap sized off the noise. See equitySyncGuard.ts.
  const guard = evaluateEquitySync(acct.netLiquidationUsd, previousEquityUsd, cfg.equitySyncMaxJumpPct, equityGuard);
  equityGuard = guard.state;
  if (!guard.accept) {
    // Journaled unconditionally, NOT under opts.log: the per-tick sync passes
    // log:false to keep ordinary mark-to-market drift out of the feed, but a
    // rejected reading is not drift — it is the one thing here worth seeing.
    logAutotradeEvent({
      stage: 'config',
      action: 'equity_sync_rejected',
      detail: {
        rejectedUsd: acct.netLiquidationUsd,
        keptUsd: previousEquityUsd,
        jumpPct: guard.jumpPct,
        maxJumpPct: cfg.equitySyncMaxJumpPct,
        reason: guard.reason,
        accountId,
      },
    });
    return {
      ok: true,
      accountId,
      previousEquityUsd,
      netLiquidationUsd: acct.netLiquidationUsd,
      ...(acct.state ? { buyingPowerUsd: acct.state.buyingPowerUsd } : {}),
      config: cfg,
    };
  }

  reportCumulativeEquityMove(acct, cfg.equitySyncMaxJumpPct);

  const next = setAutotradeConfig({ accountEquityUsd: acct.netLiquidationUsd });

  // A jump the guard accepted only after repeated corroboration is, by its own
  // definition, a real balance change rather than noise. That is the first of
  // the two signals an external cash flow needs; applyExternalCashFlow checks
  // the second (the broker's day P&L does not account for the move) and, if
  // both agree, moves the day's baseline so a deposit is not read as gain.
  // guard.reason is non-null ONLY on that path — an ordinary in-band tick
  // returns null and must not go anywhere near the baseline.
  if (guard.reason !== null) {
    applyExternalCashFlow(acct.netLiquidationUsd, acct.realizedToday?.brokerDayPnlUsd);
  }

  if ((opts?.log ?? true) && next.accountEquityUsd !== previousEquityUsd) {
    logAutotradeEvent({
      stage: 'config',
      action: 'equity_synced',
      detail: { from: previousEquityUsd, to: next.accountEquityUsd, accountId },
      riskProfile: next.riskProfile,
    });
  }
  return {
    ok: true,
    accountId,
    previousEquityUsd,
    netLiquidationUsd: acct.netLiquidationUsd,
    buyingPowerUsd: acct.state?.buyingPowerUsd,
    config: next,
  };
}

export interface LiveExecutionOutcome {
  symbol: string;
  ok: boolean;
  reason?: string;
  intentId?: number;
  /** What the placed order ACTUALLY consumes: its final quantity (after the
   *  probation cut) at its limit price — the same figure guardrails.ts valued
   *  it at. Set only on a successful placement.
   *
   *  The batch below decrements buying power and exposure by this. It used to
   *  recompute `signal.entry * result.sizing.suggestedQuantity`, which is the
   *  PRE-probation quantity at the PRE-buffer price — two differences from the
   *  order that was really sent, in opposite directions. With probation at
   *  0.5x that over-charged the next candidate in the batch by roughly double:
   *  measured in a test, $14,600 deducted for a $7,336 order, which then
   *  refused the next candidate for having only $392 left. */
  placedNotionalUsd?: number;
  /** What the placed order really RISKS: its final quantity against the stop
   *  the bracket carries, priced at the QUOTE risk is realized at — not the
   *  limit the notional field above is valued at. See entryRisk.ts's
   *  riskBasisPrice for why those are two different prices.
   *
   *  The exact twin of the notional field above, one bound over and fixed for
   *  the same reason (2026-09-13). The batch's aggregate open-risk running
   *  total was decremented by `approvedRiskAmount`, which prices the risk at
   *  `signal.entry` — so a batch whose first entry drifted 1.2% before
   *  placement (SWKS, 2026-09-11) charged the budget 1.46x less than the
   *  position it had just opened, and the next candidate was sized against
   *  headroom that did not exist. Set only on a successful placement. */
  placedRiskUsd?: number;
}

/**
 * Attempt to place a real, broker-side bracket order for an approved
 * (already risk-checked) signal. Sizing is the risk-checked quantity further
 * cut by the probation multiplier (if still active) — rounding DOWN, and
 * skipping the trade entirely (not placing a 0-quantity order) if that
 * rounds to zero. Guardrails run against FRESH account state, exactly like
 * placeOrder() does for the human path — never trusting stale data.
 */
/** Which guard on the live entry path refused an entry (2026-09-23, shorts
 *  pre-flight). See attemptLiveEntry for each. */
export type LiveEntryGuard = 'through_stop' | 'holding_unknown' | 'opposite_holding' | 'short_refused_today';

/** Refuse an entry at one of attemptLiveEntry's guards, journaling
 *  `live_entry_guard_refused` once per symbol per ET day (the first guard to
 *  fire names itself). The same signal comes back every tick while it lasts,
 *  and one row says as much as sixty.
 *
 *  Through journalDeclinedEntry, the one writer every declined live entry
 *  uses, so the row replays like the rest: side as long/short (the replay reads
 *  anything but 'short' as a long, and a raw 'sell' here had every refused
 *  short scored as a long), and the live floor it was judged against. From the
 *  PR's own review, 2026-09-23. */
function refuseEntryAtGuard(
  signal: TradeSignal,
  guard: LiveEntryGuard,
  why: string,
  detail: Record<string, unknown>,
  liveMinSignalScore: number,
): LiveExecutionOutcome {
  journalDeclinedEntry(signal, 'live_entry_guard_refused', liveMinSignalScore, { guard, reason: why, ...detail });
  return { symbol: signal.symbol.toUpperCase(), ok: false, reason: `Entry refused (${guard}): ${why}` };
}

export async function attemptLiveEntry(
  signal: TradeSignal,
  riskResult: RiskCheckResult,
  riskProfile: string,
  autotradeCfg: AutotradeConfig,
  /** At-entry context (2026-07-26), recorded on the order row and carried to
   *  the position at materialization — the market regime label + market ATR%
   *  the loop read this cycle. Both nullable, defaulting to null for direct
   *  callers (e.g. tests) that don't have them. */
  marketRegime: string | null = null,
  marketAtrPct: number | null = null,
  /** The ML regime label at entry (2026-09-08), recorded on the order row and
   *  carried to the position at materialization; null when unknown or stale. */
  mlRegime: string | null = null,
  /** The target tighten factor the bracket's target was built with
   *  (regimeTargets.ts): 1 when untightened; null for a direct caller. */
  regimeTargetFactor: number | null = null,
  /** The buying-power figure the SIZER was bound by this batch, and which
   *  broker field it came from (buyingPowerBasis). Journaled on the placement
   *  and on a broker refusal so "aimed at X, refused at Y" is readable rather
   *  than inferred — see buyingPowerBasis for the session that made that
   *  necessary. Null for a direct caller, or when no figure was loaded. */
  bpBasis: BuyingPowerBasis | null = null,
): Promise<LiveExecutionOutcome> {
  const symbol = signal.symbol.toUpperCase();
  // The deploy-level master gate, checked FIRST — mirrors placeOrder.ts's own
  // ordering exactly. This was missing entirely until an adversarial review
  // caught it: nothing else in this file (or loop.ts's isLiveEntryActive)
  // consulted it, so a deploy with TRADING_ENABLED unset could still place
  // real orders through this path alone.
  if (!config.trading.placeEnabled) {
    return { symbol, ok: false, reason: 'Order placement is disabled on the server (TRADING_ENABLED is not set).' };
  }
  if (!riskResult.ok) return { symbol, ok: false, reason: 'Risk check did not pass' };

  const accountId = autotradeCfg.liveAccountId;
  if (!accountId) return { symbol, ok: false, reason: 'No liveAccountId configured' };

  // Idempotency guard (authoritative — this function is the single choke point
  // before a real order is placed). Never place a second live entry for a
  // symbol that already has an autotrade order in flight (working, or filled-
  // but-not-yet-materialized) or an open position. A live position row is
  // created ONLY when a full fill reconciles, so an order still resting or
  // partially filled across a loop-tick boundary is invisible to an
  // open-positions check alone — the next tick re-emits the same signal and
  // places a SECOND real order (double size, two OCO bracket pairs). The exit
  // path already dedups against pending orders this way; the entry path didn't.
  if (listPendingLiveOrders().some((o) => o.symbol === symbol)) {
    return { symbol, ok: false, reason: 'A live order or open position for this symbol is already in flight' };
  }

  // The book's probation, and a short's own on top (entryProbation): one
  // multiplier, which the risk budget below reads too.
  const probation = entryProbation(autotradeCfg, signal.side);
  let quantity = Math.floor(riskResult.sizing.suggestedQuantity * probation.multiplier);
  if (quantity <= 0) {
    return {
      symbol,
      ok: false,
      reason:
        `Probation-adjusted quantity rounded to 0 (multiplier ${probation.multiplier}` +
        `${probation.short?.active ? `, short probation ${probation.short.multiplier}` : ''})`,
    };
  }

  // A SHORT THE BROKER REFUSED EARLIER TODAY (refusedShorts.ts) is refused
  // here, before the quote and the account reads, since it needs neither.
  const refusedShort = signal.side === 'sell' ? shortRefusedReason(symbol, etToday()) : undefined;
  if (refusedShort !== undefined) {
    return refuseEntryAtGuard(
      signal,
      'short_refused_today',
      `the broker refused a short in ${symbol} earlier today (${refusedShort}), and a borrow or the short-sale ` +
        'rule does not lift within the session',
      { brokerReason: refusedShort },
      autotradeCfg.liveMinSignalScore,
    );
  }

  let last: number;
  try {
    last = (await getProvider().getQuote(signal.symbol)).last;
  } catch (err) {
    return { symbol, ok: false, reason: `Quote fetch failed: ${(err as Error).message}` };
  }
  if (!Number.isFinite(last) || last <= 0) return { symbol, ok: false, reason: `Invalid quote price: ${last}` };

  // A PRICE ALREADY THROUGH THE STOP IS NOT AN ENTRY (2026-09-23, shorts
  // pre-flight). The stop was set from the signal's entry, a screen that can be
  // a minute or two old, and nothing compared it with the quote this order is
  // priced from: the bracket guardrail compares the stop with the LIMIT, which
  // sits 0.5% on the far side of the quote, so a quote up to 0.5% through the
  // stop passed. The order then filled beyond its own stop, and the stop leg
  // either fired at once or was refused as through the market. Not seen on the
  // record (39 recorded placements, the nearest 1.19% from its stop), and
  // cheaper to refuse than to find.
  const stopAlreadyHit = signal.side === 'buy' ? last <= signal.stop : last >= signal.stop;
  if (stopAlreadyHit) {
    return refuseEntryAtGuard(
      signal,
      'through_stop',
      `the quote ${last} is already ${signal.side === 'buy' ? 'at or below' : 'at or above'} the stop ${signal.stop}`,
      { last },
      autotradeCfg.liveMinSignalScore,
    );
  }

  const buffer = 1 + (signal.side === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const limitPrice = Math.round(last * buffer * 100) / 100;

  // RE-SIZE AGAINST THE PRICE WE ARE ABOUT TO SEND (2026-09-13).
  //
  // `quantity` above came from riskCheck, which sized against `signal.entry` —
  // the price the screen saw when it decided. `last` is a quote taken just
  // now, after this batch has awaited a broker round-trip for every candidate
  // ahead of this one, and the bracket's stop goes in at `signal.stop`
  // regardless. So every cent between those two prices is risk the budget
  // never approved. On the seven live rows carrying
  // plannedStopDistancePct the realized risk ran 1.00x-1.46x the planned
  // figure, mean 1.09x, and not one below 1.00x: a marketable buy limit fills
  // at or inside itself, so a long's drift is one-sided against us.
  //
  // MIN, never max. A quote that came back BETTER than the signal's entry
  // would fund more shares, but those shares were never put to the guardrails
  // and never counted against the aggregate risk budget, so sizing up here
  // would spend headroom nobody checked. Drifting favourably simply risks
  // less, which needs no correction.
  //
  // The basis is the fresh QUOTE, not the limit: the guardrail values notional
  // at the limit because the broker reserves there, but risk is realized at
  // the FILL, and this book's fills consume 0.05% of the 0.5% buffer. See
  // riskBasisPrice.
  //
  // `undefined` means the inputs could not produce a sane number (a zero-width
  // stop), and leaves `quantity` exactly as it was.
  //
  // The budget takes the probation cut too. `approvedRiskAmount` is
  // `riskPerUnit x suggestedQuantity` BEFORE the multiplier above is applied,
  // so at 0.5x it describes an order twice the size of the one being sent —
  // and a bound derived from it would have been loose enough to pass a
  // doubled risk. The same overstatement is written down one sleeve over
  // (liveOptionsExecute.ts, where the options path scales it explicitly) and
  // one field over (placedNotionalUsd, fixed for the same reason).
  const probationRiskBudget = riskResult.approvedRiskAmount * probation.multiplier;
  const riskBasis = riskBasisPrice(last);
  const riskSizedQuantity = riskCappedQuantity(riskBasis, signal.stop, probationRiskBudget);
  if (riskSizedQuantity !== undefined && riskSizedQuantity < quantity) {
    const drift = entryDriftPct(signal.entry, riskBasis, signal.side);
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_entry_risk_resized',
      detail: {
        signalEntry: signal.entry,
        // The price risk is measured at (the quote), then the price the order
        // is sent at. Naming only one of them would leave a later reader
        // unable to tell which question the drift answers.
        riskBasisPrice: riskBasis,
        limitPrice,
        stop: signal.stop,
        driftPct: drift,
        fromQuantity: quantity,
        toQuantity: riskSizedQuantity,
        approvedRiskUsd: Math.round(probationRiskBudget * 100) / 100,
        // What the unresized order would have risked against the stop it is
        // actually sending — the number the budget was never asked about.
        riskAtBasisUsd: Math.round(orderRiskAmount(riskBasis, signal.stop, quantity) * 100) / 100,
      },
      riskProfile,
    });
    quantity = riskSizedQuantity;
  }
  if (quantity <= 0) {
    return { symbol, ok: false, reason: `Re-sizing against the placement quote ${riskBasis} left 0 shares` };
  }

  // WHAT THE BROKER HAS ALREADY REFUSED TODAY (2026-09-14).
  //
  // Applied HERE, on the finished quantity, and not to the buying-power figure
  // the sizer aims at: the probation multiplier is applied above, so bounding
  // the pool would let probation halve an order that was already trimmed to
  // fit, and the book would walk itself down for no reason. The broker judges
  // a NOTIONAL; this clamps that notional.
  //
  // Inert until the broker has actually refused something today, so a normal
  // session sizes exactly as it did before.
  const learnedCeiling = learnedOpenNotionalCeiling(accountId, etToday());
  if (autotradeCfg.liveRefusalCeilingEnabled && learnedCeiling) {
    const ceilingQuantity = ceilingCappedQuantity(learnedCeiling.ceilingUsd, limitPrice);
    if (ceilingQuantity !== undefined && ceilingQuantity < quantity) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_entry_ceiling_resized',
        detail: {
          fromQuantity: quantity,
          toQuantity: ceilingQuantity,
          limitPrice,
          ceilingUsd: Math.round(learnedCeiling.ceilingUsd * 100) / 100,
          // The two brackets the ceiling was bisected from, so a reader can
          // see how the app arrived at it rather than taking the number.
          refusedUsd: learnedCeiling.refusedUsd,
          acceptedUsd: learnedCeiling.acceptedUsd,
          fromNotionalUsd: Math.round(quantity * limitPrice * 100) / 100,
        },
        riskProfile,
      });
      quantity = ceilingQuantity;
    }
  }
  if (quantity <= 0) {
    return {
      symbol,
      ok: false,
      reason: learnedCeiling
        ? `The broker refused $${learnedCeiling.refusedUsd.toFixed(2)} earlier today; nothing fits under the $${learnedCeiling.ceilingUsd.toFixed(2)} that leaves`
        : 'Re-sizing left 0 shares',
    };
  }

  // PER-LOT BRACKETS (#26, off by default): spend the sized quantity across TWO
  // bracketed entries rather than one, so a partial is just the smaller group's
  // target filling — no modify, no cancel-and-replace, no naked window. Lot 1
  // (the larger, see splitEntryForPerLot) is this order; lot 2 follows on a
  // later tick as an add-on that merges into the same position.
  //
  // A null target price means the R geometry was unusable (zero-width risk), so
  // the split is abandoned and this becomes an ordinary full-size entry —
  // degrading to today's behaviour rather than to a half-built position.
  //
  // The runner's target is the TIGHTENED one when the regime overlay says so —
  // regimeAdjustedTargets from the stamp this entry carries, the same helper
  // the loop used for decide.ts's target and the finish line reads. Reading
  // autotradeCfg.targetRMultiple raw here (as this did until 2026-09-10) would
  // have built an untightened runner while regime_target_factor on the row
  // said otherwise — two derivations of one target, and a stamp the MFE
  // ledger would have trusted. `mlRegime` is null when unknown, and null
  // tightens nothing, so a plain entry is byte-for-byte unchanged.
  const perLotSplit = autotradeCfg.livePerLotBracketsEnabled
    ? splitEntryForPerLot({
        filledQuantity: quantity,
        partialExitPct: autotradeCfg.partialExitPct,
        partialExitRMultiple: autotradeCfg.partialExitRMultiple,
        targetRMultiple: regimeAdjustedTargets(autotradeCfg, mlRegime).targetRMultiple,
      })
    : null;
  const firstLotTarget = perLotSplit
    ? lotTargetPrice(signal.entry, signal.stop, signal.side, perLotSplit.first.targetR)
    : null;
  const secondLotTarget = perLotSplit
    ? lotTargetPrice(signal.entry, signal.stop, signal.side, perLotSplit.second.targetR)
    : null;
  const perLot = perLotSplit && firstLotTarget !== null && secondLotTarget !== null ? perLotSplit : null;
  const quantityToOrder = perLot ? perLot.first.quantity : quantity;
  const targetToBracket = perLot ? (firstLotTarget as number) : signal.target;

  const intent: OrderIntent = {
    symbol,
    assetKind: 'stock',
    side: signal.side,
    openClose: 'open',
    quantity: quantityToOrder,
    orderType: 'limit',
    limitPrice,
    referencePrice: last,
    bracket: { takeProfitPrice: targetToBracket, stopLossPrice: signal.stop },
  };

  const liveCfg = buildLiveTradingConfig(autotradeCfg);
  const acct = await stockAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { symbol, ok: false, reason: acct.error ?? 'Could not load account state' };
  }

  // WHAT THE BROKER ALREADY HOLDS IN THE NAME (2026-09-23, shorts pre-flight).
  //
  // Whether a sell goes out as Webull's SHORT or as a plain SELL is decided
  // from the broker's own signed quantity (wouldOpenShort, below). The loop's
  // "already held" check reads the ledger, which the position sync refreshes
  // every few minutes, so a name the operator bought by hand inside that window
  // is invisible to it. A short entry against it would go out as a plain SELL
  // of the operator's shares, with BUY legs over them, and the fill would then
  // be booked as the loop's short. The mirror is a long entry against a short
  // the operator holds, which buys it back.
  //
  // So an entry is refused while the broker holds the name the OTHER way round,
  // and a short is refused when the holdings read failed, since that read is
  // the only thing that decides whether it is a short at all. A long with an
  // unreadable holding goes on as before: the side of its order does not turn
  // on it.
  const brokerQty = acct.positionsUnavailable ? null : acct.state.currentPositionQty;
  if (signal.side === 'sell' && brokerQty === null) {
    return refuseEntryAtGuard(
      signal,
      'holding_unknown',
      'the positions read failed, so it is not known whether this sell would open a short or sell shares held',
      {},
      autotradeCfg.liveMinSignalScore,
    );
  }
  if (brokerQty !== null && brokerQty !== 0 && brokerQty > 0 !== (signal.side === 'buy')) {
    return refuseEntryAtGuard(
      signal,
      'opposite_holding',
      `the broker already holds ${Math.abs(brokerQty)} ${symbol} ${brokerQty > 0 ? 'long' : 'short'}, the other way ` +
        `round from this ${signal.side === 'buy' ? 'long' : 'short'}`,
      { brokerPositionQty: brokerQty },
      autotradeCfg.liveMinSignalScore,
    );
  }

  const accountState: AccountState = withLoopRealizedToday(
    withDayBuyingPower({ ...acct.state, ordersToday: countTodaysOrders(Date.now(), 'stock') }, autotradeCfg, accountId),
  );
  const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
  // Only matters for a permitted short entry (allowNakedShort — naked_short
  // above already blocks it otherwise): submit Webull's own SHORT side instead
  // of a plain SELL so the broker's real-time locate/borrow check runs at
  // order time (see providers/webull/orders.ts).
  const isShort = wouldOpenShort(intent, accountState);

  const clientOrderId = newClientOrderId();
  const intentRec = createIntent(intent, clientOrderId);

  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
    logAutotradeEvent({ symbol, stage: 'execution', action: 'live_entry_blocked', detail: { reasons }, riskProfile });
    return { symbol, ok: false, reason: `Guardrails blocked: ${reasons}`, intentId: intentRec.id };
  }

  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live)' });
  transitionIntent(intentRec.id, 'confirmed', {
    detail: 'autotrade — no per-order confirmation, per confirmed design',
  });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId, isShort);
  // VWAP observer (vwap.ts): at-entry context only, never a gate — measured
  // AFTER the placement call so it cannot delay or fail a real order (VWAP is
  // cumulative; a few hundred ms later is the same number), and null on any
  // failure rather than a guess.
  const sessionCtx = await fetchTodaySessionContext(symbol);
  const entryVwap = sessionCtx.vwap;

  // Entry-extension SHADOW (entryExtension.ts): journals how far into the day's
  // move this entry landed, and what the reference thresholds WOULD have done.
  // It changes nothing — the order is already placed by this line. Raw numbers
  // are recorded alongside the verdict so the cut can be re-chosen from the
  // journal without a deploy.
  //
  // Measured at `riskBasis`, the PLACEMENT quote, not at `signal.entry`
  // (2026-09-14). The screener's price is older than the range it would be
  // divided by by a broker round-trip per candidate ahead of this one, and
  // dividing two different moments by each other put five of the first 43 rows
  // outside their own range — FCX read 130% of it. Same price the sizer risks
  // against, from the same quote, for the same reason: two derivations of one
  // quantity agree by construction or they disagree in production.
  const extension = evaluateEntryExtension({
    side: isShort ? 'short' : 'long',
    price: riskBasis,
    vwap: sessionCtx.vwap,
    range: sessionCtx.range,
  });
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'entry_extension_shadow',
    detail: {
      // Which BOOK this reading belongs to. The paper path journals the same
      // action in the same minute for the same symbol (execute.ts), and the
      // leak scan joins on symbol + minute — without this the two collide and
      // the paper control silently reads the live book's number.
      book: 'live',
      side: isShort ? 'short' : 'long',
      // The price actually measured, and the screen's price beside it, so a
      // later reader can see the drift this row was computed despite.
      price: riskBasis,
      priceBasis: 'placement_quote',
      signalEntry: signal.entry,
      // Kept under its original name: rows written before 2026-09-14 carry
      // `entry` as the measured price, and a reader of the old rows must not
      // have to guess which field that was.
      entry: riskBasis,
      vwap: sessionCtx.vwap,
      sessionHigh: sessionCtx.range?.high ?? null,
      sessionLow: sessionCtx.range?.low ?? null,
      vwapExtPct: extension.vwapExtPct,
      pctOfRange: extension.pctOfRange,
      // Non-null means the quote printed outside the completed 5-minute bars,
      // i.e. the bars were behind. The residual staleness this measure cannot
      // remove, counted rather than assumed away.
      extendedRange: extension.extendedRange,
      wouldBlock: extension.wouldBlock,
      reasons: extension.reasons,
      // Names the cut this verdict used, so a later journal read is not left
      // guessing which thresholds produced it if they are ever changed.
      referenceMaxPctOfRange: REFERENCE_MAX_PCT_OF_RANGE,
      referenceMaxVwapExtPct: REFERENCE_MAX_VWAP_EXT_PCT,
    },
    riskProfile,
  });

  const orderRow = {
    intentId: intentRec.id,
    symbol,
    stopPrice: signal.stop,
    targetPrice: signal.target,
    // The risk this ORDER carries, not the risk the check approved. Three
    // things read it — the aggregate open-risk budget via
    // pendingLiveOrdersRisk(), the position it materializes into, and the leak
    // scan — and all three were being handed the pre-drift figure. On a
    // per-lot entry it is also the FIRST lot's risk rather than the whole
    // sized position's; lot 2 records its own when it goes in.
    riskAmount: orderRiskAmount(riskBasis, signal.stop, quantityToOrder),
    riskProfile,
    accountId,
    grade: convictionGrade(signal.score, {
      aMinScore: autotradeCfg.convictionGradeAMinScore,
      bMinScore: autotradeCfg.convictionGradeBMinScore,
    }),
    entryScore: signal.score,
    entryComponents: signal.components ?? null,
    marketRegime,
    marketAtrPct,
    mlRegime,
    regimeTargetFactor,
    entryVwap,
    // Stop-cap forensics (2026-09-11, task #62) — carried from the signal to
    // the order row and on to the position at materialization, the same path
    // entryVwap takes. Capture-only: nothing below reads either to change a
    // trade. Stamped here rather than re-derived later because the SIGNAL's
    // entry price is what plannedStopDistancePct is a percentage of, and that
    // price is gone once the fill lands.
    stopSqueezeRatio: signal.stopSqueezeRatio ?? null,
    plannedStopDistancePct: signal.plannedStopDistancePct ?? null,
    // The combo group id this client minted for the bracket. Stored on BOTH
    // paths below — including the ambiguous one, where the order may well have
    // reached the broker and a later modify would still need to name its group.
    clientComboOrderId: broker.clientComboOrderId ?? null,
    // Each exit leg's own id (#147), on both paths for the same reason: the
    // reconcile asks a leg by this id when the sync finds the shares gone.
    legClientOrderIds: broker.legClientOrderIds ?? null,
  };
  if (!broker.ok && broker.ambiguous) {
    // We do NOT know whether this order reached the broker, so it must not be
    // treated as rejected: 'rejected' is terminal, which drops the intent out of
    // listPendingLiveOrders() and out of the dedup guard, and the NEXT cycle
    // would place the same real order again — double size, two bracket pairs.
    // Instead leave the intent at 'submitted' and record the order row anyway,
    // so it is (a) polled by reconcileLiveOrders, which looks the order up by
    // CLIENT order id and so can resolve it without a broker id, and (b) counted
    // by the double-open guard meanwhile. reconcileLiveOrders marks it rejected
    // once the broker positively reports no such order.
    recordLiveOrder(orderRow);
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_order_outcome_unknown',
      detail: { reason: broker.error, clientOrderId },
      riskProfile,
    });
    return {
      symbol,
      ok: false,
      reason: `Placement outcome unknown (kept pending for reconcile): ${broker.error}`,
      intentId: intentRec.id,
    };
  }
  if (!broker.ok) {
    transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
    // Learn a symbol the TRADING api cannot parse, so the next candidate for it
    // is skipped before any of this is spent again. Webull quotes BF.B and
    // BRK.B happily and then refuses to place an order for either, so market
    // data alone is not evidence that a symbol is tradable.
    const unparseable = isUnparseableSymbolError(symbol, broker.error);
    if (unparseable) markUnplaceableSymbol(symbol, broker.error ?? 'broker cannot parse this symbol');
    // A SHORT the broker refused (hard to borrow, no locate, the short-sale
    // rule) holds that symbol's shorts for the day; see refusedShorts.ts. Only
    // a definite refusal reaches here: an unanswered one returned above. A
    // buying-power refusal is not one of those: the ceiling learned just below
    // lets the next attempt fit at a smaller size, and a day-long hold on the
    // symbol would override it.
    if (isShort && !isInsufficientBuyingPowerError(broker.error)) {
      markShortRefused(symbol, etToday(), broker.error ?? 'refused');
    }
    // Learn the ceiling from the broker itself. The reported buying power
    // overstates what it will fund on an opening order — it is netted against
    // CURRENT exposure, which a closed position returns to zero, while the
    // broker's pool is spent by purchases and not credited back on the sale.
    // Recording the refused notional lets the next candidate be sized under it
    // instead of being refused in turn (buyingPowerRefusals.ts).
    const refusedNotionalUsd = Math.round(quantityToOrder * limitPrice * 100) / 100;
    if (isInsufficientBuyingPowerError(broker.error)) {
      markBuyingPowerRefusal(accountId, etToday(), refusedNotionalUsd);
    }
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_entry_failed',
      detail: {
        reason: broker.error,
        ...(unparseable ? { symbolUnplaceable: true } : {}),
        // What the sizer believed it had, beside what the broker just said.
        // A "buying power is insufficient" rejection is unreadable without it.
        ...(bpBasis ? { buyingPower: bpBasis } : {}),
        orderNotionalUsd: refusedNotionalUsd,
      },
      riskProfile,
    });
    return { symbol, ok: false, reason: `Broker rejected: ${broker.error}`, intentId: intentRec.id };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  // The other bracket: proof the broker will fund at least this much today.
  // `quantityToOrder`, not `quantity`: under per-lot bracketing this is the
  // first LOT, so the recorded acceptance can understate what the broker would
  // have taken. That only ever makes the next bisection more conservative,
  // which is the safe direction for a bracket that exists to avoid refusals.
  markBuyingPowerAccepted(accountId, etToday(), Math.round(quantityToOrder * limitPrice * 100) / 100);
  recordLiveOrder(orderRow);
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_order_placed',
    detail: {
      side: signal.side,
      quantity: quantityToOrder,
      // The probation cut this order took (entryProbation): the book's window
      // times, for a short, the short window. 1 when neither is active.
      probationMultiplier: probation.multiplier,
      limitPrice,
      // The price the SIZER used, beside the price the order was sent at. The
      // gap between them is what the risk budget never saw (entryRisk.ts), and
      // it is only readable from a journal row if both are on it — the
      // signal's entry is gone the moment the fill lands, which is the same
      // reason plannedStopDistancePct is stamped rather than re-derived.
      signalEntry: signal.entry,
      riskBasisPrice: riskBasis,
      stop: signal.stop,
      target: targetToBracket,
      ...(bpBasis ? { buyingPower: bpBasis } : {}),
      orderId: broker.orderId,
      entryVwap,
      // Journaled too, not only stored: the squeeze ratio is the number the
      // #62 rule groups by, and a journal row is readable the moment an entry
      // places rather than after its fill reconciles.
      stopSqueezeRatio: signal.stopSqueezeRatio ?? null,
      plannedStopDistancePct: signal.plannedStopDistancePct ?? null,
      // Present only on a per-lot entry, so the journal distinguishes "a
      // deliberately smaller first lot" from "a smaller position than the risk
      // check sized", which otherwise look identical here.
      ...(perLot ? { perLotRole: perLot.first.role, perLotOf: quantity } : {}),
    },
    riskProfile,
  });
  // THE SECOND LOT'S PLAN, written where checkLivePerLotSecondLots can find it.
  //
  // Journal-as-state, deliberately and with its limits known: the plan needs to
  // outlive this call (lot 2 goes on a later tick, after this fill
  // materializes) and there is no column on autotrade_live_orders for it. A
  // migration is the right home if this flag ever ships ON — recorded here so
  // that is a decision someone makes rather than a gap someone finds. The event
  // is wanted as evidence regardless: without it, a position that never got its
  // second lot is indistinguishable from one that was never meant to have one.
  if (perLot) {
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'per_lot_entry_planned',
      detail: {
        entryIntentId: intentRec.id,
        sizedQuantity: quantity,
        first: { quantity: perLot.first.quantity, targetR: perLot.first.targetR, role: perLot.first.role },
        second: {
          quantity: perLot.second.quantity,
          targetR: perLot.second.targetR,
          role: perLot.second.role,
          targetPrice: secondLotTarget,
        },
        stopPrice: signal.stop,
      },
      riskProfile,
    });
  }
  // Best-effort — a real order was already placed and journaled above
  // regardless of whether anyone's actually configured a webhook to hear
  // about it (dispatchNotifications() itself is a no-op with zero channels
  // configured, and never throws). Reuses the SAME Slack/Discord/webhook
  // infra the price-alert system already dispatches through, rather than a
  // second notification path — this is the one live autotrade event a human
  // most wants to know about without having the app open.
  await dispatchAutotradeNotification('live equity', [
    {
      title: symbol,
      message: `Autotrade LIVE ${signal.side === 'buy' ? 'BUY' : 'SELL'}: ${quantity} ${symbol} @ ~$${limitPrice.toFixed(2)} (stop ${signal.stop.toFixed(2)}, target ${signal.target.toFixed(2)})`,
    },
  ]);
  return {
    symbol,
    ok: true,
    intentId: intentRec.id,
    placedNotionalUsd: quantityToOrder * limitPrice,
    placedRiskUsd: orderRiskAmount(riskBasis, signal.stop, quantityToOrder),
  };
}

/**
 * Risk-check, then attempt to place, a batch of already-decided signals —
 * sequentially against a RUNNING total (autotrade's own open LIVE positions +
 * already-approved earlier in this same call), mirroring execute.ts's
 * runPaperExecution() and riskCheck.ts's runAutotradeRiskCheck exactly.
 */
export async function runLiveExecution(
  candidates: { signal: TradeSignal }[],
  /** Regime-aware sizing (2026-07-16) — same market-ATR% reading loop.ts
   *  already computed once this cycle for its volatility hard-cutoff, not
   *  re-fetched here. Defaults to null (regime cut inactive) for any caller
   *  that doesn't have/need one, e.g. a direct test call. */
  marketAtrPct: number | null = null,
  /** The live OPTIONS book's daily P&L / streak / trade count, supplied by
   *  loop.ts (liveOptionsSeedForEquity). Defaults to zeros for a direct caller.
   *
   *  Without it these three gates saw only the equity book, while paper combines
   *  both and the live OPTIONS batch already folds in equity — so the asymmetry
   *  was one-way. The consequences were real money: a day of live OPTIONS losses
   *  left the equity daily-drawdown halt unaware (it could keep opening full-size
   *  positions past the intended daily cap), and consecutive OPTIONS losses never
   *  engaged equity's step-down cut — sizing at full risk exactly when the
   *  strategy was losing. */
  optionsSeed: LiveOptionsRiskSeed = { dailyPnl: 0, consecutiveLosses: 0, tradesToday: 0 },
  /** Market regime label the loop read this cycle (2026-07-26) — recorded on
   *  the entry order row and carried to the position at materialization as
   *  at-entry context; never used for sizing here. */
  marketRegime: string | null = null,
  /** What the loop knows about the regime this tick (2026-09-08,
   *  effectiveRisk.ts's TickRegime) — the risk check's trigger inputs and the
   *  ONE effective regime recorded on the entry order and carried to the
   *  position at materialization. */
  regime: TickRegime = NO_TICK_REGIME,
  /** Which way the whole market leans this tick (2026-09-23,
   *  marketDirection.ts), read once by the loop. With
   *  marketDirectionGateEnabled on, a long on a broad red day and a short on a
   *  broad green one are refused. Null for a direct caller: no reading, no
   *  refusal. */
  marketDirection: MarketDirectionReading | null = null,
): Promise<LiveExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const equity = cfg.accountEquityUsd ?? 0;
  // The day's opening equity, for the drawdown halt only — sizing below stays
  // on the CURRENT reading, which is what risk per trade should be a fraction
  // of. See dayLossBudget.ts for why the halt must not use the same number.
  const dayStart = dayStartEquityUsd(getDailyBaseline(), etToday(), equity).usd;

  const snapshot = getLivePortfolioSnapshot();
  const dailyPnl = snapshot.dailyPnl + optionsSeed.dailyPnl;
  const tradesToday = snapshot.tradesToday + optionsSeed.tradesToday;
  const consecutiveLosses = Math.max(snapshot.consecutiveLosses, optionsSeed.consecutiveLosses);
  // Seed the running risk/count from the COMBINED live book (both equity and
  // options, positions AND placed-but-unmaterialized orders) -- not this book's
  // position-only snapshot -- so equity and options entries in the same tick
  // can't jointly exceed the aggregate-risk / concurrent-position caps.
  // Nothing may be opened so close to the bell that the end-of-day flatten
  // would swallow it — batch-level, and BEFORE the buying-power read below, so
  // a doomed batch costs no broker round-trip either. See evaluateEntryCutoff.
  const entryCutoff = evaluateEntryCutoff(cfg, Date.now());
  if (entryCutoff.blocked) {
    logAutotradeEvent({
      stage: 'execution',
      action: 'entry_window_closed',
      detail: {
        reason: entryCutoff.reason,
        minutesLeft: entryCutoff.minutesLeft,
        cutoffMinutes: entryCutoff.cutoffMinutes,
        refused: candidates.length,
        // The other BATCH row, carrying the same gap and fixed with it: a count
        // with no symbol cannot say what the cutoff cost.
        symbols: candidates.map(({ signal }) => signal.symbol.toUpperCase()),
      },
    });
    return candidates.map(({ signal }) => ({
      symbol: signal.symbol.toUpperCase(),
      ok: false,
      reason: entryCutoff.reason ?? 'past the end-of-day entry cutoff',
    }));
  }

  const combined = combinedLiveOpenRisk();
  let runningRisk = combined.risk;
  let runningCount = combined.count;
  // Buying power for the SIZER, so it fits the order to what the account can
  // fund rather than building an unfundable one for the guardrail to refuse
  // (see buyingPowerSizing.ts -- 627 such refusals and zero entries on
  // 2026-08-28).
  //
  // Loaded LAZILY: an unplaceable short must still cost no broker round-trip,
  // which is the whole point of the skip below it — a short only gets this far
  // when liveAllowNakedShort is ON. Read once per batch and then decremented by
  // each fill (either side — an opening short consumes margin too), so two
  // entries in the same tick cannot both be sized against the same dollars;
  // the broker's own figure only catches up on the next tick.
  //
  // Best-effort throughout: no account id, a failed read, or a payload without
  // the field all leave it undefined, which imposes no constraint and restores
  // the previous behaviour exactly.
  let buyingPowerLoaded = false;
  let availableBuyingPowerUsd: number | undefined;
  // Carried onto the journal row: which broker field won, what it was netted
  // against, and the ceiling the broker's own refusals have taught today.
  let bpBasis: BuyingPowerBasis | null = null;
  // Room left under the ACCOUNT EXPOSURE cap, loaded from the same account read
  // and decremented alongside buying power below.
  //
  // guardrails.ts refuses an entry on three dollar tests, and until 2026-09-05
  // only ONE of them (buying power) was known to the sizer — so the other two
  // were discovered after a full-size order had been built, which is the
  // build-then-refuse loop the sizer exists to end. The live journal for the
  // four sessions after the buying-power fix: 23 blocks, 18 of them
  // account_exposure, several within $11-$120 of the cap, and DG refused six
  // times in eleven minutes for the same ~$120.
  let exposureHeadroomUsd: number | undefined;
  const liveTradingCfg = buildLiveTradingConfig(cfg);
  const buyingPowerForSide = async (side: 'buy' | 'sell'): Promise<number | undefined> => {
    // Both sides need a figure. An opening SHORT consumes margin exactly as a
    // buy consumes cash, so returning undefined for a sell left the sizer
    // unconstrained on every short — buyingPowerMaxQuantity reads undefined as
    // "no constraint". The guardrail caught an unfundable short, but only
    // after a full-size order had been built, which is the very
    // build-then-refuse loop the buying-power sizer exists to end (627 refusals
    // in one session, zero entries).
    //
    // The lazy fetch this guard was protecting is still intact: a short only
    // reaches here when liveAllowNakedShort is ON, because the short-entry skip
    // above returns first when it is off. So a disabled-shorts book still never
    // pays for the broker round-trip.
    void side;
    if (!buyingPowerLoaded) {
      buyingPowerLoaded = true;
      if (cfg.liveAccountId) {
        try {
          const acct = await webullAccountState(cfg.liveAccountId);
          // A NON-throwing failure is just as silent as a thrown one, and more
          // likely: the broker answers, the answer is not ok, and the bound
          // simply never gets set.
          if (!acct.ok && claimOncePerDay('live_buying_power_unavailable', 'account')) {
            logAutotradeEvent({
              stage: 'risk_check',
              action: 'live_buying_power_unavailable',
              detail: {
                reason: acct.error ?? 'broker account read returned not-ok',
                effect: 'sizing is unconstrained by buying power and by the exposure headroom for this batch',
              },
              riskProfile: cfg.riskProfile,
            });
          }
          if (acct.ok && acct.state) {
            bpBasis = buyingPowerBasis(
              acct.state,
              cfg,
              learnedOpenNotionalCeiling(cfg.liveAccountId, etToday())?.ceilingUsd,
            );
            availableBuyingPowerUsd = bpBasis.usedUsd;
            // Same rearrangement the guardrail does, one step earlier:
            // exposureAfter <= maxExposureUsd becomes notional <= headroom.
            // maxExposureUsd is 0 when equity is unset, which fails closed
            // there and must fail closed here too — a 0 headroom sizes to 0
            // rather than silently ignoring the cap.
            exposureHeadroomUsd = liveTradingCfg.maxExposureUsd - acct.state.exposureUsd;
          }
        } catch (err) {
          // FAIL-OPEN, SAID OUT LOUD (2026-09-12). `undefined` buying power
          // means "no constraint" to the sizer, so a broker read that throws
          // silently removes the buying-power bound AND the exposure headroom
          // for the rest of the batch — the two bounds this block exists to
          // aim orders at. Failing closed would be worse (one bad read would
          // stop the book), so the behaviour stands and the weakening is
          // journaled. Once per ET day: the read is attempted on every batch.
          if (claimOncePerDay('live_buying_power_unavailable', 'account')) {
            logAutotradeEvent({
              stage: 'risk_check',
              action: 'live_buying_power_unavailable',
              detail: {
                reason: (err as Error).message,
                effect: 'sizing is unconstrained by buying power and by the exposure headroom for this batch',
              },
              riskProfile: cfg.riskProfile,
            });
          }
        }
      }
    }
    return availableBuyingPowerUsd;
  };
  const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = snapshot.openPositions.map(
    (p) => ({
      symbol: p.symbol,
      notional: p.entryPrice * p.quantity,
      side: p.side,
    }),
  );
  // Skip a symbol that has an open position OR a still-working / not-yet-
  // materialized live order. A position row is created ONLY when a full fill
  // reconciles, so open positions alone miss an entry still resting or
  // partially filled across a loop-tick boundary -- the next tick would re-emit
  // the same signal and place a SECOND real order (double size + two bracket
  // pairs). listPendingLiveOrders() covers all three states (its row persists
  // until the position both materializes and closes). attemptLiveEntry()
  // re-checks this authoritatively; this just avoids risk-checking a known dup.
  //
  // Deliberately ANY open position for the symbol here, not snapshot's own
  // 'autotrade'-tag-filtered openPositions -- a real holding that leaked into
  // the journal untagged (the generic Webull position-sync backstop importing
  // a fill reconcile missed, before adoptOrphanedLivePositions() below can
  // heal it) is still real shares in the same account; failing to recognize
  // it here means placing a genuine duplicate real-money order for a symbol
  // already held, not just a cosmetic dashboard gap. getLivePortfolioSnapshot's
  // own tag-filtered openPositions is still correct for THIS function's risk/
  // P&L accounting below (auto-trade's own performance, deliberately not
  // conflated with a human's separate manual trading) -- only the dedup check
  // needs the wider net.
  const openNow = listPositions({ status: 'open' });
  const skipSymbols = new Set([...openNow.map((p) => p.symbol), ...listPendingLiveOrders().map((o) => o.symbol)]);
  // WHY the refusal below is journaled rather than merely returned (2026-09-12):
  // it was the one silent refusal left on this path, so a paper entry the live
  // book passed on for this reason reached the attribution as `no_live_row` —
  // "nothing the journal explains" — and sat in the same bucket as a genuine
  // recording gap. It is also the refusal most likely to surprise: the set
  // above is not autotrade-only, so a name the OPERATOR is holding by hand
  // silently suppresses every live signal on it for as long as they hold it.
  const heldByAutotrade = new Set(openNow.filter(isAutotradePosition).map((p) => p.symbol));
  // The options sleeve's contracts are in `openNow` too: the generic broker sync
  // imports every holding, untagged, under the underlying's symbol. Until
  // 2026-09-23 they read as the operator holding the name by hand — all four of
  // that day's 'manual' rows (AMZN, DELL, HOOD, TSLA) were the sleeve's own
  // contracts. The refusal itself is unchanged: this only names who holds it.
  const optionsSleeveSymbols = new Set(listOpenLiveOptionsPositions().map((p) => p.symbol.toUpperCase()));
  const isSleeveContract = (p: Position): boolean =>
    p.assetType === 'option' && optionsSleeveSymbols.has(p.symbol.toUpperCase());
  const heldManually = new Set(
    openNow.filter((p) => !isAutotradePosition(p) && !isSleeveContract(p)).map((p) => p.symbol),
  );
  const heldByOptionsSleeve = new Set(
    openNow.filter((p) => !isAutotradePosition(p) && isSleeveContract(p)).map((p) => p.symbol),
  );
  const sectorOf = buildSectorOf();

  // Finish-line discipline + symbol cooldown (2026-08-22) — LIVE-only, both
  // computed once per batch. The daily-target status is re-evaluated from the
  // persisted baseline (not threaded from loop.ts) so a direct caller gets
  // the same protection the loop does.
  const dailyTarget = evaluateDailyTarget(cfg, getDailyBaseline(), strategyDayFor(etToday()).pnlUsd);
  const cooldowns = activeSymbolCooldowns(cfg);
  // Autotrade's OWN closed positions only — a human's manual trade in the same
  // name is not the loop's thesis and must not gate it.
  // Loaded for the cooldown OR the same-day re-entry size cut — tying the read
  // to one feature's setting is how the other silently sees an empty list.
  const closedAutotradeForReentry =
    cfg.symbolReentryCooldownMinutes > 0 || cfg.repeatEntrySizeCutPct > 0
      ? listPositions({ status: 'closed' }).filter(isAutotradePosition)
      : [];
  // LIVE rows only for the repeat cut: paper is the control arm this finding
  // will be re-measured against, so its trades must not size the live book.
  const closedLiveForRepeat = closedAutotradeForReentry.filter((p) => p.tags.includes('live'));
  const etDayForRepeat = etToday();
  // The finish-line trim is derived PER SIGNAL, below — not once per batch. It
  // has to reason about the risk % this particular entry will actually take,
  // and two of the factors that set it (grade expectancy, method lean) are
  // per-signal. See computeFinishLineFactor's own note.

  const outcomes: LiveExecutionOutcome[] = [];
  for (const { signal: candidateSignal } of candidates) {
    const symbol = candidateSignal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      // The four cases are NOT the same finding and must not pool: an
      // autotrade hold is the book working as designed, a manual hold is the
      // operator unknowingly muting a name, an options-sleeve hold is the two
      // sleeves meeting on one name, and a working order is a transient that
      // should clear within a tick or two.
      const holder = heldByAutotrade.has(symbol)
        ? 'autotrade'
        : heldManually.has(symbol)
          ? 'manual'
          : heldByOptionsSleeve.has(symbol)
            ? 'options_sleeve'
            : 'pending_order';
      journalDeclinedEntry(candidateSignal, 'live_symbol_held_skipped', cfg.liveMinSignalScore, { holder });
      outcomes.push({ symbol, ok: false, reason: `Already has an open live position (${holder})` });
      continue;
    }
    // A short entry cannot be placed while naked shorts are off — guardrails'
    // naked_short rule refuses it at the very end, after a correlation lookup,
    // a sector lookup, a risk check and a broker round-trip have all been
    // spent on it. On 2026-08-27 that was 31 of 48 live refusals: a third of
    // the day's live attempts went to orders that were never placeable.
    // Skipping here changes no outcome, only the work and the journal noise —
    // and it re-opens itself the moment liveAllowNakedShort is turned on.
    // A symbol the broker has already refused to parse cannot be traded, no
    // matter how well it scores. Skipping here rather than at placement saves
    // the correlation lookup, the sector lookup, the risk check, the quote and
    // the round-trip — and, because a rejected placement still creates an
    // order intent, it stops a guaranteed failure from spending one of the
    // day's maxOrdersPerDay allowance.
    const unplaceable = unplaceableReason(symbol);
    if (unplaceable) {
      journalDeclinedEntry(candidateSignal, 'symbol_unplaceable_skipped', cfg.liveMinSignalScore, {
        reason: unplaceable,
      });
      outcomes.push({ symbol, ok: false, reason: `broker cannot trade this symbol: ${unplaceable}` });
      continue;
    }
    // Whether a live short may go out on this tape at all (marketDirection.ts,
    // liveShortPermitted): shorts off, or on and held to a red tape
    // (liveShortsRedTapeOnly, 2026-09-24) while the tape is not red. The same
    // predicate rules on a short's scale-in and second lot.
    const shortPermission = candidateSignal.side === 'sell' ? liveShortPermitted(cfg, marketDirection) : null;
    if (shortPermission !== null && !shortPermission.permitted) {
      // Journaled once per symbol per ET day (task #61, the shape #43 settled
      // on). Until 2026-09-10 this skip left NO row, so the journal could not
      // say how many live-eligible shorts the live book declined on a day, or
      // which — the one number a decision to enable shorts needs. On 2026-09-09
      // 785 of 1,000 journaled signals were SELL and 15 of 17 of those names
      // closed below their open, and nothing recorded that live saw any of it.
      // The paper book takes shorts and records the outcome; this records the
      // decline, so the two can be joined. Not a behaviour change.
      //
      // Once per symbol per TAPE per day (2026-09-24), not per day: the red-tape
      // bar reads the shorts declined on a red tape, and a name first declined
      // on a mixed tape at 09:37 was never recorded again when the tape turned
      // red at 10:15, so the record could not say what a red-tape-only switch
      // would have taken. The key is the reading the gate acts on (held).
      const tape = marketDirection?.direction ?? 'none';
      if (claimOncePerDay('live_short_skipped', `${symbol}|${tape}`)) {
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'live_short_skipped',
          detail: {
            side: 'short',
            score: candidateSignal.score,
            entry: candidateSignal.entry,
            stop: candidateSignal.stop,
            target: candidateSignal.target,
            // What the ATR reachability gate right below would read, had
            // shorts been on: the replay applies the same rule (atrReach.ts).
            atr: candidateSignal.atr ?? null,
            direction: marketDirection?.direction ?? null,
            rawDirection: marketDirection ? (marketDirection.rawDirection ?? marketDirection.direction) : null,
            heldBy: marketDirection?.heldBy ?? null,
            // This skip runs BEFORE the score floor, both cooldowns and the
            // risk check, so a row exists for every scoring short candidate —
            // not for the ones the live book would actually have taken. On
            // 2026-09-10 that was 39 distinct symbols against THREE at or above
            // the floor, a 13x overstatement of live-eligible short flow, and
            // task #21's whole enabling decision reads this number. Stamping
            // the verdict here rather than leaving it to be re-derived means a
            // reader who does not know the gate order still counts the right
            // thing, and the floor travels with the row so a later change to
            // liveMinSignalScore cannot silently rewrite history.
            liveEligible: candidateSignal.score >= cfg.liveMinSignalScore,
            liveMinSignalScore: cfg.liveMinSignalScore,
            // Which refusal: the switch, or the red-tape rule with shorts on.
            // Both are a declined short, and the shadow record replays both.
            cause: shortPermission.cause,
            reason: shortPermission.reason,
          },
          riskProfile: cfg.riskProfile,
        });
      }
      outcomes.push({
        symbol,
        ok: false,
        reason: `short entry skipped — ${shortPermission.reason}`,
      });
      continue;
    }
    // Is 1R reachable on THIS name inside a session? A property of the SETUP,
    // not the portfolio — no sizing or slot decision can rescue a trade whose
    // 1R needs more than the stock's daily range.
    //
    // LIVE-ONLY, and that placement is the point (moved here 2026-09-01). It
    // first shipped inside generateSignal, which sits ABOVE the paper/live
    // split: loop.ts calls decide once and both books consume the same
    // signals, so the filter silently removed those names from PAPER too and
    // left the experiment measuring it with no control group. Every other
    // entry gate here is live-only for exactly that reason.
    // The rule itself is atrReach.ts's, shared with the replays that ask what
    // this path would have taken.
    const atrForReach = candidateSignal.atr;
    if (
      atrForReach &&
      atrReachRefuses(candidateSignal.entry, candidateSignal.stop, atrForReach, cfg.maxRiskAtrFraction)
    ) {
      const stopDistance = Math.abs(candidateSignal.entry - candidateSignal.stop);
      const reason =
        `1R costs ${(stopDistance / atrForReach).toFixed(2)}x this name's daily range ` +
        `(max ${cfg.maxRiskAtrFraction}) — not reachable in a session`;
      journalDeclinedEntry(candidateSignal, 'risk_atr_unreachable_skipped', cfg.liveMinSignalScore, {
        stopDistance: Math.round(stopDistance * 100) / 100,
        atr: Math.round(atrForReach * 100) / 100,
        ratio: Math.round((stopDistance / atrForReach) * 100) / 100,
        maxRiskAtrFraction: cfg.maxRiskAtrFraction,
        reason,
      });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    // Is the price FREE TO MOVE today? The gate above asks whether 1R fits
    // this name's TYPICAL range, from a 14-day ATR. That is the wrong question
    // for a stock pinned by a deal: BWIN's ATR was $1.133 (healthy, recent
    // daily ranges $0.83-$1.99) so it passed — while today's entire range was
    // $0.24. The gap that maxed its score also propped up the ATR the gate
    // trusts, so both read the past and both were fooled by the same candle.
    //
    // Live-only for the same reason the ATR gate is: paper stays the control.
    // Ordered AFTER it because that one is free, and this one costs a candle
    // fetch — cached five minutes per symbol, and the entry that proceeds pays
    // it again for entryExtension anyway, so only a skipped candidate is a
    // genuinely extra call.
    const absorbed = evaluateAbsorbedPrice({
      sessionRangeUsd: await sessionRangeUsdFor(symbol),
      atr: candidateSignal.atr,
      relVolume: candidateSignal.relVolume,
      minutesIntoSession: minutesIntoSession() ?? 0,
      minRelVolume: cfg.absorbedPriceMinRelVolume,
      maxRangeAtrFraction: cfg.absorbedPriceMaxRangeAtrFraction,
      minMinutesIntoSession: cfg.absorbedPriceMinMinutesIntoSession,
    });
    if (absorbed.verdict === 'absorbed' && absorbed.reason) {
      journalDeclinedEntry(candidateSignal, 'absorbed_price_skipped', cfg.liveMinSignalScore, {
        relVolume: absorbed.relVolume,
        rangeAtrRatio: absorbed.rangeAtrRatio,
        atr: candidateSignal.atr ?? null,
        minRelVolume: cfg.absorbedPriceMinRelVolume,
        maxRangeAtrFraction: cfg.absorbedPriceMaxRangeAtrFraction,
        reason: absorbed.reason,
      });
      outcomes.push({ symbol, ok: false, reason: absorbed.reason });
      continue;
    }

    const reentry = reentryCooldownFor(symbol, closedAutotradeForReentry, cfg.symbolReentryCooldownMinutes);
    if (reentry) {
      const reason = `Re-entry cooldown — exited ${reentry.minutesSince}m ago, resumes after ${reentry.cooldownMinutes}m`;
      // Journaled EVERY time, not once per day: a re-entry the loop wanted is
      // exactly the population to audit before trusting this gate, and the
      // whole reason it exists is that these were invisible.
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'symbol_reentry_cooldown_skipped',
        // Every tick, not once per day (see above), so this one keeps its own
        // writer rather than journalDeclinedEntry's throttle — but it carries
        // the same replay fields, because a refusal nobody can score is a
        // refusal nobody can judge.
        detail: {
          ...reentry,
          reason,
          side: declinedSide(candidateSignal.side),
          score: candidateSignal.score,
          entry: candidateSignal.entry,
          stop: candidateSignal.stop,
          liveEligible: candidateSignal.score >= cfg.liveMinSignalScore,
          liveMinSignalScore: cfg.liveMinSignalScore,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    const cooldown = cooldowns.get(symbol);
    if (cooldown) {
      const reason = `Symbol cooling down after ${cooldown.losses} losses since ${cooldown.lastLossDate} — resumes ${cooldown.until}`;
      journalDeclinedEntry(candidateSignal, 'symbol_cooldown_skipped', cfg.liveMinSignalScore, {
        ...cooldown,
        reason,
      });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    // ONE conviction gate, composing the everyday live floor, the armed-day
    // ramp and the High-Vol bar (from this tick's effective regime — the same
    // one that cut the size and tightened the target) — whichever bar is
    // strictest right now decides, and the gate says which, so a refusal stays
    // attributable. See entryScoreGate.ts for the 57-trade evidence behind
    // the everyday floor.
    const scoreGate = liveEntryScoreGate(candidateSignal.score, dailyTarget, cfg, regime.effectiveRegime);
    if (scoreGate.skip) {
      journalDeclinedEntry(candidateSignal, scoreGate.action ?? 'live_score_floor_skipped', cfg.liveMinSignalScore, {
        bar: scoreGate.bar,
        source: scoreGate.source,
        effectiveRegime: regime.effectiveRegime,
        reason: scoreGate.detail,
      });
      const label =
        scoreGate.source === 'armed_day'
          ? 'Armed-day selectivity'
          : scoreGate.source === 'high_vol_regime'
            ? 'Below the High-Vol conviction bar'
            : 'Below the live conviction floor';
      outcomes.push({ symbol, ok: false, reason: `${label}: ${scoreGate.detail}` });
      continue;
    }
    // THE MARKET-DIRECTION GATE (2026-09-23; marketDirection.ts). A long on a
    // broad red day or a short on a broad green one — the whole market leaning
    // against the trade, read from SPY and from how much of the universe is on
    // the other side of its prior close. On 2026-09-23 all four live longs were
    // bought into a red market and all four lost.
    //
    // Placed AFTER every gate that asks whether the book wants the trade at all
    // (the score floor above all), so each refusal here is an entry the live
    // book would otherwise have taken: the rows count what the gate costs or
    // saves, not the whole red day's flow. Live-only, like its neighbours: the
    // paper book keeps taking these as the control.
    if (
      cfg.marketDirectionGateEnabled &&
      marketDirection &&
      directionRefuses(marketDirection, declinedSide(candidateSignal.side))
    ) {
      const reason = `${marketDirection.detail} — a ${declinedSide(candidateSignal.side)} leans against it`;
      journalDeclinedEntry(candidateSignal, 'live_market_direction_skipped', cfg.liveMinSignalScore, {
        direction: marketDirection.direction,
        // Whether the reading was held (2026-09-24), so the refusals a hold
        // made can be counted apart from ones the bar made on its own.
        rawDirection: marketDirection.rawDirection ?? marketDirection.direction,
        heldBy: marketDirection.heldBy ?? null,
        indexSymbol: marketDirection.indexSymbol,
        indexChangePct: marketDirection.indexChangePct,
        redPct: marketDirection.redPct,
        greenPct: marketDirection.greenPct,
        breadthSample: marketDirection.sample,
        indexPct: marketDirection.indexPct,
        breadthPct: marketDirection.breadthPct,
        reason,
      });
      outcomes.push({ symbol, ok: false, reason: `Market direction: ${reason}` });
      continue;
    }
    // THE DAY'S ORDER BUDGET IS SPENT (2026-09-24). The guardrail refuses every
    // opening order past liveMaxOrdersPerDay, but only at placement: after the
    // level fetch, the correlation and sector lookups, the risk check, the
    // account read and the quote, and after an order intent has been written.
    // A sleeve at its cap paid all of that for every candidate on every tick
    // until the entry cutoff. The options sleeve did so 50 times in 32 minutes
    // on 2026-09-23, and those refused intents pushed the day's real orders out
    // of the Trade page's recent list. Asked here, after every gate that
    // decides whether the book wants the trade, so the declined-entry rows
    // those gates write are unchanged. Same predicate and inputs as the
    // guardrail, which stays the authority for an order placed later in this
    // same batch.
    const ordersToday = countTodaysOrders(Date.now(), 'stock');
    const orderCap = buildLiveTradingConfig(cfg).maxOrdersPerDay;
    if (!withinDailyOrderCap(ordersToday, orderCap)) {
      journalDeclinedEntry(candidateSignal, 'live_order_cap_skipped', cfg.liveMinSignalScore, {
        ordersToday,
        maxOrdersPerDay: orderCap,
      });
      outcomes.push({ symbol, ok: false, reason: `Daily order cap: ${ordersToday} placed vs ${orderCap}/day` });
      continue;
    }
    // Level-aware exits (levelPlan.ts): re-place this signal's ATR stop and R
    // target against real swing structure BEFORE anything downstream sizes or
    // prices from them. Runs here rather than in decide.ts deliberately — it
    // is live-equity only, which leaves the paper book running the unmodified
    // ATR plan as a control group to judge this against.
    //
    // One daily-bar fetch per candidate actually reaching execution (a handful
    // a day, never per screened name). A fetch failure yields no levels, which
    // the planner treats as "no structure" and hands the ATR plan straight
    // back — a data blip must never silently re-price a real order.
    let signal = candidateSignal;
    if (cfg.levelExitsEnabled) {
      // Fetch and scan the SAME span: these two numbers are one quantity, and
      // raising either alone does nothing. At the old 120 the detector could
      // not see a 52-week high at all (DE's sat 133 bars back), so a target
      // was placed above it.
      const bars = await getProvider()
        .getCandles(symbol, 'daily', { limit: cfg.levelLookbackBars })
        .catch(() => []);
      const plan = planAroundLevels({
        side: signal.side === 'buy' ? 'long' : 'short',
        entry: signal.entry,
        stop: signal.stop,
        target: signal.target,
        levels: detectLevels(bars, {
          pivotWindow: 3,
          tolerancePct: 0.75,
          lookbackBars: cfg.levelLookbackBars,
        }),
        // From the bars already in hand — no second fetch, and the same series
        // the levels were read from, so the reach cap and the wall cannot be
        // measured against different history.
        atr: atr(bars),
        relVolPace: signal.relVolPace ?? null,
        cfg: {
          enabled: true,
          minStrength: cfg.levelMinStrength,
          bufferPct: cfg.levelBufferPct,
          maxStopWidenPct: cfg.levelMaxStopWidenPct,
          minRewardR: cfg.levelMinRewardR,
          targetReachAtrMultiple: cfg.levelTargetReachAtrMultiple,
          breakoutRelVolPace: cfg.levelBreakoutRelVolPace,
        },
      });
      if (plan.veto) {
        // Journaled every time, not once per day like the cheap skips: a
        // rejection here is a trade the loop WANTED and structure refused, and
        // that is exactly the population to audit before trusting the veto.
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'level_veto',
          detail: {
            entry: signal.entry,
            atrStop: signal.stop,
            atrTarget: signal.target,
            cappedTarget: plan.target,
            rewardR: plan.rewardR,
            intendedRewardR: plan.intendedRewardR,
            reachCapped: plan.reachCapped,
            breakoutAllowed: plan.breakoutAllowed,
            minRewardR: cfg.levelMinRewardR,
            resistance: plan.resistancePrice,
            support: plan.supportPrice,
            reason: plan.detail,
          },
          riskProfile: cfg.riskProfile,
        });
        outcomes.push({ symbol, ok: false, reason: `Level veto: ${plan.detail}` });
        continue;
      }
      if (plan.stopAdjusted || plan.targetAdjusted) {
        signal = { ...signal, stop: plan.stop, target: plan.target };
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'level_exits_applied',
          detail: {
            entry: signal.entry,
            stop: plan.stop,
            target: plan.target,
            stopAdjusted: plan.stopAdjusted,
            targetAdjusted: plan.targetAdjusted,
            rewardR: plan.rewardR,
            // What the signal asked for, so the COST of the adjustment is
            // recoverable from the journal — rewardR alone cannot show it.
            intendedRewardR: plan.intendedRewardR,
            reachCapped: plan.reachCapped,
            breakoutAllowed: plan.breakoutAllowed,
            support: plan.supportPrice,
            resistance: plan.resistancePrice,
            reason: plan.detail,
          },
          riskProfile: cfg.riskProfile,
        });
      }
    }

    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
      runningPositions,
      cfg.correlationLookbackDays,
      cfg.correlationThreshold,
    );
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
      runningPositions,
      sectorOf,
    );
    const expectancyMultiplier =
      snapshot.gradeExpectancyMultipliers[
        convictionGrade(signal.score, {
          aMinScore: cfg.convictionGradeAMinScore,
          bMinScore: cfg.convictionGradeBMinScore,
        })
      ] ?? 1;
    const methodMultiplier = snapshot.methodMultipliers[methodOfEquitySignal(signal.side)] ?? 1;
    // Derived ONCE. The finish-line pre-factor and the risk check must reason
    // about the same count of prior same-day exits — two calls that agree today
    // is exactly what CLAUDE.md's "agree by construction" rule is about.
    const priorSameDayExits = sameDaySymbolExits(signal.symbol, closedLiveForRepeat, etDayForRepeat);
    // The finish-line trim, from every OTHER factor this entry will be sized
    // by. It is one of seven multipliers in the same product, so comparing the
    // gap to the bank line against a payoff derived from the raw
    // cfg.riskPerTradePct double-counted every cut already in force — see
    // computeFinishLineFactor's own note for the worked case.
    const finishLine = computeFinishLineFactor({
      enabled: cfg.finishLineSizingEnabled,
      dailyTarget,
      equity,
      riskPerTradePct: preFinishLineRiskPct(
        cfg.riskPerTradePct,
        preFinishLineFactors({
          consecutiveLosses,
          stepDownAfterLosses: cfg.stepDownAfterLosses,
          stepDownSizeCutPct: cfg.stepDownSizeCutPct,
          marketAtrPct,
          regimeAtrThresholdPct: cfg.regimeAtrThresholdPct,
          regimeSizeCutPct: cfg.regimeSizeCutPct,
          mlRegime: regime.mlRegime,
          mlRegimeEnabled: cfg.mlRegimeEnabled,
          mlRegimeSizeCutPct: cfg.mlRegimeSizeCutPct,
          todayRangePct: regime.todayRangePct,
          regimeShockRangeRatio: cfg.regimeShockRangeRatio,
          priorSameDayExits,
          repeatEntrySizeCutPct: cfg.repeatEntrySizeCutPct,
          equityCurveDerisk: cutFactor(snapshot.equityCurveDeriskActive, cfg.equityCurveDeriskCutPct),
          expectancy: expectancyMultiplier,
          method: methodMultiplier,
        }),
      ),
      // What a winner pays per $1 risked is the EFFECTIVE target — tightened
      // by the ML regime overlay under this tick's effective regime, the same
      // multiple decide.ts built the bracket from (regimeTargets.ts).
      rewardMultiple: regimeAdjustedTargets(cfg, regime.effectiveRegime).targetRMultiple,
    });
    const ctx: RiskCheckContext = {
      priorSameDayExits,
      repeatEntrySizeCutPct: cfg.repeatEntrySizeCutPct,
      equity,
      dayStartEquityUsd: dayStart,
      // Sticky for the rest of the day once the live halt has tripped
      // (dailyHaltVerdict): the live pool is stock plus options, as both checks.
      dailyHaltTripped: liveDrawdownHaltedOn(etToday()),
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
      sectorNotional: sectorAmount,
      maxSectorExposurePct: cfg.maxSectorExposurePct,
      candidateSector,
      marketAtrPct,
      regimeAtrThresholdPct: cfg.regimeAtrThresholdPct,
      regimeSizeCutPct: cfg.regimeSizeCutPct,
      mlRegime: regime.mlRegime,
      mlRegimeEnabled: cfg.mlRegimeEnabled,
      mlRegimeSizeCutPct: cfg.mlRegimeSizeCutPct,
      todayRangePct: regime.todayRangePct,
      regimeShockRangeRatio: cfg.regimeShockRangeRatio,
      equityCurveDeriskActive: snapshot.equityCurveDeriskActive,
      equityCurveDeriskCutPct: cfg.equityCurveDeriskCutPct,
      maxAdvParticipationPct: cfg.maxAdvParticipationPct,
      buyingPowerUsd: await buyingPowerForSide(signal.side),
      // The other two dollar bounds the guardrail will apply to this very
      // order, so the sizer AIMS at them instead of being judged by them.
      // Read after the await above, which is what populates exposureHeadroomUsd.
      maxOrderUsd: liveTradingCfg.maxOrderUsd,
      exposureHeadroomUsd,
      // Value the order the way the guardrail will — at its marketable limit,
      // not the raw signal entry. Signed: a buy's limit is above the quote and
      // a short's below, matching attemptLiveEntry's own buffer exactly.
      limitBufferPct: (signal.side === 'buy' ? 1 : -1) * MARKETABLE_LIMIT_BUFFER_PCT,
      expectancyMultiplier,
      methodMultiplier,
      finishLineFactor: finishLine.factor,
      finishLineDetail: finishLine.detail,
    };
    const result = evaluateRiskCheck(signal, ctx);
    if (!result.ok) {
      // JOURNAL THE REFUSAL (2026-09-01). This path used to drop a blocked
      // candidate silently: an `outcomes` entry reading 'Risk check blocked',
      // no event, and no record of WHICH rule refused it.
      //
      // Every `blocked` row in the journal comes from runPaperExecution() or
      // the manual preview route, so the LIVE book's refusals — the ones that
      // decide what real money does — were the only ones invisible. Asked why
      // buying power sat idle, the honest answer had to be inferred from a
      // dashboard gauge rather than read: the cap was `max_concurrent_positions`
      // at 2 of 2, which no journal row anywhere would have told you. It also
      // means historical claims about why live entries stopped were read off
      // PAPER rows and may have been misattributed.
      //
      // A distinct action rather than reusing 'blocked': folding these in with
      // paper's would preserve the exact ambiguity this exists to remove.
      // Only refusals are journaled — a pass already produces its own
      // live_order_placed (or a live_entry_blocked at the guardrail), so
      // logging passes here would double the row count to say nothing new.
      logAutotradeEvent({
        symbol,
        stage: 'risk_check',
        riskProfile: cfg.riskProfile,
        action: 'live_risk_blocked',
        detail: {
          // Named up front so the reason is readable without parsing `checks`,
          // and countable straight off the summary endpoint.
          failedRules: result.checks.filter((c) => !c.passed).map((c) => c.rule),
          checks: result.checks,
          quantity: result.sizing.suggestedQuantity,
        },
      });
      outcomes.push({ symbol, ok: false, reason: 'Risk check blocked' });
      continue;
    }

    // Re-fetch fresh config for the actual placement attempt — NOT the same
    // `cfg` snapshotted once above. That snapshot is deliberately reused for
    // the risk-check MATH across the batch (equity/profile consistency,
    // mirroring runPaperExecution()'s own batch convention), but the SAFETY
    // GATE (liveTradingEnabled/killSwitch/live caps) must not be "batch-frozen"
    // the same way: this loop awaits real broker round-trips between
    // candidates, and a kill switch engaged mid-batch has to stop the NEXT
    // candidate immediately, not just the next full cycle (an adversarial
    // review caught this — the human config was already re-fetched fresh
    // inside buildLiveTradingConfig(), but autotrade's own config wasn't).
    const freshCfg = getAutotradeConfig();
    // Isolate each candidate: a rare unexpected throw (e.g. a better-sqlite3
    // write error while recording the order) must not abort the REST of the
    // batch's candidates. attemptLiveEntry normally returns an outcome rather
    // than throwing (the broker client never throws), so this is a backstop.
    let outcome: LiveExecutionOutcome;
    try {
      outcome = await attemptLiveEntry(
        signal,
        result,
        freshCfg.riskProfile,
        freshCfg,
        marketRegime,
        marketAtrPct,
        regimeStamp(regime),
        regimeAdjustedTargets(freshCfg, regime.effectiveRegime).factor,
        bpBasis,
      );
    } catch (err) {
      const reason = `Unexpected error placing order: ${(err as Error).message}`;
      logAutotradeEvent({ symbol, stage: 'execution', action: 'live_entry_failed', detail: { reason } });
      outcome = { symbol, ok: false, reason };
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      // The risk the order really carries, not the risk the check approved —
      // they differ by whatever the quote drifted between the screen's tick
      // and placement, and it is the placed figure the aggregate budget has to
      // account for. Falls back to the approved amount for any path that
      // reports no placed figure, rather than charging the budget nothing.
      runningRisk += outcome.placedRiskUsd ?? result.approvedRiskAmount;
      runningCount += 1;
      // What the order really costs, straight from the placement. The
      // fallback keeps the old estimate for any path that somehow reports no
      // figure, rather than silently decrementing nothing.
      const notional = outcome.placedNotionalUsd ?? signal.entry * result.sizing.suggestedQuantity;
      runningPositions.push({
        symbol,
        notional,
        side: signal.side === 'buy' ? 'long' : 'short',
      });
      // A filled ENTRY has spent this money — the next candidate in the same
      // batch must not be sized against it too. The broker's own figure only
      // catches up on the next tick's read.
      //
      // Both sides decrement (2026-09-02). This used to read `signal.side ===
      // 'buy'` on the premise that "sells free buying power rather than
      // consuming it, matching guardrails.ts" — true of a CLOSING sell, and
      // false of every signal that reaches here. `runLiveExecution` is the
      // ENTRY batch: `side: 'sell'` means OPEN A SHORT, which consumes margin
      // exactly as a buy consumes cash. Left as it was, a batch that opened a
      // short would hand the next candidate buying power the short had
      // already spent — precisely the double-spend this decrement exists to
      // prevent.
      //
      // Fourth site of the same confusion, and the one the earlier three
      // missed: guardrails.ts and buyingPowerSizing.ts were both moved from
      // `side` to `openClose`, and buyingPowerForSide above was fixed to
      // return a figure for both sides — but fixing the READ left this
      // WRITE-BACK on the old premise. Assert at the consumer.
      if (availableBuyingPowerUsd !== undefined) {
        availableBuyingPowerUsd = Math.max(0, availableBuyingPowerUsd - notional);
      }
      // Exposure moves with the same notional and for the same reason: a
      // second entry in this tick must not be sized against headroom the
      // first one already consumed. Leaving this out would reproduce the
      // double-spend the buying-power decrement above exists to prevent,
      // one bound over.
      if (exposureHeadroomUsd !== undefined) {
        exposureHeadroomUsd = Math.max(0, exposureHeadroomUsd - notional);
      }
      skipSymbols.add(symbol);
    }
  }
  return outcomes;
}

export interface LiveReconcileOutcome {
  intentId: number;
  symbol: string;
  changed: boolean;
  /** Set when this reconcile materialized a fill into a real `positions` row
   *  (entry) or recorded an exit against one (a bracket leg firing). */
  action?: 'entry_filled' | 'exit_filled';
  error?: string;
}

/**
 * Poll every non-terminal autotrade-placed order for a status change, and
 * materialize the result into the real `positions` ledger: an ENTRY fill
 * creates a Position (tagged ['live','autotrade'], stop/target carried over
 * from the signal); a bracket EXIT leg firing records an exit against the
 * matching open position. Runs every cycle regardless of either kill switch —
 * this only detects and records what the broker already did; it places
 * nothing (mirrors reconcileIntent()'s own read-only-toward-the-broker
 * posture, and the Phase 7 "exits always run" precedent for paper).
 *
 * Exit-leg detection is BEST-EFFORT and not yet probe-confirmed against a
 * real bracket fill (see WebullOrderLeg's own caveat in providers/webull/
 * orders.ts) — it fails closed: if no leg unambiguously reports a FILLED
 * status distinct from the entry, the position is left open rather than
 * guessed closed. A real live trade should be used to confirm this before
 * fully trusting it.
 */
export async function reconcileLiveOrders(): Promise<LiveReconcileOutcome[]> {
  const cfg = getAutotradeConfig();
  const accountId = cfg.liveAccountId;
  if (!accountId) return [];

  const pending = listPendingLiveOrders();
  const intentsById = getIntents(pending.map((p) => p.intentId));
  // One pair of list fetches for every pending order, rather than a pair each:
  // the order-query endpoints allow 2 requests per 2 seconds, so polling per
  // order rate-limited this loop against itself once there were more than a
  // couple to reconcile. See webullOrderStatusBatch.
  const statuses = await webullOrderStatusBatch(
    accountId,
    pending.map((p) => intentsById.get(p.intentId)?.idempotencyKey).filter((k): k is string => !!k),
  );

  // Acknowledged orders neither list accounted for are looked up directly
  // (Order Detail) and folded into `statuses`, so the loop below reconciles
  // them exactly as it reconciles a list answer. See orderDetailFallback.ts:
  // SHOP's 2026-09-22 close is why this exists, and the options reconcile
  // calls the same function.
  await resolveUnlistedFromOrderDetail(
    'stock',
    accountId,
    pending.flatMap((meta) => {
      const intent = intentsById.get(meta.intentId);
      return intent ? [{ intent, symbol: meta.symbol, role: meta.role, riskProfile: meta.riskProfile }] : [];
    }),
    statuses,
  );

  // A bracket leg the lists have not shown filled yet (#147): once the sync
  // has found the position's shares gone, its stored legs are asked by Order
  // Detail, and a FILLED answer lands in `statuses` for the loop below to book
  // like a listed leg. See resolveFilledLegsFromOrderDetail.
  await resolveFilledLegsFromOrderDetail(
    accountId,
    filledBracketLegCandidates(accountId, pending, intentsById),
    statuses,
  );

  const outcomes: LiveReconcileOutcome[] = [];
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
      // Couldn't ask — say nothing about the order and try again next tick.
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }
    if (!broker.found) {
      // Resolve an UNKNOWN placement (attemptLiveEntry's ambiguous branch): the
      // intent is still 'submitted' with no broker id because we never heard
      // back. Both the open-orders and history endpoints answered and neither
      // knows this client order id, which is positive evidence it never landed —
      // so retire it rather than leaving it pending forever, holding the
      // symbol's dedup slot and its risk against the aggregate cap.
      // An ACKNOWLEDGED order missing from both is a different case (it landed
      // once and may simply have aged out of the history window), so that one is
      // still left alone.
      //
      // Only once it has been outstanding long enough for the broker to have
      // recorded it — see UNKNOWN_PLACEMENT_RETIRE_GRACE_MS. Retiring on the
      // very next tick re-opens the double-place hole this branch exists to
      // close, since freeing the dedup slot is exactly what lets the next cycle
      // place the same real order again.
      if (canRetireUnknownPlacement(intent)) {
        transitionIntent(intent.id, 'rejected', {
          detail: 'placement outcome was unknown; broker reports no such order — never reached it',
        });
        logAutotradeEvent({
          symbol: meta.symbol,
          stage: 'execution',
          action: 'live_order_never_placed',
          detail: { intentId: intent.id, clientOrderId: intent.idempotencyKey },
          riskProfile: meta.riskProfile,
        });
        outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: true });
        continue;
      }
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }

    const changed = reconcileOneLiveOrder(intent, meta, broker);
    outcomes.push({ intentId: intent.id, symbol: meta.symbol, ...changed });
  }
  return outcomes;
}

/**
 * Whether the broker no longer holds ANY of a position's shares, by the sync's
 * latest reading (2026-09-25, #147 on review): at least one miss, with the
 * broker showing 0. A miss alone is any gap, and a partial one (a hand trim, a
 * scale-out sold but not yet booked) leaves shares that still need their stop.
 * The Order Detail candidates and the ratchet both ask this, so the two cannot
 * disagree about when a position's shares are gone.
 */
function sharesGoneAtBroker(accountId: string, pos: Position): { gone: boolean; missStreak: number } {
  const key = contractKey(pos);
  const missStreak = missStreakOf(accountId, key);
  return { gone: missStreak >= 1 && missStreakBrokerQty(accountId, key) === 0, missStreak };
}

/**
 * The filled bracket entries whose shares the broker no longer shows (#147):
 * a filled bracket entry, its position still open in the ledger, at least one
 * stored exit-leg id, and a sync whose latest miss found none of the shares.
 * One miss is enough here, where the sync waits for two before it acts: this
 * only ASKS, and only a leg the broker itself reports FILLED for the whole
 * remaining quantity is booked.
 *
 * Newest first (2026-09-25, on review): the lookups per tick are budgeted, and
 * a position whose own closing order is already working (a time exit, the
 * end-of-day flatten) has cancelled its legs and books through that order, so
 * it is left out rather than spending the budget a real leg fill needs.
 */
function filledBracketLegCandidates(
  accountId: string,
  pending: LiveOrderMeta[],
  intentsById: Map<number, OrderIntentRecord>,
): FilledBracketLegCandidate[] {
  // A close still WORKING, not merely listed: a scale-out's filled exit row
  // stays pending while its position is open (positionsWithWorkingClose).
  const closing = positionsWithWorkingClose(pending, (id) => intentsById.get(id)?.state);
  const out: FilledBracketLegCandidate[] = [];
  // One candidate per position, from its NEWEST filled bracket row: a re-arm
  // writes the legs it placed there (recordRearmedLegs), and an older row of a
  // scaled-in position still names legs that re-arm cancelled. Asking those
  // spent the tick's lookups on orders that cannot have filled. An add-on not
  // filled yet does not qualify, so the original row still stands for it.
  const asked = new Set<number>();
  for (const meta of [...pending].reverse()) {
    if (meta.role !== 'entry' || meta.positionId === null) continue;
    if (!meta.takeProfitClientOrderId && !meta.stopLossClientOrderId) continue;
    if (closing.has(meta.positionId) || asked.has(meta.positionId)) continue;
    const intent = intentsById.get(meta.intentId);
    if (!intent || intent.state !== 'filled' || !intent.isBracket) continue;
    const pos = getPosition(meta.positionId);
    if (!pos || pos.status !== 'open') continue;
    asked.add(meta.positionId);
    const { gone, missStreak } = sharesGoneAtBroker(accountId, pos);
    if (!gone) continue;
    out.push({
      intent,
      symbol: meta.symbol,
      positionId: meta.positionId,
      riskProfile: meta.riskProfile,
      takeProfitClientOrderId: meta.takeProfitClientOrderId,
      stopLossClientOrderId: meta.stopLossClientOrderId,
      missStreak,
      remainingQuantity: pos.remainingQuantity,
    });
  }
  return out;
}

/** Point a position's entry row at the legs a re-arm just placed (#147). The
 *  entry bracket's own legs are cancelled by then, so a leg fill is found only
 *  by asking these. No entry row (an imported position): nothing to point. */
function recordRearmedLegs(positionId: number, legs: BracketLegIds | undefined): void {
  const entry = getLiveEntryOrderForPosition(positionId);
  if (entry) setLiveOrderLegClientOrderIds(entry.intentId, legs ?? {});
}

function reconcileOneLiveOrder(
  intent: OrderIntentRecord,
  meta: LiveOrderMeta,
  broker: Awaited<ReturnType<typeof webullOrderStatus>>,
): { changed: boolean; action?: 'entry_filled' | 'exit_filled'; error?: string } {
  const { stopPrice, targetPrice, riskAmount, riskProfile, accountId } = meta;
  // The MASTER (entry) leg's own status, same field reconcileIntent() already
  // uses for a non-bracket order. Also this table's ROLE='exit' order's own
  // (and only) status -- a time-exit closing order is never a bracket, so
  // its fill is exactly this simple, same as a plain non-bracket order.
  const masterTarget = broker.status ? mapWebullStatus(broker.status) : undefined;
  // The broker knows this order, so an unknown-outcome placement (left at
  // 'submitted' by attemptLiveEntry's ambiguous branch) is resolved: record the
  // acknowledgement we never received before applying the status. Without it a
  // FILLED observed straight off an ambiguous place is an illegal transition
  // from 'submitted', so canMove was false and the order sat here forever —
  // polled every tick, holding the symbol's dedup slot, with the real filled
  // position never materialized. See ackUnknownPlacement.
  const { intent: current, acked } = ackUnknownPlacement(intent, broker.brokerOrderId);
  const canMove =
    !!masterTarget &&
    !isTerminal(current.state) &&
    masterTarget !== current.state &&
    canTransition(current.state, masterTarget);
  // An order resting at `partially_filled` across two ticks hasn't changed
  // state but may have filled further, and a partial that is later CANCELLED
  // leaves this table's polling set entirely (listPendingLiveOrders excludes
  // cancelled intents). Both are handled by materializing on every observed
  // fill rather than only on the terminal one — see materializeLiveFill.
  const restingPartial = masterTarget === 'partially_filled' && current.state === 'partially_filled';
  // A status the mapper doesn't recognize used to make this whole function a
  // silent no-op — and if that response carried a filled quantity, those were
  // real autotrade-opened shares dropped without a state change, a position
  // row, or a single line anywhere saying so. The label and the fill are
  // separate facts: not knowing what to call the state is no reason to discard
  // what the broker reported filled, and computeFillDelta's guards make acting
  // on it safe (they only ever book less than reported). Book it, leave the
  // lifecycle alone, and journal the unrecognized status once so it surfaces.
  const unrecognizedFill = !!broker.status && masterTarget === undefined && (broker.filledQty ?? 0) > 0;
  if (!!broker.status && masterTarget === undefined) {
    const noted = recordIntentNoteOnce(
      current.id,
      `broker reported an unrecognized status "${broker.status}" — lifecycle left unchanged, ` +
        `any reported fill is still booked`,
    );
    // Once per intent+status, not once per 60s tick.
    if (noted) {
      logAutotradeEvent({
        symbol: current.symbol,
        stage: 'execution',
        action: 'live_broker_status_unrecognized',
        detail: { intentId: current.id, status: broker.status, filledQty: broker.filledQty ?? 0 },
        riskProfile,
      });
    }
  }
  // A crash on an earlier tick (or a materialization failure before booking
  // and its mark were transactional) can leave a terminal 'filled' intent
  // whose booking never landed. listPendingLiveOrders keeps re-selecting
  // exactly that shape (entry with position_id NULL) — but this gate used to
  // turn each re-selection into a no-op: canMove is false once the state is
  // terminal, so the stranded fill was re-polled forever and booked never
  // (the try/catch's own comment below called it permanent; it no longer is).
  // Let the fill delta decide instead: computeFillDelta books only what's
  // missing, so a fully-booked filled intent still no-ops while a stranded
  // one finally lands (within one tick of the crash).
  const strandedFilled = current.state === 'filled' && current.materializedQty < current.quantity;
  if (canMove || restingPartial || unrecognizedFill || strandedFilled) {
    if (canMove) {
      transitionIntent(current.id, masterTarget!, {
        detail: `broker ${broker.status?.toLowerCase()}`,
        brokerOrderId: broker.brokerOrderId,
      });
    }
    // How much the broker says is filled. A terminal FILLED implies the whole
    // order even when the response omits the quantity outright (some do), which
    // is why this falls back to the intent's own size there but to ZERO on any
    // other status — a CANCELLED with no quantity field filled nothing, and
    // assuming otherwise would fabricate a position.
    const observedQty = broker.filledQty ?? (masterTarget === 'filled' ? intent.quantity : 0);

    // Keyed on the broker REPORTING a fill, not on which state it reported: a
    // partial that gets cancelled between two 60s ticks arrives as a single
    // CANCELLED response still carrying its filled quantity, and that intent
    // then leaves listPendingLiveOrders() for good (its WHERE clause excludes
    // cancelled/rejected/expired). If this tick doesn't book it, nothing ever
    // will — real autotrade-opened shares, permanently invisible to the Auto
    // page's risk and P&L accounting.
    if (observedQty > 0) {
      // The intent transition above has ALREADY committed by this point — if
      // materializing the position throws, the intent is left at terminal
      // 'filled' with no positions row. That used to be PERMANENT data loss
      // (an adversarial review's finding; no try/catch existed at all). It
      // now self-heals: listPendingLiveOrders() re-selects a filled entry
      // with no linked position, and the strandedFilled admission above lets
      // it back into this block on the next tick, where computeFillDelta
      // books exactly the missing part. The catch below still matters — a
      // failure must not crash the rest of this cycle's other pending
      // orders, and it must be LOUD (there's no human watching this path in
      // real time the way the Trade page assumes).
      try {
        // Book only the part of the broker's running fill total we haven't
        // recorded yet, under the shared guards the human path uses too (see
        // trading/fillDelta.ts). Every ambiguous case there resolves toward
        // recording LESS, so a broker whose semantics differ from our reading
        // can leave a fill under-recorded — recoverable, and loudly logged —
        // but can never inflate an autotrade position's size or cost basis,
        // which would corrupt every risk figure derived from it.
        // `??` does not fire on 0, and the vendor docs say filled_price "may be
        // zero or null" before execution completes — so a literal 0 used to
        // pass straight through to be booked as a real cost basis. Fall back to
        // the limit price for a zero exactly as for a null; computeFillDelta
        // refuses outright if that is unusable too.
        const observedPrice =
          broker.filledPrice !== undefined && broker.filledPrice !== null && broker.filledPrice > 0
            ? broker.filledPrice
            : (intent.limitPrice ?? 0);
        const { qty, price, warning } = computeFillDelta(intent, observedQty, observedPrice);

        if (warning) {
          logAutotradeEvent({
            symbol: intent.symbol,
            stage: 'execution',
            action: 'live_fill_not_fully_materialized',
            detail: { intentId: intent.id, observedQty, alreadyBooked: intent.materializedQty, warning },
            riskProfile,
          });
        }
        // Nothing new to record — either this fill was already booked on an
        // earlier tick, or the guards refused it.
        if (qty <= 0) return { changed: acked || canMove, error: warning };

        // Every branch below commits its booking and the materialization mark
        // in ONE transaction. The mark is the only thing telling a later tick
        // "this part is already booked" (computeFillDelta keys on it, and the
        // blend-vs-create discriminator below reads it directly) — as two bare
        // auto-committing writes, a crash landing between them replayed the
        // SAME fill on the next tick: a doubled position, add-on, or exit
        // against real live capital. All materialize paths are synchronous, so
        // a better-sqlite3 transaction is safe.
        if (meta.role === 'exit') {
          // A time-exit closing order — meta.positionId is known upfront
          // (recordLiveExitOrder), unlike an entry's positionId which is
          // null until THIS materialization sets it.
          let recorded = false;
          db.transaction(() => {
            recorded = materializeTimeExitFill(meta.positionId!, intent, price, riskProfile, qty);
            if (recorded) advanceMaterialized(intent.id, qty, qty * price);
          })();
          return recorded ? { changed: true, action: 'exit_filled' } : { changed: acked || canMove };
        }
        if (meta.addonOfPositionId !== null) {
          // A scale-in ADD-ON fill — MERGE into the already-open position
          // (blended entry, bigger quantity) rather than creating a second
          // position row. Its own protective bracket (raised stop + the
          // position's target) rests separately, watched via the bracket-leg
          // block below on later ticks once position_id is linked here.
          db.transaction(() => {
            materializeAddOnFill(meta.addonOfPositionId!, intent, qty, price, riskProfile);
            advanceMaterialized(intent.id, qty, qty * price);
          })();
          return { changed: true, action: 'entry_filled' };
        }

        // A plain entry. autotrade_live_orders.position_id is a SINGLE column,
        // so one intent maps to exactly ONE position — unlike the human ledger,
        // a later instalment must BLEND into the position the first instalment
        // created rather than opening a second row that nothing could link to.
        //
        // The discriminator is OUR OWN materialization mark, not whether
        // position_id is set: adoptOrphanedLivePositions() also sets that column
        // (for a position imported whole from the broker), so treating a linked
        // id as "we booked an earlier instalment" would blend a full fill into
        // an already-complete adopted position and double its quantity — the
        // very duplication adoption exists to prevent. materializedQty is only
        // ever advanced by this function, so it means exactly what's needed here.
        const linkedId = getLiveOrder(intent.id)?.positionId ?? null;
        if (intent.materializedQty > 0 && linkedId !== null) {
          db.transaction(() => {
            materializeAddOnFill(linkedId, intent, qty, price, riskProfile);
            advanceMaterialized(intent.id, qty, qty * price);
          })();
          return { changed: true, action: 'entry_filled' };
        }

        db.transaction(() => {
          const outcome = materializeEntryFill(
            intent,
            stopPrice,
            targetPrice,
            riskAmount,
            riskProfile,
            accountId,
            qty,
            price,
          );
          // An ADOPTED position was imported from the broker whole, so it
          // already reflects every instalment of this order — including ones
          // we never observed. Mark the intent fully booked so a later partial
          // can't blend quantity into it a second time.
          if (outcome === 'linked_adopted') {
            const remaining = intent.quantity - intent.materializedQty;
            if (remaining > 0) advanceMaterialized(intent.id, remaining, remaining * price);
          } else {
            advanceMaterialized(intent.id, qty, qty * price);
          }
        })();
        return { changed: true, action: 'entry_filled' };
      } catch (err) {
        const message = (err as Error).message;
        logAutotradeEvent({
          symbol: intent.symbol,
          stage: 'execution',
          action: meta.role === 'exit' ? 'live_time_exit_materialization_failed' : 'live_entry_materialization_failed',
          detail: { intentId: intent.id, error: message },
          riskProfile,
        });
        return {
          changed: true,
          error:
            meta.role === 'exit'
              ? `Broker fill recorded but failed to materialize the close: ${message}`
              : `Broker fill recorded but failed to materialize a Position: ${message}`,
        };
      }
    }
    return { changed: true };
  }

  // Once the entry itself is filled, look for an EXIT leg (STOP_LOSS or
  // STOP_PROFIT) having also filled. Best-effort per this function's header
  // caveat: only acts on a leg unambiguously identified as non-MASTER AND
  // FILLED; anything else (including two legs BOTH reporting FILLED, which
  // shouldn't happen under normal OCO semantics but isn't ruled out given
  // this response shape is unconfirmed) leaves the position open rather
  // than guessing. Entry rows only — a role='exit' order is never a bracket
  // (checkLiveEquityTimeExits places a plain close), so it has no exit legs
  // of its own to look for here.
  if (meta.role === 'entry' && current.state === 'filled' && current.isBracket && broker.legs) {
    const filledExitLegs = broker.legs.filter((l) => isExitLeg(l) && l.status === 'FILLED');
    if (filledExitLegs.length > 1) {
      logAutotradeEvent({
        symbol: intent.symbol,
        stage: 'execution',
        action: 'live_exit_ambiguous',
        detail: { intentId: intent.id, legs: filledExitLegs.map((l) => l.comboType) },
        riskProfile,
      });
      return {
        changed: acked,
        error: 'Two exit legs both reported FILLED — ambiguous, left open rather than guessed',
      };
    }
    const exitLeg = filledExitLegs[0];
    if (exitLeg) {
      // Which bracket leg filled IS the exit reason — the one place in the
      // live path that knows it firsthand rather than inferring from price.
      // Named by the same function the estimate correction uses
      // (exitPriceBackfill.ts), so the two can never disagree about a leg. An
      // unlabelled leg that is not a stop order stays a target, as before.
      const legReason = legExitReason(exitLeg) ?? 'target';
      const fallbackPrice = legReason === 'stop' ? stopPrice : targetPrice;
      try {
        const recorded = materializeExitFill(
          intent,
          meta.positionId,
          exitLeg.filledPrice ?? fallbackPrice,
          riskProfile,
          exitLeg.filledQty,
          legReason,
        );
        return recorded ? { changed: true, action: 'exit_filled' } : { changed: acked };
      } catch (err) {
        const message = (err as Error).message;
        logAutotradeEvent({
          symbol: intent.symbol,
          stage: 'execution',
          action: 'live_exit_materialization_failed',
          detail: { intentId: intent.id, error: message },
          riskProfile,
        });
        return {
          changed: true,
          error: `Broker exit recorded but failed to materialize against the Position: ${message}`,
        };
      }
    }
  }
  return { changed: acked };
}

function materializeEntryFill(
  intent: OrderIntentRecord,
  stopPrice: number,
  targetPrice: number,
  riskAmount: number,
  riskProfile: string,
  accountId: string | null,
  filledQty: number,
  filledPrice: number,
): 'created' | 'linked_adopted' {
  // This fill may belong to a position adoptOrphanedLivePositions() already
  // adopted under this SAME intent, earlier: reconcile missed the fill on an
  // earlier tick, the generic Webull position-sync backstop imported the real
  // holding untagged, and adoption retagged it before THIS (later) tick's
  // reconcile finally caught up and observed the broker-reported fill. An
  // adopted orphan never has sourceIntentId set (adoption deliberately can't
  // patch it post-creation — see adoptOrphanedLivePositions' own doc comment),
  // so an open, autotrade-tagged, sourceIntentId-less position for this exact
  // symbol is a reliable "already handled, just needs linking" signal — not
  // some unrelated already-tracked position, which always has ITS OWN
  // sourceIntentId set at creation. Skipping this check would create a
  // genuine SECOND position for the SAME real fill; the generic sync's own
  // close-detection half would then "clean up" the resulting doubled
  // quantity by auto-closing the older (adopted) one with a FABRICATED
  // estimated exit price, corrupting the journal with a trade that never
  // happened. Link, don't duplicate.
  //
  // WIDENED 2026-08-24 after this raced in production. The check below used to
  // require the orphan to be ALREADY autotrade-tagged — i.e. it only caught
  // orphans adoptOrphanedLivePositions() had gotten to first. But the import
  // can land BETWEEN the broker's fill and this reconcile, with no adoption
  // pass in between: VALE filled, the position-sync imported it as a plain
  // ['webull'] row, and moments later this function looked for an
  // autotrade-tagged orphan, found none, and created a SECOND row for the same
  // 81 real shares. The journal then read 162 shares against a broker holding
  // of 81, and the sync's close-detection half "fixed" it by closing the
  // excess at an estimated price — exactly the corruption the original comment
  // warned about, reached through the one door it left open. So an untagged
  // broker-imported orphan now counts too, and is adopted here (retagged,
  // stop/target backfilled) instead of duplicated.
  //
  // Safe against stealing a human's holding: runLiveExecution() refuses to
  // place an entry for a symbol that has ANY open position, so at placement
  // time there was none — an orphan for this symbol appearing before the fill
  // reconciles can only be this fill. Account agreement is still required
  // where both sides know it, mirroring adoptOrphanedLivePositions().
  //
  // SHARES ONLY (2026-09-23). "Can only be this fill" held for the stock book
  // alone. The options sleeve trades the same names, and the generic sync
  // imports its contracts into this table as untagged ['webull'] rows under the
  // UNDERLYING's symbol. At 09:37 both sleeves bought MRNA — 129 shares and 3
  // calls — and this lookup, newest first, took the CALL (row 692): tagged
  // autotrade with the shares' stop and target, closed by the sync at an
  // estimated 1.56 when the call was sold, it booked −$384 the stock book never
  // lost, while the real shares (row 690, a +$546 take-profit) stayed untagged
  // and uncounted. The phantom tripped the −7.5% daily halt at 10:23, on a real
  // day of about −4.3%. A stock order fills in shares; only a stock row can be
  // that fill.
  //
  // AND ON THE ORDER'S SIDE (2026-09-23, shorts pre-flight): a buy fills a
  // long, a short sale fills a short. A long row the operator holds in the name
  // is not a short order's fill, and adopting it would book the short's P&L
  // with the sign reversed.
  const fillSide = positionSideOf(intent.side);
  const orphanCandidates = listPositions({ status: 'open', symbol: intent.symbol }).filter(
    (p) => p.assetType === 'stock' && p.sourceIntentId === null && p.side === fillSide,
  );
  const adopted =
    orphanCandidates.find((p) => isAutotradePosition(p)) ??
    orphanCandidates.find(
      (p) =>
        (p.tags.includes('webull') || p.tags.includes('live')) &&
        (accountId == null || p.accountId == null || p.accountId === accountId),
    );
  if (adopted) {
    const meta = getLiveOrder(intent.id);
    // The entry stamp is applied OUTSIDE the untagged-healing block below,
    // because a null entryDate breaks tradesToday/maxTradesPerDay whether or
    // not the orphan carried the tag — adoptOrphanedLivePositions() may have
    // retagged it a tick earlier without stamping it, and did until 2026-08-31.
    // See entryStampPatch().
    const entryStamp = entryStampPatch(adopted, meta?.createdAt ?? Date.now());
    // An untagged orphan needs the same healing adoptOrphanedLivePositions()
    // would have applied: without the tag it stays invisible to every
    // autotrade-scoped figure (open risk, daily P&L, the method ledger).
    if (!isAutotradePosition(adopted)) {
      // Carry the same at-entry context the create path below records. It is
      // known here (it lives on the order, not the fill) and nothing else ever
      // backfills it, so without this an adopted position is permanently
      // missing its grade/score/regime and its entry VWAP — silently shrinking
      // the very datasets those fields exist to build.
      updatePosition(adopted.id, {
        tags: Array.from(new Set([...adopted.tags, ...AUTOTRADE_TAGS])),
        stopPrice: adopted.stopPrice ?? stopPrice,
        targetPrice: adopted.targetPrice ?? targetPrice,
        grade: adopted.grade ?? meta?.grade ?? null,
        entryScore: adopted.entryScore ?? meta?.entryScore ?? null,
        // `adopted.entryComponents ??` first, like its five siblings. Until
        // 2026-09-04 this line alone lacked the preserve-existing prefix, so it
        // was the one write here that could DESTROY a value rather than backfill
        // one — overwriting components the position already had with null
        // whenever the order's meta lacked them.
        //
        // No production row is known to have been lost to it: this branch only
        // runs for an UNTAGGED orphan, and the only writers of position
        // entryComponents are the autotrade entry paths, which tag. (The 17 of
        // 30 September rows missing components are explained entirely by #471's
        // ship date — the cutover is clean at 09-03, with no pre-09-03 row
        // carrying them and no post-09-03 row missing them.) It is fixed as a
        // reachability-independent asymmetry: one field of six written to a
        // different rule is a latent bug waiting for a new caller.
        entryComponents: adopted.entryComponents ?? meta?.entryComponents ?? null,
        marketRegime: adopted.marketRegime ?? meta?.marketRegime ?? null,
        marketAtrPct: adopted.marketAtrPct ?? meta?.marketAtrPct ?? null,
        mlRegime: adopted.mlRegime ?? meta?.mlRegime ?? null,
        regimeTargetFactor: adopted.regimeTargetFactor ?? meta?.regimeTargetFactor ?? null,
        entryVwap: adopted.entryVwap ?? meta?.entryVwap ?? null,
        stopSqueezeRatio: adopted.stopSqueezeRatio ?? meta?.stopSqueezeRatio ?? null,
        plannedStopDistancePct: adopted.plannedStopDistancePct ?? meta?.plannedStopDistancePct ?? null,
        ...(entryStamp ?? {}),
      });
    } else if (entryStamp) {
      // Already tagged, but still missing its entry stamp — the cap needs it
      // just the same.
      updatePosition(adopted.id, entryStamp);
    }
    setLiveOrderPositionId(intent.id, adopted.id);
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: 'live_position_linked_to_adopted',
      detail: {
        positionId: adopted.id,
        quantity: filledQty,
        entryPrice: filledPrice,
        wasUntagged: !isAutotradePosition(adopted),
      },
      riskProfile,
    });
    return 'linked_adopted';
  }

  // Entry timestamp: the ORDER's placement moment, not this reconcile pass's
  // wall clock. A marketable-limit entry fills within seconds of placement,
  // while materialization happens on a LATER reconcile tick (a minute later
  // normally, longer if a tick was missed) — dating the entry by the reconcile
  // would drift every fill toward "later than it happened", and entry_time is
  // exactly the field the Journal's time-of-day session buckets read.
  const orderMeta = getLiveOrder(intent.id);
  const placedAt = orderMeta?.createdAt ?? Date.now();
  const position = createPosition({
    assetType: 'stock',
    symbol: intent.symbol,
    side: positionSideOf(intent.side),
    quantity: filledQty,
    entryPrice: filledPrice,
    entryDate: etDateStr(placedAt),
    entryTime: etTimeOfDay(placedAt),
    stopPrice,
    targetPrice,
    notes: `Auto-placed by autotrade — order #${intent.id}${intent.brokerOrderId ? ` (broker ${intent.brokerOrderId})` : ''}`,
    tags: AUTOTRADE_TAGS,
    grade: orderMeta?.grade ?? null,
    entryScore: orderMeta?.entryScore ?? null,
    entryComponents: orderMeta?.entryComponents ?? null,
    marketRegime: orderMeta?.marketRegime ?? null,
    marketAtrPct: orderMeta?.marketAtrPct ?? null,
    mlRegime: orderMeta?.mlRegime ?? null,
    regimeTargetFactor: orderMeta?.regimeTargetFactor ?? null,
    entryVwap: orderMeta?.entryVwap ?? null,
    stopSqueezeRatio: orderMeta?.stopSqueezeRatio ?? null,
    plannedStopDistancePct: orderMeta?.plannedStopDistancePct ?? null,
    sourceIntentId: intent.id,
    accountId,
  });
  setLiveOrderPositionId(intent.id, position.id);
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_position_opened',
    detail: { quantity: filledQty, entryPrice: filledPrice, stopPrice, targetPrice, riskAmount },
    riskProfile,
  });
  return 'created';
}

/** Merge a scale-in ADD-ON fill into an already-open live position: blend the
 *  entry toward the fill and grow the quantity, so cost basis and P&L stay
 *  honest. The position's own stop/target (its ORIGINAL bracket, still resting
 *  and protecting the original shares) are deliberately left untouched — the
 *  ADDED shares are protected by the add-on's OWN bracket, whose stop/target
 *  legs reconcile independently via the bracket-leg block. Links the add-on
 *  order's intent to the position (so it stops re-materializing and its bracket
 *  legs get watched). Fails closed if the position is gone/closed — never
 *  fabricates a position. */
function materializeAddOnFill(
  positionId: number,
  intent: OrderIntentRecord,
  filledQty: number,
  filledPrice: number,
  riskProfile: string,
): void {
  setLiveOrderPositionId(intent.id, positionId);
  const position = getPosition(positionId);
  if (!position || position.status !== 'open') {
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: 'live_scale_in_orphaned',
      detail: { positionId, filledQty, filledPrice, reason: 'position not open at add-on fill time' },
      riskProfile,
    });
    return;
  }
  const oldQty = position.quantity;
  const newQty = oldQty + filledQty;
  const blendedEntry =
    newQty > 0 ? (position.entryPrice * oldQty + filledPrice * filledQty) / newQty : position.entryPrice;
  updatePosition(positionId, { quantity: newQty, entryPrice: blendedEntry });
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_scaled_in_filled',
    detail: { positionId, addQty: filledQty, addPrice: filledPrice, blendedEntry, newQuantity: newQty },
    riskProfile,
  });
}

/** Record an exit against the open autotrade position this intent produced.
 *  Returns false (a no-op) if the position can't be found or is already
 *  closed — defensive against a double-reconcile of the same fill. Matches
 *  EITHER sourceIntentId (set on entry fill by materializeEntryFill's normal
 *  create path) OR autotrade_live_orders.positionId (also true for a
 *  position materializeEntryFill LINKED to instead of creating, which never
 *  gets a sourceIntentId — see that function's own doc comment) — the latter
 *  alone would be sufficient since setLiveOrderPositionId is called on both
 *  paths, but matching both is the more conservative change. */
function materializeExitFill(
  intent: OrderIntentRecord,
  positionId: number | null,
  exitPrice: number,
  riskProfile: string,
  filledQty?: number,
  /** Which bracket leg produced this exit — 'stop' (STOP_LOSS) or 'target'
   *  (STOP_PROFIT), stamped on the position_exits row (2026-07-26). Omitted
   *  only by a caller that genuinely doesn't know; never guessed here. */
  exitReason?: 'stop' | 'target',
): boolean {
  const position = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => isAutotradePosition(p) && (p.sourceIntentId === intent.id || (positionId !== null && p.id === positionId)),
  );
  if (!position) return false;
  // Book what the leg ACTUALLY filled, not the whole position. A bracket leg
  // can report FILLED on a partial quantity, and closing the full remainder on
  // that would both fabricate P&L for shares that never sold and drop the real
  // remainder out of the ledger — out of getLivePortfolioSnapshot's risk/P&L,
  // out of checkLiveEquityTimeExits, and out of the scale-in loop — leaving
  // untracked live exposure. Mirrors materializeTimeExitFill's own clamp.
  const closeQty = Math.min(filledQty ?? position.remainingQuantity, position.remainingQuantity);
  if (closeQty <= 0) return false;
  const closed = addExit(position.id, {
    quantity: closeQty,
    exitPrice,
    exitDate: etDateStr(),
    sourceIntentId: intent.id,
    exitReason: exitReason ?? null,
  });
  if (!closed) return false;
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_position_closed',
    detail: { exitPrice, pnl: realizedPnlOf(closed), exitReason: exitReason ?? null },
    riskProfile,
  });
  return true;
}

/** Record an exit against `positionId` for a FILLED time-exit closing order
 *  (checkLiveEquityTimeExits' own fresh order — never a bracket leg, so this
 *  is simpler than materializeExitFill: the position to close is known
 *  upfront, not inferred from sourceIntentId). Returns false (a no-op) if the
 *  position is already closed — defensive against a double-reconcile of the
 *  same fill, same as materializeExitFill. */
function materializeTimeExitFill(
  positionId: number,
  intent: OrderIntentRecord,
  exitPrice: number,
  riskProfile: string,
  quantity?: number,
): boolean {
  const position = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => p.id === positionId && isAutotradePosition(p),
  );
  if (!position) return false;
  // A partly-filled close reduces the position by what actually filled; the
  // rest stays open (and keeps being polled) rather than being booked as a
  // full exit at a price only part of the order achieved.
  const closeQty = Math.min(quantity ?? position.remainingQuantity, position.remainingQuantity);
  if (closeQty <= 0) return false;
  // Was this order a SCALE-OUT or an exit? Derived from the order, not stored:
  // every exit path orders the whole remaining position, and only a scale-out
  // deliberately orders less. That distinction survives a partial FILL too — a
  // time exit that only half-filled still ordered the full size, so it books as
  // a time exit, while a scale-out books as 'partial' even if it fills whole.
  const isScaleOut = intent.quantity < position.remainingQuantity;
  const closed = addExit(position.id, {
    quantity: closeQty,
    exitPrice,
    // Dated by the ORDER, not by when this reconcile got round to it. Every
    // order this books is a DAY order (buildWebullStockOrder), which can only
    // fill on the ET date it was placed, so the placement date IS the fill
    // date. Booking "today" was right only while a fill was always seen the
    // same day; SHOP's 2026-09-22 close was first read on the 23rd, and
    // "today" would have moved a realized gain into the next session's day
    // P&L, where the halts, the goal and the give-back guard all read it.
    exitDate: etDateStr(intent.createdAt),
    sourceIntentId: intent.id,
    exitReason: isScaleOut ? 'partial' : 'time_exit',
  });
  if (!closed) return false;
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: isScaleOut ? 'live_scale_out_filled' : 'live_time_exit_closed',
    detail: { exitPrice, quantity: closeQty, pnl: realizedPnlOf(closed), positionId },
    riskProfile,
  });
  return true;
}

// ---------------------------------------------------------------------------
// maxHoldDays force-close (added 2026-07-11) — the one exception to "equity's
// live exits are 100% broker-bracket-driven" (see reconcileLiveOrders' own
// header comment). A position that's been open longer than maxHoldDays
// without its stop or target firing needs an ACTIVE close: cancel the
// resting bracket's exit legs, then place a fresh closing order — there is
// no existing precedent for this in the codebase (unlike options, equity
// entries are NEVER placed without a bracket, so this is genuinely new
// broker-order-cancellation surface).
//
// UNCONFIRMED AGAINST A REAL ACCOUNT, same posture as WebullOrderLeg's own
// "best-effort... not yet probe-confirmed" caveat this mechanism builds on
// top of. Specifically unconfirmed: whether cancelling by the MASTER leg's
// own client_order_id (intent.idempotencyKey) — the only id this codebase
// durably tracks for a bracket; Webull's own combo_order_id is generated
// fresh per-place in providers/webull/orders.ts and never persisted —
// actually reaches the still-resting STOP_LOSS/STOP_PROFIT legs once the
// MASTER itself is already terminal ('filled'). The working theory, per this
// codebase's own "combo" framing of a bracket (buildOrderRequest emits ONE
// client_combo_order_id grouping all three legs), is that it does. This
// function never trusts that theory blindly: it always re-polls immediately
// after cancelling and verifies every non-MASTER leg is no longer resting
// before proceeding — anything short of that fails closed (position left
// open, retried next cycle) rather than risking a double-close. A real live
// trade should be used to confirm this behavior before fully trusting it,
// exactly as WebullOrderLeg's own header already asks for bracket-fill
// detection in general.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface BracketCancelOutcome {
  ok: boolean;
  reason?: string;
  /** A bracket leg was found FILLED on the post-cancel re-poll — it raced the
   *  cancel attempt. Left alone deliberately: the next normal
   *  reconcileLiveOrders() pass will materialize this as an ordinary stop/
   *  target exit, exactly as if maxHoldDays had never fired this cycle. */
  raced?: boolean;
}

/** Exported for reuse by services/trading/closePosition.ts (manual "close
 *  this position" from the Positions page, 2026-07-16) — a position's
 *  resting bracket exit legs need cancelling first regardless of WHY the
 *  position is being closed (maxHoldDays here, or a human clicking Close),
 *  and this function has nothing autotrade-specific in its own body. */
/** An order at the broker is "resting" (could still fill and race our close)
 *  unless it's in a known terminal state. Unknown/missing statuses are treated
 *  as resting — conservative: we'll try to cancel and then require the re-scan
 *  to confirm it's gone, rather than assume an unrecognized status is safe.
 *
 *  This used to be its own status list, independent of reconcile.ts's
 *  mapWebullStatus, and the two had already drifted apart (DELETED / INACTIVE
 *  were terminal here and unmapped there). Now there is one vocabulary: adding
 *  a status in one place changes both. */
const isRestingStatus = canStillFill;

/** The bracket's resting exit legs, recovered from the broker's live open
 *  orders: same symbol, the EXIT side (a long's stop/target are sells, a
 *  short's are buys — the same side as the close we're about to place), still
 *  resting, and with a client_order_id we can cancel by. Side must be POSITIVELY
 *  parsed to match — an order whose side we couldn't read is never assumed to be
 *  cancellable (fail closed, never cancel a wrong-side order). */
function restingExitOrders(orders: WebullOpenOrder[], symbol: string, exitSide: 'buy' | 'sell'): WebullOpenOrder[] {
  // Not an option on the same name (2026-09-23, isOptionOrder): the options
  // sleeve's working close on an MRNA call is a resting SELL LIMIT on "MRNA",
  // so by symbol and side it was this position's take-profit — cancelled by
  // every time exit's bracket clear, and read by the protection sweep as a
  // take-profit still resting.
  return orders.filter(
    (o) =>
      o.symbol?.toUpperCase() === symbol &&
      o.side === exitSide &&
      isRestingStatus(o.status) &&
      !!o.clientOrderId &&
      !isOptionOrder(o),
  );
}

/**
 * Which half of a bracket a resting exit leg is: the protective STOP, the
 * profit TARGET, or unreadable.
 *
 * Two independent markers, both confirmed against 12 real orders on the live
 * account (2026-09-05): the envelope's `combo_type` (STOP_LOSS / STOP_PROFIT)
 * and the leg's own `order_type` (STOP_LOSS for the stop, LIMIT for the
 * target). combo_type is tried first because it names the ROLE; order_type is
 * the fallback for exactly the failure that has happened before — combo_type
 * read from the wrong nesting level (PR #467), which made it parse as
 * undefined on every leg.
 *
 * 'unknown' is a real answer and must stay one. Collapsing it into either
 * bucket is how a parse miss becomes either a false naked-position alert or a
 * false all-clear.
 */
function classifyExitLeg(o: WebullOpenOrder): 'stop' | 'target' | 'unknown' {
  const combo = (o.comboType ?? '').toUpperCase();
  if (combo === 'STOP_LOSS') return 'stop';
  if (combo === 'STOP_PROFIT') return 'target';
  const type = (o.orderType ?? '').toUpperCase();
  if (type === 'STOP_LOSS' || type === 'STOP_LOSS_LIMIT') return 'stop';
  if (type === 'LIMIT') return 'target';
  return 'unknown';
}

/**
 * Why an empty restingExitOrders() result CANNOT be trusted to mean the exit
 * side is clear — undefined when it can be.
 *
 * restingExitOrders is a filter, so it returns nothing both when there is
 * genuinely nothing resting AND when the lenient parsing in mapOpenOrder()
 * couldn't read enough of a real resting leg to match it. Those are opposite
 * facts with opposite consequences: the first makes a close safe, the second
 * means the stop is still sitting at the broker and the close will double up
 * against it — for a long, filling both leaves you short a position nobody
 * opened, tracked nowhere until a later broker sync imports it as an orphan.
 *
 * The parse miss is not hypothetical: logOpenOrdersDiagnostic() exists
 * precisely because this response shape is unconfirmed against a real account
 * and the field names may not be the ones mapOpenOrder guesses at — but it only
 * ever printed a console warning, and the close went ahead anyway.
 *
 * Only RESTING orders are considered: a terminal one can't fill, so failing to
 * parse it costs nothing.
 */
function unreadableOpenOrders(orders: WebullOpenOrder[], symbol: string, exitSide: 'buy' | 'sell'): string | undefined {
  // An order positively labelled OPTION cannot be a stock bracket's leg, so its
  // unreadable fields cannot be hiding one (restingExitOrders' rule, applied to
  // the question of what might be missing from it).
  const live = orders.filter((o) => isRestingStatus(o.status) && !isOptionOrder(o));
  // A resting order whose SYMBOL wouldn't parse could be on any symbol,
  // including this one — so "nothing resting on SYM" is not a claim we can make.
  const noSymbol = live.filter((o) => !o.symbol);
  if (noSymbol.length > 0) {
    return `${noSymbol.length} resting broker order(s) carried no readable symbol`;
  }
  // A resting order that IS on this symbol but that restingExitOrders couldn't
  // classify: its side wouldn't parse (so it may be an exit leg), or it is on
  // the exit side but carries no client order id to cancel it by. Either way it
  // could be the stop/target, and either way we cannot clear it.
  const unidentified = live.filter(
    (o) => o.symbol!.toUpperCase() === symbol && (o.side === undefined || (o.side === exitSide && !o.clientOrderId)),
  );
  if (unidentified.length > 0) {
    return `${unidentified.length} resting order(s) on ${symbol} could not be identified as cancellable (unreadable side, or no client order id)`;
  }
  return undefined;
}

export async function cancelLiveBracketExitLegs(
  intent: OrderIntentRecord,
  accountId: string,
): Promise<BracketCancelOutcome> {
  const symbol = intent.symbol.toUpperCase();
  // The exit legs are the OPPOSITE side of the entry (a long's stop/target are
  // sells; a short's are buys) — the same side as the close we're about to
  // place. We CANNOT clear them by the entry's own client_order_id: a bracket's
  // exit legs each get their OWN client_order_id at placement (orders.ts's
  // buildOrderRequest), which was never persisted, and cancelling by the master
  // id doesn't reach them — confirmed against a real account, where a close was
  // rejected as "will reverse an existing position" until the resting stop/
  // target was cancelled by hand. So recover them from the broker's live open
  // orders and cancel each by its own id, exactly as that manual fix did.
  const exitSide: 'buy' | 'sell' = intent.side === 'buy' ? 'sell' : 'buy';

  const first = await listWebullOpenOrders(accountId);
  if (!first.ok) {
    return {
      ok: false,
      reason: `Could not read the broker's open orders to clear the resting bracket: ${first.error}`,
    };
  }
  logOpenOrdersDiagnostic(symbol, first.orders, first.raw);

  let resting = restingExitOrders(first.orders, symbol, exitSide);
  if (resting.length === 0) {
    // Nothing came back on the exit side — but this branch used to read that as
    // "the bracket is already gone, safe to close" no matter WHY the list was
    // empty, which is the one reading that can create real untracked exposure.
    // Absence of evidence is not evidence of absence here; each way of not
    // seeing a leg is now separated out.

    // 1) The list itself couldn't be read well enough to prove anything.
    const unreadable = unreadableOpenOrders(first.orders, symbol, exitSide);
    if (unreadable) {
      return {
        ok: false,
        reason:
          `Could not confirm ${symbol}'s resting bracket is clear — ${unreadable}. ` +
          `Not placing a close that could double up against a stop still working at the broker.`,
      };
    }

    // 2) This entry never had exit legs (a plain non-bracket entry, or a
    //    position adopted from the broker), so there is nothing to have missed
    //    and nothing to confirm — and no reason to spend a broker call on it.
    if (!intent.isBracket) return { ok: true };

    // 3) A bracket WAS submitted for this entry, so finding none of its legs is
    //    contradictory rather than reassuring: either they are genuinely gone
    //    (cancelled, or filled and thus terminal) or we simply can't see them.
    //    The combo status is the only other witness, so a failure to read it
    //    leaves the question open — it used to fall through to "safe to close".
    //    Note this is only ever used to detect a RACE; we never require the legs
    //    to be echoed back to allow a close, since that response shape is
    //    unconfirmed (see WebullOrderLeg) and requiring it could block every
    //    close forever.
    const combo = await webullOrderStatus(accountId, intent.idempotencyKey);
    if (!combo.ok) {
      return {
        ok: false,
        reason:
          `Could not check whether a bracket leg raced the close (${combo.error}) — ` +
          `not placing one while that is unknown.`,
      };
    }
    // A `found: false` is deliberately NOT treated as unresolved: an entry old
    // enough to hit maxHoldDays has very likely aged out of the broker's order
    // history, so blocking on it would break the close for exactly the
    // population this path exists to serve.
    const filledLeg = combo.found && (combo.legs ?? []).some((l) => isExitLeg(l) && l.status === 'FILLED');
    if (filledLeg) {
      return {
        ok: false,
        raced: true,
        reason: 'A bracket leg filled before the close — the position is already closing',
      };
    }
    return { ok: true };
  }

  // Cancel each resting exit leg by its OWN client_order_id.
  for (const o of resting) {
    await webullCancelOrder(accountId, o.clientOrderId!);
  }

  // Re-scan and CONFIRM they actually cleared before letting the close through —
  // a cancel POST is only an accepted request, not proof of a terminal state.
  const second = await listWebullOpenOrders(accountId);
  if (!second.ok) {
    return {
      ok: false,
      reason: `Cancelled the resting bracket order(s) but could not confirm they cleared: ${second.error}`,
    };
  }
  resting = restingExitOrders(second.orders, symbol, exitSide);
  if (resting.length > 0) {
    // Still resting after the cancel — a fresh close would double up against
    // them, so fail closed rather than risk it.
    return {
      ok: false,
      reason: `Resting ${exitSide} order(s) on ${symbol} did not clear after cancel (${resting
        .map((o) => o.clientOrderId)
        .join(', ')}) — not placing a close that could double up.`,
    };
  }
  // The re-scan is the whole proof that the cancel took effect, so it needs the
  // same "could this list even be read" test as the first one: an unparseable
  // re-scan produces an empty filter result that looks exactly like success.
  const unreadable = unreadableOpenOrders(second.orders, symbol, exitSide);
  if (unreadable) {
    return {
      ok: false,
      reason:
        `Cancelled the resting bracket order(s) but could not confirm they cleared — ${unreadable}. ` +
        `Not placing a close that could double up.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Is each open live position's protective stop ACTUALLY at the broker?
//
// A bracket is submitted as one request — MASTER plus STOP_PROFIT/STOP_LOSS
// under a client_combo_order_id — and webullPlaceOrder treats a 2xx as
// acceptance of the whole thing. Nothing has ever verified that the EXIT LEGS
// were accepted. materializeEntryFill then writes stopPrice/targetPrice onto
// the position, so the ledger asserts a stop exists on no evidence at all: if
// the broker took the entry and dropped the exits, the position is naked and
// every screen in this app still shows it protected.
//
// The direct check — reading per-leg acceptance out of the place/history
// response — is not available: the only per-leg signal is combo_type, which
// WebullOrderLeg documents as unconfirmed against a real account. Building a
// protection check on it would risk a false "unprotected" on every bracket, or
// worse a false "protected".
//
// So this asks the question the open-orders endpoint CAN answer: is there a
// resting order on the exit side for this symbol? Note the polarity — this is
// a POSITIVE existence check, looking FOR the stop, where finding it is the
// safe answer. That is the opposite of cancelLiveBracketExitLegs, which had to
// prove a stop was ABSENT before placing a close. Same scan, and the same
// unreadableOpenOrders guard, pointed the other way.
//
// It reports and never acts. Auto-placing a replacement stop would be the
// tempting next step and is exactly wrong: unreadableOpenOrders exists because
// this scan can fail to see orders that ARE there, and a replacement placed on
// a false negative leaves TWO stops on one position — a gap down sells twice
// and flips a long short. That is the failure mode the cancel path was hardened
// against, reintroduced from the other side. Telling a human is the whole job.
//
// STOCK brackets only. bracketExit() is GTC so a stock's exit legs persist,
// but optionBracketExit() is DAY — Webull restricts option sell-side orders to
// DAY-only — so a human-placed single-leg option bracket's exits legitimately
// vanish at every close, and checking them would manufacture a daily false
// alarm for a gap the code already documents separately. Autotrade's options
// path never places brackets at all, so nothing is lost by scoping this out.
// ---------------------------------------------------------------------------

/** How long after a position is created to start checking it. The exit legs go
 *  in with the entry, so they should already be resting by the time a fill is
 *  observed — but the fill and the broker's own open-orders view need not be
 *  consistent in the same instant, and a false "unprotected" on the very first
 *  tick would train the alert to be ignored. */
const BRACKET_PROTECTION_GRACE_MS = 3 * 60_000;

export interface BracketProtectionOutcome {
  positionId: number;
  symbol: string;
  /** True when a resting exit-side order was positively found. */
  protectedAtBroker: boolean;
  /** Set when the scan couldn't answer — neither protected nor unprotected. */
  unknown?: string;
  /** Shares the BROKER says are held, read only when the scan is about to call
   *  a position naked. null when the read failed. Zero means the position is
   *  gone — its stop filled — which is not the same thing as unprotected. */
  heldAtBroker?: number | null;
  /** Set when the position was naked AND already through its recorded stop, so
   *  the sweep closed it instead of re-arming a stop the market has passed.
   *  Asserted by the tests at the CONSUMER — the outcome the loop sees — rather
   *  than only on the helper that places the order. */
  breachClose?: { requested: boolean; lastPrice: number; reason?: string };
  /** A kill switch was engaged, so nothing was placed, cancelled or closed —
   *  the position was detected and reported only. */
  heldByKillSwitch?: true;
  /** A close the app placed is still working on this position, so nothing was
   *  stacked on top of it (a protective order over shares a close already
   *  commits is refused as a reversal, or oversells if both fill). */
  exitWorking?: true;
  /** The stop was gone while the take-profit rested: these take-profit legs
   *  were cancelled so the next sweep can re-arm BOTH legs together, the only
   *  shape the broker accepts over shares a resting leg already commits. */
  targetCancelled?: string[];
}

/**
 * Check every open autotrade EQUITY position that was opened with a bracket for
 * a resting exit-side order at the broker, and journal the ones that have none.
 *
 * NOT read-only, and that sentence stood here after it stopped being true. It
 * placed nothing until 2026-09-12, when the naked case gained an automatic
 * re-arm; since 2026-09-15 it can also CLOSE a position whose stop is already
 * through the market (see that branch). One open-orders pull per tick
 * regardless of position count; the broker calls that place anything happen
 * only on a position this sweep has already proven naked.
 *
 * It still RUNS regardless of the kill switch, for the same reason the
 * reconcilers do — a halted account still needs to know a real position is
 * sitting there unprotected — but the switch stops it acting. Detection is free
 * and always on; placement is not.
 *
 * That paragraph used to say the re-arm and the close "go through the shared
 * guardrails, which fail kill_switch". Only the close does. The re-arm called
 * webullPlaceStandaloneBracket directly, which checks nothing, so it kept
 * sending orders through every halt: SNDK's reached the broker at 10:31:05 on
 * 2026-09-22, two and a half minutes after the switch was engaged, while the
 * operator was closing positions by hand. The switch is now read HERE, before
 * anything is placed or cancelled (`halted` below), from the same
 * buildLiveTradingConfig the guardrails read — both switches, one derivation.
 *
 * Attribution caveat, stated rather than papered over: the scan matches by
 * symbol and side, so it cannot tell one position's stop from another order on
 * the same symbol and side. With autotrade's one-position-per-symbol dedup that
 * is nearly always unambiguous, but a human order on the same symbol could
 * satisfy the check for an autotrade position. That direction is a missed
 * alert, never a false one — and the same unverified response shape that rules
 * out per-leg parsing rules out doing better here.
 */
export async function checkLiveBracketProtection(now: number = Date.now()): Promise<BracketProtectionOutcome[]> {
  const cfg = getAutotradeConfig();
  const accountId = cfg.liveAccountId;
  if (!accountId) return [];

  // Scoped to the account whose open orders we are about to read. Without this
  // the check compares positions from EVERY account against one account's
  // resting orders, so on a multi-account login (a cash and a margin account on
  // the same Webull login is the ordinary case) a position held in the other
  // account finds no matching order here and gets reported naked when its stop
  // is sitting there perfectly fine. An alert that fires on healthy positions is
  // worse than no alert: it trains you to ignore the one that matters.
  //
  // A row with NO account recorded is close-eligible only in a single-account
  // setup, exactly as closePositionsFromPreview decides the same question
  // (providers/webull/positions.ts, task #120): once a second account is known
  // we cannot say which one an unassigned row belongs to, so we cannot judge
  // whether a missing stop is real.
  const otherAccountKnown = listKnownAccountIds().some((a) => a !== accountId);
  const candidates = listAutotradeLivePositions({ status: 'open' }).filter((p) => {
    if (p.assetType !== 'stock') return false;
    if (!(p.accountId === accountId || (p.accountId === null && !otherAccountKnown))) return false;
    if (now - p.createdAt < BRACKET_PROTECTION_GRACE_MS) return false;
    const intentId = entryIntentIdForPosition(p);
    return intentId !== null && (getIntent(intentId)?.isBracket ?? false);
  });
  if (candidates.length === 0) return [];

  // Either kill switch (this page's or the Trade page's), read from the SAME
  // derivation the guardrails use, so this sweep and every guarded order agree
  // on whether the account is halted. Read once: a switch flipped mid-sweep is
  // honoured from the next tick, the same granularity the loop's own gates have.
  const halted = buildLiveTradingConfig(cfg).killSwitch;

  const open = await listWebullOpenOrders(accountId);
  if (!open.ok) return []; // couldn't ask — say nothing, retry next tick
  const outcomes: BracketProtectionOutcome[] = [];
  // Positions that already have a closing order working. The breach close below
  // must never stack a second one, and this is the DB-backed way to know —
  // unlike an in-memory latch it survives the restart that would otherwise let
  // one through, which matters for the only branch here that sells shares.
  const pendingExitPositionIds = new Set(
    listPendingLiveOrders()
      .filter((o) => o.role === 'exit' && o.positionId !== null)
      .map((o) => o.positionId!),
  );

  for (const pos of candidates) {
    const symbol = pos.symbol.toUpperCase();
    const exitSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
    // The same guard the cancel path uses: an unparseable list produces an
    // empty filter result that is indistinguishable from a genuinely absent
    // stop, and calling that "unprotected" would cry wolf on a parse miss.
    const unreadable = unreadableOpenOrders(open.orders, symbol, exitSide);
    if (unreadable) {
      outcomes.push({ positionId: pos.id, symbol, protectedAtBroker: false, unknown: unreadable });
      continue;
    }
    const restingLegs = restingExitOrders(open.orders, symbol, exitSide);

    // Per-lot bracket OBSERVER (bracketGroups.ts). Changes nothing: it records
    // how the resting legs actually group, and whether the entry order's stored
    // brokerOrderId equals its exit legs' comboOrderId — the attribution link
    // the per-lot work depends on and which no live account has yet confirmed.
    // Once per position per ET day, so a persistent shape does not bury the log.
    if (restingLegs.length > 0 && !alreadyObservedGroupsToday(pos.id)) {
      const grouped = groupExitLegsByCombo(restingLegs);
      // The intent, not the live-order row: placeOrder stores broker.orderId
      // there, and webullPlaceOrder resolves that as order_id ?? combo_order_id
      // — so for a bracket it IS the envelope's combo group id. sourceIntentId
      // is non-null by the candidate filter above.
      const obsIntentId = entryIntentIdForPosition(pos);
      const entryBrokerOrderId = obsIntentId === null ? null : (getIntent(obsIntentId)?.brokerOrderId ?? null);
      const attributed = attributeByEntryOrder(grouped, entryBrokerOrderId);
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'bracket_groups_observed',
        detail: {
          positionId: pos.id,
          ...summarizeGroups(grouped),
          singleBracket: isSingleBracket(grouped),
          entryBrokerOrderId,
          // The whole point of the observation: did the entry order's id match a
          // resting group? A false here with a non-null id on a one-group book
          // says the ids are NOT the same key, and the attribution plan needs a
          // different link before anything is switched over to it.
          attributedByEntryOrderId: attributed !== null,
        },
        riskProfile: getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
      });
    }

    // "Is THIS position's stop still there", not "is anything resting".
    //
    // This used to accept ANY resting exit-side order as protection, and the
    // reason was written down: combo_type per leg was UNCONFIRMED (see
    // scripts/captureBrokerFields.ts's Q3, which exists to settle exactly this
    // and notes it is answerable "only once the account has actually placed a
    // BRACKET"). Answered on 2026-09-05 against 12 real orders: combo_type
    // rides the envelope and mapOpenOrder already lifts it, and the stop leg
    // additionally carries order_type STOP_LOSS. So the precise question is
    // answerable now.
    //
    // It matters because a bracket has TWO exit legs and only one of them is
    // protection. A position whose STOP was cancelled while its TARGET still
    // rests was reported protected — silently, forever — and that state is
    // reachable: cancelReplaceBracket cancels legs one at a time and returns
    // early if the second cancel fails, journaling "the bracket may now be
    // PARTLY cancelled". The standing alert would then never fire on it.
    const roles = restingLegs.map(classifyExitLeg);
    if (roles.includes('stop')) {
      outcomes.push({ positionId: pos.id, symbol, protectedAtBroker: true });
      continue;
    }
    if (restingLegs.length > 0 && !roles.includes('target')) {
      // Legs are resting but none could be classified either way. That is a
      // parse miss, not a missing stop, and it takes the same "say nothing"
      // path as unreadableOpenOrders above — an alert that fires on healthy
      // positions is worse than no alert.
      outcomes.push({
        positionId: pos.id,
        symbol,
        protectedAtBroker: false,
        unknown: `${restingLegs.length} resting exit leg(s) on ${symbol}, none identifiable as stop or target`,
      });
      continue;
    }
    // NO RESTING STOP IS NOT THE SAME AS NAKED (2026-09-08).
    //
    // A bracket whose stop has just FILLED looks identical to one whose stop was
    // never accepted: both show zero resting exit legs. On 09-08 this alarm
    // paged on SMCI at 13:52:45 — "check the broker and re-arm protection by
    // hand" — and that position's stop was booked 75 seconds later at 40.77.
    // Nothing was ever unprotected; the stop was in the act of working.
    //
    // The distinguishing signal is the HELD QUANTITY, and the reconcile already
    // had it eight seconds later (position_reconcile_skipped, brokerQty 0).
    // Zero held means the position is gone and the reconcile will close it;
    // more than zero with no resting stop is the real thing worth waking
    // someone for. A partial fill lands in the second case correctly — the
    // shares that remain genuinely have no stop under them.
    //
    // Read LAZILY, on this branch only. Every position that still has its stop
    // has already returned above, so this costs one account read per position
    // actually about to page, not one per position per tick.
    const held = await stockAccountState(accountId, symbol);
    // A holdings read that FAILED does not come back as a failure: the balance
    // half answered, so the result is ok with a quantity of 0 and
    // positionsUnavailable set (accountState.ts). Taken at face value that is
    // "closed, page nobody", the one answer this alarm must never give about a
    // read it did not get. It is unknown, which acts on nothing and pages as
    // unconfirmed below. (2026-09-23, from the #637 review.)
    const heldQty = held.ok && !held.positionsUnavailable ? (held.state?.currentPositionQty ?? null) : null;
    // THE BROKER'S QUANTITY IS SIGNED (accountState.ts: long +, short −), so a
    // short of 100 comes back as −100. Everything below used to require it to
    // be positive, which no short can ever be: a short that lost its stop was
    // never re-armed and never closed through its stop, only paged, and the
    // one test of it handed the sweep a +10 the reader never returns for a
    // short (2026-09-23, from the shorts pre-flight audit).
    //
    // `heldShares` is the holding IN THE POSITION'S DIRECTION. Positive: the
    // position's shares are confirmed held. Negative: the broker holds the
    // OTHER way, which is not this position's holding whatever it is (the
    // operator's own trade in the name, most likely), so it confirms nothing
    // and nothing is acted on — the same stance as a read that failed.
    const heldShares = heldQty === null ? null : pos.side === 'short' ? -heldQty : heldQty;
    const heldConfirmed = heldShares !== null && heldShares > 0 ? heldShares : null;
    const heldOpposite = heldShares !== null && heldShares < 0;
    if (heldQty === 0) {
      // Not naked — closed, and awaiting the reconcile. Say so and page nobody.
      outcomes.push({
        positionId: pos.id,
        symbol,
        protectedAtBroker: false,
        heldAtBroker: 0,
        unknown: `no resting stop on ${symbol}, and the broker holds 0 — the position is closed, not unprotected`,
      });
      continue;
    }
    // Held by reference so the breach close below can fill in its result
    // without indexing back into the array — an index would keep working right
    // up until someone pushes another outcome in between, and then be wrong
    // silently.
    const outcome: BracketProtectionOutcome = {
      positionId: pos.id,
      symbol,
      protectedAtBroker: false,
      heldAtBroker: heldConfirmed,
    };
    outcomes.push(outcome);

    // RE-ARM IT (2026-09-12), rather than only paging a human.
    //
    // This check has been able to prove a position naked since 2026-09-08 —
    // shares confirmed held at the broker, zero resting stop — and its response
    // was a journal row saying "re-arm protection by hand". GRMN sat that way on
    // 2026-08-25. At 1.25% risk an unprotected position was a bad hour; at the
    // sizing this book is moving to it is a bad day, and the machinery to fix it
    // already exists (webullPlaceStandaloneBracket, used by the scale-out's own
    // rollback). The stop and target come from the position row, which is the
    // same geometry the original bracket carried.
    //
    // Only on a CONFIRMED naked position: heldConfirmed null means the account
    // read failed or the broker holds the other way round, and placing a
    // bracket against an unknown holding is how a covered position becomes a
    // short. An AMBIGUOUS placement is never retried for the same reason the
    // scale-out does not retry one — a second bracket on top of a possibly-live
    // one is two stops against one position.
    //
    // THE SIDE (2026-09-23). The intent comes from protectiveBracketIntent, the
    // one derivation every standalone bracket now shares. This branch built its
    // own and handed over the CLOSING side, which bracketExit inverts again, so
    // for eleven days every re-arm of a long was a BUY stop plus a BUY
    // take-profit limit. See that helper for the record and the hazard.
    //
    // FOUR STATES STOP IT, each one something the broker or the operator has
    // already shown us (2026-09-23):
    //
    //  1. A KILL SWITCH. It is the operator's "hands off, I am trading this by
    //     hand", and this branch placed orders through two halts before it read
    //     the switch at all.
    //  2. A CLOSE ALREADY WORKING. The app's own close commits these shares; a
    //     protective order on top is refused as a reversal, or sells the
    //     position twice if both fill. The close is the protection of record.
    //  3. A TAKE-PROFIT STILL RESTING WITH ITS STOP GONE. This used to re-arm the
    //     stop ALONE (so as not to stack a second take-profit on the working
    //     one), and the broker can never accept that: it counts shares held MINUS
    //     shares resting exits already commit (committedProtectiveQuantity,
    //     measured on FCX 2026-09-08), and the take-profit commits all of them.
    //     SNDK's attempt on 2026-09-22 was refused. Cancel-then-place is the only
    //     order the broker permits, so the take-profit is cancelled here and the
    //     next sweep, finding nothing resting, re-arms BOTH legs as one OCO pair.
    //     That also retires the orphan the stop-alone design left behind: a stop
    //     not linked to the old take-profit, so a stop fill left a GTC sell
    //     resting over shares no longer held.
    //  4. A LEG IT CANNOT CLASSIFY beside that take-profit, or a LIMIT the
    //     broker does not label as a bracket's take-profit. Cancelling an order
    //     this sweep cannot prove is the app's is a guess about someone else's,
    //     and the likeliest someone else is the operator's own exit.
    //
    // None of the four sets rearmNote. The breach close below treats a non-null
    // note as the broker REFUSING a stop at the recorded price — the fact that
    // corroborates the quote — and a hold, a working close or a cancel says
    // nothing about price.
    let rearmed = false;
    let rearmNote: string | null = null;
    let actionNote: string | null = null;
    const canAct = heldConfirmed !== null && pos.stopPrice !== null && config.trading.placeEnabled;
    if (canAct && halted) {
      outcome.heldByKillSwitch = true;
    } else if (canAct && pendingExitPositionIds.has(pos.id)) {
      outcome.exitWorking = true;
    } else if (canAct && roles.includes('target')) {
      // ONLY A LEG THE BROKER LABELS AS A BRACKET'S TAKE-PROFIT IS OURS TO
      // CANCEL (2026-09-23, from the #637 review). classifyExitLeg falls back
      // to the order type, so a plain LIMIT on the exit side reads as
      // 'target' whoever placed it. Every leg of every bracket this app places
      // carries combo_type STOP_PROFIT or STOP_LOSS (bracketExit), and its
      // plain orders carry NORMAL; the app's own plain closes never get here,
      // because a working close takes the branch above. So an exit-side LIMIT
      // without the STOP_PROFIT label is someone else's order, and the one
      // this is most likely to be is the operator's hand exit: engage the
      // switch, cancel the bracket, rest a sell limit in Webull, release the
      // switch before it fills. Cancelling it would undo the operator's exit
      // and re-arm the app's bracket over it. So: cancel nothing, and page.
      const unlabelled = restingLegs.filter((l) => (l.comboType ?? '').toUpperCase() !== 'STOP_PROFIT');
      if (roles.some((r) => r !== 'target')) {
        actionNote =
          'A resting leg beside the take-profit could not be classified, so nothing was cancelled to make room for a stop.';
      } else if (unlabelled.length > 0) {
        actionNote =
          `${unlabelled.length} resting limit order(s) on the ${exitSide} side of ${symbol} are not labelled as a ` +
          `bracket's take-profit (combo type ${unlabelled.map((l) => l.comboType ?? 'none').join(', ')}), so they may ` +
          'be orders placed by hand. Nothing was cancelled to make room for a stop.';
      } else {
        const cancelled: string[] = [];
        let cancelError: string | null = null;
        // restingExitOrders only returns legs that carry a client order id.
        for (const leg of restingLegs) {
          const c = await webullCancelOrder(accountId, leg.clientOrderId!);
          if (!c.ok) {
            cancelError = `${leg.clientOrderId}: ${c.error ?? 'cancel failed'}`;
            break;
          }
          cancelled.push(leg.clientOrderId!);
        }
        if (cancelled.length > 0) outcome.targetCancelled = cancelled;
        if (cancelError === null) {
          logAutotradeEvent({
            symbol,
            stage: 'execution',
            action: 'live_bracket_rearm_target_cancelled',
            detail: {
              positionId: pos.id,
              heldAtBroker: heldConfirmed,
              cancelled,
              recordedStop: pos.stopPrice,
              targetPrice: pos.targetPrice,
              reason:
                "the position's stop was gone while its take-profit still rested, and the broker refuses a stop " +
                'added over shares the take-profit already commits — the take-profit was cancelled so the next ' +
                'sweep re-arms both legs together',
            },
            riskProfile: getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
          });
          // Not paged: the repair is under way and the next sweep either re-arms
          // both legs or pages with the broker's reason.
          continue;
        }
        actionNote =
          `Cancelling the resting take-profit to make room for a stop failed (${cancelError})` +
          (cancelled.length > 0 ? ` after ${cancelled.length} leg(s) were already cancelled` : '') +
          '.';
      }
    } else if (canAct && heldConfirmed !== null) {
      const quantity = Math.min(pos.remainingQuantity, heldConfirmed);
      const rearm = await webullPlaceStandaloneBracket(
        accountId,
        protectiveBracketIntent(symbol, pos.side, quantity),
        pos.targetPrice ?? undefined,
        pos.stopPrice!,
      );
      rearmed = rearm.ok;
      rearmNote = rearm.ok ? null : rearm.ambiguous ? 'unanswered' : (rearm.error ?? 'unknown');
      if (rearm.ok) {
        recordRearmedLegs(pos.id, rearm.legClientOrderIds);
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'live_bracket_rearmed',
          detail: {
            positionId: pos.id,
            quantity,
            stopPrice: pos.stopPrice,
            targetPrice: pos.targetPrice,
            // WHICH legs this placement put on the book. Always both when the
            // position has a target: this branch runs only with nothing resting.
            legsPlaced: pos.targetPrice !== null ? 'stop+target' : 'stop',
            clientComboOrderId: rearm.clientComboOrderId ?? null,
            reason: 'position was confirmed naked at the broker — protection re-armed automatically',
          },
          riskProfile: getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
        });
        continue;
      }
    }

    // THE STOP IS ALREADY THROUGH THE MARKET — CLOSE, DO NOT RE-ARM (2026-09-15).
    //
    // A stop cannot be placed where the market has already been: the broker
    // refuses a SELL stop above the market (a BUY stop below it, for a short).
    // There is no protection left to restore, and the recorded stop was the
    // decision, so the answer is to close.
    //
    // CORRECTED 2026-09-23: the example this was written for was not an example
    // of it. BWIN, 2026-09-14 12:13 ET, was read as this case because the re-arm
    // was refused with "The stop price of the stop-loss order should be higher
    // than the current market price". BWIN was at 31.95 against a 31.16 stop —
    // nowhere near through it. The refusal was the broker's rule for a BUY stop,
    // because the re-arm above was sending its legs on the wrong side (see
    // protectiveBracketIntent). The rule below is still right for the case it
    // describes; with the side fixed, a refused re-arm is finally a sell stop
    // the market has passed, which is what fact (2) was meant to mean.
    //
    // PR A's plan said "a standalone bracket at the recorded stop, OR a
    // marketable close if price is already through it". Only the first half was
    // built. This is the second.
    //
    // THREE INDEPENDENT FACTS, ALL REQUIRED, because this is the one branch here
    // that sells real shares with no human in the loop:
    //   1. the broker confirms the shares are still held, the right way round
    //      (heldConfirmed, above — the same read that tells a naked position
    //      from a stop mid-fill);
    //   2. the re-arm was ATTEMPTED and the broker REFUSED it;
    //   3. a QUOTE FETCHED NOW is through the recorded stop.
    // (2) and (3) are separate sources that must agree, so neither a stale quote
    // nor a misread error string can fire this on its own. Matching on the
    // broker's wording alone was the tempting shortcut and is exactly the kind
    // of string dependency that breaks silently when a vendor rewords an error.
    //
    // The placement itself is `placeLiveEquityTimeExitClose` unchanged — the
    // same path the stagnation and end-of-day exits use. That is the point of
    // reusing it: it cancels the resting legs first, prices a MARKETABLE LIMIT
    // at the 0.5% buffer rather than sending a market order, runs the full
    // guardrails (so the kill switch stops it), and already handles the
    // ambiguous-placement case that stops a second close going out against a
    // position whose first may have filled.
    //
    // AN UNANSWERED RE-ARM IS NOT A REFUSED ONE. `rearmNote === 'unanswered'`
    // means the placement timed out or the broker 5xx'd, so a protective
    // bracket may well be resting with a combo id we never learned. Closing on
    // top of that is two sells against one position, and for a long an oversell
    // flips it short — the exact disaster the re-arm's own comment refuses to
    // retry an ambiguous placement over. Only an EXPLICIT refusal counts as
    // fact (2); an unanswered one pages, as it did before.
    let breachClose: BracketProtectionOutcome['breachClose'];
    if (
      !rearmed &&
      rearmNote !== null &&
      rearmNote !== 'unanswered' &&
      heldConfirmed !== null &&
      pos.stopPrice !== null &&
      config.trading.placeEnabled &&
      !pendingExitPositionIds.has(pos.id)
    ) {
      let last: number | null;
      try {
        const q = await getProvider().getQuote(symbol);
        last = Number.isFinite(q.last) && q.last > 0 ? q.last : null;
      } catch {
        last = null; // no quote, no third fact — fall through to the page.
      }
      // Through the stop, in the direction the stop protects: at or below for a
      // long, at or above for a short. Equality counts — a stop resting exactly
      // at the market is the case the broker refuses.
      const through = last !== null && (pos.side === 'long' ? last <= pos.stopPrice : last >= pos.stopPrice);
      if (last !== null && through) {
        const entryIntentId = entryIntentIdForPosition(pos);
        const entryIntent = entryIntentId === null ? null : getIntent(entryIntentId);
        // Every candidate reaching this loop was filtered on having a bracket
        // entry intent, so this is defensive rather than expected.
        if (entryIntent) {
          const closed = await placeLiveEquityTimeExitClose(
            pos,
            accountId,
            getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
            entryIntent,
            {
              kind: 'unprotected_breach',
              journal: {
                recordedStop: pos.stopPrice,
                lastPrice: last,
                heldAtBroker: heldConfirmed,
                // WHY the stop could not simply be re-armed, carried into the
                // one row this produces so the sequence reads without a join.
                rearmOutcome: rearmNote,
              },
              notice: 'position was unprotected and already through its stop',
            },
          );
          breachClose = {
            requested: closed.requested,
            lastPrice: last,
            ...(closed.reason ? { reason: closed.reason } : {}),
          };
          outcome.breachClose = breachClose;
          // A REQUESTED close is the answer; `live_time_exit_placed` with
          // trigger 'unprotected_breach' is the record and is already wired into
          // the failure alerting. A FAILED one leaves the position genuinely
          // naked, so it falls through to the page below carrying its reason.
          if (closed.requested) continue;
        }
      }
    }

    // Still naked: the re-arm was not attempted (unreadable account, no recorded
    // stop, placement disabled, a kill switch, a close already working, a leg
    // it could not classify, a take-profit it could not cancel) or it failed,
    // and the position is not through its stop (or the close failed too). NOW
    // page a human.
    // Once per position per STATE per ET day: this condition persists until a
    // human acts, so journaling every tick would bury it, and journaling once
    // ever would let it go quiet while the position is still naked.
    //
    // Per state, not per position (2026-09-23, from the #637 review). The
    // row is the page (liveFailureAlert's AMBIGUITY_ACTIONS), and a kill
    // switch now writes one that says "this is expected". Deduplicated by
    // position alone, that row used the day's only page: release the switch,
    // have the re-arm refused, and the position sat naked with nothing sent
    // until the next ET day. A new state is new information, so it writes.
    const reportState = unprotectedReportState({
      heldByKillSwitch: outcome.heldByKillSwitch ?? false,
      exitWorking: outcome.exitWorking ?? false,
      // An opposite holding confirms nothing, so it pages as unconfirmed.
      heldAtBroker: heldConfirmed,
    });
    if (!alreadyReportedUnprotectedToday(pos.id, reportState)) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_position_unprotected',
        detail: {
          positionId: pos.id,
          // Which of the four states wrote this row: the dedup key above, and
          // the leak scan's split of this action (edgeLeakScanData.ts).
          state: reportState,
          quantity: pos.remainingQuantity,
          recordedStop: pos.stopPrice,
          restingExitLegs: restingLegs.length,
          // null means the account read FAILED (or the broker holds the other
          // way round), so this is paging without having confirmed the shares
          // are still held. Fail-loud is the right direction for a protection
          // alarm, but the reader must be able to tell that case from a
          // confirmed naked position.
          heldAtBroker: heldConfirmed,
          // The broker's own signed quantity (long +, short −), as read.
          brokerPositionQty: heldQty,
          // Why the automatic re-arm did not save it — the first question a
          // reader of this row now has.
          rearmAttempted: rearmNote !== null || rearmed,
          rearmOutcome: rearmed ? 'ok' : rearmNote,
          // The states that stop the sweep acting at all, so a halted or
          // mid-close position does not read like a failed repair.
          heldByKillSwitch: outcome.heldByKillSwitch ?? false,
          exitWorking: outcome.exitWorking ?? false,
          ...(outcome.targetCancelled ? { targetCancelled: outcome.targetCancelled } : {}),
          // Present only when the position was ALSO through its stop, so the
          // sweep tried to close it and could not. Its absence means the stop
          // was still placeable and the re-arm failed for another reason.
          ...(breachClose
            ? { breachCloseFailed: breachClose.reason ?? 'unknown', lastPrice: breachClose.lastPrice }
            : {}),
          reason:
            (restingLegs.length === 0
              ? 'This position was opened with a bracket, but the broker shows no resting ' +
                `${exitSide} order on ${symbol} — its stop may never have been accepted, or was cancelled. `
              : `This position's TAKE-PROFIT leg is still resting on ${symbol}, but its STOP is not. ` +
                'The position is running with no downside protection while looking like it has a bracket. ') +
            (outcome.heldByKillSwitch
              ? 'A kill switch is engaged, so nothing was placed, cancelled or closed. If you are managing ' +
                'this position by hand, this is expected; if it is still unprotected when the switch is ' +
                'released, the next sweep re-arms it. '
              : outcome.exitWorking
                ? 'A close the app placed is still working on it, so nothing was stacked on top; if that ' +
                  'close does not fill, these shares have no stop under them. '
                : actionNote !== null
                  ? `${actionNote} `
                  : '') +
            (rearmNote === null
              ? ''
              : rearmNote === 'unanswered'
                ? 'An automatic re-arm was UNANSWERED, so a second bracket was not stacked on a possibly-live one. '
                : `An automatic re-arm failed (${rearmNote}). `) +
            (heldOpposite && heldQty !== null
              ? `The broker holds ${Math.abs(heldQty)} share(s) of ${symbol} the other way round ` +
                `(${heldQty > 0 ? 'long' : 'short'}), not this ${pos.side}, so nothing was acted on — ` +
                'check the broker before acting.'
              : heldConfirmed === null
                ? 'The account read FAILED, so it is NOT confirmed that these shares are still held — ' +
                  'a stop that has just filled looks the same from here. Check the broker before acting.'
                : `The broker confirms ${heldConfirmed} share(s) still held, so this is real.` +
                  (outcome.heldByKillSwitch ? '' : ' Check the broker and re-arm protection by hand.')),
        },
        riskProfile: getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
      });
    }
  }
  return outcomes;
}

// entryIntentIdForPosition moved to db/autotradeLiveOrders.ts (2026-09-23), beside
// the lookup it wraps, so readers below this layer can call the same function.
// Re-exported here for the callers that already import it from this module.
export { entryIntentIdForPosition };

function alreadyObservedGroupsToday(positionId: number): boolean {
  const today = etDateStr();
  return listAutotradeEvents({ stage: 'execution', actions: ['bracket_groups_observed'], limit: 200 }).some((e) => {
    if (etDateStr(e.createdAt) !== today) return false;
    try {
      return (JSON.parse(e.detail ?? '{}') as { positionId?: unknown }).positionId === positionId;
    } catch {
      return false;
    }
  });
}

function alreadyReportedUnprotectedToday(positionId: number, state: UnprotectedReportState): boolean {
  const today = etDateStr();
  return listAutotradeEvents({ stage: 'execution', actions: ['live_position_unprotected'], limit: 200 }).some((e) => {
    if (etDateStr(e.createdAt) !== today) return false;
    try {
      const detail = JSON.parse(e.detail ?? '{}') as Record<string, unknown>;
      return detail.positionId === positionId && unprotectedReportState(detail) === state;
    } catch {
      return false;
    }
  });
}

/** One-line server-log breadcrumb so the FIRST real close reveals whether the
 *  lenient open-orders parsing actually found the symbol's resting legs — and,
 *  when it found open orders but matched none to the symbol (a likely parse
 *  miss), a truncated raw sample to reveal the true field names. Quiet unless
 *  there's something to see. */
function logOpenOrdersDiagnostic(symbol: string, orders: WebullOpenOrder[], raw: unknown): void {
  const onSymbol = orders.filter((o) => o.symbol?.toUpperCase() === symbol);
  if (onSymbol.length > 0) {
    const summary = onSymbol.map((o) => ({ id: o.clientOrderId, side: o.side, status: o.status, combo: o.comboType }));
    console.warn(
      `[cancelLiveBracketExitLegs] ${symbol}: ${orders.length} open order(s), matched ${JSON.stringify(summary)}`,
    );
  } else if (orders.length > 0) {
    const sample = JSON.stringify(Array.isArray(raw) ? raw[0] : raw)?.slice(0, 600);
    console.warn(
      `[cancelLiveBracketExitLegs] ${symbol}: ${orders.length} open order(s) but NONE matched the symbol — likely a field-name parse miss. Sample: ${sample}`,
    );
  }
}

export interface LiveEquityTimeExitOutcome {
  symbol: string;
  positionId: number;
  /** A fresh closing order was successfully PLACED — mirrors
   *  LiveOptionsExitCheckOutcome's own `requested` naming: this is NOT "the
   *  position is now closed" (that only happens once the order later fills
   *  and reconcileLiveOrders() materializes it). */
  requested: boolean;
  reason?: string;
  intentId?: number;
}

/** Places a fresh MARKETABLE-LIMIT closing order for `pos` — never a bracket
 *  (mirrors liveOptionsExecute.ts's own "no bracket, ever" time-exit close).
 *  Guardrails run against a FRESH account state, same as attemptLiveEntry —
 *  in particular the naked_short check: a same-or-smaller-quantity closing
 *  sell against the account's ACTUAL current holding (currentPositionQty,
 *  read fresh from the broker) never computes a negative resultingQty, so
 *  this needs no override the way options' single-leg close does (options'
 *  account-state read doesn't reflect contract holdings the way equity's
 *  reflects share holdings). "Actual" means SHARES: until 2026-09-23 the read
 *  also counted every option contract on the name, which let a sell of shares
 *  no longer held pass the check (stockAccountState). */
/** Journal + return a time-exit that never reached the broker. These bail-outs
 *  used to return a `reason` string that died in the return value: nothing
 *  journaled them, so nothing could alert on them (liveFailureAlert reads the
 *  journal) and nothing recorded that a position past its hold limit had been
 *  looked at and skipped. Because maxHoldDays does not un-trigger, each one
 *  repeats every 60s for as long as the cause persists — silently, until now.
 *  Uses the same 'live_time_exit_failed' action the broker-rejection path
 *  already does: FAILURE_ACTIONS is explicitly scoped to include "a close we
 *  couldn't even price", which is exactly what these are. */
function timeExitFailure(
  pos: Position,
  riskProfile: string,
  reason: string,
  extra: Record<string, unknown> = {},
): LiveEquityTimeExitOutcome {
  const symbol = pos.symbol.toUpperCase();
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_time_exit_failed',
    detail: { reason, positionId: pos.id, ...extra },
    riskProfile,
  });
  return { symbol, positionId: pos.id, requested: false, reason };
}

/** WHY this close is happening — threaded into the placement journal entry
 *  and the push notification so a maxHoldDays force-close and a stagnation
 *  scratch stay distinguishable for auditing (the position's own exitReason
 *  stays 'time_exit' for both at materialization: one fill path, one
 *  vocabulary). `journal` carries the trigger's numbers (heldMinutes,
 *  progressR) into the event detail. */
export interface TimeExitTrigger {
  kind: 'max_hold_days' | 'stagnation' | 'end_of_day' | 'unprotected_breach';
  journal: Record<string, unknown>;
  /** Human phrasing for the notification, e.g. "max hold time reached". */
  notice: string;
}

async function placeLiveEquityTimeExitClose(
  pos: Position,
  accountId: string,
  riskProfile: string,
  entryIntent: OrderIntentRecord,
  trigger: TimeExitTrigger,
): Promise<LiveEquityTimeExitOutcome> {
  const symbol = pos.symbol.toUpperCase();
  let last: number;
  try {
    last = (await getProvider().getQuote(symbol)).last;
  } catch (err) {
    return timeExitFailure(pos, riskProfile, `Quote fetch failed: ${(err as Error).message}`);
  }
  if (!Number.isFinite(last) || last <= 0) {
    return timeExitFailure(pos, riskProfile, `Invalid quote price: ${last}`);
  }

  const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
  const buffer = 1 + (closeSide === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const limitPrice = Math.round(last * buffer * 100) / 100;

  const intent: OrderIntent = {
    symbol,
    assetKind: 'stock',
    side: closeSide,
    openClose: 'close',
    quantity: pos.remainingQuantity,
    orderType: 'limit',
    limitPrice,
    referencePrice: last,
  };

  const liveCfg = buildLiveTradingConfig(getAutotradeConfig());
  const acct = await stockAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return timeExitFailure(pos, riskProfile, acct.error ?? 'Could not load account state');
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(Date.now(), 'stock') };

  // THE BROKER MUST HOLD WHAT THE CLOSE ORDERS (2026-09-23, shorts pre-flight).
  //
  // The close orders `remainingQuantity`, and the only thing that stopped it
  // ordering more than the broker held was the guardrails' naked_short rule: a
  // long's close that would leave the account net SHORT is refused while
  // liveAllowNakedShort is off. Turning shorts on switches that rule off, and
  // with it the long side's only protection in this app — a stagnation close on
  // a long whose stop had just filled would then go out as a SELL of shares no
  // longer held. And no rule here stopped a short's cover buying more than the
  // short held. The broker has been seen refusing a close that would reverse a
  // position (see cancelLiveBracketExitLegs), but whether it refuses these has
  // never been seen. Its check is not ours to lean on.
  //
  // So the close reads the holding in the position's direction (the broker's
  // quantity is signed: long +, short −) and is refused when it is less than
  // the close would order: exactly what naked_short did for a long, now on both
  // sides and whatever liveAllowNakedShort says. The shares are gone and a
  // reconcile will book the fill, or a bracket leg is part-way through filling,
  // or the read failed, or the broker holds the other way round. The next tick
  // asks again, and the position keeps its bracket meanwhile: this returns
  // before anything is cancelled.
  //
  // REFUSED, NOT CAPPED at what is held. A first version sold the smaller
  // holding, and the PR's own review found three ways that goes wrong: the fill
  // books as a scale-out (materializeTimeExitFill tells the two apart by
  // quantity alone) and strands the rest of the position; a holding can include
  // the operator's own lot in the same name, which a capped sell would take
  // while the loop's shares were already gone; and a fractional hand lot would
  // become a fractional order.
  const brokerQty = acct.positionsUnavailable ? null : acct.state.currentPositionQty;
  const heldShares = brokerQty === null ? null : pos.side === 'short' ? -brokerQty : brokerQty;
  if (heldShares === null || heldShares < intent.quantity) {
    const reasons = `broker_holding: ${
      brokerQty === null
        ? 'the positions read failed, so the holding is unknown'
        : brokerQty === 0
          ? `the broker holds no ${symbol}`
          : heldShares !== null && heldShares > 0
            ? `the broker holds ${heldShares} ${symbol}, fewer than the ${intent.quantity} this close would ${closeSide}`
            : `the broker holds ${Math.abs(brokerQty)} ${symbol} ${brokerQty > 0 ? 'long' : 'short'}, not this ${pos.side}`
    } — not ordering more than is held`;
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_time_exit_blocked',
      detail: { reasons, positionId: pos.id, brokerPositionQty: brokerQty, remainingQuantity: intent.quantity },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: `Guardrails blocked: ${reasons}` };
  }

  const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });

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
      action: 'live_time_exit_blocked',
      detail: { reasons, positionId: pos.id },
      riskProfile,
    });
    return {
      symbol,
      positionId: pos.id,
      requested: false,
      reason: `Guardrails blocked: ${reasons}`,
      intentId: intentRec.id,
    };
  }

  // ONLY NOW cancel the resting bracket. This used to run in the caller, before
  // any of the above: the position's only stop was cancelled and confirmed
  // cleared, and THEN the close was evaluated — so anything that blocks it left
  // a real position with no stop at the broker and no closing order. The kill
  // switch is the easiest way to hit it (buildLiveTradingConfig ORs both kill
  // switches into a block-severity guardrail, and this function is deliberately
  // not gated on the kill switch, so the loop keeps calling it), which means the
  // gesture a user makes to stop trading was the one most likely to strip a
  // position's protection. It also could not self-heal: the rejected intent never
  // becomes a pending exit order, so the next tick re-entered, found nothing left
  // to cancel, and was blocked again — every 60s, silently, with none of these
  // event actions wired into liveFailureAlert.
  const cancelled = await cancelLiveBracketExitLegs(entryIntent, accountId);
  if (!cancelled.ok) {
    transitionIntent(intentRec.id, 'rejected', { detail: `bracket cancel failed: ${cancelled.reason}` });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_time_exit_cancel_failed',
      detail: { positionId: pos.id, reason: cancelled.reason, raced: cancelled.raced ?? false },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: cancelled.reason, intentId: intentRec.id };
  }

  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live time-exit)' });
  transitionIntent(intentRec.id, 'confirmed', {
    detail: 'autotrade — no per-order confirmation, per confirmed design',
  });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId);
  if (!broker.ok && broker.ambiguous) {
    // Unknown outcome, so not terminal — see attemptLiveEntry's own branch. It
    // matters more here: the bracket has already been cancelled by this point,
    // and marking the close rejected would empty pendingExitPositionIds, so the
    // next tick would place a SECOND closing order against a position whose
    // first close may already have filled — overselling, and for a long that
    // means flipping short.
    recordLiveExitOrder({ intentId: intentRec.id, symbol, riskProfile, positionId: pos.id });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_order_outcome_unknown',
      detail: { reason: broker.error, clientOrderId, positionId: pos.id },
      riskProfile,
    });
    return {
      symbol,
      positionId: pos.id,
      requested: false,
      reason: `Placement outcome unknown (kept pending for reconcile): ${broker.error}`,
      intentId: intentRec.id,
    };
  }
  if (!broker.ok) {
    transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_time_exit_failed',
      detail: { reason: broker.error, positionId: pos.id },
      riskProfile,
    });
    return {
      symbol,
      positionId: pos.id,
      requested: false,
      reason: `Broker rejected: ${broker.error}`,
      intentId: intentRec.id,
    };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  recordLiveExitOrder({ intentId: intentRec.id, symbol, riskProfile, positionId: pos.id });
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_time_exit_placed',
    detail: {
      quantity: intent.quantity,
      limitPrice,
      orderId: broker.orderId,
      positionId: pos.id,
      trigger: trigger.kind,
      ...trigger.journal,
    },
    riskProfile,
  });
  await dispatchAutotradeNotification('live equity', [
    {
      title: symbol,
      message: `Autotrade LIVE closing ${symbol} (${trigger.notice}): ${intent.quantity} @ ~$${limitPrice.toFixed(2)}`,
    },
  ]);
  return { symbol, positionId: pos.id, requested: true, intentId: intentRec.id };
}

/**
 * Check every open live equity position against maxHoldDays (0 = disabled)
 * AND the intraday stagnation exit (stagnationExitMinutes, 0 = disabled —
 * see stagnationExit.ts's header for the evidence and the rule), and
 * force-close whichever has overstayed or stalled: cancel its resting
 * bracket exit legs, verify they're actually clear, then place a fresh
 * closing order. See the module-level comment above for why this is
 * fundamentally riskier than every other exit path in this file, and what
 * specifically is unconfirmed.
 *
 * A position with an exit order ALREADY in flight (pending, per
 * listPendingLiveOrders()'s role='exit' rows) is skipped — neither trigger
 * un-fires within the same day, so without this guard every tick would
 * attempt ANOTHER cancel+close for the same still-closing position
 * (mirrors checkLiveOptionsExits' identical guard).
 */
export interface LiveScaleOutOutcome {
  symbol: string;
  positionId: number;
  requested: boolean;
  quantity?: number;
  rMultiple?: number | null;
  reason?: string;
  intentId?: number;
}

/**
 * Cancel the resting bracket so the caller can sell a partial.
 *
 * Returns ok ONLY when the legs are confirmed gone from a fresh broker read.
 * On any doubt the caller must abandon the scale-out — back to a fully
 * protected position and a missed partial, exactly where the in-place path
 * already leaves us.
 *
 * It does not sell and does not re-bracket; the caller owns both, because the
 * caller holds the ordering rule. See cancelReplace.ts.
 */
async function cancelReplaceBracket(
  accountId: string,
  pos: {
    id: number;
    symbol: string;
    side: 'long' | 'short';
    remainingQuantity: number;
    stopPrice: number | null;
    targetPrice: number | null;
  },
  resting: WebullOpenOrder[],
  keepQty: number,
  cfg: AutotradeConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const symbol = pos.symbol.toUpperCase();
  // TAKE-PROFIT first, STOP last. This loop cancels one leg at a time and
  // returns on the first failure, so the bracket can be left HALF cancelled —
  // and which half survives decides whether the position is merely missing a
  // target or is running naked. See cancelOrderForLegs in cancelReplace.ts.
  const attempted = cancelOrderForLegs(resting);
  const ids = attempted.map((l) => l.clientOrderId).filter((v): v is string => !!v);
  if (ids.length !== attempted.length) {
    return { ok: false, reason: 'a resting leg has no client order id to cancel by' };
  }

  const cancelled: string[] = [];
  for (const id of ids) {
    const c = await webullCancelOrder(accountId, id);
    if (!c.ok) {
      // Did we already remove the protection? With cancelOrderForLegs in front
      // of this loop the answer is NO for every input that can reach here:
      // buildBracketResizePatches has already refused anything that is not one
      // take-profit + one stop (or a lone leg), so the sort is total and the
      // stop is always cancelled last. This is therefore a DEFENCE, not a live
      // case — it exists so that a future change to the ordering, or a bracket
      // shape this code has not seen, degrades into a loud alert instead of a
      // quiet lie in the note below. Derived, never assumed.
      const stopGone = stopWasCancelled(attempted, cancelled.length);
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        // A cancelled STOP is not a blocked scale-out, it is an unprotected
        // position — the action liveFailureAlert pages on. Journaling it as
        // live_scale_out_blocked (which alerts on nothing) is how this state
        // would stay silent until the next protection sweep.
        action: stopGone ? 'live_position_unprotected' : 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          quantity: pos.remainingQuantity,
          reason: stopGone
            ? `cancel-replace: cancelling leg ${id} failed (${c.error ?? 'unknown'}) AFTER the stop was already ` +
              'cancelled — this position has NO downside protection. Re-arm the stop by hand.'
            : `cancel-replace: cancelling leg ${id} failed: ${c.error ?? 'unknown'}`,
          cancelledSoFar: cancelled,
          note: stopGone
            ? 'The bracket is PARTLY cancelled and the STOP is the part that is gone.'
            : 'The bracket may now be PARTLY cancelled, but the STOP was NOT among the legs cancelled — ' +
              'the position keeps its downside protection and has lost only its target. ' +
              'Checked, not assumed: see cancelOrderForLegs.',
        },
        riskProfile: cfg.riskProfile,
      });
      return { ok: false, reason: `cancel failed for ${id}: ${c.error ?? 'unknown'}` };
    }
    cancelled.push(id);
  }

  // A cancel is an accepted REQUEST, not a completed action. Confirm before
  // anything sells against this position.
  const fresh = await listWebullOpenOrders(accountId);
  const verdict = verifyLegsGone(fresh.ok ? fresh.orders : null, ids);
  if (!verdict.ok) {
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_out_blocked',
      detail: {
        positionId: pos.id,
        reason: `cancel-replace abandoned: ${verdict.reason}`,
        note: 'Not selling against a bracket that may still be live — the accidental short this ordering prevents.',
      },
      riskProfile: cfg.riskProfile,
    });
    return { ok: false, reason: verdict.reason };
  }

  // --- 3. RE-BRACKET THE REMAINDER, BEFORE ANYTHING SELLS -----------------
  //
  // cancelReplace.ts documents five steps and only the first two existed: this
  // function used to journal "unprotected — re-arm by hand" and return ok, and
  // the caller then sold the partial. So turning the flag on would have left
  // the remainder with no stop and no target INDEFINITELY. A missed partial is
  // worth +0.18R; an unhedged real-money position is worth far less than that,
  // which is why the flag was never safe to enable.
  //
  // Bracketing BEFORE the sell (rather than after, as the original sketch had
  // it) removes the worst state entirely. If this placement fails we have sold
  // nothing, so the rollback is simply to re-bracket the FULL position and
  // abandon the scale-out — back to exactly where we started, protected, with
  // a missed partial. Sell-then-bracket has no such rollback: the shares are
  // already gone and the only remaining move is a forced close.
  // The shared derivation (it was a local copy here, correctly sided; the
  // protection sweep's copy was not). One function, so the two cannot drift.
  const protectIntent = (quantity: number): OrderIntent => protectiveBracketIntent(symbol, pos.side, quantity);
  const rearm = await webullPlaceStandaloneBracket(
    accountId,
    protectIntent(keepQty),
    pos.targetPrice ?? undefined,
    pos.stopPrice ?? undefined,
  );
  if (!rearm.ok) {
    // Ambiguous means the bracket MAY be resting. Placing a second one for the
    // full size could leave two stops against one position — the accidental
    // short. So restore only on a KNOWN rejection, and on an unanswered one
    // leave it to checkLiveBracketProtection's fresh read next tick.
    if (!rearm.ambiguous) {
      const restored = await webullPlaceStandaloneBracket(
        accountId,
        protectIntent(pos.remainingQuantity),
        pos.targetPrice ?? undefined,
        pos.stopPrice ?? undefined,
      );
      if (restored.ok) recordRearmedLegs(pos.id, restored.legClientOrderIds);
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: restored.ok ? 'live_bracket_rearmed' : 'live_position_unprotected',
        detail: {
          positionId: pos.id,
          quantity: pos.remainingQuantity,
          reason: restored.ok
            ? 'cancel-replace abandoned — full bracket restored, nothing was sold'
            : `cancel-replace abandoned AND the full-size restore failed (${restored.error ?? 'unknown'}) — position is unprotected`,
        },
        riskProfile: cfg.riskProfile,
      });
    } else {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_position_unprotected',
        detail: {
          positionId: pos.id,
          quantity: pos.remainingQuantity,
          reason: `re-bracket was UNANSWERED (${rearm.error ?? 'no response'}) — protection state unknown, not stacking a second bracket on top of a possibly-live one`,
        },
        riskProfile: cfg.riskProfile,
      });
    }
    return { ok: false, reason: `re-bracket failed: ${rearm.error ?? 'unknown'}` };
  }

  recordRearmedLegs(pos.id, rearm.legClientOrderIds);
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_bracket_rearmed',
    detail: {
      positionId: pos.id,
      quantity: keepQty,
      targetPrice: pos.targetPrice,
      stopPrice: pos.stopPrice,
      clientComboOrderId: rearm.clientComboOrderId ?? null,
      reason: 'remainder bracketed for a cancel-replace scale-out; the partial sell follows',
    },
    riskProfile: cfg.riskProfile,
  });
  return { ok: true };
}

/**
 * Bank part of a live winner at the configured R trigger — see scaleOut.ts for
 * why this exists (live positions otherwise exit on a timer at whatever R they
 * happen to be) and for the ordering rule this function implements.
 *
 * The sequence, and the reason for it:
 *   1. Read the broker's resting exit legs for the symbol.
 *   2. REDUCE each of them to the remainder we intend to keep.
 *   3. Only then sell the scale-out quantity.
 *
 * Selling first would leave a full-size bracket against a half-size holding,
 * and a later stop fill would sell shares we no longer own — for a long, a
 * SHORT position nobody opened. Reducing first inverts that: if step 3 fails,
 * the shares we were about to sell sit briefly unbracketed, which
 * checkLiveBracketProtection already reports and the next tick retries.
 *
 * A leg that cannot be reduced ABANDONS the scale-out for this tick with the
 * position still fully protected. There is no path here that sells against an
 * unreduced bracket.
 */
export async function checkLiveEquityScaleOuts(): Promise<LiveScaleOutOutcome[]> {
  if (!config.trading.placeEnabled) return [];
  const cfg = getAutotradeConfig();
  if (!cfg.liveScaleOutEnabled || !cfg.liveAccountId) return [];
  // Per-lot brackets REPLACE this path (#26). They are two answers to one
  // question — how to bank a partial — and running both would have the
  // scale-out cancel-and-replace a bracket whose near target is already
  // resting, reopening the exact naked window per-lot brackets exist to remove.
  // Mutually exclusive by construction rather than by the operator remembering
  // to turn one off.
  if (cfg.livePerLotBracketsEnabled) return [];
  // Never into pre/after-hours liquidity: this is opportunistic profit-taking,
  // not a protective exit, so it has no business paying a wide spread.
  if (!checkSessionWindow(0).ok) return [];
  // Nor through a kill switch (2026-09-23). The partial SELL below runs the
  // guardrails and was always refused under a halt, but the bracket RESIZE
  // (and the cancel-replace fallback) runs before it and calls the broker
  // directly — so a halted account would have had its bracket cut to the
  // remainder and then nothing sold, leaving the partial with no stop.
  if (buildLiveTradingConfig(cfg).killSwitch) return [];

  const open = listAutotradeLivePositions({ status: 'open' });
  if (open.length === 0) return [];
  // Closed positions can never resize again; drop their latches so the map
  // tracks the open book rather than every position the process has seen.
  pruneResizeLatches(open.map((p) => p.id));
  const pendingExitPositionIds = new Set(
    listPendingLiveOrders()
      .filter((o) => o.role === 'exit' && o.positionId !== null)
      .map((o) => o.positionId!),
  );

  const accountId = cfg.liveAccountId;
  const outcomes: LiveScaleOutOutcome[] = [];
  for (const pos of open) {
    // An exit already working means the whole position is on its way out;
    // scaling out of it would race that close for the same shares.
    if (pendingExitPositionIds.has(pos.id)) continue;

    let last: number;
    try {
      last = (await getProvider().getQuote(pos.symbol.toUpperCase())).last;
    } catch {
      continue; // opportunistic — a transient quote failure just waits a tick
    }
    const decision = evaluateScaleOut(pos, last, cfg);
    if (!decision.triggered) continue;

    const symbol = pos.symbol.toUpperCase();
    const exitSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
    const keepQty = pos.remainingQuantity - decision.quantity;

    // --- 1. what is actually resting at the broker -------------------------
    const listed = await listWebullOpenOrders(accountId);
    if (!listed.ok) {
      outcomes.push({
        symbol,
        positionId: pos.id,
        requested: false,
        reason: `Could not read open orders: ${listed.error ?? 'unreadable'}`,
      });
      continue;
    }
    const resting = restingExitOrders(listed.orders, symbol, exitSide);
    if (resting.length === 0) {
      // Same reasoning as the close path's own refusal: an empty list is
      // ambiguous (nothing resting, OR a leg we failed to parse), and acting on
      // it is what oversells. A position with no readable protection is
      // checkLiveBracketProtection's problem, not something to scale out of.
      outcomes.push({
        symbol,
        positionId: pos.id,
        requested: false,
        reason: 'No readable resting exit leg — not scaling out against an unknown bracket',
      });
      continue;
    }

    // A single bracket rests as at most TWO exit legs — a take-profit and a
    // stop-loss, of which exactly one can fill. MORE than two means this symbol
    // carries more than one LOT's protection, which is precisely what a
    // scale-in creates: placeLiveScaleInAddOn gives the added shares their OWN
    // bracket rather than resizing the original one.
    //
    // keepQty is a single whole-position number, so applying it to every leg
    // would leave TWO brackets each protecting keepQty. If the stop then fills,
    // both stop legs sell keepQty against a position of keepQty and the account
    // ends up SHORT by keepQty — the accidental short this function's ordering
    // is otherwise so careful to avoid.
    //
    // Splitting keepQty across lots correctly would mean tracking which bracket
    // protects which shares, which nothing here does. So refuse, exactly as
    // restingStopLeg refuses when it finds more than one STOP_LOSS leg for the
    // same reason. Found 2026-09-02 auditing liveScaleInEnabled BEFORE turning
    // it on; unreachable while scale-in is off.
    if (resting.length > 2) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          reason: `${resting.length} resting exit legs — more than one lot's bracket, cannot attribute the reduction`,
          legs: resting.map((l) => l.clientOrderId),
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({
        symbol,
        positionId: pos.id,
        requested: false,
        reason: `${resting.length} resting exit legs — ambiguous, not resizing a multi-lot bracket`,
      });
      continue;
    }

    // --- 2. reduce every leg to the remainder FIRST ------------------------
    // ONE request carrying every leg, not a replace per leg. The broker checks
    // the OCO group's balance per request, so reducing a take-profit without
    // its stop-loss in the same call is refused: "The number of take-profit
    // orders and the number of stop-loss orders must be the same." Measured
    // 2026-09-02 — 89 refusals across DELL, GTLB and HPQ, and not one
    // scale-out had ever executed since the mechanism shipped.
    //
    // It also removes the partial-modify window the loop had: it broke on the
    // first failure without undoing legs it had already changed, which could
    // leave the target covering the reduced size while the stop still covered
    // the full one. A single request cannot half-apply.
    //
    // 2026-09-03: batching was necessary but NOT sufficient. The batched
    // quantity-only modify was refused with the SAME message, 9 times, on the
    // first day the ratchet worked. What separates the two replace calls this
    // system makes is which fields they carry:
    //
    //   ratchet    { client_order_id, stop_price }            -> 6/6 accepted
    //   scale-out  { client_order_id, quantity } x2            -> 0/9 accepted
    //
    // The accepted one names the price that DEFINES its leg; the refused one
    // names nothing that identifies either leg as a take-profit or a stop-loss.
    // Both legs of a long bracket are `sell`, and until now nothing here read
    // order_type or combo_type, so we could not say which was which either —
    // the broker's complaint was literally true of the request we sent.
    //
    // So each leg now restates its own defining price alongside the new
    // quantity: limit_price for the take-profit, stop_price for the stop. The
    // price sent is the one just READ BACK from the broker, so it is an exact
    // echo and moves nothing — this is identification, not a price change.
    const patches = buildBracketResizePatches(resting, keepQty);
    if (!patches) {
      // Fail closed, and make the next occurrence self-diagnosing: without the
      // leg shapes this failure is indistinguishable from the one above, which
      // is how it went a full session looking like an already-fixed bug.
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          reason: 'Could not tell the take-profit leg from the stop-loss leg — not resizing a bracket blind',
          // null, not undefined: JSON.stringify DROPS undefined keys, and an
          // absent comboType/orderType is precisely the thing being diagnosed
          // here — recording it as a missing key would hide the evidence.
          legs: resting.map((l) => ({
            clientOrderId: l.clientOrderId ?? null,
            comboType: l.comboType ?? null,
            comboOrderId: l.comboOrderId ?? null,
            orderType: l.orderType ?? null,
            limitPrice: l.limitPrice ?? null,
            stopPrice: l.stopPrice ?? null,
            quantity: l.quantity ?? null,
            status: l.status ?? null,
          })),
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({
        symbol,
        positionId: pos.id,
        requested: false,
        reason: 'exit legs not classifiable as take-profit + stop-loss',
      });
      continue;
    }
    // The combo group id, when we have one. Persisted at placement since
    // 2026-09-04; null for any bracket opened before that, which simply sends
    // the request without it exactly as before.
    // Looked up for the JOURNAL only — it is deliberately not sent (see the
    // request below). Recorded so a refusal says which group the legs belong
    // to without implying the id went on the wire.
    const knownComboId = getLiveEntryOrderForPosition(pos.id)?.clientComboOrderId ?? null;

    // A refusal here is deterministic in the request, so retrying an IDENTICAL
    // one every tick adds a broker round-trip and a journal row and no
    // information. Skip only an exact repeat — any change to the patches or the
    // group id is attempted, so a payload experiment is never suppressed.
    // undefined, because that is what the request now carries. The signature
    // must describe what is SENT — otherwise the latch could suppress a payload
    // experiment as a duplicate of a request that no longer exists.
    const signature = resizeAttemptSignature(patches, undefined);
    const repeat = shouldSkipResize(pos.id, signature);
    if (repeat.skip) {
      outcomes.push({
        symbol,
        positionId: pos.id,
        requested: false,
        reason: `bracket resize refused ${repeat.priorRefusals}x with this same request — not retrying until it changes`,
      });
      continue;
    }

    // No client_combo_order_id. The ratchet — the only call this endpoint has
    // ever accepted on a resting bracket leg — does not send one, and sending
    // it here has now drawn 46 identical refusals. See buildBracketResizePatches.
    const replaced = await webullReplaceOrders(accountId, patches);
    let reduceFailed = replaced.ok
      ? null
      : `${resting.map((l) => l.clientOrderId).join(', ')}: ${replaced.error ?? 'replace failed'}`;

    // LAST RESORT, and only when explicitly enabled. In-place quantity
    // modification of a combo leg is closed (four payload shapes, 100+
    // refusals, confirmed 2026-09-04 with a real client_combo_order_id on the
    // wire). Cancel-and-replace is the only other route and it INVERTS the
    // failure mode — between the cancel and the new bracket the position is
    // naked — so it is a separate, deliberate decision from liveScaleOutEnabled
    // and defaults off. See cancelReplace.ts for the ordering rule.
    let usedCancelReplace = false;
    if (reduceFailed && cfg.liveScaleOutCancelReplaceEnabled) {
      const outcome = await cancelReplaceBracket(accountId, pos, resting, keepQty, cfg);
      if (outcome.ok) {
        reduceFailed = null;
        usedCancelReplace = true;
      } else {
        reduceFailed = `${reduceFailed}; cancel-replace also failed: ${outcome.reason}`;
      }
    }

    if (reduceFailed) {
      const attempt = recordResizeRefusal(pos.id, signature);
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          reason: `Could not reduce the resting bracket: ${reduceFailed}`,
          // Attempt number for THIS request. Identical retries after it are
          // skipped and never journaled, so a reader must not take the row
          // count as the number of ticks that hit this — it is the number of
          // DISTINCT requests refused.
          attempt,
          identicalRetriesSuppressed: true,
          // The shapes we sent, so a repeat refusal names the field the broker
          // is unhappy with instead of just repeating its message back at us.
          sent: patches,
          // NOT sent since 2026-09-08 — recorded so a reader can tell the two
          // eras apart, and so a refusal still names the group.
          clientComboOrderIdSent: null,
          knownComboOrderId: knownComboId,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: reduceFailed });
      continue;
    }

    // ACCEPTED IS NOT APPLIED. Re-read the book and confirm the legs actually
    // carry the new size, and still carry their prices, before a single share
    // is sold against them. A 200 from the broker with a full-size bracket
    // still resting would turn this partial into a short.
    // Only for the DIRECT resize. Cancel-and-replace deliberately destroys these
    // leg ids and places a fresh bracket, so checking that the old ids came back
    // resized would condemn its success as a vanished leg — it does its own
    // verification (verifyLegsGone) and re-brackets before selling.
    const after = usedCancelReplace ? null : await listWebullOpenOrders(accountId);
    const verdict = usedCancelReplace
      ? ({ ok: true } as const)
      : verifyLegsResized(after && after.ok ? after.orders : null, resting, keepQty);
    if (!verdict.ok) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        // A bracket that MOVED into a shape nobody chose is a protection
        // problem and pages; one that did not move at all is just a partial we
        // decline to take, and the position keeps its full-size bracket.
        action: verdict.applied ? 'live_position_unprotected' : 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          reason: `resize accepted but not verified: ${verdict.reason}`,
          note: verdict.applied
            ? 'The resting bracket changed into something this code did not ask for. NOTHING was sold. Check the broker.'
            : 'The bracket is unchanged and still covers the whole position, so the partial was skipped and nothing is unprotected.',
          sent: patches,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: verdict.reason });
      continue;
    }

    // The resize was ACCEPTED and CONFIRMED, so the latch has nothing left to
    // suppress. Clear it rather than leaving a stale signature that could skip
    // a later partial on this same position.
    clearResizeLatch(pos.id);

    // --- 3. and only now sell the difference -------------------------------
    const buffer = 1 + (exitSide === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
    const intent: OrderIntent = {
      symbol,
      assetKind: 'stock',
      side: exitSide,
      openClose: 'close',
      quantity: decision.quantity,
      orderType: 'limit',
      limitPrice: Math.round(last * buffer * 100) / 100,
      referencePrice: last,
    };
    const liveCfg = buildLiveTradingConfig(cfg);
    const acct = await stockAccountState(accountId, symbol);
    if (!acct.ok || !acct.state) {
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: acct.error ?? 'no account state' });
      continue;
    }
    const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(Date.now(), 'stock') };
    const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
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
        action: 'live_scale_out_blocked',
        detail: { positionId: pos.id, reasons },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: reasons, intentId: intentRec.id });
      continue;
    }

    transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live scale-out)' });
    transitionIntent(intentRec.id, 'confirmed', { detail: 'autotrade — no per-order confirmation' });
    transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });
    const broker = await webullPlaceOrder(accountId, intent, clientOrderId);
    if (!broker.ok && !broker.ambiguous) {
      transitionIntent(intentRec.id, 'rejected', { detail: broker.error ?? 'placement failed' });
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_scale_out_failed',
        detail: { positionId: pos.id, reason: broker.error },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: broker.error, intentId: intentRec.id });
      continue;
    }
    // Recorded as a role='exit' order, so reconcile's existing exit path books
    // the fill — materializeTimeExitFill already reduces a position by what
    // actually filled and leaves the rest open, which is exactly a scale-out.
    transitionIntent(intentRec.id, 'acknowledged', {
      brokerOrderId: broker.orderId,
      detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
    });
    recordLiveExitOrder({ intentId: intentRec.id, symbol, riskProfile: cfg.riskProfile, positionId: pos.id });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_out_placed',
      detail: {
        positionId: pos.id,
        quantity: decision.quantity,
        keepQty,
        rMultiple: decision.rMultiple,
        limitPrice: intent.limitPrice,
        legsReduced: resting.length,
        reason: decision.detail,
      },
      riskProfile: cfg.riskProfile,
    });
    outcomes.push({
      symbol,
      positionId: pos.id,
      requested: true,
      quantity: decision.quantity,
      rMultiple: decision.rMultiple,
      intentId: intentRec.id,
    });
  }
  return outcomes;
}

export async function checkLiveEquityTimeExits(): Promise<LiveEquityTimeExitOutcome[]> {
  // The deploy-level master gate, checked FIRST — mirrors checkLiveOptionsExits'
  // own reasoning: this places a brand-new real order (and cancels a resting
  // one), so it needs the same check attemptLiveEntry's own entry path gets.
  if (!config.trading.placeEnabled) return [];
  const cfg = getAutotradeConfig();
  if (!cfg.liveAccountId) return [];
  const stagnationConfigured = cfg.stagnationExitMinutes > 0;
  const flatten = evaluateEndOfDayFlatten(cfg, Date.now());
  if (cfg.maxHoldDays <= 0 && !stagnationConfigured && !flatten.active) return [];

  const open = listAutotradeLivePositions({ status: 'open' });
  if (open.length === 0) return [];

  // Stagnation is evaluated only while the REGULAR session is open: wall-clock
  // minutes would otherwise mark a Friday-afternoon entry "stagnant" at
  // Monday's opening bell purely from the weekend, and a scratch should never
  // be attempted into pre/after-market liquidity. maxHoldDays keeps its
  // original anytime behavior (the placement guardrails' market-open check
  // still gates the actual order either way).
  const sessionOpen = stagnationConfigured && checkSessionWindow(0).ok;

  // The book's ROOM, read once per tick from the same two quantities the entry
  // gate compares (task #41). Computed even when
  // stagnationExitRequiresScarcity is OFF: a scratch that fired while the cap
  // was binding and one that fired into three free slots are different events,
  // and the journal could not tell them apart. That distinction is the whole
  // question the paper experiment is running to answer, so it is recorded from
  // now regardless of which way the flag is set.
  //
  // Once per tick, not per position: a close placed inside this loop does not
  // relieve pressure until the fill is booked, which is equally true of the
  // entry gate reading the same numbers.
  const slotPressure: SlotPressure | undefined = sessionOpen
    ? (() => {
        const combined = combinedLiveOpenRisk();
        const equity = cfg.accountEquityUsd ?? 0;
        return {
          openPositions: combined.count,
          maxConcurrentPositions: cfg.maxConcurrentPositions,
          openRiskUsd: combined.risk,
          aggregateRiskCapUsd: (cfg.maxAggregateOpenRiskPct / 100) * equity,
          nextTradeRiskUsd: (cfg.riskPerTradePct / 100) * equity,
        };
      })()
    : undefined;

  const pendingExits = listPendingLiveOrders().filter((o) => o.role === 'exit' && o.positionId !== null);
  const pendingExitPositionIds = new Set(pendingExits.map((o) => o.positionId!));
  // A resting exit placed BEFORE the flatten window may be nowhere near the
  // current price — GRMN on 2026-08-25 rested a 293.52 limit priced off the
  // 294.99 opening print while the stock traded 289.85, and would have been
  // carried a second night by an exit that had already decided to leave. Inside
  // the window such an order is replaced once (placeLiveEquityTimeExitClose
  // cancels every resting exit-side order for the symbol, then re-prices off a
  // fresh quote). An order placed INSIDE the window is left alone, so this
  // cannot churn cancel/replace on every tick.
  //
  // "Replaceable" means: it has a resting exit from BEFORE the window and none
  // from inside it. The second half matters — cancelLiveBracketExitLegs cancels
  // the stale order at the BROKER, but its local intent row stays pending until
  // a later reconcile tick observes the cancel. Without the freshness check that
  // lingering row would read as replaceable again next tick and place a THIRD
  // order against a position that already has a live close working.
  const windowStartedAt = flatten.active ? Date.now() - cfg.endOfDayFlattenMinutes * 60_000 : 0;
  const replaceableExitPositionIds = new Set<number>();
  if (flatten.active) {
    const byPosition = new Map<number, number[]>();
    for (const o of pendingExits) {
      const list = byPosition.get(o.positionId!) ?? [];
      list.push(o.createdAt);
      byPosition.set(o.positionId!, list);
    }
    for (const [positionId, createdAts] of byPosition) {
      const hasStale = createdAts.some((t) => t < windowStartedAt);
      const hasFresh = createdAts.some((t) => t >= windowStartedAt);
      if (hasStale && !hasFresh) replaceableExitPositionIds.add(positionId);
    }
  }

  const outcomes: LiveEquityTimeExitOutcome[] = [];
  for (const pos of open) {
    if (pendingExitPositionIds.has(pos.id) && !replaceableExitPositionIds.has(pos.id)) continue;
    let trigger: TimeExitTrigger | null = null;
    if (flatten.active) {
      // FIRST, and unconditional on how the trade is doing: a winner held into
      // the close is still an overnight gap, and this loop's edge is intraday.
      trigger = {
        kind: 'end_of_day',
        journal: {
          minutesLeft: flatten.minutesLeft,
          endOfDayFlattenMinutes: cfg.endOfDayFlattenMinutes,
          replacedRestingExit: replaceableExitPositionIds.has(pos.id),
          reason: flatten.detail,
        },
        notice: `flattening ${flatten.minutesLeft}m before the close`,
      };
    } else if (cfg.maxHoldDays > 0 && Date.now() - pos.createdAt >= cfg.maxHoldDays * MS_PER_DAY) {
      trigger = { kind: 'max_hold_days', journal: { maxHoldDays: cfg.maxHoldDays }, notice: 'max hold time reached' };
    } else if (sessionOpen && Date.now() - pos.createdAt >= cfg.stagnationExitMinutes * 60_000) {
      // Progress needs a quote. A transient quote failure just skips this
      // position until the next tick (stagnation is opportunistic — nothing
      // is left unprotected, the bracket is still resting) rather than
      // journaling a failure per tick.
      let last: number;
      try {
        last = (await getProvider().getQuote(pos.symbol.toUpperCase())).last;
      } catch {
        continue;
      }
      const decision = evaluateStagnation(pos, last, cfg, Date.now(), slotPressure);
      if (!decision.triggered) {
        // A trade that WOULD have been scratched and was kept because the slot
        // was free is the gate's only observable effect, so it gets its own
        // action rather than being invisible. Once per position per ET day:
        // the condition persists across every tick until the position closes.
        if (decision.heldForFreeSlot && claimOncePerDay('stagnation_exit_held_slot_free', String(pos.id))) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'stagnation_exit_held_slot_free',
            detail: {
              positionId: pos.id,
              heldMinutes: decision.heldMinutes,
              progressR: decision.progress,
              scarcity: decision.scarcity,
              reason: decision.detail,
            },
          });
        }
        continue;
      }
      trigger = {
        kind: 'stagnation',
        journal: {
          heldMinutes: decision.heldMinutes,
          progressR: decision.progress,
          // Recorded on the TRIGGER too, not only on the hold — "the cap was
          // binding when this fired" is the half of the question a
          // suppression-only record cannot answer.
          scarcity: decision.scarcity,
          reason: decision.detail,
        },
        notice: `stagnant: ${decision.progress}R after ${decision.heldMinutes}m`,
      };
    }
    if (!trigger) continue;

    // Both of these leave a position sitting past its hold limit with no close
    // attempted, every tick, so they are journaled like any other failed close
    // rather than reported only in this function's return value.
    // Which bracket owns this position? Normally positions.source_intent_id,
    // set at creation. An ADOPTED position never has it (see
    // getLiveEntryOrderForPosition's own comment) — its link lives only in
    // autotrade_live_orders.position_id — so fall back to that rather than
    // declaring the position unclosable. Without the fallback a triggered
    // time exit re-failed on EVERY tick and the position could never be
    // exited by the loop at all.
    const entryOrderMeta =
      pos.sourceIntentId !== null ? getLiveOrder(pos.sourceIntentId) : getLiveEntryOrderForPosition(pos.id);
    const entryIntentId = pos.sourceIntentId ?? entryOrderMeta?.intentId ?? null;
    if (entryIntentId === null) {
      outcomes.push(
        timeExitFailure(
          pos,
          cfg.riskProfile,
          'No source intent on this position — cannot locate its bracket to cancel',
        ),
      );
      continue;
    }
    const entryIntent = getIntent(entryIntentId);
    const riskProfile = entryOrderMeta?.riskProfile ?? cfg.riskProfile;
    if (!entryIntent) {
      outcomes.push(timeExitFailure(pos, riskProfile, `Source intent ${entryIntentId} not found`));
      continue;
    }

    // Re-fetch fresh config for EACH triggered position, same reasoning as
    // checkLiveOptionsExits' own per-position refresh — this loop awaits real
    // broker round-trips between positions, and a kill switch engaged
    // mid-loop must stop the NEXT position's cancel/close immediately, not
    // just the next cycle.
    const freshCfg = getAutotradeConfig();
    const freshAccountId = freshCfg.liveAccountId;
    if (!freshAccountId) continue;
    // The re-read above used to check ONLY liveAccountId, despite this comment
    // promising a mid-loop kill switch stops the next cancel/close. It now
    // actually does. The guardrails inside the close path would catch it too
    // (and now do so BEFORE the bracket is cancelled), but stopping here means
    // a halted account doesn't churn a rejected intent per position per tick.
    const freshLiveCfg = buildLiveTradingConfig(freshCfg);
    if (!freshLiveCfg.enabled || freshLiveCfg.killSwitch) break;

    // The bracket cancel now happens INSIDE placeLiveEquityTimeExitClose, after
    // its guardrails pass — cancelling here meant a blocked close stripped the
    // position's only stop. See that function's own comment.
    outcomes.push(await placeLiveEquityTimeExitClose(pos, freshAccountId, riskProfile, entryIntent, trigger));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Scale into winners on LIVE equity positions (opt-in via liveScaleInEnabled).
// The RISKIEST autotrade action — it ADDS to a real, already-open position —
// so it's built to NEVER leave the position under-protected: the add is placed
// as its OWN bracket order (raised stop + the position's target), so the added
// shares are born protected and the ORIGINAL bracket is never touched (no
// cancel-and-replace, no naked window, and it never leans on the
// still-unconfirmed bracket-cancel path). Its fill later MERGES into the
// position (blended entry, bigger quantity) via materializeAddOnFill.
//
// Fails closed at every step: a bad quote, blocked guardrail, or broker
// rejection for ONE position is logged and skipped, never crashing the loop or
// touching another position. Same "unconfirmed against a real account" caveat
// the rest of this file's live-order surface carries — validate in paper +
// backtest first.
// ---------------------------------------------------------------------------

/**
 * THE MARKET-DIRECTION GATE FOR ADDS (2026-09-24). A scale-in and a per-lot
 * second lot both put more shares on in the position's direction, which is the
 * bet the gate refuses as a fresh entry: a long add on a broad red day is a
 * long bought into a red market. Until this date only the entry path asked.
 *
 * Both add paths run BEFORE the tick's screen (loop.ts), so they judge the
 * previous tick's held reading, about one tick old; a reading older than
 * LATEST_DIRECTION_MAX_AGE_MS is one the loop has not taken lately, and it
 * refuses nothing, the same as an `unknown` one. One function for both paths,
 * so the two cannot come to disagree about when an add is refused.
 *
 * Returns the reading that refuses this add, or null.
 */
function addOnDirectionRefusal(
  cfg: AutotradeConfig,
  side: 'long' | 'short',
  now: number,
): { reading: MarketDirectionReading; ageMs: number } | null {
  if (!cfg.marketDirectionGateEnabled) return null;
  const latest = latestMarketDirection(now);
  if (latest === null || !directionRefuses(latest.reading, side)) return null;
  return latest;
}

/**
 * A SHORT add's own permission (2026-09-24, the tape plan's PR 8). A scale-in
 * or a second lot on a short puts on more short, which is the bet
 * liveShortPermitted rules on for a fresh entry: shorts off refuses it, and
 * with liveShortsRedTapeOnly only a red reading admits it. The same predicate,
 * on the reading the direction gate for adds reads (the loop's latest, held),
 * so an add never goes out on a tape a fresh short would be refused on. A
 * long add returns null.
 */
function addOnShortRefusal(
  cfg: AutotradeConfig,
  side: 'long' | 'short',
  now: number,
): { cause: ShortRefusalCause; reason: string; direction: MarketDirectionReading['direction'] | null } | null {
  if (side !== 'short') return null;
  const latest = latestMarketDirection(now);
  const verdict = liveShortPermitted(cfg, latest?.reading ?? null);
  if (verdict.permitted) return null;
  return { cause: verdict.cause, reason: verdict.reason, direction: latest?.reading.direction ?? null };
}

/** The journal detail an add refused by the market's direction carries: the
 *  reading, whether it was held, and how old it was. */
function addOnDirectionDetail(
  refusedBy: { reading: MarketDirectionReading; ageMs: number },
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const r = refusedBy.reading;
  return {
    ...extra,
    direction: r.direction,
    rawDirection: r.rawDirection ?? r.direction,
    heldBy: r.heldBy ?? null,
    indexSymbol: r.indexSymbol,
    indexChangePct: r.indexChangePct,
    redPct: r.redPct,
    greenPct: r.greenPct,
    breadthSample: r.sample,
    indexPct: r.indexPct,
    breadthPct: r.breadthPct,
    readingAgeSec: Math.round(refusedBy.ageMs / 1000),
  };
}

export interface LiveScaleInOutcome {
  symbol: string;
  positionId: number;
  /** True when a real add-on order was actually placed at the broker. */
  requested: boolean;
  reason?: string;
}

export async function checkLiveScaleIns(
  /** The live OPTIONS sleeve's day, threaded in by loop.ts exactly as
   *  runLiveExecution's is (reading it here would be an import cycle). The
   *  add-on's drawdown halt is the live pool's, stock plus options. REQUIRED,
   *  not defaulted: a default of zero is how a caller would silently judge the
   *  stock sleeve alone, which is what this gate did until 2026-09-23. */
  optionsSeed: LiveOptionsRiskSeed,
): Promise<LiveScaleInOutcome[]> {
  if (!config.trading.placeEnabled) return []; // server master (TRADING_ENABLED)
  const cfg = getAutotradeConfig();
  if (!cfg.liveAccountId) return [];
  if (!cfg.liveScaleInEnabled) return [];
  if (cfg.liveMaxAddOns <= 0 || cfg.addOnTriggerRMultiple <= 0 || cfg.addOnSizePct <= 0) return [];
  // Session window, checked HERE rather than relying on the caller. A scale-in
  // places a real, marketable order that ADDS risk to an already-open position,
  // and loop.ts runs it well before its own checkSessionWindow — behind
  // isLiveEntryActive, which despite its call-site comment carries no
  // market-hours term (kill switches and master gates only). The guardrail
  // layer is not a backstop either: evaluateGuardrails only WARNS on a closed
  // market, never blocks. Without this, an add-on could be submitted overnight,
  // at a weekend, or inside the open/close buffer every other entry respects.
  const session = checkSessionWindow(cfg.sessionBufferMinutes);
  if (!session.ok) return [];

  const open = listAutotradeLivePositions({ status: 'open' }).filter((p) => p.assetType === 'stock');
  if (open.length === 0) return [];

  // Dedup: skip a position if any UNMATERIALIZED order for its symbol is in
  // flight (position_id IS NULL) — a fresh entry still working, or an add-on
  // placed a prior tick that hasn't filled/merged yet. A fresh add would race
  // it. Deliberately NOT keyed on the position's own filled entry bracket (its
  // position_id is set — it's what we're adding TO) nor on an ALREADY-merged
  // add-on (position_id set too — the liveMaxAddOns cap governs how many of
  // those, checked below, not this dedup).
  const inFlightSymbols = new Set(
    listPendingLiveOrders()
      .filter((o) => o.positionId === null)
      .map((o) => o.symbol),
  );

  const outcomes: LiveScaleInOutcome[] = [];
  for (const pos of open) {
    try {
      if (inFlightSymbols.has(pos.symbol)) continue;
      // Same adopted-position fallback as the time-exit loop above: without
      // it an adopted position can never scale in, since it has no
      // source_intent_id to carry the original risk geometry.
      const entryOrder =
        pos.sourceIntentId !== null ? getLiveOrder(pos.sourceIntentId) : getLiveEntryOrderForPosition(pos.id);
      if (!entryOrder || !(entryOrder.stopPrice > 0)) continue;
      if (countLiveAddOns(pos.id) >= cfg.liveMaxAddOns) continue;

      const targetPrice = pos.targetPrice ?? entryOrder.targetPrice;
      if (!(targetPrice > 0)) continue; // the add-on's own bracket needs a target

      let last: number;
      try {
        last = (await getProvider().getQuote(pos.symbol)).last;
      } catch (err) {
        outcomes.push({
          symbol: pos.symbol,
          positionId: pos.id,
          requested: false,
          reason: `Quote fetch failed: ${(err as Error).message}`,
        });
        continue;
      }
      if (!Number.isFinite(last) || last <= 0) continue;

      const add = computeScaleIn(
        {
          side: pos.side === 'long' ? 'buy' : 'sell',
          entryPrice: pos.entryPrice,
          initialStopPrice: entryOrder.stopPrice, // frozen original stop = the R denominator
          stopPrice: pos.stopPrice ?? entryOrder.stopPrice,
          quantity: pos.remainingQuantity,
          addOnsTaken: countLiveAddOns(pos.id),
        },
        last,
        {
          addOnTriggerRMultiple: cfg.addOnTriggerRMultiple,
          addOnSizePct: cfg.addOnSizePct,
          maxAddOns: cfg.liveMaxAddOns,
        },
      );
      if (!add) continue;

      // A short add's own permission (addOnShortRefusal), then the market's
      // direction (addOnDirectionRefusal), asked once the trigger and the
      // add-on cap say an add is due. The daily halt, the aggregate open-risk
      // cap and the guardrails below are asked after them, so a row can record
      // an add one of those would also have refused (a red day already halted
      // for drawdown, say). Unlike the second lot, a scale-in is priced and
      // sized afresh every tick, so a refused one is deferred, not dropped.
      const shortRefused = addOnShortRefusal(cfg, pos.side, Date.now());
      if (shortRefused !== null) {
        const key = `${pos.id}|${shortRefused.cause}|${shortRefused.direction ?? 'none'}`;
        if (claimOncePerDay('live_scale_in_short_skipped', key)) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'live_scale_in_short_skipped',
            detail: {
              positionId: pos.id,
              side: pos.side,
              addQuantity: add.addQty,
              rMultiple: add.rMultiple,
              cause: shortRefused.cause,
              direction: shortRefused.direction,
              reason: shortRefused.reason,
            },
            riskProfile: cfg.riskProfile,
          });
        }
        outcomes.push({
          symbol: pos.symbol,
          positionId: pos.id,
          requested: false,
          reason: `Short add-on refused: ${shortRefused.reason}`,
        });
        continue;
      }
      // The market's direction: once per position and direction a day; the
      // refusal stands every tick the reading does.
      const refusedBy = addOnDirectionRefusal(cfg, pos.side, Date.now());
      if (refusedBy !== null) {
        const reason = `${refusedBy.reading.detail} — a ${pos.side} add-on leans against it`;
        if (claimOncePerDay('live_scale_in_direction_skipped', `${pos.id}|${refusedBy.reading.direction}`)) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'live_scale_in_direction_skipped',
            detail: addOnDirectionDetail(refusedBy, {
              positionId: pos.id,
              side: pos.side,
              addQuantity: add.addQty,
              rMultiple: add.rMultiple,
              reason,
            }),
            riskProfile: cfg.riskProfile,
          });
        }
        outcomes.push({
          symbol: pos.symbol,
          positionId: pos.id,
          requested: false,
          reason: `Market direction: ${reason}`,
        });
        continue;
      }

      outcomes.push(await placeLiveScaleInAddOn(pos, add, last, targetPrice, cfg, optionsSeed));
    } catch (err) {
      // Fail closed per position — a broker hiccup never crashes the loop.
      outcomes.push({
        symbol: pos.symbol,
        positionId: pos.id,
        requested: false,
        reason: `Scale-in error: ${(err as Error).message}`,
      });
    }
  }
  return outcomes;
}

/** Place a single scale-in add-on as its own bracket order — mirrors
 *  attemptLiveEntry's guardrails→place→record→notify sequence exactly, so the
 *  add gets the SAME fresh-account-state guardrail gate (buying power, per-order
 *  $, daily loss, orders/day, naked-short) a fresh entry does. */
async function placeLiveScaleInAddOn(
  pos: Position,
  add: ReturnType<typeof computeScaleIn> & object,
  last: number,
  targetPrice: number,
  cfg: AutotradeConfig,
  optionsSeed: LiveOptionsRiskSeed,
): Promise<LiveScaleInOutcome> {
  const symbol = pos.symbol.toUpperCase();
  // Fresh account id per position — a kill switch flipped mid-loop must stop
  // the next add immediately (same reasoning as the time-exit loop).
  const accountId = getAutotradeConfig().liveAccountId;
  if (!accountId) return { symbol, positionId: pos.id, requested: false, reason: 'No liveAccountId configured' };
  const side: 'buy' | 'sell' = pos.side === 'long' ? 'buy' : 'sell';
  // Same either-link lookup as bracket protection: an ADOPTED position has no
  // source_intent_id, and reading only that silently fell back to the config's
  // profile instead of the one the entry was actually sized under.
  const riskProfile = getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile;

  const buffer = 1 + (side === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const limitPrice = Math.round(last * buffer * 100) / 100;

  // Risk-LAYER gates (distinct from the per-order guardrails below). A fresh
  // entry goes through evaluateRiskCheck, which blocks on the realized
  // daily-drawdown halt and the aggregate open-risk cap; an add-on adds REAL
  // risk to the book, so it must respect those too — otherwise pyramiding into
  // winners can push total open risk past maxAggregateOpenRiskPct, and add-ons
  // keep firing on a day already halted for realized drawdown. equity ?? 0
  // mirrors evaluateRiskCheck (snapshot.equity ?? 0): with equity unconfigured
  // the cap is 0, so any add is blocked — same as a fresh entry.
  const equity = cfg.accountEquityUsd ?? 0;
  const addRisk = orderRiskAmount(limitPrice, add.newStopPrice, add.addQty);
  // The one halt rule every entry runs (dailyHaltVerdict), on the same pool and
  // the same day-opening equity: live stock PLUS live options, and held for the
  // rest of the day once tripped. Until 2026-09-23 this was a third copy of the
  // rule, on the stock sleeve's P&L alone and re-checked each tick, so an add
  // could fire on a day the entries beside it were halted.
  const dailyPnl = getLivePortfolioSnapshot().dailyPnl + optionsSeed.dailyPnl;
  const today = etToday();
  const halt = dailyHaltVerdict({
    dailyPnl,
    maxDailyDrawdownPct: cfg.maxDailyDrawdownPct,
    dayStartEquityUsd: dayStartEquityUsd(getDailyBaseline(), today, equity).usd,
    dailyHaltTripped: liveDrawdownHaltedOn(today),
  });
  if (!halt.ok) {
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_in_blocked',
      detail: {
        reason: 'daily_drawdown_halt',
        dailyPnl,
        dailyHaltLevel: halt.level,
        haltDetail: halt.detail,
        positionId: pos.id,
      },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: `Daily drawdown halt (${halt.detail})` };
  }
  const aggregateCap = (cfg.maxAggregateOpenRiskPct / 100) * equity;
  const aggregateAfter = combinedLiveOpenRisk().risk + addRisk;
  if (aggregateAfter > aggregateCap) {
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_in_blocked',
      detail: { reason: 'max_aggregate_open_risk', aggregateAfter, aggregateCap, positionId: pos.id },
      riskProfile,
    });
    return {
      symbol,
      positionId: pos.id,
      requested: false,
      reason: `Aggregate open-risk cap (${aggregateAfter.toFixed(0)} vs ${aggregateCap.toFixed(0)})`,
    };
  }

  const intent: OrderIntent = {
    symbol,
    assetKind: 'stock',
    side,
    openClose: 'open',
    quantity: add.addQty,
    orderType: 'limit',
    limitPrice,
    referencePrice: last,
    // The added shares' OWN protective bracket: 1R below/above the new blended
    // entry, and the position's original target. The original bracket keeps
    // protecting the original shares untouched.
    bracket: { takeProfitPrice: targetPrice, stopLossPrice: add.newStopPrice },
  };

  const liveCfg = buildLiveTradingConfig(cfg);
  const acct = await stockAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { symbol, positionId: pos.id, requested: false, reason: acct.error ?? 'Could not load account state' };
  }
  const accountState: AccountState = withLoopRealizedToday({
    ...acct.state,
    ordersToday: countTodaysOrders(Date.now(), 'stock'),
  });
  const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
  const isShort = wouldOpenShort(intent, accountState);

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
      action: 'live_scale_in_blocked',
      detail: { reasons, positionId: pos.id },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: `Guardrails blocked: ${reasons}` };
  }

  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live scale-in)' });
  transitionIntent(intentRec.id, 'confirmed', { detail: 'autotrade scale-in — no per-order confirmation' });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting add-on (cid ${clientOrderId})` });

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId, isShort);
  const addOnRow = {
    intentId: intentRec.id,
    symbol,
    stopPrice: add.newStopPrice,
    targetPrice,
    riskAmount: orderRiskAmount(limitPrice, add.newStopPrice, add.addQty),
    riskProfile,
    addonOfPositionId: pos.id,
    accountId,
    legClientOrderIds: broker.legClientOrderIds ?? null,
  };
  if (!broker.ok && broker.ambiguous) {
    // Unknown outcome, so not terminal — see attemptLiveEntry's own branch.
    // checkLiveScaleIns skips a position with any unmaterialized order in
    // flight, so recording the row is also what stops the next tick adding to
    // this position a second time.
    recordLiveAddOnOrder(addOnRow);
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_order_outcome_unknown',
      detail: { reason: broker.error, clientOrderId, positionId: pos.id },
      riskProfile,
    });
    return {
      symbol,
      positionId: pos.id,
      requested: false,
      reason: `Placement outcome unknown (kept pending for reconcile): ${broker.error}`,
    };
  }
  if (!broker.ok) {
    transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_in_failed',
      detail: { reason: broker.error, positionId: pos.id },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: `Broker rejected: ${broker.error}` };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  recordLiveAddOnOrder(addOnRow);
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_scaled_in',
    detail: {
      positionId: pos.id,
      addQty: add.addQty,
      limitPrice,
      stop: add.newStopPrice,
      target: targetPrice,
      orderId: broker.orderId,
      rMultiple: add.rMultiple,
    },
    riskProfile,
  });
  await dispatchAutotradeNotification('live equity', [
    {
      title: symbol,
      message: `Autotrade LIVE SCALE-IN: +${add.addQty} ${symbol} @ ~$${limitPrice.toFixed(2)} (stop ${add.newStopPrice.toFixed(2)}, target ${targetPrice.toFixed(2)})`,
    },
  ]);
  return { symbol, positionId: pos.id, requested: true };
}

// ---------------------------------------------------------------------------
// Live stop ratchet (2026-08-26) — breakeven and trailing stops for LIVE
// equity. See services/autotrading/stopAdjust.ts for the decision and for why
// the three R settings driving it were inert on this path until now.
//
// The mechanism is a REPLACE on the bracket's resting STOP_LOSS leg, not a
// cancel-and-place: a replace is atomic at the broker, so the position is
// never momentarily unprotected. This is the same webullReplaceOrder the live
// scale-out already uses to resize those legs — only the field differs.
//
// IDENTIFYING THE STOP LEG is the part that has to be right, and it is why
// this refuses more often than it acts. A bracket rests as TWO exit-side
// orders: a STOP_PROFIT limit (the target) and a STOP_LOSS stop. They are told
// apart by `combo_type`, which a real-account capture confirmed is carried on
// the ENVELOPE (providers/webull/orders.ts's WebullOrderLeg comment documents
// that capture). Moving the wrong one would drag the TARGET down onto the
// price and sell the position at a loss the moment it filled — so anything
// short of exactly one positively-identified STOP_LOSS leg is refused and
// retried next tick, the same fail-closed posture restingExitOrders() takes.
//
// ORDER OF OPERATIONS: broker first, ledger second. The local stop_price is
// only written once the broker has confirmed the replace. Doing it the other
// way round would leave the ledger claiming protection at a price the broker
// has never heard of — and every downstream risk figure reads the ledger.
// ---------------------------------------------------------------------------

export interface LiveStopAdjustOutcome {
  symbol: string;
  positionId: number;
  adjusted: boolean;
  from?: number;
  to?: number;
  kind?: 'breakeven' | 'trail' | 'day_protective';
  rMultiple?: number | null;
  reason?: string;
}

/** The resting STOP_LOSS leg for a symbol, or a reason there isn't exactly one
 *  we can act on. Never guesses: a bracket whose legs cannot be told apart is
 *  left strictly alone. */
function restingStopLeg(
  orders: WebullOpenOrder[],
  symbol: string,
  exitSide: 'buy' | 'sell',
): { ok: true; leg: WebullOpenOrder } | { ok: false; reason: string } {
  const exits = restingExitOrders(orders, symbol, exitSide);
  if (exits.length === 0) return { ok: false, reason: 'no readable resting exit leg' };
  // combo_type FIRST, and it stays a filter of its own rather than folding into
  // exitLegKind below: it is the more discriminating field, and it is the only
  // one that can pick this bracket's stop out of a symbol that also carries a
  // standalone one (a re-armed protective stop, a hand-placed order). Reading
  // both markers equally there would see two stops and refuse a case that works
  // today.
  const stops = exits.filter((o) => (o.comboType ?? '').toUpperCase() === 'STOP_LOSS');
  if (stops.length === 1) return { ok: true, leg: stops[0] };
  if (stops.length === 0) {
    // combo_type identified nothing. Before concluding "we cannot tell", ask the
    // SHARED derivation — the same `exitLegKind` the scale-out's resize uses.
    //
    // This used to be an inline `order_type === 'STOP_LOSS'` test (2026-09-05),
    // and that spelling is NARROWER than the shared one, which also accepts
    // **STOP_LOSS_LIMIT**. That is an order type this app itself places:
    // `buildWebullOrder` builds it, and `webullReplaceBody` carries a dedicated
    // guard against a replace "converting a STOP_LOSS_LIMIT into a plain
    // STOP_LOSS". So a bracket whose stop rested as a stop-LIMIT was a stop to
    // the scale-out and to checkLiveBracketProtection, and invisible HERE — the
    // ratchet would refuse it every tick, all day, and the stop would never
    // reach breakeven or start trailing. Three readers of one fact, agreeing on
    // two of its three spellings.
    //
    // Not proven live: the 62 `live_stop_adjust_blocked` rows on the book (DELL,
    // 2026-09-02, one position, the whole session) predate the fallback
    // entirely, and nothing has been blocked since. Fixed because the next
    // spelling the broker uses should not need a fourth edit in a fourth place.
    //
    // Still a recovery path, not a relaxation — it runs only when combo_type
    // matched zero legs, so it cannot turn a working match into an ambiguous
    // one. And it cannot cause the accident this function exists to prevent:
    // the hazard is moving the TARGET, the target is a LIMIT, and exitLegKind
    // reads LIMIT as 'tp'. It is additionally STRICTER than the old test where
    // the two markers disagree — it believes neither, rather than moving a leg
    // it cannot describe consistently.
    //
    // checkLiveBracketProtection's `classifyExitLeg` deliberately does NOT share
    // this, and that is not an oversight to tidy up later. There the question is
    // "is SOMETHING protecting this position", and being wrong means stacking a
    // second stop on a live one, so its safe default is to read leniently and
    // stay quiet. Here being wrong means moving the wrong order, so the safe
    // default is to refuse. Same question, opposite direction of error.
    const byLegKind = exits.filter((o) => exitLegKind(o) === 'sl');
    if (byLegKind.length === 1) return { ok: true, leg: byLegKind[0] };
    // Either the bracket genuinely has no stop leg (checkLiveBracketProtection's
    // problem, not ours) or no marker parsed. Both mean the same thing here: we
    // cannot say which resting order is the stop, so we touch none. The SHAPES
    // go in the reason — 62 identical rows in one session said only "among 2
    // exit order(s)", so working out which of those two cases it was needed a
    // reading of the source rather than of the journal.
    return {
      ok: false,
      reason:
        `no resting leg identifiable as STOP_LOSS among ${exits.length} exit order(s) ` +
        `[${exits.map((o) => `${o.comboType ?? '?'}/${o.orderType ?? '?'}`).join(', ')}]`,
    };
  }
  return {
    ok: false,
    reason: `${stops.length} resting STOP_LOSS legs — ambiguous, not guessing which protects this lot`,
  };
}

/**
 * Ratchet the stop on every open live equity position whose breakeven or
 * trailing trigger has been reached.
 *
 * Opportunistic, like the scale-out: a transient quote or broker failure just
 * waits for the next tick, because nothing is left unprotected by doing
 * nothing — the original stop is still resting at the broker throughout.
 */
export async function checkLiveEquityStopAdjusts(): Promise<LiveStopAdjustOutcome[]> {
  if (!config.trading.placeEnabled) return [];
  const cfg = getAutotradeConfig();
  if (!cfg.liveTrailingEnabled && !cfg.dayProtectiveStopEnabled) return [];
  if (!cfg.liveAccountId) return [];
  // Regular session only. A stop replace outside it is not dangerous the way a
  // market close is, but the quote driving the decision is thin and stale
  // enough after hours to move a stop off a price nobody traded at.
  if (!checkSessionWindow(0).ok) return [];

  const open = listAutotradeLivePositions({ status: 'open' });
  if (open.length === 0) return [];
  const pendingExitPositionIds = new Set(
    listPendingLiveOrders()
      .filter((o) => o.role === 'exit' && o.positionId !== null)
      .map((o) => o.positionId!),
  );

  // One read for the sweep: the day does not move between positions, and
  // this is the same persisted baseline the entry path measures against.
  const dailyTarget = evaluateDailyTarget(cfg, getDailyBaseline(), strategyDayFor(etToday()).pnlUsd);
  // A kill switch holds every broker call below (2026-09-23). The ratchet
  // replaces the stop leg directly rather than through the guardrails, so the
  // switch never reached it: on 2026-09-21 it moved a LITE stop to 972.65 at
  // 10:27:40, twenty minutes into a halt the operator had engaged to manage
  // positions by hand. The journal shows no LITE stop resting from 10:07 to
  // 10:18, so the leg it moved was very likely one the operator had set.
  // "It only ever tightens" is true and beside the point; the switch means
  // hands off. The water mark below is still kept, because it is bookkeeping,
  // not an order, and the trail hangs off it once the switch is released.
  const halted = buildLiveTradingConfig(cfg).killSwitch;

  const accountId = cfg.liveAccountId;
  const outcomes: LiveStopAdjustOutcome[] = [];
  for (const pos of open) {
    // A close already working means the position is on its way out; moving its
    // stop now would only race that close.
    if (pendingExitPositionIds.has(pos.id)) continue;

    let last: number;
    try {
      last = (await getProvider().getQuote(pos.symbol.toUpperCase())).last;
    } catch {
      continue;
    }

    const decision = evaluateStopAdjust(pos, last, cfg, dailyTarget);
    // Maintain the water mark on EVERY cycle, including the ones that do not
    // move the stop — the trail hangs off this number, so a tick skipped here
    // is a peak the trail never learns about.
    if (decision.bestPrice !== null && decision.bestPrice !== pos.bestPriceSinceEntry) {
      updatePositionBestPrice(pos.id, decision.bestPrice);
    }
    if (!decision.adjust || decision.newStop === null) continue;

    const symbol = pos.symbol.toUpperCase();
    const exitSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';

    if (halted) {
      // Once per position per ET day: the decision repeats every tick of the
      // halt, and the switch's own journal row already dates the halt.
      if (claimOncePerDay('live_stop_adjust_held', String(pos.id))) {
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'live_stop_adjust_held',
          detail: {
            positionId: pos.id,
            kind: decision.kind,
            from: pos.stopPrice,
            wanted: decision.newStop,
            reason: 'a kill switch is engaged — the stop was not moved at the broker',
          },
          riskProfile: cfg.riskProfile,
        });
      }
      outcomes.push({
        symbol,
        positionId: pos.id,
        adjusted: false,
        kind: decision.kind ?? undefined,
        reason: 'kill switch engaged',
      });
      continue;
    }

    const listed = await listWebullOpenOrders(accountId);
    if (!listed.ok) {
      outcomes.push({
        symbol,
        positionId: pos.id,
        adjusted: false,
        reason: `Could not read open orders: ${listed.error ?? 'unreadable'}`,
      });
      continue;
    }
    const found = restingStopLeg(listed.orders, symbol, exitSide);
    if (!found.ok && sharesGoneAtBroker(accountId, pos).gone) {
      // THE SHARES ARE GONE, NOT THE STOP (2026-09-24, #147). A bracket leg that
      // filled leaves no resting stop, and the ledger keeps the position open
      // until the reconcile books the fill. This tick's sync has already missed
      // the shares, so a missing stop is the fill, not a defect: HOOD 09-18 and
      // MRNA 09-22 wrote `live_stop_adjust_blocked` on exactly this, and the
      // advisor counted each as an execution defect. Once per position a day,
      // on its own key so the "already tighter" skip below keeps its own row.
      if (claimOncePerDay('live_stop_adjust_skipped', `${pos.id}:shares_gone`)) {
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'live_stop_adjust_skipped',
          detail: {
            positionId: pos.id,
            kind: decision.kind,
            wanted: decision.newStop,
            reason: 'the broker no longer shows the shares: the stop leg has most likely filled',
          },
          riskProfile: cfg.riskProfile,
        });
      }
      outcomes.push({ symbol, positionId: pos.id, adjusted: false, reason: 'shares gone at the broker' });
      continue;
    }
    if (!found.ok) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_stop_adjust_blocked',
        // `kind` says WHICH rule wanted the move, and it matters most here
        // rather than on the success row: a blocked ratchet is a decision that
        // did not reach the broker, and without this a day-protective move
        // that never landed is indistinguishable from a trail that never
        // landed. The success row has carried `kind` since the ratchet
        // shipped; the failure row is where a reader actually needs it.
        detail: { positionId: pos.id, reason: found.reason, wanted: decision.newStop, kind: decision.kind },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, adjusted: false, reason: found.reason });
      continue;
    }

    // NEVER LOOSER THAN WHAT IS ACTUALLY RESTING (2026-09-23). The decision is
    // made against the LEDGER's stop, and the ledger does not see a stop moved
    // by hand at the broker. An operator who raised the stop past the app's
    // next step would have had it pulled back down to that step. A leg that
    // carries no readable stop price is judged on the ledger alone, as before.
    const restingStop = found.leg.stopPrice;
    if (typeof restingStop === 'number' && Number.isFinite(restingStop) && restingStop > 0) {
      const tighter = pos.side === 'short' ? decision.newStop < restingStop : decision.newStop > restingStop;
      if (!tighter) {
        const reason = `the stop resting at the broker (${restingStop}) is already at or past ${decision.newStop}`;
        if (claimOncePerDay('live_stop_adjust_skipped', String(pos.id))) {
          logAutotradeEvent({
            symbol,
            stage: 'execution',
            action: 'live_stop_adjust_skipped',
            detail: {
              positionId: pos.id,
              kind: decision.kind,
              recordedStop: pos.stopPrice,
              restingStop,
              wanted: decision.newStop,
              reason,
            },
            riskProfile: cfg.riskProfile,
          });
        }
        outcomes.push({ symbol, positionId: pos.id, adjusted: false, kind: decision.kind ?? undefined, reason });
        continue;
      }
    }

    const replaced = await webullReplaceOrder(accountId, found.leg.clientOrderId!, { stopPrice: decision.newStop });
    if (!replaced.ok) {
      // Including the ambiguous case: we do NOT know whether the broker applied
      // it, so we must not claim the new stop locally. The next tick re-reads
      // the resting leg and re-decides from whatever is actually there.
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_stop_adjust_failed',
        detail: {
          positionId: pos.id,
          reason: replaced.error ?? 'replace failed',
          ambiguous: !!replaced.ambiguous,
          from: pos.stopPrice,
          wanted: decision.newStop,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, adjusted: false, reason: replaced.error ?? 'replace failed' });
      continue;
    }

    // Broker confirmed — only now does the ledger get to say so.
    const from = pos.stopPrice;
    ratchetPositionStop(pos.id, decision.newStop);
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_stop_ratcheted',
      detail: {
        positionId: pos.id,
        kind: decision.kind,
        from,
        to: decision.newStop,
        rMultiple: decision.rMultiple,
        bestPrice: decision.bestPrice,
      },
      riskProfile: cfg.riskProfile,
    });
    outcomes.push({
      symbol,
      positionId: pos.id,
      adjusted: true,
      from: from ?? undefined,
      to: decision.newStop,
      kind: decision.kind ?? undefined,
      rMultiple: decision.rMultiple,
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// PER-LOT BRACKETS: place the SECOND lot (2026-09-09, task #26).
//
// attemptLiveEntry placed the first (larger) lot with its own bracket and
// journaled the plan. This adds the second lot as a bracketed ADD-ON, so its
// fill merges into the same position (materializeAddOnFill's blended entry) and
// everything downstream still sees ONE trade: one concurrency slot, one
// cooldown, one exit path.
//
// Each OTOCO is atomic — entry plus its own exits — so neither lot is ever
// unprotected, at any ordering. What the 2026-09-09 probe could NOT show is the
// steady state this creates: both groups' exits ACTIVE over one holding,
// summing to exactly what is held. That is what the first live entry under this
// flag settles, which is why the flag ships off and why every outcome here is
// journaled rather than only returned.
//
// IT PLACES AT MOST ONE ADD-ON PER POSITION, and the add-on row itself is the
// marker: countLiveAddOns(pos.id) > 0 means the second lot has been sent. That
// also means this path and the scale-in share a counter — a position cannot be
// both pyramided into and per-lot split, which is the correct exclusion rather
// than an accident (both would add shares against one plan's arithmetic).
// ---------------------------------------------------------------------------

export interface LivePerLotOutcome {
  symbol: string;
  positionId: number;
  requested: boolean;
  quantity?: number;
  reason?: string;
}

/** The second lot's plan, as journaled at entry. Null when this position never
 *  had one, or its event has aged out of the scan window. */
function perLotPlanFor(entryIntentId: number | null): {
  quantity: number;
  targetPrice: number;
  targetR: number;
} | null {
  if (entryIntentId === null) return null;
  for (const e of listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'], limit: 400 })) {
    try {
      const d = JSON.parse(e.detail ?? '{}') as {
        entryIntentId?: number;
        second?: { quantity?: number; targetPrice?: number; targetR?: number };
      };
      if (d.entryIntentId !== entryIntentId) continue;
      const q = d.second?.quantity;
      const t = d.second?.targetPrice;
      const r = d.second?.targetR;
      if (typeof q === 'number' && q >= 1 && typeof t === 'number' && t > 0 && typeof r === 'number') {
        return { quantity: q, targetPrice: t, targetR: r };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether the market-direction gate refused this position's second lot: its
 *  refusal row ends the lot (see the gate's block in checkLivePerLotSecondLots). */
function secondLotDroppedByDirection(positionId: number): boolean {
  return listAutotradeEvents({
    stage: 'execution',
    actions: ['per_lot_second_lot_direction_skipped'],
    limit: 400,
  }).some((e) => {
    try {
      return (JSON.parse(e.detail ?? '{}') as { positionId?: unknown }).positionId === positionId;
    } catch {
      return false;
    }
  });
}

export async function checkLivePerLotSecondLots(): Promise<LivePerLotOutcome[]> {
  if (!config.trading.placeEnabled) return []; // server master (TRADING_ENABLED)
  const cfg = getAutotradeConfig();
  if (!cfg.liveAccountId) return [];
  if (!cfg.livePerLotBracketsEnabled) return [];
  // Same reasoning as checkLiveScaleIns: this places a real marketable order
  // that ADDS shares, and the guardrail layer only WARNS on a closed market.
  const session = checkSessionWindow(cfg.sessionBufferMinutes);
  if (!session.ok) return [];

  const open = listAutotradeLivePositions({ status: 'open' }).filter((p) => p.assetType === 'stock');
  if (open.length === 0) return [];

  // Skip a symbol with any UNMATERIALIZED order in flight — a first lot still
  // working, or a second lot from a previous tick that has not merged yet.
  // Placing into that races the merge and can double the second lot.
  const inFlightSymbols = new Set(
    listPendingLiveOrders()
      .filter((o) => o.positionId === null)
      .map((o) => o.symbol),
  );

  const accountId = cfg.liveAccountId;
  const outcomes: LivePerLotOutcome[] = [];
  for (const pos of open) {
    try {
      if (inFlightSymbols.has(pos.symbol)) continue;
      if (countLiveAddOns(pos.id) > 0) continue; // already sent, or scaled in
      // Resolve the entry order FIRST, because it is also how the plan's key is
      // recovered. positions.source_intent_id is populated only intermittently
      // — 40 of 106 live positions on 2026-09-09, flipping back and forth since
      // July, because whichever path first observes the fill creates the row and
      // the broker-sync/adoption path does not carry the intent link (the same
      // seam as task #30). Keying the plan off it directly meant
      // perLotPlanFor(null) returned null and this loop `continue`d SILENTLY:
      // both of the first two real per-lot entries (HPE 34 of an intended 51,
      // DELL 1 of 2) got a first lot, no second lot, and no event saying why.
      // The fallback below already existed for the entry order on exactly this
      // reasoning; the plan lookup simply never used it.
      const entryOrder =
        pos.sourceIntentId !== null ? getLiveOrder(pos.sourceIntentId) : getLiveEntryOrderForPosition(pos.id);
      const entryIntentId = pos.sourceIntentId ?? entryOrder?.intentId ?? null;
      if (entryIntentId === null) {
        // Nothing left to look the plan up by. Say so once a day per position
        // rather than dropping it: this function's own header asks for a
        // position that never got its second lot to be distinguishable from one
        // that was never meant to have one, and a bare `continue` is exactly
        // what made them identical.
        if (claimOncePerDay('per_lot_intent_unresolved', String(pos.id))) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'per_lot_second_lot_blocked',
            detail: { positionId: pos.id, reason: 'no entry intent id — cannot look up the second lot plan' },
          });
        }
        continue;
      }
      const plan = perLotPlanFor(entryIntentId);
      if (!plan) continue;
      // Both lots share ONE stop — the position has a single risk level, and two
      // stops would be two ideas about where the trade is wrong. The FROZEN
      // entry stop, not the ratcheted one: the second lot is part of the
      // original plan, not a re-entry at a new level.
      const stopPrice = pos.initialStopPrice ?? entryOrder?.stopPrice ?? null;
      if (stopPrice === null || !(stopPrice > 0)) continue;

      // A short's second lot is more short (addOnShortRefusal): refused where a
      // fresh short would be, and asked first, like the entry path asks it
      // before its direction gate. Its own action, for the reason below.
      const shortRefused = addOnShortRefusal(cfg, pos.side, Date.now());
      if (shortRefused !== null) {
        const key = `${pos.id}|${shortRefused.cause}|${shortRefused.direction ?? 'none'}`;
        if (claimOncePerDay('per_lot_second_lot_short_skipped', key)) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'per_lot_second_lot_short_skipped',
            detail: {
              positionId: pos.id,
              side: pos.side,
              quantity: plan.quantity,
              cause: shortRefused.cause,
              direction: shortRefused.direction,
              reason: shortRefused.reason,
            },
            riskProfile: cfg.riskProfile,
          });
        }
        outcomes.push({
          symbol: pos.symbol,
          positionId: pos.id,
          requested: false,
          reason: `Short second lot refused: ${shortRefused.reason}`,
        });
        continue;
      }
      // The market's direction (addOnDirectionRefusal), after every check that
      // decides whether this position has a second lot to send. The first lot
      // passed the gate at entry; the tape can turn before the second goes.
      // Its OWN action rather than per_lot_second_lot_blocked, for the reason
      // given at the guardrail block below: two gates sharing one action cannot
      // be counted apart.
      //
      // A REFUSED SECOND LOT IS DROPPED, NOT DEFERRED (2026-09-24, review). The
      // lot is the entry's plan: its quantity and target were sized at entry,
      // against the frozen entry stop, and it was meant to follow the first lot
      // within a tick. Sent hours later when the tape turned back, it would buy
      // at that moment's price against the same stop, with none of the entry's
      // checks run again: long 34 @ 100, stop 98, a 17-share lot sent at 103.5
      // risks $93.50 where the sizer budgeted $34. So the refusal row is the
      // lot's end, and a position that has one never sends it.
      if (secondLotDroppedByDirection(pos.id)) continue;
      const refusedBy = addOnDirectionRefusal(cfg, pos.side, Date.now());
      if (refusedBy !== null) {
        const reason =
          `${refusedBy.reading.detail} — a ${pos.side} second lot leans against it; dropped, not deferred ` +
          '(a later send would go in at a different price against the entry stop)';
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'per_lot_second_lot_direction_skipped',
          detail: addOnDirectionDetail(refusedBy, {
            positionId: pos.id,
            side: pos.side,
            quantity: plan.quantity,
            dropped: true,
            reason,
          }),
          riskProfile: cfg.riskProfile,
        });
        outcomes.push({
          symbol: pos.symbol,
          positionId: pos.id,
          requested: false,
          reason: `Market direction: ${reason}`,
        });
        continue;
      }

      const symbol = pos.symbol.toUpperCase();
      let last: number;
      try {
        last = (await getProvider().getQuote(symbol)).last;
      } catch {
        continue; // transient — the next tick tries again
      }
      if (!Number.isFinite(last) || last <= 0) continue;

      const side: 'buy' | 'sell' = pos.side === 'long' ? 'buy' : 'sell';
      const buffer = 1 + (side === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
      const limitPrice = Math.round(last * buffer * 100) / 100;
      const intent: OrderIntent = {
        symbol,
        assetKind: 'stock',
        side,
        openClose: 'open',
        quantity: plan.quantity,
        orderType: 'limit',
        limitPrice,
        referencePrice: last,
        bracket: { takeProfitPrice: plan.targetPrice, stopLossPrice: stopPrice },
      };

      const liveCfg = buildLiveTradingConfig(cfg);
      const acct = await stockAccountState(accountId, symbol);
      if (!acct.ok || !acct.state) {
        outcomes.push({
          symbol,
          positionId: pos.id,
          requested: false,
          reason: acct.error ?? 'Could not load account state',
        });
        continue;
      }
      const accountState: AccountState = withLoopRealizedToday({
        ...acct.state,
        ordersToday: countTodaysOrders(Date.now(), 'stock'),
      });
      const guardrails = evaluateGuardrails(intent, accountState, liveCfg, { marketOpen: marketOpenContext(intent) });
      const isShort = wouldOpenShort(intent, accountState);

      const clientOrderId = newClientOrderId();
      const intentRec = createIntent(intent, clientOrderId);
      if (!guardrails.ok) {
        const reasons = blockingFailures(guardrails)
          .map((c) => `${c.rule}: ${c.detail}`)
          .join('; ');
        transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
        // Its OWN action, not live_entry_blocked: a refused second lot leaves a
        // real position at the first lot's size and target, which is a
        // different fact from an entry that never happened, and #53's lesson is
        // that two gates sharing one action cannot be counted apart.
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'per_lot_second_lot_blocked',
          detail: { reasons, positionId: pos.id, quantity: plan.quantity },
          riskProfile: cfg.riskProfile,
        });
        outcomes.push({ symbol, positionId: pos.id, requested: false, reason: `Guardrails blocked: ${reasons}` });
        continue;
      }

      transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (per-lot second bracket)' });
      transitionIntent(intentRec.id, 'confirmed', { detail: 'autotrade per-lot — no per-order confirmation' });
      transitionIntent(intentRec.id, 'submitted', { detail: `submitting second lot (cid ${clientOrderId})` });

      const broker = await webullPlaceOrder(accountId, intent, clientOrderId, isShort);
      const row = {
        intentId: intentRec.id,
        symbol,
        stopPrice,
        targetPrice: plan.targetPrice,
        riskAmount: orderRiskAmount(limitPrice, stopPrice, plan.quantity),
        riskProfile: cfg.riskProfile,
        addonOfPositionId: pos.id,
        accountId,
        legClientOrderIds: broker.legClientOrderIds ?? null,
      };

      if (!broker.ok && broker.ambiguous) {
        // Unknown outcome — record the row so the next tick's countLiveAddOns
        // stops a second attempt, exactly as the scale-in path does.
        recordLiveAddOnOrder(row);
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'live_order_outcome_unknown',
          detail: { reason: broker.error, clientOrderId, positionId: pos.id, perLotSecondLot: true },
          riskProfile: cfg.riskProfile,
        });
        outcomes.push({ symbol, positionId: pos.id, requested: false, reason: 'Broker outcome unknown' });
        continue;
      }
      if (!broker.ok) {
        transitionIntent(intentRec.id, 'rejected', { detail: `broker refused: ${broker.error}` });
        // No add-on row: the order does not exist, so the next tick may retry.
        // classifySecondBracketRefusal's premise changed with the 2026-09-09
        // probe (see perLotBrackets.ts) but its rule did not — a
        // reverse-position refusal means the broker counts shares differently
        // than this plan assumed, which retrying cannot fix.
        const verdict = classifySecondBracketRefusal(broker.error, 1);
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: 'per_lot_second_lot_failed',
          detail: { reason: broker.error, positionId: pos.id, quantity: plan.quantity, verdict },
          riskProfile: cfg.riskProfile,
        });
        outcomes.push({ symbol, positionId: pos.id, requested: false, reason: broker.error ?? 'Broker refused' });
        continue;
      }

      recordLiveAddOnOrder(row);
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'per_lot_second_lot_placed',
        detail: {
          positionId: pos.id,
          quantity: plan.quantity,
          targetPrice: plan.targetPrice,
          targetR: plan.targetR,
          stopPrice,
          limitPrice,
          orderId: broker.orderId,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: true, quantity: plan.quantity });
    } catch (err) {
      outcomes.push({ symbol: pos.symbol, positionId: pos.id, requested: false, reason: (err as Error).message });
    }
  }
  return outcomes;
}
