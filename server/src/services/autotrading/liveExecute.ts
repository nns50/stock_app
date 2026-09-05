import { config } from '../../config';
import { db } from '../../db';
import { AutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import {
  AccountState,
  evaluateGuardrails,
  OrderIntent,
  blockingFailures,
  TradingConfig,
  wouldOpenShort,
} from '../trading/guardrails';
import { marketOpenContext } from '../trading/marketHours';
import { webullAccountState } from '../../providers/webull/accountState';
import {
  newClientOrderId,
  webullPlaceOrder,
  webullOrderStatus,
  webullOrderStatusBatch,
  webullCancelOrder,
  listWebullOpenOrders,
  webullReplaceOrder,
  webullReplaceOrders,
  isExitLeg,
  buildBracketResizePatches,
  WebullOpenOrder,
} from '../../providers/webull/orders';
import { ackUnknownPlacement, canRetireUnknownPlacement, canStillFill, mapWebullStatus } from '../trading/reconcile';
import { computeFillDelta } from '../trading/fillDelta';
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
import { canTransition, isTerminal } from '../trading/orderLifecycle';
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
  LiveOrderMeta,
} from '../../db/autotradeLiveOrders';
import { computeScaleIn } from './scaleIn';
import { checkSessionWindow } from './executionGuards';
import { computeEquityCurveDerisk } from './equityCurveDerisk';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { computeMethodMultipliers, methodOfEquitySignal } from './methodSizing';
import { activeSymbolCooldowns, journalEntrySkipOncePerDay } from './symbolCooldown';
import { computeFinishLineFactor, finishLineScoreGate } from './finishLine';
import { evaluateStagnation } from './stagnationExit';
import { evaluateEndOfDayFlatten, evaluateEntryCutoff } from './endOfDayFlatten';
import { evaluateStopAdjust } from './stopAdjust';
import { evaluateScaleOut } from './scaleOut';
import { verifyLegsGone } from './cancelReplace';
import { attributeByEntryOrder, groupExitLegsByCombo, isSingleBracket, summarizeGroups } from './bracketGroups';
import {
  resizeAttemptSignature,
  shouldSkipResize,
  recordResizeRefusal,
  clearResizeLatch,
  pruneResizeLatches,
} from './resizeRetryLatch';
import { fetchTodaySessionContext } from './vwap';
import { evaluateEntryExtension, REFERENCE_MAX_PCT_OF_RANGE, REFERENCE_MAX_VWAP_EXT_PCT } from './entryExtension';
import { detectLevels } from '../../indicators/levels';
import { reentryCooldownFor } from './reentryCooldown';
import { atr } from '../../indicators/indicators';
import { planAroundLevels } from './levelPlan';
import { applyExternalCashFlow, evaluateDailyTarget } from './dailyTarget';
import { evaluateEquitySync, freshEquityGuardState, EquityGuardState } from './equitySyncGuard';
import { getDailyBaseline } from '../../db/dailyBaseline';
// DB-layer reads only (NOT the options execution service) -- so the combined
// live budget can fold in the options book without a liveExecute <-> options
// service import cycle.
import { pendingLiveOptionsOrdersRisk } from '../../db/autotradeLiveOptionsOrders';
import { listLiveOptionsPositions, listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import type { LiveOptionsRiskSeed } from './liveOptionsExecute';
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
import { realizedPnlOf, initialRiskOf, openRiskOf, computeStreaksAndDrawdown } from '../pnl';
import { etTimeOfDay } from '../../util/marketDate';
import { TradeSignal, convictionGrade } from './decide';
import {
  RiskCheckContext,
  RiskCheckResult,
  correlatedNotional,
  sectorNotional,
  buildSectorOf,
  evaluateRiskCheck,
} from './riskCheck';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { getProvider } from '../../providers';
import { dispatchNotifications } from '../notifier';

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
const MARKETABLE_LIMIT_BUFFER_PCT = 0.5;

/**
 * Let an intraday entry use the account's DAY-trading buying power.
 *
 * `buyingPowerUsd` is deliberately the overnight figure — what a position can
 * use without having to be closed by the bell. autotrade's live equity loop is
 * the one caller that always IS flat by the bell (endOfDayFlattenMinutes), so
 * it is the one caller entitled to the day figure. On 2026-08-27 the account
 * reported $9,800.80 of day buying power against $2,450.20 of equity, while
 * entries were being refused for "$1,005.46 available".
 *
 * `liveDayBuyingPowerUsd` is a CAP, not a value: 0 (the default) uses the
 * broker's figure in full, and a positive number refuses to use more than
 * that however much the broker offers. It was originally a hand-entered
 * substitute for a field I believed the payload lacked; the payload has it,
 * and a number typed in by hand only goes stale, so it earns its keep as a
 * ceiling instead.
 *
 * What is already deployed still consumes it, the same way the broker's own
 * figures net out open positions. Never LOWERS what the guardrail would have
 * used, so this cannot turn into a new way to block a fundable order.
 */
function withDayBuyingPower(state: AccountState, cfg: AutotradeConfig): AccountState {
  const broker = state.dayBuyingPowerUsd;
  if (broker === undefined || !(broker > 0)) return state;
  const ceiling = cfg.liveDayBuyingPowerUsd > 0 ? Math.min(broker, cfg.liveDayBuyingPowerUsd) : broker;
  const availableIntraday = Math.max(0, ceiling - state.exposureUsd);
  return { ...state, buyingPowerUsd: Math.max(state.buyingPowerUsd, availableIntraday) };
}

/** Combine the autotrade-specific live caps with BOTH kill switches — the
 *  human Trade page's own (since live orders share the same real broker
 *  account) and autotrade's own. Either being engaged, or either "enabled"
 *  toggle being off, blocks new live orders. This is a defense-in-depth
 *  default, not something explicitly requested — see the Phase 8 "additional
 *  safety layer" resolved decision in the spec. */
export function buildLiveTradingConfig(autotradeCfg: AutotradeConfig): TradingConfig {
  const humanCfg = getTradingConfig();
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
    // $2,283.61 cap and the second was refused by 39 cents. Still 0 when
    // equity is unset, which fails closed (any nonzero notional exceeds it)
    // rather than silently allowing anything through.
    maxExposureUsd: ((autotradeCfg.accountEquityUsd ?? 0) * autotradeCfg.liveMaxExposurePct) / 100,
    maxOrdersPerDay: autotradeCfg.liveMaxOrdersPerDay,
    maxDailyLossUsd: autotradeCfg.liveMaxDailyLossUsd,
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

  const tradesToday =
    openPositions.filter((p) => p.entryDate === today).length +
    closedAutotrade.filter((p) => p.entryDate === today).length;
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
  const orphans = listPositions({ status: 'open' }).filter(
    (p) =>
      !isAutotradePosition(p) && (p.tags.includes('webull') || (p.tags.includes('live') && p.sourceIntentId !== null)),
  );
  if (orphans.length === 0) return { adopted: 0 };
  const pendingEntries = listPendingLiveOrders().filter((o) => o.role === 'entry' && o.positionId === null);
  if (pendingEntries.length === 0) return { adopted: 0 };

  let adopted = 0;
  for (const p of orphans) {
    const match =
      p.sourceIntentId !== null
        ? // Exact order-to-order link — no cross-account ambiguity possible.
          pendingEntries.find((o) => o.intentId === p.sourceIntentId)
        : // Symbol-only match — could otherwise link a pending order for account A
          // to an orphan actually held in account B if both trade the same symbol
          // around an account switch. Require agreement when both sides know
          // their account; a null on either side (legacy data) still matches, same
          // permissive-for-linking-not-closing stance as positions.ts's own
          // includeUnassignedAccount.
          pendingEntries.find(
            (o) => o.symbol === p.symbol && (o.accountId == null || p.accountId == null || o.accountId === p.accountId),
          );
    if (!match) continue;
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
  /** Max rows to return (default 200, capped at 1000) — same convention as
   *  listPaperPositions/listOptionsPaperPositions. */
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
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return all.slice(0, limit);
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
}

/**
 * Attempt to place a real, broker-side bracket order for an approved
 * (already risk-checked) signal. Sizing is the risk-checked quantity further
 * cut by the probation multiplier (if still active) — rounding DOWN, and
 * skipping the trade entirely (not placing a 0-quantity order) if that
 * rounds to zero. Guardrails run against FRESH account state, exactly like
 * placeOrder() does for the human path — never trusting stale data.
 */
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

  const probation = getProbationStatus(autotradeCfg);
  const quantity = Math.floor(riskResult.sizing.suggestedQuantity * probation.multiplier);
  if (quantity <= 0) {
    return {
      symbol,
      ok: false,
      reason: `Probation-adjusted quantity rounded to 0 (multiplier ${probation.multiplier})`,
    };
  }

  let last: number;
  try {
    last = (await getProvider().getQuote(signal.symbol)).last;
  } catch (err) {
    return { symbol, ok: false, reason: `Quote fetch failed: ${(err as Error).message}` };
  }
  if (!Number.isFinite(last) || last <= 0) return { symbol, ok: false, reason: `Invalid quote price: ${last}` };

  const buffer = 1 + (signal.side === 'buy' ? 1 : -1) * (MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const limitPrice = Math.round(last * buffer * 100) / 100;

  const intent: OrderIntent = {
    symbol,
    assetKind: 'stock',
    side: signal.side,
    openClose: 'open',
    quantity,
    orderType: 'limit',
    limitPrice,
    referencePrice: last,
    bracket: { takeProfitPrice: signal.target, stopLossPrice: signal.stop },
  };

  const liveCfg = buildLiveTradingConfig(autotradeCfg);
  const acct = await webullAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { symbol, ok: false, reason: acct.error ?? 'Could not load account state' };
  }
  const accountState: AccountState = withDayBuyingPower(
    { ...acct.state, ordersToday: countTodaysOrders() },
    autotradeCfg,
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
  const extension = evaluateEntryExtension({
    side: isShort ? 'short' : 'long',
    price: signal.entry,
    vwap: sessionCtx.vwap,
    range: sessionCtx.range,
  });
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'entry_extension_shadow',
    detail: {
      side: isShort ? 'short' : 'long',
      entry: signal.entry,
      vwap: sessionCtx.vwap,
      sessionHigh: sessionCtx.range?.high ?? null,
      sessionLow: sessionCtx.range?.low ?? null,
      vwapExtPct: extension.vwapExtPct,
      pctOfRange: extension.pctOfRange,
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
    riskAmount: riskResult.approvedRiskAmount,
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
    entryVwap,
    // The combo group id this client minted for the bracket. Stored on BOTH
    // paths below — including the ambiguous one, where the order may well have
    // reached the broker and a later modify would still need to name its group.
    clientComboOrderId: broker.clientComboOrderId ?? null,
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
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_entry_failed',
      detail: { reason: broker.error },
      riskProfile,
    });
    return { symbol, ok: false, reason: `Broker rejected: ${broker.error}`, intentId: intentRec.id };
  }

  transitionIntent(intentRec.id, 'acknowledged', {
    brokerOrderId: broker.orderId,
    detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
  });
  recordLiveOrder(orderRow);
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_order_placed',
    detail: {
      side: signal.side,
      quantity,
      limitPrice,
      stop: signal.stop,
      target: signal.target,
      orderId: broker.orderId,
      entryVwap,
    },
    riskProfile,
  });
  // Best-effort — a real order was already placed and journaled above
  // regardless of whether anyone's actually configured a webhook to hear
  // about it (dispatchNotifications() itself is a no-op with zero channels
  // configured, and never throws). Reuses the SAME Slack/Discord/webhook
  // infra the price-alert system already dispatches through, rather than a
  // second notification path — this is the one live autotrade event a human
  // most wants to know about without having the app open.
  await dispatchNotifications([
    {
      title: symbol,
      message: `Autotrade LIVE ${signal.side === 'buy' ? 'BUY' : 'SELL'}: ${quantity} ${symbol} @ ~$${limitPrice.toFixed(2)} (stop ${signal.stop.toFixed(2)}, target ${signal.target.toFixed(2)})`,
    },
  ]);
  return { symbol, ok: true, intentId: intentRec.id };
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
): Promise<LiveExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const equity = cfg.accountEquityUsd ?? 0;

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
          if (acct.ok && acct.state) {
            availableBuyingPowerUsd = withDayBuyingPower(acct.state, cfg).buyingPowerUsd;
          }
        } catch {
          /* leave undefined — unconstrained, exactly as before */
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
  const skipSymbols = new Set([
    ...listPositions({ status: 'open' }).map((p) => p.symbol),
    ...listPendingLiveOrders().map((o) => o.symbol),
  ]);
  const sectorOf = buildSectorOf();

  // Finish-line discipline + symbol cooldown (2026-08-22) — LIVE-only, both
  // computed once per batch. The daily-target status is re-evaluated from the
  // persisted baseline (not threaded from loop.ts) so a direct caller gets
  // the same protection the loop does.
  const dailyTarget = evaluateDailyTarget(cfg, getDailyBaseline());
  const cooldowns = activeSymbolCooldowns(cfg);
  // Autotrade's OWN closed positions only — a human's manual trade in the same
  // name is not the loop's thesis and must not gate it.
  const closedAutotradeForReentry =
    cfg.symbolReentryCooldownMinutes > 0 ? listPositions({ status: 'closed' }).filter(isAutotradePosition) : [];
  const finishLine = computeFinishLineFactor({
    enabled: cfg.finishLineSizingEnabled,
    dailyTarget,
    equity,
    riskPerTradePct: cfg.riskPerTradePct,
    rewardMultiple: cfg.targetRMultiple,
  });

  const outcomes: LiveExecutionOutcome[] = [];
  for (const { signal: candidateSignal } of candidates) {
    const symbol = candidateSignal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open live position' });
      continue;
    }
    // A short entry cannot be placed while naked shorts are off — guardrails'
    // naked_short rule refuses it at the very end, after a correlation lookup,
    // a sector lookup, a risk check and a broker round-trip have all been
    // spent on it. On 2026-08-27 that was 31 of 48 live refusals: a third of
    // the day's live attempts went to orders that were never placeable.
    // Skipping here changes no outcome, only the work and the journal noise —
    // and it re-opens itself the moment liveAllowNakedShort is turned on.
    if (candidateSignal.side === 'sell' && !cfg.liveAllowNakedShort) {
      outcomes.push({
        symbol,
        ok: false,
        reason: 'short entry skipped — liveAllowNakedShort is off',
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
    const atrForReach = candidateSignal.atr;
    if (cfg.maxRiskAtrFraction > 0 && atrForReach && atrForReach > 0) {
      const stopDistance = Math.abs(candidateSignal.entry - candidateSignal.stop);
      if (stopDistance > atrForReach * cfg.maxRiskAtrFraction) {
        const reason =
          `1R costs ${(stopDistance / atrForReach).toFixed(2)}x this name's daily range ` +
          `(max ${cfg.maxRiskAtrFraction}) — not reachable in a session`;
        journalEntrySkipOncePerDay(symbol, 'risk_atr_unreachable_skipped', {
          stopDistance: Math.round(stopDistance * 100) / 100,
          atr: Math.round(atrForReach * 100) / 100,
          ratio: Math.round((stopDistance / atrForReach) * 100) / 100,
          maxRiskAtrFraction: cfg.maxRiskAtrFraction,
          reason,
        });
        outcomes.push({ symbol, ok: false, reason });
        continue;
      }
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
        detail: { ...reentry, reason },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    const cooldown = cooldowns.get(symbol);
    if (cooldown) {
      const reason = `Symbol cooling down after ${cooldown.losses} losses since ${cooldown.lastLossDate} — resumes ${cooldown.until}`;
      journalEntrySkipOncePerDay(symbol, 'symbol_cooldown_skipped', { ...cooldown, reason });
      outcomes.push({ symbol, ok: false, reason });
      continue;
    }
    const scoreGate = finishLineScoreGate(candidateSignal.score, dailyTarget, cfg);
    if (scoreGate.skip) {
      journalEntrySkipOncePerDay(symbol, 'finish_line_skipped', {
        score: candidateSignal.score,
        reason: scoreGate.detail,
      });
      outcomes.push({ symbol, ok: false, reason: `Armed-day selectivity: ${scoreGate.detail}` });
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
      sectorNotional: sectorAmount,
      maxSectorExposurePct: cfg.maxSectorExposurePct,
      candidateSector,
      marketAtrPct,
      regimeAtrThresholdPct: cfg.regimeAtrThresholdPct,
      regimeSizeCutPct: cfg.regimeSizeCutPct,
      equityCurveDeriskActive: snapshot.equityCurveDeriskActive,
      equityCurveDeriskCutPct: cfg.equityCurveDeriskCutPct,
      maxAdvParticipationPct: cfg.maxAdvParticipationPct,
      buyingPowerUsd: await buyingPowerForSide(signal.side),
      expectancyMultiplier:
        snapshot.gradeExpectancyMultipliers[
          convictionGrade(signal.score, {
            aMinScore: cfg.convictionGradeAMinScore,
            bMinScore: cfg.convictionGradeBMinScore,
          })
        ] ?? 1,
      methodMultiplier: snapshot.methodMultipliers[methodOfEquitySignal(signal.side)] ?? 1,
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
      outcome = await attemptLiveEntry(signal, result, freshCfg.riskProfile, freshCfg, marketRegime, marketAtrPct);
    } catch (err) {
      const reason = `Unexpected error placing order: ${(err as Error).message}`;
      logAutotradeEvent({ symbol, stage: 'execution', action: 'live_entry_failed', detail: { reason } });
      outcome = { symbol, ok: false, reason };
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      const notional = signal.entry * result.sizing.suggestedQuantity;
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
        const observedPrice = broker.filledPrice ?? intent.limitPrice ?? 0;
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
      const fallbackPrice = exitLeg.comboType === 'STOP_LOSS' ? stopPrice : targetPrice;
      try {
        const recorded = materializeExitFill(
          intent,
          meta.positionId,
          exitLeg.filledPrice ?? fallbackPrice,
          riskProfile,
          exitLeg.filledQty,
          // Which bracket leg filled IS the exit reason — the one place in the
          // live path that knows it firsthand rather than inferring from price.
          exitLeg.comboType === 'STOP_LOSS' ? 'stop' : 'target',
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
  const orphanCandidates = listPositions({ status: 'open', symbol: intent.symbol }).filter(
    (p) => p.sourceIntentId === null,
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
        entryComponents: meta?.entryComponents ?? null,
        marketRegime: adopted.marketRegime ?? meta?.marketRegime ?? null,
        marketAtrPct: adopted.marketAtrPct ?? meta?.marketAtrPct ?? null,
        entryVwap: adopted.entryVwap ?? meta?.entryVwap ?? null,
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
    side: intent.side === 'buy' ? 'long' : 'short',
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
    entryVwap: orderMeta?.entryVwap ?? null,
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
    exitDate: etDateStr(),
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
  return orders.filter(
    (o) => o.symbol?.toUpperCase() === symbol && o.side === exitSide && isRestingStatus(o.status) && !!o.clientOrderId,
  );
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
  const live = orders.filter((o) => isRestingStatus(o.status));
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
}

/**
 * Check every open autotrade EQUITY position that was opened with a bracket for
 * a resting exit-side order at the broker, and journal the ones that have none.
 *
 * Read-only: one open-orders pull per tick regardless of position count, and it
 * places, cancels and modifies nothing. Runs regardless of the kill switch for
 * the same reason the reconcilers do — a halted account still needs to know a
 * real position is sitting there unprotected.
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

  const open = await listWebullOpenOrders(accountId);
  if (!open.ok) return []; // couldn't ask — say nothing, retry next tick
  const outcomes: BracketProtectionOutcome[] = [];

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

    if (restingLegs.length > 0) {
      outcomes.push({ positionId: pos.id, symbol, protectedAtBroker: true });
      continue;
    }
    outcomes.push({ positionId: pos.id, symbol, protectedAtBroker: false });
    // Once per position per ET day: this condition persists until a human acts,
    // so journaling every tick would bury it, and journaling once ever would let
    // it go quiet while the position is still naked.
    if (!alreadyReportedUnprotectedToday(pos.id)) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_position_unprotected',
        detail: {
          positionId: pos.id,
          quantity: pos.remainingQuantity,
          recordedStop: pos.stopPrice,
          reason:
            'This position was opened with a bracket, but the broker shows no resting ' +
            `${exitSide} order on ${symbol} — its stop may never have been accepted, or was cancelled. ` +
            'Check the broker and re-arm protection by hand.',
        },
        riskProfile: getLiveEntryOrderForPosition(pos.id)?.riskProfile ?? cfg.riskProfile,
      });
    }
  }
  return outcomes;
}

/**
 * The ENTRY intent behind a live position, by EITHER link.
 *
 * `positions.source_intent_id` is set only when a fill materializes through
 * materializeEntryFill's create path. A position ADOPTED from the broker sync
 * never gets one — adoption deliberately does not patch it, because a null
 * source_intent_id is itself the "orphan, needs linking" signal that path
 * matches on. What adoption DOES establish is the reverse link:
 * setLiveOrderPositionId writes position_id onto the entry order row.
 *
 * Reading only source_intent_id therefore makes every adopted position
 * invisible, and this is the SECOND time that has cost something. The first was
 * an adopted CTVA position that failed its stagnation close 21 ticks running
 * (see getLiveEntryOrderForPosition's own doc comment). The second was
 * checkLiveBracketProtection: from 2026-09-01, when the book flipped to almost
 * entirely adopted positions, it found ZERO candidates and returned before ever
 * querying the broker — so the naked-position alarm went quiet for ten days
 * while reading exactly like "nothing is wrong".
 *
 * Prefer source_intent_id when present (it is the precise link), fall back to
 * the entry order's own intentId, and return null only when neither exists.
 */
export function entryIntentIdForPosition(pos: { id: number; sourceIntentId: number | null }): number | null {
  if (pos.sourceIntentId !== null) return pos.sourceIntentId;
  return getLiveEntryOrderForPosition(pos.id)?.intentId ?? null;
}

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

function alreadyReportedUnprotectedToday(positionId: number): boolean {
  const today = etDateStr();
  return listAutotradeEvents({ stage: 'execution', actions: ['live_position_unprotected'], limit: 200 }).some((e) => {
    if (etDateStr(e.createdAt) !== today) return false;
    try {
      return (JSON.parse(e.detail ?? '{}') as { positionId?: unknown }).positionId === positionId;
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
 *  reflects share holdings). */
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
  kind: 'max_hold_days' | 'stagnation' | 'end_of_day';
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
  const acct = await webullAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return timeExitFailure(pos, riskProfile, acct.error ?? 'Could not load account state');
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };
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
  await dispatchNotifications([
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
  pos: { id: number; symbol: string; remainingQuantity: number },
  resting: WebullOpenOrder[],
  keepQty: number,
  cfg: AutotradeConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const symbol = pos.symbol.toUpperCase();
  const ids = resting.map((l) => l.clientOrderId).filter((v): v is string => !!v);
  if (ids.length !== resting.length) {
    return { ok: false, reason: 'a resting leg has no client order id to cancel by' };
  }

  const cancelled: string[] = [];
  for (const id of ids) {
    const c = await webullCancelOrder(accountId, id);
    if (!c.ok) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_scale_out_blocked',
        detail: {
          positionId: pos.id,
          reason: `cancel-replace: cancelling leg ${id} failed: ${c.error ?? 'unknown'}`,
          cancelledSoFar: cancelled,
          note: 'The bracket may now be PARTLY cancelled — check the broker.',
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

  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'live_position_unprotected',
    detail: {
      positionId: pos.id,
      quantity: pos.remainingQuantity,
      keepQty,
      reason:
        'Bracket CANCELLED for a cancel-replace scale-out. The position is unprotected until the remainder ' +
        'is re-bracketed — if this is the last such event for this position, re-arm by hand.',
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
  // Never into pre/after-hours liquidity: this is opportunistic profit-taking,
  // not a protective exit, so it has no business paying a wide spread.
  if (!checkSessionWindow(0).ok) return [];

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
    const comboId = getLiveEntryOrderForPosition(pos.id)?.clientComboOrderId ?? undefined;

    // A refusal here is deterministic in the request, so retrying an IDENTICAL
    // one every tick adds a broker round-trip and a journal row and no
    // information. Skip only an exact repeat — any change to the patches or the
    // group id is attempted, so a payload experiment is never suppressed.
    const signature = resizeAttemptSignature(patches, comboId);
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

    const replaced = await webullReplaceOrders(accountId, patches, comboId);
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
    if (reduceFailed && cfg.liveScaleOutCancelReplaceEnabled) {
      const outcome = await cancelReplaceBracket(accountId, pos, resting, keepQty, cfg);
      if (outcome.ok) {
        reduceFailed = null;
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
          // Which group id accompanied the request, so a repeat refusal says
          // whether it was sent at all rather than leaving that to be inferred.
          clientComboOrderId: comboId ?? null,
        },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: reduceFailed });
      continue;
    }

    // The resize was ACCEPTED, so the latch has nothing left to suppress. Clear
    // it rather than leaving a stale signature that could skip a later partial
    // on this same position.
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
    const acct = await webullAccountState(accountId, symbol);
    if (!acct.ok || !acct.state) {
      outcomes.push({ symbol, positionId: pos.id, requested: false, reason: acct.error ?? 'no account state' });
      continue;
    }
    const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };
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
      const decision = evaluateStagnation(pos, last, cfg, Date.now());
      if (!decision.triggered) continue;
      trigger = {
        kind: 'stagnation',
        journal: { heldMinutes: decision.heldMinutes, progressR: decision.progress, reason: decision.detail },
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

export interface LiveScaleInOutcome {
  symbol: string;
  positionId: number;
  /** True when a real add-on order was actually placed at the broker. */
  requested: boolean;
  reason?: string;
}

export async function checkLiveScaleIns(): Promise<LiveScaleInOutcome[]> {
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

      outcomes.push(await placeLiveScaleInAddOn(pos, add, last, targetPrice, cfg));
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
  const addRisk = Math.abs(limitPrice - add.newStopPrice) * add.addQty;
  const dailyPnl = getLivePortfolioSnapshot().dailyPnl;
  const dailyHaltLevel = -(cfg.maxDailyDrawdownPct / 100) * equity;
  if (!(dailyPnl > dailyHaltLevel)) {
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: 'live_scale_in_blocked',
      detail: { reason: 'daily_drawdown_halt', dailyPnl, dailyHaltLevel, positionId: pos.id },
      riskProfile,
    });
    return { symbol, positionId: pos.id, requested: false, reason: `Daily drawdown halt (today ${dailyPnl})` };
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
  const acct = await webullAccountState(accountId, symbol);
  if (!acct.ok || !acct.state) {
    return { symbol, positionId: pos.id, requested: false, reason: acct.error ?? 'Could not load account state' };
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };
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
    riskAmount: Math.abs(limitPrice - add.newStopPrice) * add.addQty,
    riskProfile,
    addonOfPositionId: pos.id,
    accountId,
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
  await dispatchNotifications([
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
  const stops = exits.filter((o) => (o.comboType ?? '').toUpperCase() === 'STOP_LOSS');
  if (stops.length === 1) return { ok: true, leg: stops[0] };
  if (stops.length === 0) {
    // Either the bracket genuinely has no stop leg (checkLiveBracketProtection's
    // problem, not ours) or combo_type did not parse. Both mean the same thing
    // here: we cannot say which resting order is the stop, so we touch none.
    return { ok: false, reason: `no resting leg identifiable as STOP_LOSS among ${exits.length} exit order(s)` };
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
  const dailyTarget = evaluateDailyTarget(cfg, getDailyBaseline());

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
    if (!found.ok) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'live_stop_adjust_blocked',
        detail: { positionId: pos.id, reason: found.reason, wanted: decision.newStop },
        riskProfile: cfg.riskProfile,
      });
      outcomes.push({ symbol, positionId: pos.id, adjusted: false, reason: found.reason });
      continue;
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
