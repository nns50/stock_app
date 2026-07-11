import { config } from '../../config';
import { AutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import { AccountState, evaluateGuardrails, OrderIntent, blockingFailures, TradingConfig } from '../trading/guardrails';
import { marketOpenContext } from '../trading/marketHours';
import { webullAccountState } from '../../providers/webull/accountState';
import { newClientOrderId, webullPlaceOrder, webullOrderStatus } from '../../providers/webull/orders';
import { mapWebullStatus } from '../trading/reconcile';
import { createIntent, transitionIntent, countTodaysOrders, getIntent, OrderIntentRecord } from '../../db/orders';
import { canTransition, isTerminal } from '../trading/orderLifecycle';
import {
  recordLiveOrder,
  setLiveOrderPositionId,
  listPendingLiveOrders,
  countLiveOrdersSince,
  pendingLiveOrdersRisk,
} from '../../db/autotradeLiveOrders';
// DB-layer reads only (NOT the options execution service) -- so the combined
// live budget can fold in the options book without a liveExecute <-> options
// service import cycle.
import { pendingLiveOptionsOrdersRisk } from '../../db/autotradeLiveOptionsOrders';
import { listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { createPosition, listPositions, addExit, Position } from '../../db/positions';
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
const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

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
export async function runLiveExecution(candidates: { signal: TradeSignal }[]): Promise<LiveExecutionOutcome[]> {
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
  const runningPositions: { symbol: string; notional: number }[] = snapshot.openPositions.map((p) => ({
    symbol: p.symbol,
    notional: p.entryPrice * p.quantity,
  }));
  // Skip a symbol that has an open position OR a still-working / not-yet-
  // materialized live order. A position row is created ONLY when a full fill
  // reconciles, so open positions alone miss an entry still resting or
  // partially filled across a loop-tick boundary -- the next tick would re-emit
  // the same signal and place a SECOND real order (double size + two bracket
  // pairs). listPendingLiveOrders() covers all three states (its row persists
  // until the position both materializes and closes). attemptLiveEntry()
  // re-checks this authoritatively; this just avoids risk-checking a known dup.
  const skipSymbols = new Set([
    ...snapshot.openPositions.map((p) => p.symbol),
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
      runningPositions.push({ symbol, notional: signal.entry * result.sizing.suggestedQuantity });
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
  const outcomes: LiveReconcileOutcome[] = [];
  for (const meta of pending) {
    const intent = getIntent(meta.intentId);
    if (!intent) continue;
    const broker = await webullOrderStatus(accountId, intent.idempotencyKey);
    if (!broker.ok || !broker.found) {
      outcomes.push({ intentId: intent.id, symbol: meta.symbol, changed: false, error: broker.error });
      continue;
    }

    const changed = reconcileOneLiveOrder(
      intent,
      meta.stopPrice,
      meta.targetPrice,
      meta.riskAmount,
      meta.riskProfile,
      broker,
    );
    outcomes.push({ intentId: intent.id, symbol: meta.symbol, ...changed });
  }
  return outcomes;
}

function reconcileOneLiveOrder(
  intent: OrderIntentRecord,
  stopPrice: number,
  targetPrice: number,
  riskAmount: number,
  riskProfile: string,
  broker: Awaited<ReturnType<typeof webullOrderStatus>>,
): { changed: boolean; action?: 'entry_filled' | 'exit_filled'; error?: string } {
  // The MASTER (entry) leg's own status, same field reconcileIntent() already
  // uses for a non-bracket order.
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
          action: 'live_entry_materialization_failed',
          detail: { intentId: intent.id, error: message },
          riskProfile,
        });
        return { changed: true, error: `Broker fill recorded but failed to materialize a Position: ${message}` };
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
  // than guessing.
  if (intent.state === 'filled' && intent.isBracket && broker.legs) {
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
        const recorded = materializeExitFill(intent, exitLeg.filledPrice ?? fallbackPrice, riskProfile);
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
 *  closed — defensive against a double-reconcile of the same fill. Looks up
 *  the position via sourceIntentId (set on entry fill by materializeEntryFill)
 *  rather than autotrade_live_orders.positionId, which is a convenience
 *  cache, not the source of truth. */
function materializeExitFill(intent: OrderIntentRecord, exitPrice: number, riskProfile: string): boolean {
  const position = listPositions({ status: 'open', symbol: intent.symbol }).find(
    (p) => p.sourceIntentId === intent.id && isAutotradePosition(p),
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
