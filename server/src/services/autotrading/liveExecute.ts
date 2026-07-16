import { config } from '../../config';
import { AutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import { AccountState, evaluateGuardrails, OrderIntent, blockingFailures, TradingConfig } from '../trading/guardrails';
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
import { mapWebullStatus } from '../trading/reconcile';
import {
  createIntent,
  transitionIntent,
  countTodaysOrders,
  getIntent,
  getIntents,
  OrderIntentRecord,
} from '../../db/orders';
import { canTransition, isTerminal } from '../trading/orderLifecycle';
import {
  recordLiveOrder,
  recordLiveExitOrder,
  setLiveOrderPositionId,
  listPendingLiveOrders,
  countLiveOrdersSince,
  pendingLiveOrdersRisk,
  getLiveOrder,
  LiveOrderMeta,
} from '../../db/autotradeLiveOrders';
// DB-layer reads only (NOT the options execution service) -- so the combined
// live budget can fold in the options book without a liveExecute <-> options
// service import cycle.
import { pendingLiveOptionsOrdersRisk } from '../../db/autotradeLiveOptionsOrders';
import { listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { createPosition, listPositions, updatePosition, addExit, Position } from '../../db/positions';
import { realizedPnlOf, initialRiskOf, computeStreaksAndDrawdown } from '../pnl';
import { TradeSignal } from './decide';
import { RiskCheckContext, RiskCheckResult, correlatedNotional, evaluateRiskCheck } from './riskCheck';
import { logAutotradeEvent } from '../../db/autotradeEvents';
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
        ? pendingEntries.find((o) => o.intentId === p.sourceIntentId)
        : pendingEntries.find((o) => o.symbol === p.symbol);
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

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId);
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
  recordLiveOrder({
    intentId: intentRec.id,
    symbol,
    stopPrice: signal.stop,
    targetPrice: signal.target,
    riskAmount: riskResult.approvedRiskAmount,
    riskProfile,
  });
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
): Promise<LiveExecutionOutcome[]> {
  const cfg = getAutotradeConfig();
  const equity = cfg.accountEquityUsd ?? 0;

  const snapshot = getLivePortfolioSnapshot();
  const { dailyPnl, consecutiveLosses, tradesToday } = snapshot;
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
    if (!broker.ok || !broker.found) {
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
  const { stopPrice, targetPrice, riskAmount, riskProfile } = meta;
  // The MASTER (entry) leg's own status, same field reconcileIntent() already
  // uses for a non-bracket order. Also this table's ROLE='exit' order's own
  // (and only) status -- a time-exit closing order is never a bracket, so
  // its fill is exactly this simple, same as a plain non-bracket order.
  const masterTarget = broker.status ? mapWebullStatus(broker.status) : undefined;
  if (
    masterTarget &&
    !isTerminal(intent.state) &&
    masterTarget !== intent.state &&
    canTransition(intent.state, masterTarget)
  ) {
    transitionIntent(intent.id, masterTarget, {
      detail: `broker ${broker.status?.toLowerCase()}`,
      brokerOrderId: broker.brokerOrderId,
    });
    if (masterTarget === 'filled') {
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
        if (meta.role === 'exit') {
          // A time-exit closing order — meta.positionId is known upfront
          // (recordLiveExitOrder), unlike an entry's positionId which is
          // null until THIS materialization sets it.
          const recorded = materializeTimeExitFill(
            meta.positionId!,
            intent,
            broker.filledPrice ?? intent.limitPrice ?? 0,
            riskProfile,
          );
          return recorded ? { changed: true, action: 'exit_filled' } : { changed: false };
        }
        materializeEntryFill(
          intent,
          stopPrice,
          targetPrice,
          riskAmount,
          riskProfile,
          broker.filledQty ?? intent.quantity,
          broker.filledPrice ?? intent.limitPrice ?? 0,
        );
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
  if (meta.role === 'entry' && intent.state === 'filled' && intent.isBracket && broker.legs) {
    const filledExitLegs = broker.legs.filter((l) => l.comboType && l.comboType !== 'MASTER' && l.status === 'FILLED');
    if (filledExitLegs.length > 1) {
      logAutotradeEvent({
        symbol: intent.symbol,
        stage: 'execution',
        action: 'live_exit_ambiguous',
        detail: { intentId: intent.id, legs: filledExitLegs.map((l) => l.comboType) },
        riskProfile,
      });
      return { changed: false, error: 'Two exit legs both reported FILLED — ambiguous, left open rather than guessed' };
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
        );
        return recorded ? { changed: true, action: 'exit_filled' } : { changed: false };
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
  return { changed: false };
}

function materializeEntryFill(
  intent: OrderIntentRecord,
  stopPrice: number,
  targetPrice: number,
  riskAmount: number,
  riskProfile: string,
  filledQty: number,
  filledPrice: number,
): void {
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
    return;
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
    sourceIntentId: intent.id,
  });
  setLiveOrderPositionId(intent.id, position.id);
  logAutotradeEvent({
    symbol: intent.symbol,
    stage: 'execution',
    action: 'live_position_opened',
    detail: { quantity: filledQty, entryPrice: filledPrice, stopPrice, targetPrice, riskAmount },
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
): boolean {
  const position = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => isAutotradePosition(p) && (p.sourceIntentId === intent.id || (positionId !== null && p.id === positionId)),
  );
  if (!position) return false;
  const closed = addExit(position.id, {
    quantity: position.remainingQuantity,
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
): boolean {
  const position = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => p.id === positionId && isAutotradePosition(p),
  );
  if (!position) return false;
  const closed = addExit(position.id, {
    quantity: position.remainingQuantity,
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
 *  to confirm it's gone, rather than assume an unrecognized status is safe. */
const TERMINAL_ORDER_STATUSES = new Set([
  'FILLED',
  'CANCELLED',
  'CANCELED',
  'EXPIRED',
  'REJECTED',
  'FAILED',
  'DELETED',
  'INACTIVE',
]);
function isRestingStatus(status?: string): boolean {
  return !status || !TERMINAL_ORDER_STATUSES.has(status.toUpperCase());
}

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
    // Nothing resting on the exit side. Either the bracket is already gone (safe
    // to close) OR an exit leg just filled and the position is closing on its
    // own (don't place a second order). Distinguish via the combo status — a
    // best-effort signal; the close's own naked-short guardrail is the backstop
    // if the broker doesn't surface the fill here.
    const combo = await webullOrderStatus(accountId, intent.idempotencyKey);
    const filledLeg =
      combo.ok &&
      combo.found &&
      combo.legs?.some((l) => l.comboType && l.comboType !== 'MASTER' && l.status === 'FILLED');
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
  return { ok: true };
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
async function placeLiveEquityTimeExitClose(
  pos: Position,
  accountId: string,
  riskProfile: string,
): Promise<LiveEquityTimeExitOutcome> {
  const symbol = pos.symbol.toUpperCase();
  let last: number;
  try {
    last = (await getProvider().getQuote(symbol)).last;
  } catch (err) {
    return { symbol, positionId: pos.id, requested: false, reason: `Quote fetch failed: ${(err as Error).message}` };
  }
  if (!Number.isFinite(last) || last <= 0) {
    return { symbol, positionId: pos.id, requested: false, reason: `Invalid quote price: ${last}` };
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
    return { symbol, positionId: pos.id, requested: false, reason: acct.error ?? 'Could not load account state' };
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

  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live time-exit)' });
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

    if (pos.sourceIntentId === null) {
      outcomes.push({
        symbol: pos.symbol,
        positionId: pos.id,
        requested: false,
        reason: 'No source intent on this position — cannot locate its bracket to cancel',
      });
      continue;
    }
    const entryIntent = getIntent(pos.sourceIntentId);
    if (!entryIntent) {
      outcomes.push({
        symbol: pos.symbol,
        positionId: pos.id,
        requested: false,
        reason: `Source intent ${pos.sourceIntentId} not found`,
      });
      continue;
    }
    const riskProfile = getLiveOrder(pos.sourceIntentId)?.riskProfile ?? cfg.riskProfile;

    // Re-fetch fresh config for EACH triggered position, same reasoning as
    // checkLiveOptionsExits' own per-position refresh — this loop awaits real
    // broker round-trips between positions, and a kill switch engaged
    // mid-loop must stop the NEXT position's cancel/close immediately, not
    // just the next cycle.
    const freshAccountId = getAutotradeConfig().liveAccountId;
    if (!freshAccountId) continue;

    const cancelled = await cancelLiveBracketExitLegs(entryIntent, freshAccountId);
    if (!cancelled.ok) {
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'live_time_exit_cancel_failed',
        detail: { positionId: pos.id, reason: cancelled.reason, raced: cancelled.raced ?? false },
        riskProfile,
      });
      outcomes.push({ symbol: pos.symbol, positionId: pos.id, requested: false, reason: cancelled.reason });
      continue;
    }

    outcomes.push(await placeLiveEquityTimeExitClose(pos, freshAccountId, riskProfile));
  }
  return outcomes;
}
