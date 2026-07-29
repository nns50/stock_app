import {
  OrderIntentRecord,
  advanceMaterialized,
  getIntent,
  isComboOrder,
  listIntents,
  recordIntentNote,
  recordIntentNoteOnce,
  recordReplace,
  transitionIntent,
} from '../../db/orders';
import { Position, addExit, createPosition, listPositions } from '../../db/positions';
import { db } from '../../db';
import { OrderState, canTransition, isTerminal } from './orderLifecycle';
import { WebullOrderStatus, isExitLeg, webullOrderStatus } from '../../providers/webull/orders';
import { isAutotradeIntent } from '../../db/autotradeLiveOrders';
import { isAutotradeOptionsIntent } from '../../db/autotradeLiveOptionsOrders';
import { QTY_EPS, computeFillDelta, isShortBooked } from './fillDelta';
import { etToday } from '../../util/marketDate';
import { orderingDateOf } from '../../db/positions';

// ---------------------------------------------------------------------------
// Reconcile an order intent's state with the broker (design §6 "status reconcile").
//
// We never get push fills (the gRPC event stream is out of scope), so this PULLS
// the order's live status by its client_order_id (open orders → history) and, if
// the broker has moved on (filled / partially filled / cancelled / expired),
// advances our lifecycle to match — appending an audit event. READ-ONLY toward
// the broker: it places and cancels nothing.
// ---------------------------------------------------------------------------

/** Broker statuses that mean "this order can no longer fill" but have no
 *  lifecycle state worth jumping to. Kept separate from mapWebullStatus rather
 *  than guessed into it: calling DELETED a 'cancelled' would put a specific,
 *  possibly wrong claim in the audit trail, while all the resting check needs
 *  to know is that it's finished. */
const EXTRA_TERMINAL_BROKER_STATUSES = new Set(['DELETED', 'INACTIVE']);

/**
 * Can this broker status still fill? Everything that isn't positively known to
 * be finished counts as resting — an unrecognized or missing status included,
 * since assuming an unknown status is safe is exactly the guess that gets a
 * close placed alongside a live stop.
 *
 * Derived FROM mapWebullStatus so there is one vocabulary rather than two.
 * There used to be a second, independent list in liveExecute.ts, and the two
 * had already drifted: DELETED and INACTIVE were terminal there but unmapped
 * here, so one order could be simultaneously "gone, safe to place the close"
 * for the bracket-cancel scan and "unknown, do nothing" for the reconcilers.
 * Any status added to mapWebullStatus now flows into both automatically.
 */
export function canStillFill(status?: string): boolean {
  if (!status) return true;
  const s = status.toUpperCase();
  if (EXTRA_TERMINAL_BROKER_STATUSES.has(s)) return false;
  const mapped = mapWebullStatus(s);
  return mapped === undefined || !isTerminal(mapped);
}

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

/**
 * How long an unknown-outcome placement must have been outstanding before the
 * broker denying knowledge of it is trusted enough to retire it.
 *
 * The autotrade reconcilers retire such an intent as 'rejected' once both the
 * open-orders and history endpoints answer without it, on the reasoning that
 * absence from both is positive evidence it never landed. That reasoning is
 * sound for an order the broker has had time to record, and NOT sound the tick
 * after it was sent: the reconcile loop runs every 60s, so an order placed at T
 * can be judged missing at T+60s, before the broker has necessarily indexed it.
 * (webullOrderStatus also sends no pagination parameters and scans whatever the
 * endpoint chose to return, which is a second reason absence is weaker evidence
 * than presence — less acute here, since a just-placed order would be near the
 * top of the OPEN list rather than deep in history, but it argues the same way.)
 *
 * Retiring wrongly is the expensive direction and the one this guards: it frees
 * the symbol's dedup slot, so the next cycle re-emits the same signal and places
 * a SECOND real order against a first that may be working — double size, two
 * bracket pairs. Waiting is nearly free by comparison; the only cost is the
 * dedup slot staying held a few minutes longer, which is the safe direction
 * anyway. So this is deliberately several ticks, not one.
 */
export const UNKNOWN_PLACEMENT_RETIRE_GRACE_MS = 5 * 60_000;

/**
 * Whether an unknown-outcome placement the broker denies knowing can now be
 * retired. `state === 'submitted'` with no broker order id is reachable ONLY
 * from an ambiguous placement — every other path out of 'submitted' either
 * records a broker id (acknowledged) or is terminal (rejected) — and
 * `updatedAt` is the moment of that submitted transition, since nothing else
 * touches the row while it sits here.
 */
export function canRetireUnknownPlacement(intent: OrderIntentRecord, now: number = Date.now()): boolean {
  if (intent.state !== 'submitted' || intent.brokerOrderId) return false;
  return now - intent.updatedAt >= UNKNOWN_PLACEMENT_RETIRE_GRACE_MS;
}

/**
 * Bring an intent whose placement outcome was UNKNOWN up to the state a
 * broker-reported status can legally apply from, and report whether it moved.
 *
 * An ambiguous placement leaves the intent at 'submitted' with no broker order
 * id (placeOrder / attemptLiveEntry / placeLiveOptionsOrder all do this rather
 * than claim a rejection they can't know about). But 'submitted' only leads to
 * 'acknowledged' or 'rejected' — the state machine models OUR knowledge, and it
 * says an order must be seen working before it can be seen filled. The broker
 * is under no such obligation: a marketable limit routinely fills within the
 * 60s before the first reconcile, so the very first status we ever see for it
 * is FILLED.
 *
 * Every reconciler computes `canTransition(state, target)`, so that arrived as
 * an ILLEGAL jump and was silently skipped — the intent then sat at 'submitted'
 * forever, polled every tick, holding its symbol's dedup slot, while the real
 * filled position was never materialized into any ledger. The whole point of
 * keeping an ambiguous placement non-terminal is that it stays resolvable, and
 * for the most likely outcome it wasn't.
 *
 * Fixed here rather than by widening TRANSITIONS: the broker answering at all
 * IS the acknowledgement we never received, so recording it as one is honest,
 * confined to this exact case, and leaves the audit trail reading the way it
 * actually happened. Callers must fold the returned `acked` into their own
 * "did anything change" answer.
 */
export function ackUnknownPlacement(
  intent: OrderIntentRecord,
  brokerOrderId?: string,
): { intent: OrderIntentRecord; acked: boolean } {
  if (intent.state !== 'submitted') return { intent, acked: false };
  return {
    intent: transitionIntent(intent.id, 'acknowledged', {
      brokerOrderId,
      detail: 'broker has this order — placement outcome was unknown until now',
    }),
    acked: true,
  };
}

/**
 * Adopt the broker's own order quantity when it disagrees with ours.
 *
 * The broker is authoritative about how big ITS order is, and our copy can be
 * stale: a replace whose response was lost may have applied (replaceOrder's
 * ambiguous branch deliberately declines to guess), leaving us describing an
 * order the broker no longer has. That matters beyond cosmetics, because
 * computeFillDelta clamps every booking to `intent.quantity` — a stale-low
 * quantity makes the extra shares unbookable by any path, so they exist at the
 * broker and in no ledger, cap or P&L figure we have.
 *
 * Confined to what can be trusted:
 *   - a COMBO (bracket / spread) is several broker orders and `total_quantity`
 *     is read off one leg, so it isn't comparable to our single figure.
 *     Replace already refuses combos outright, so this can't arise for them.
 *   - a missing or nonsensical value changes nothing. Absence is not evidence.
 *   - never below what we've already booked, which really happened.
 *
 * Purely informational otherwise: this is a correction to our own record, not
 * a lifecycle transition, so it's recorded as an audit note at the current
 * state (recordReplace's existing shape, which is exactly this operation).
 */
function adoptBrokerQuantity(
  intent: OrderIntentRecord,
  broker: WebullOrderStatus,
): { intent: OrderIntentRecord; adopted: boolean } {
  const brokerQty = broker.totalQty;
  if (isComboOrder(intent)) return { intent, adopted: false };
  if (brokerQty === undefined || !Number.isFinite(brokerQty) || brokerQty <= 0) return { intent, adopted: false };
  if (Math.abs(brokerQty - intent.quantity) <= QTY_EPS) return { intent, adopted: false };
  if (brokerQty < intent.materializedQty - QTY_EPS) return { intent, adopted: false };
  return {
    intent: recordReplace(
      intent.id,
      { quantity: brokerQty },
      `quantity corrected ${intent.quantity} → ${brokerQty} from the broker's own order record ` +
        `(our copy was stale — most likely a modify whose response was lost)`,
    ),
    adopted: true,
  };
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

interface MaterializeOutcome {
  booked: number;
  warning?: string;
}

/**
 * Mirror the not-yet-booked part of an observed fill into the Positions ledger.
 *
 * How MUCH is safe to book (and whether to book at all) is decided by the
 * shared computeFillDelta — the same core autotrade's own reconcile uses, so
 * the safety guards behind partial handling can't drift between the two paths.
 * This function only decides the SHAPE of the write: the human ledger records
 * each instalment as its own lot at its own price, which is what actually
 * happened and what FIFO exit matching already expects.
 */
function materializeFill(intent: OrderIntentRecord, observedQty: number, observedAvgPrice: number): MaterializeOutcome {
  const { qty, price, warning } = computeFillDelta(intent, observedQty, observedAvgPrice);
  if (qty <= 0) return { booked: 0, warning };

  // The booking and the materialization mark that says "this part is booked"
  // are ONE fact — commit them together or not at all. As two bare
  // auto-committing writes, a crash (or a throw from the second) landing
  // between them left the position/exit recorded with materialized_qty still
  // behind it, and the next reconcile — keyed on exactly that high-water mark
  // (computeFillDelta) — would book the SAME fill again: a duplicated lot, or
  // a duplicated exit against real P&L. Synchronous throughout, so a
  // better-sqlite3 transaction is sufficient and safe here.
  db.transaction(() => {
    if (intent.openClose === 'open') recordFillAsPosition(intent, qty, price);
    else recordCloseAsExit(intent, qty, price);

    advanceMaterialized(intent.id, qty, qty * price);
  })();
  return { booked: qty, warning };
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
    const filledExitLegs = (broker.legs ?? []).filter((l) => isExitLeg(l) && l.status === 'FILLED');
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

  // The broker knows this order, so an unknown-outcome placement is resolved:
  // record the acknowledgement we never received before applying its status,
  // or a FILLED arriving straight off an ambiguous place is an illegal jump
  // and gets skipped forever. See ackUnknownPlacement.
  const acknowledged = ackUnknownPlacement(intent, broker.brokerOrderId);
  const drifted = adoptBrokerQuantity(acknowledged.intent, broker);
  const current = drifted.intent;
  const acked = acknowledged.acked || drifted.adopted;

  const target = mapWebullStatus(broker.status);
  // A status the mapper doesn't recognize used to fall out of the early return
  // below and do NOTHING — no state change, no booking, and no trace. If that
  // response carried a filled quantity, those were real shares dropped in
  // silence. The status label and the reported fill are separate facts: not
  // knowing what to call the order's state is no reason to discard what the
  // broker said it filled, and materializeFill's guards (fillDelta.ts) make
  // acting on it safe — they only ever book LESS than reported, never more.
  // So book it, leave the lifecycle alone (we genuinely don't know what state
  // to claim), and say so in the audit trail.
  const unrecognized = target === undefined;
  if (unrecognized) {
    recordIntentNoteOnce(
      id,
      `broker reported an unrecognized status "${broker.status}" — lifecycle left unchanged, ` +
        `any reported fill is still booked`,
    );
  }
  const unrecognizedFill = unrecognized && (broker.filledQty ?? 0) > 0;
  const canMove = !!target && target !== current.state && canTransition(current.state, target);
  // An order that stays `partially_filled` across two observations has NOT
  // changed state, but it may well have filled further — the old code's
  // `target === intent.state` early return meant every partial after the first
  // was ignored, so a 30/100 that became 90/100 booked nothing for the extra 60.
  const restingPartial = target === 'partially_filled' && current.state === 'partially_filled';
  if (!canMove && !restingPartial && !unrecognizedFill) {
    return { ok: true, changed: acked, intent: current, broker };
  }

  const fill = broker.filledQty !== undefined ? ` ${broker.filledQty}/${broker.totalQty ?? current.quantity}` : '';
  const at = broker.filledPrice !== undefined ? ` @ ${broker.filledPrice}` : '';
  // Computed before the transaction closure below: `broker.status`/`target`
  // are narrowed non-null/defined HERE, and TS property narrowing doesn't
  // survive into a closure.
  const transitionDetail = `broker ${broker.status.toLowerCase()}${fill}${at}`;
  const moveTarget = canMove ? target : undefined;
  let updated = current;

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
  //
  // Keyed on the broker REPORTING a fill, not on which state it reported —
  // because a partial that is cancelled between two refreshes arrives as a
  // single CANCELLED response still carrying `filled_quantity: 30`. Gating on
  // filled/partially_filled would book nothing for it and lose those shares
  // exactly as before, just in a narrower window.
  //
  // A terminal FILLED implies the whole order even when the response omits the
  // quantity outright (some do), which is why this falls back to the order's own
  // size there but to ZERO on any other status — a CANCELLED carrying no
  // quantity field filled nothing, and assuming otherwise would fabricate a
  // position out of an order that never executed.
  const singleName = current.assetKind === 'stock' || current.optionType !== null;
  const observedQty = broker.filledQty ?? (target === 'filled' ? current.quantity : 0);
  let outcome: MaterializeOutcome = { booked: 0 };
  // ONE transaction across the state transition AND the fill booking. 'filled'
  // is terminal, and (bracket exit-legs aside) this reconcile refuses to touch
  // a terminal intent again — so a crash landing after the transition
  // committed but before the booking did left real observed shares
  // permanently unbookable: state says filled, the ledger says nothing, and
  // no later call can get back in. (The autotrade paths don't have this
  // window: listPendingLiveOrders / listPendingLiveOptionsOrders deliberately
  // re-select filled-but-unmaterialized orders. This generic path's only
  // guard is atomicity.) Everything here is synchronous; materializeFill's
  // own inner transaction nests as a savepoint.
  db.transaction(() => {
    if (moveTarget) {
      updated = transitionIntent(id, moveTarget, {
        detail: transitionDetail,
        brokerOrderId: broker.brokerOrderId,
      });
    }
    if (singleName && observedQty > 0) {
      outcome = materializeFill(updated, observedQty, broker.filledPrice ?? updated.limitPrice ?? 0);
    }
  })();

  // A fully-filled order whose booked quantity doesn't match what was ordered is
  // a real discrepancy — the ledger is now out of step with the account. Say so
  // in the audit trail rather than letting it pass as a clean reconcile.
  if (target === 'filled' && singleName) {
    const fresh = getIntent(id) ?? updated;
    if (isShortBooked(fresh)) {
      outcome.warning = [
        outcome.warning,
        `order filled but only ${fresh.materializedQty} of ${current.quantity} is reflected in Positions.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  if (outcome.warning) recordIntentNote(id, `materialization: ${outcome.warning}`);
  else if (outcome.booked > 0) recordIntentNote(id, `materialized ${outcome.booked} into Positions`);

  return {
    ok: true,
    changed: acked || canMove || outcome.booked > 0,
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
      // ET, not the box's UTC clock: a fill reconciled after 20:00 ET would
      // otherwise be dated tomorrow (see util/marketDate.ts).
      entryDate: etToday(),
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
    // ET, not UTC — same reason as recordFillAsPosition's entryDate above.
    const exitDate = etToday();
    // The position being closed is the OPPOSITE side of the closing order.
    const closingSide = intent.side === 'sell' ? 'long' : 'short';
    const open = listPositions({ status: 'open', symbol: intent.symbol, assetType: intent.assetKind })
      .filter((p) => p.side === closingSide && p.remainingQuantity > 0 && sameContract(p, intent))
      // FIFO: oldest entry first, with an undated lot ordered by when it was
      // recorded (see orderingDateOf).
      .sort((a, b) => orderingDateOf(a).localeCompare(orderingDateOf(b)) || a.id - b.id);

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
 * getting checked (see reconcileIntent's watchingBracketExit), PLUS an order
 * whose placement outcome is UNKNOWN.
 *
 * That last case has no broker order id — we never got a response to read one
 * from (placeOrder's ambiguous branch) — so the broker-id test alone excluded
 * precisely the orders most in need of resolving: possibly live, possibly
 * filled, and invisible to Positions until someone finds out which. It is
 * identified by shape instead: still 'submitted' with no broker id. That can
 * only be reached by an ambiguous placement, since every other path out of
 * 'submitted' either records a broker id (acknowledged) or is terminal
 * (rejected). reconcileIntent looks orders up by CLIENT order id, so it
 * resolves these without a broker id.
 *
 * Sequential on purpose — one broker status pull at a time, never a burst.
 */
export async function reconcileAllWorking(accountId: string): Promise<ReconcileAllResult> {
  const working = listIntents().filter((i) =>
    i.brokerOrderId
      ? !isTerminal(i.state) || (i.isBracket && i.state === 'filled' && hasOpenPositionForIntent(i))
      : i.state === 'submitted',
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
