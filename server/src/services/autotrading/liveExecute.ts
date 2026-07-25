import { config } from '../../config';
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
  webullCancelOrder,
  listWebullOpenOrders,
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
  LiveOrderMeta,
} from '../../db/autotradeLiveOrders';
import { computeScaleIn } from './scaleIn';
import { checkSessionWindow } from './executionGuards';
import { computeEquityCurveDerisk } from './equityCurveDerisk';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
// DB-layer reads only (NOT the options execution service) -- so the combined
// live budget can fold in the options book without a liveExecute <-> options
// service import cycle.
import { pendingLiveOptionsOrdersRisk } from '../../db/autotradeLiveOptionsOrders';
import { listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import type { LiveOptionsRiskSeed } from './liveOptionsExecute';
import { createPosition, getPosition, listPositions, updatePosition, addExit, Position } from '../../db/positions';
import { realizedPnlOf, initialRiskOf, computeStreaksAndDrawdown } from '../pnl';
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
    // 100% of configured equity — a cash account (confirmed in
    // LIVE_TRADING_DESIGN.md §13) can't have MORE gross exposure than its own
    // equity without margin. 0 when equity is unset, which fails closed
    // (any nonzero notional exceeds it) rather than silently allowing
    // anything through.
    maxExposureUsd: autotradeCfg.accountEquityUsd ?? 0,
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
  const openRisk = openPositions.reduce((s, p) => s + (initialRiskOf(p) ?? 0), 0);

  // Equity-curve de-risk from the live book's OWN full realized history — the
  // cumulative curve, dated by each trade's last exit, the MA filter needs.
  const config = getAutotradeConfig();
  const closedHistory = closedAutotrade.map((p) => ({
    date: p.exits.length
      ? p.exits
          .map((e) => e.exitDate)
          .sort()
          .slice(-1)[0]
      : p.entryDate,
    pnl: realizedPnlOf(p),
  }));
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
  const next = setAutotradeConfig({ accountEquityUsd: acct.netLiquidationUsd });
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
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };
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
  const combined = combinedLiveOpenRisk();
  let runningRisk = combined.risk;
  let runningCount = combined.count;
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

  const outcomes: LiveExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open live position' });
      continue;
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
      expectancyMultiplier:
        snapshot.gradeExpectancyMultipliers[
          convictionGrade(signal.score, {
            aMinScore: cfg.convictionGradeAMinScore,
            bMinScore: cfg.convictionGradeBMinScore,
          })
        ] ?? 1,
    };
    const result = evaluateRiskCheck(signal, ctx);
    if (!result.ok) {
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
      outcome = await attemptLiveEntry(signal, result, freshCfg.riskProfile, freshCfg);
    } catch (err) {
      const reason = `Unexpected error placing order: ${(err as Error).message}`;
      logAutotradeEvent({ symbol, stage: 'execution', action: 'live_entry_failed', detail: { reason } });
      outcome = { symbol, ok: false, reason };
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({
        symbol,
        notional: signal.entry * result.sizing.suggestedQuantity,
        side: signal.side === 'buy' ? 'long' : 'short',
      });
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
  const outcomes: LiveReconcileOutcome[] = [];
  for (const meta of pending) {
    const intent = intentsById.get(meta.intentId);
    if (!intent) continue;
    const broker = await webullOrderStatus(accountId, intent.idempotencyKey);
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
  if (canMove || restingPartial || unrecognizedFill) {
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
      // 'filled' with no positions row and, since listPendingLiveOrders()
      // only keeps polling a 'filled' intent while its linked position is
      // open, NOTHING would ever retry this. An adversarial review flagged
      // this as a real, permanent-data-loss gap (no try/catch existed at
      // all). This can't be prevented outright (the write already
      // happened), but it must not crash the rest of this reconcile cycle's
      // other pending orders, and it must be LOUD — there's no human
      // watching this path in real time the way the Trade page assumes, so
      // silently swallowing it (as the human path's own equivalent,
      // reconcile.ts's recordFillAsPosition, deliberately does) would leave
      // a real fill permanently invisible with no trace anywhere.
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

        if (meta.role === 'exit') {
          // A time-exit closing order — meta.positionId is known upfront
          // (recordLiveExitOrder), unlike an entry's positionId which is
          // null until THIS materialization sets it.
          const recorded = materializeTimeExitFill(meta.positionId!, intent, price, riskProfile, qty);
          if (recorded) advanceMaterialized(intent.id, qty, qty * price);
          return recorded ? { changed: true, action: 'exit_filled' } : { changed: acked || canMove };
        }
        if (meta.addonOfPositionId !== null) {
          // A scale-in ADD-ON fill — MERGE into the already-open position
          // (blended entry, bigger quantity) rather than creating a second
          // position row. Its own protective bracket (raised stop + the
          // position's target) rests separately, watched via the bracket-leg
          // block below on later ticks once position_id is linked here.
          materializeAddOnFill(meta.addonOfPositionId, intent, qty, price, riskProfile);
          advanceMaterialized(intent.id, qty, qty * price);
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
          materializeAddOnFill(linkedId, intent, qty, price, riskProfile);
          advanceMaterialized(intent.id, qty, qty * price);
          return { changed: true, action: 'entry_filled' };
        }

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
        // An ADOPTED position was imported from the broker whole, so it already
        // reflects every instalment of this order — including ones we never
        // observed. Mark the intent fully booked so a later partial can't blend
        // quantity into it a second time.
        if (outcome === 'linked_adopted') {
          const remaining = intent.quantity - intent.materializedQty;
          if (remaining > 0) advanceMaterialized(intent.id, remaining, remaining * price);
        } else {
          advanceMaterialized(intent.id, qty, qty * price);
        }
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
    const filledExitLegs = broker.legs.filter((l) => l.comboType && l.comboType !== 'MASTER' && l.status === 'FILLED');
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
  const adopted = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => isAutotradePosition(p) && p.sourceIntentId === null,
  );
  if (adopted) {
    setLiveOrderPositionId(intent.id, adopted.id);
    logAutotradeEvent({
      symbol: intent.symbol,
      stage: 'execution',
      action: 'live_position_linked_to_adopted',
      detail: { positionId: adopted.id, quantity: filledQty, entryPrice: filledPrice },
      riskProfile,
    });
    return 'linked_adopted';
  }

  const position = createPosition({
    assetType: 'stock',
    symbol: intent.symbol,
    side: intent.side === 'buy' ? 'long' : 'short',
    quantity: filledQty,
    entryPrice: filledPrice,
    entryDate: etDateStr(),
    stopPrice,
    targetPrice,
    notes: `Auto-placed by autotrade — order #${intent.id}${intent.brokerOrderId ? ` (broker ${intent.brokerOrderId})` : ''}`,
    tags: AUTOTRADE_TAGS,
    grade: getLiveOrder(intent.id)?.grade ?? null,
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
  });
  if (!closed) return false;
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_position_closed',
    detail: { exitPrice, pnl: realizedPnlOf(closed) },
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
  const closed = addExit(position.id, {
    quantity: closeQty,
    exitPrice,
    exitDate: etDateStr(),
    sourceIntentId: intent.id,
  });
  if (!closed) return false;
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_time_exit_closed',
    detail: { exitPrice, pnl: realizedPnlOf(closed), positionId },
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
    const filledLeg =
      combo.found && (combo.legs ?? []).some((l) => l.comboType && l.comboType !== 'MASTER' && l.status === 'FILLED');
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

  const candidates = listAutotradeLivePositions({ status: 'open' }).filter(
    (p) =>
      p.assetType === 'stock' &&
      p.sourceIntentId !== null &&
      now - p.createdAt >= BRACKET_PROTECTION_GRACE_MS &&
      (getIntent(p.sourceIntentId)?.isBracket ?? false),
  );
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
    if (restingExitOrders(open.orders, symbol, exitSide).length > 0) {
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
        riskProfile: getLiveOrder(pos.sourceIntentId!)?.riskProfile ?? cfg.riskProfile,
      });
    }
  }
  return outcomes;
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

async function placeLiveEquityTimeExitClose(
  pos: Position,
  accountId: string,
  riskProfile: string,
  entryIntent: OrderIntentRecord,
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
    detail: { quantity: intent.quantity, limitPrice, orderId: broker.orderId, positionId: pos.id },
    riskProfile,
  });
  await dispatchNotifications([
    {
      title: symbol,
      message: `Autotrade LIVE closing ${symbol} (max hold time reached): ${intent.quantity} @ ~$${limitPrice.toFixed(2)}`,
    },
  ]);
  return { symbol, positionId: pos.id, requested: true, intentId: intentRec.id };
}

/**
 * Check every open live equity position against maxHoldDays (0 = disabled)
 * and force-close whichever has overstayed: cancel its resting bracket exit
 * legs, verify they're actually clear, then place a fresh closing order. See
 * the module-level comment above for why this is fundamentally riskier than
 * every other exit path in this file, and what specifically is unconfirmed.
 *
 * A position with an exit order ALREADY in flight (pending, per
 * listPendingLiveOrders()'s role='exit' rows) is skipped — maxHoldDays
 * doesn't un-trigger within the same day, so without this guard every tick
 * would attempt ANOTHER cancel+close for the same still-closing position
 * (mirrors checkLiveOptionsExits' identical guard).
 */
export async function checkLiveEquityTimeExits(): Promise<LiveEquityTimeExitOutcome[]> {
  // The deploy-level master gate, checked FIRST — mirrors checkLiveOptionsExits'
  // own reasoning: this places a brand-new real order (and cancels a resting
  // one), so it needs the same check attemptLiveEntry's own entry path gets.
  if (!config.trading.placeEnabled) return [];
  const cfg = getAutotradeConfig();
  if (!cfg.liveAccountId) return [];
  if (cfg.maxHoldDays <= 0) return [];

  const open = listAutotradeLivePositions({ status: 'open' });
  if (open.length === 0) return [];

  const pendingExitPositionIds = new Set(
    listPendingLiveOrders()
      .filter((o) => o.role === 'exit' && o.positionId !== null)
      .map((o) => o.positionId!),
  );

  const outcomes: LiveEquityTimeExitOutcome[] = [];
  for (const pos of open) {
    if (pendingExitPositionIds.has(pos.id)) continue;
    if (Date.now() - pos.createdAt < cfg.maxHoldDays * MS_PER_DAY) continue;

    // Both of these leave a position sitting past its hold limit with no close
    // attempted, every tick, so they are journaled like any other failed close
    // rather than reported only in this function's return value.
    if (pos.sourceIntentId === null) {
      outcomes.push(
        timeExitFailure(
          pos,
          cfg.riskProfile,
          'No source intent on this position — cannot locate its bracket to cancel',
        ),
      );
      continue;
    }
    const entryIntent = getIntent(pos.sourceIntentId);
    const riskProfile = getLiveOrder(pos.sourceIntentId)?.riskProfile ?? cfg.riskProfile;
    if (!entryIntent) {
      outcomes.push(timeExitFailure(pos, riskProfile, `Source intent ${pos.sourceIntentId} not found`));
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
    outcomes.push(await placeLiveEquityTimeExitClose(pos, freshAccountId, riskProfile, entryIntent));
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
      if (pos.sourceIntentId === null) continue; // can't locate the original risk
      const entryOrder = getLiveOrder(pos.sourceIntentId);
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
  const riskProfile = getLiveOrder(pos.sourceIntentId!)?.riskProfile ?? cfg.riskProfile;

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
