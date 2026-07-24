import {
  OrderIntentRecord,
  advanceMaterialized,
  getIntent,
  listIntents,
  recordIntentNote,
  transitionIntent,
} from '../../db/orders';
import { Position, addExit, createPosition, listPositions } from '../../db/positions';
import { OrderState, canTransition, isTerminal } from './orderLifecycle';
import { WebullOrderStatus, webullOrderStatus } from '../../providers/webull/orders';
import { isAutotradeIntent } from '../../db/autotradeLiveOrders';
import { isAutotradeOptionsIntent } from '../../db/autotradeLiveOptionsOrders';

// ---------------------------------------------------------------------------
// Reconcile an order intent's state with the broker (design §6 "status reconcile").
//
// We never get push fills (the gRPC event stream is out of scope), so this PULLS
// the order's live status by its client_order_id (open orders → history) and, if
// the broker has moved on (filled / partially filled / cancelled / expired),
// advances our lifecycle to match — appending an audit event. READ-ONLY toward
// the broker: it places and cancels nothing.
// ---------------------------------------------------------------------------

/** Map a raw Webull order status to our lifecycle state (undefined = unknown). */
export function mapWebullStatus(status: string): OrderState | undefined {
  switch (status.toUpperCase()) {
    case 'FILLED':
      return 'filled';
    case 'PARTIAL_FILLED':
    case 'PARTIALLY_FILLED':
    case 'PARTIAL':
      return 'partially_filled';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    case 'FAILED':
    case 'REJECTED':
      return 'rejected';
    // Still live at the broker — our `acknowledged` already covers this.
    case 'PENDING':
    case 'PENDING_SUBMIT':
    case 'SUBMITTED':
    case 'QUEUED':
    case 'WORKING':
    case 'ACCEPTED':
    case 'NEW':
      return 'acknowledged';
    default:
      return undefined;
  }
}

export interface ReconcileResult {
  ok: boolean;
  /** True when this call advanced the intent's state OR booked new fill
   *  quantity into the Positions ledger. */
  changed: boolean;
  intent?: OrderIntentRecord;
  broker?: WebullOrderStatus;
  error?: string;
  /** Quantity newly mirrored into Positions by this call (0 when none). */
  materialized?: number;
  /** Set when the broker's fill data contradicted an assumption this code
   *  depends on. Surfaced rather than swallowed — see materializeFill. */
  fillWarning?: string;
}

/** Quantities are REAL columns; compare with a tolerance rather than exactly. */
const QTY_EPS = 1e-9;

interface MaterializeOutcome {
  booked: number;
  warning?: string;
}

/**
 * Mirror the not-yet-booked part of an observed fill into the Positions ledger.
 *
 * The broker reports a RUNNING total (`filled_quantity`) and an AVERAGE price
 * over all executions, so the new lot is the difference against what we already
 * booked: quantity by subtraction, price by differencing notionals. Booking the
 * delta rather than the total is what makes this safe to call repeatedly — all
 * three reconcile callers (human Refresh, the Webull scheduler, autotrade's own
 * loop) can observe the same fill and only the unbooked remainder is written.
 *
 * That running-total reading is an ASSUMPTION about the broker — it has not
 * been confirmed against a real partial fill (see `npm run capture:broker`).
 * So rather than trust it, every way it could be wrong is checked here and
 * fails toward under-booking with a loud note, never toward silently booking
 * phantom shares:
 *
 *   - a DECREASE means the field reports each execution separately instead of a
 *     running total, and differencing is invalid — refuse and flag.
 *   - a total exceeding the order's own size means the same thing (or broker
 *     inconsistency) — book only up to what was actually ordered, and flag.
 *   - a non-sensical implied price (from an inconsistent average) falls back to
 *     the reported average, and flags.
 *
 * Under-booking is recoverable: the shares show up in the next Webull positions
 * sync and the note says why. Over-booking would invent cost basis that never
 * existed, which silently corrupts P&L — so every ambiguous case resolves the
 * conservative way.
 */
function materializeFill(intent: OrderIntentRecord, observedQty: number, observedAvgPrice: number): MaterializeOutcome {
  if (!Number.isFinite(observedQty) || observedQty <= QTY_EPS) return { booked: 0 };

  let delta = observedQty - intent.materializedQty;
  if (delta < -QTY_EPS) {
    return {
      booked: 0,
      warning:
        `broker reported ${observedQty} filled after ${intent.materializedQty} was already booked — ` +
        `filled_quantity decreased, so it is NOT a running total and cannot be differenced. ` +
        `Refusing to book; reconcile this order manually.`,
    };
  }
  if (delta <= QTY_EPS) return { booked: 0 };

  let warning: string | undefined;

  // Never book more than the order actually asked for.
  const bookable = intent.quantity - intent.materializedQty;
  if (delta > bookable + QTY_EPS) {
    warning =
      `broker reported ${observedQty} filled on an order for ${intent.quantity} — ` +
      `booking only the ${Math.max(0, bookable)} outstanding.`;
    delta = Math.max(0, bookable);
    if (delta <= QTY_EPS) return { booked: 0, warning };
  }

  // Price of THIS lot, backed out of the running average.
  const observedNotional = observedQty * observedAvgPrice;
  const incrementalNotional = observedNotional - intent.materializedNotional;
  let price = incrementalNotional / delta;
  if (!Number.isFinite(price) || price <= 0) {
    price = observedAvgPrice;
    warning = [warning, `implied incremental price was not usable — falling back to the average fill price.`]
      .filter(Boolean)
      .join(' ');
  }

  if (intent.openClose === 'open') recordFillAsPosition(intent, delta, price);
  else recordCloseAsExit(intent, delta, price);

  advanceMaterialized(intent.id, delta, delta * price);
  return { booked: delta, warning };
}

/** True when `intent`'s own entry fill produced a position that's still open —
 *  i.e. a filled bracket whose stop-loss/take-profit exit leg hasn't (yet)
 *  closed it. */
function hasOpenPositionForIntent(intent: OrderIntentRecord): boolean {
  return listPositions({ status: 'open', symbol: intent.symbol }).some((p) => p.sourceIntentId === intent.id);
}

export async function reconcileIntent(id: number, accountId: string): Promise<ReconcileResult> {
  const intent = getIntent(id);
  if (!intent) return { ok: false, changed: false, error: `No order intent ${id}.` };

  // order_intents has no "who placed this" column (autotrade and the human
  // Trade page share the one table — see db/autotradeLiveOrders.ts's own
  // header comment), so without this guard this GENERIC reconcile — reached
  // via a human's Trade-page Refresh/Refresh-all/Cancel/Replace, or the
  // background Webull sync scheduler (services/webullPositionsScheduler.ts,
  // on its own independent timer) — can observe an autotrade-placed order's
  // fill before autotrade's OWN reconcile
  // (autotrading/liveExecute.ts's reconcileLiveOrders/reconcileOneLiveOrder,
  // on its own 60s loop tick) gets a turn. If it does, transitionIntent()
  // below moves the intent to 'filled' — a TERMINAL state (no further
  // transitions, orderLifecycle.ts) — and recordFillAsPosition() tags the
  // resulting Position plain `['live']`. Because 'filled' is terminal,
  // autotrade's own reconcile's `!isTerminal(intent.state)` guard then
  // PERMANENTLY blocks it from ever materializing (or linking, see #266) the
  // position itself: real, autotrade-opened capital left stuck invisible to
  // isAutotradePosition() — the Auto page's live-positions table and its own
  // risk/P&L accounting — forever. Confirmed via a real user report (a live
  // position that was genuinely autotrade-placed, showing on Positions but
  // never on the Auto page). Autotrade's own intents are exclusively its own
  // reconcile's job from here on; this path defers entirely rather than just
  // skipping recordFillAsPosition — transitioning the intent's STATE here
  // would independently trip the same terminal-state lockout.
  //
  // Checked for BOTH live paths — equity (liveExecute.ts, tracked in
  // db/autotradeLiveOrders.ts) and options (liveOptionsExecute.ts, its own
  // PARALLEL db/autotradeLiveOptionsOrders.ts side table) — since both place
  // orders into this SAME shared order_intents table and are equally exposed
  // to the same race. The options side has no tag-based healing mechanism
  // equivalent to adoptOrphanedLivePositions() (its own live positions live
  // in a separate table with no tags column at all), so preventing the race
  // here is the only guard for it.
  if (isAutotradeIntent(id) || isAutotradeOptionsIntent(id)) return { ok: true, changed: false, intent };

  // A bracket's own `state` only ever reflects its MASTER (entry) leg — the
  // instant that fills it reads 'filled' and, since 'filled' is terminal,
  // never moves again, EVEN THOUGH a linked STOP_LOSS/STOP_PROFIT exit leg can
  // still be sitting at the broker, working. Without this, a human-placed
  // bracket's exit is NEVER picked up here no matter how many times "Refresh
  // all" is clicked — confirmed as the cause of two real symbols staying
  // "open" long after their stop/target actually filled. Mirrors
  // autotrading/liveExecute.ts's identical bracket-exit handling
  // (reconcileOneLiveOrder / listPendingLiveOrders) for the autotrade path.
  const watchingBracketExit = intent.isBracket && intent.state === 'filled' && hasOpenPositionForIntent(intent);
  if (isTerminal(intent.state) && !watchingBracketExit) return { ok: true, changed: false, intent };

  const broker = await webullOrderStatus(accountId, intent.idempotencyKey);
  if (!broker.ok) return { ok: false, changed: false, intent, broker, error: broker.error };
  if (!broker.found) return { ok: true, changed: false, intent, broker };

  if (watchingBracketExit) {
    // Same fails-closed posture as the autotrade path: only act on a leg
    // unambiguously identified as non-MASTER AND FILLED; zero (still working)
    // or two-or-more (shouldn't happen under normal OCO semantics, but not
    // ruled out) both leave the position open rather than guessing.
    const filledExitLegs = (broker.legs ?? []).filter(
      (l) => l.comboType && l.comboType !== 'MASTER' && l.status === 'FILLED',
    );
    if (filledExitLegs.length === 1) {
      const leg = filledExitLegs[0];
      // recordCloseAsExit infers which position side to reduce from the
      // INTENT's own `side` ('sell' closes a long) — correct for a genuinely
      // separate close order, but a bracket's exit leg is still THIS entry
      // intent (side/openClose never changed from 'buy'/'open'). Flip them so
      // the inference lands on the side the entry itself opened, not its
      // opposite.
      const asClose: OrderIntentRecord = {
        ...intent,
        side: intent.side === 'buy' ? 'sell' : 'buy',
        openClose: 'close',
      };
      // The exit leg's own fill — NOT routed through materializeFill, whose
      // high-water mark tracks this intent's ENTRY quantity. Re-entry is
      // bounded instead by hasOpenPositionForIntent above: once the exit is
      // booked the position is no longer open, so this stops firing.
      recordCloseAsExit(asClose, leg.filledQty ?? intent.quantity, leg.filledPrice ?? intent.limitPrice ?? 0);
      return { ok: true, changed: true, intent, broker };
    }
    return { ok: true, changed: false, intent, broker };
  }

  if (!broker.status) return { ok: true, changed: false, intent, broker };

  const target = mapWebullStatus(broker.status);
  const canMove = !!target && target !== intent.state && canTransition(intent.state, target);
  // An order that stays `partially_filled` across two observations has NOT
  // changed state, but it may well have filled further — the old code's
  // `target === intent.state` early return meant every partial after the first
  // was ignored, so a 30/100 that became 90/100 booked nothing for the extra 60.
  const restingPartial = target === 'partially_filled' && intent.state === 'partially_filled';
  if (!canMove && !restingPartial) return { ok: true, changed: false, intent, broker };

  const fill = broker.filledQty !== undefined ? ` ${broker.filledQty}/${broker.totalQty ?? intent.quantity}` : '';
  const at = broker.filledPrice !== undefined ? ` @ ${broker.filledPrice}` : '';
  let updated = intent;
  if (canMove) {
    updated = transitionIntent(id, target, {
      detail: `broker ${broker.status.toLowerCase()}${fill}${at}`,
      brokerOrderId: broker.brokerOrderId,
    });
  }

  // A live single-leg/stock fill is mirrored into the Positions ledger so live
  // trades show on Positions / Journal like a manually-logged trade: an OPEN fill
  // creates a Position, a CLOSE fill records an exit against the matching open
  // position(s). A spread/combo doesn't map to one position (its single-leg
  // fields are null), so it's skipped.
  //
  // PARTIAL fills are mirrored too, not just the terminal `filled`. Booking only
  // at `filled` meant a partial that was then CANCELLED — a legal, terminal
  // lifecycle path — left real shares held with no position row at all:
  // invisible to Positions, to exposure, to the open-risk caps, and to every
  // exit rule. materializeFill() books the unbooked delta, so the shares appear
  // as soon as the broker reports them and repeated observations are harmless.
  const singleName = intent.assetKind === 'stock' || intent.optionType !== null;
  const sawFill = target === 'filled' || target === 'partially_filled';
  let outcome: MaterializeOutcome = { booked: 0 };
  if (singleName && sawFill && broker.filledQty !== undefined) {
    outcome = materializeFill(updated, broker.filledQty, broker.filledPrice ?? updated.limitPrice ?? 0);
  }

  // A fully-filled order whose booked quantity doesn't match what was ordered is
  // a real discrepancy — the ledger is now out of step with the account. Say so
  // in the audit trail rather than letting it pass as a clean reconcile.
  if (target === 'filled' && singleName) {
    const booked = (getIntent(id) ?? updated).materializedQty;
    if (Math.abs(booked - intent.quantity) > QTY_EPS) {
      outcome.warning = [
        outcome.warning,
        `order filled but only ${booked} of ${intent.quantity} is reflected in Positions.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  if (outcome.warning) recordIntentNote(id, `materialization: ${outcome.warning}`);
  else if (outcome.booked > 0) recordIntentNote(id, `materialized ${outcome.booked} into Positions`);

  return {
    ok: true,
    changed: canMove || outcome.booked > 0,
    intent: getIntent(id) ?? updated,
    broker,
    materialized: outcome.booked,
    fillWarning: outcome.warning,
  };
}

/** Record a filled OPEN order (or one instalment of it) as a tracked Position.
 *  A partially-filled order books one lot per observed instalment, each at its
 *  own price — which is what actually happened, and what FIFO exit matching
 *  already expects. Best-effort: a logging failure must not break order
 *  reconciliation. */
function recordFillAsPosition(intent: OrderIntentRecord, quantity: number, entryPrice: number): void {
  try {
    createPosition({
      assetType: intent.assetKind,
      symbol: intent.symbol,
      side: intent.side === 'buy' ? 'long' : 'short',
      quantity,
      entryPrice,
      entryDate: new Date().toISOString().slice(0, 10),
      optionType: intent.optionType,
      strike: intent.strike,
      expiration: intent.expiration,
      multiplier: intent.assetKind === 'option' ? 100 : undefined,
      notes: `Auto-recorded from live order #${intent.id}${intent.brokerOrderId ? ` (broker ${intent.brokerOrderId})` : ''}`,
      tags: ['live'],
      sourceIntentId: intent.id,
    });
  } catch {
    // Swallow — the order reconcile already succeeded; position logging is a bonus.
  }
}

/** Does this open position match the contract the closing order references? */
function sameContract(p: Position, intent: OrderIntentRecord): boolean {
  if (p.symbol !== intent.symbol || p.assetType !== intent.assetKind) return false;
  if (intent.assetKind === 'stock') return true;
  return p.optionType === intent.optionType && p.strike === intent.strike && p.expiration === intent.expiration;
}

/** Record a filled CLOSE order as an exit against the matching open position(s),
 *  oldest first (FIFO), so the Journal's realized P&L reflects the live trade.
 *  A sell-to-close reduces a long; a buy-to-close reduces a short. Best-effort:
 *  a logging failure must not break order reconciliation, and an unmatched close
 *  (e.g. the open leg was a spread, or never logged here) is simply a no-op. */
function recordCloseAsExit(intent: OrderIntentRecord, quantity: number, exitPrice: number): void {
  try {
    let remaining = quantity;
    if (remaining <= 0) return;
    const exitDate = new Date().toISOString().slice(0, 10);
    // The position being closed is the OPPOSITE side of the closing order.
    const closingSide = intent.side === 'sell' ? 'long' : 'short';
    const open = listPositions({ status: 'open', symbol: intent.symbol, assetType: intent.assetKind })
      .filter((p) => p.side === closingSide && p.remainingQuantity > 0 && sameContract(p, intent))
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id - b.id); // FIFO: oldest entry first

    for (const p of open) {
      if (remaining <= 1e-9) break;
      const take = Math.min(remaining, p.remainingQuantity);
      addExit(p.id, {
        quantity: take,
        exitPrice,
        exitDate,
        notes: `Auto-recorded from live close order #${intent.id}${intent.brokerOrderId ? ` (broker ${intent.brokerOrderId})` : ''}`,
        sourceIntentId: intent.id,
      });
      remaining -= take;
    }
  } catch {
    // Swallow — the order reconcile already succeeded; exit logging is a bonus.
  }
}

export interface ReconcileAllResult {
  ok: boolean;
  /** How many still-working orders were checked against the broker. */
  reconciled: number;
  /** How many of those advanced to a new state. */
  changed: number;
  results: Array<{
    id: number;
    changed: boolean;
    state?: OrderState;
    status?: string;
    error?: string;
    materialized?: number;
    fillWarning?: string;
  }>;
  /** How many orders reported a fill the ledger could not fully mirror. Surfaced
   *  so a bulk refresh can't quietly hide a discrepancy behind a tidy count. */
  warnings: number;
}

/**
 * Reconcile every still-working order in one pass — the "Refresh all" action, so
 * the live-order panel can be brought up to date without tapping each order. A
 * "working" order is non-terminal AND known to the broker (has a broker order id;
 * drafts / guardrail-rejected intents never reached the broker) — PLUS a filled
 * bracket whose position is still open, so its still-working exit leg keeps
 * getting checked (see reconcileIntent's watchingBracketExit). Sequential on
 * purpose — one broker status pull at a time, never a burst.
 */
export async function reconcileAllWorking(accountId: string): Promise<ReconcileAllResult> {
  const working = listIntents().filter(
    (i) =>
      i.brokerOrderId && (!isTerminal(i.state) || (i.isBracket && i.state === 'filled' && hasOpenPositionForIntent(i))),
  );
  const results: ReconcileAllResult['results'] = [];
  let changed = 0;
  let warnings = 0;
  for (const intent of working) {
    const r = await reconcileIntent(intent.id, accountId);
    if (r.changed) changed++;
    if (r.fillWarning) warnings++;
    results.push({
      id: intent.id,
      changed: r.changed,
      state: r.intent?.state,
      status: r.broker?.status,
      error: r.error,
      materialized: r.materialized,
      fillWarning: r.fillWarning,
    });
  }
  return { ok: true, reconciled: working.length, changed, results, warnings };
}
