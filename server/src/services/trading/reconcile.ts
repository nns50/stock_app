import { OrderIntentRecord, getIntent, listIntents, transitionIntent } from '../../db/orders';
import { Position, addExit, createPosition, listPositions } from '../../db/positions';
import { OrderState, canTransition, isTerminal } from './orderLifecycle';
import { WebullOrderStatus, webullOrderStatus } from '../../providers/webull/orders';

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
  /** True when this call advanced the intent's state. */
  changed: boolean;
  intent?: OrderIntentRecord;
  broker?: WebullOrderStatus;
  error?: string;
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
      recordCloseAsExit(asClose, { ...broker, filledQty: leg.filledQty, filledPrice: leg.filledPrice });
      return { ok: true, changed: true, intent, broker };
    }
    return { ok: true, changed: false, intent, broker };
  }

  if (!broker.status) return { ok: true, changed: false, intent, broker };

  const target = mapWebullStatus(broker.status);
  // Only move when the broker reports a genuinely new, legal next state.
  if (!target || target === intent.state || !canTransition(intent.state, target)) {
    return { ok: true, changed: false, intent, broker };
  }

  const fill = broker.filledQty !== undefined ? ` ${broker.filledQty}/${broker.totalQty ?? intent.quantity}` : '';
  const at = broker.filledPrice !== undefined ? ` @ ${broker.filledPrice}` : '';
  const updated = transitionIntent(id, target, {
    detail: `broker ${broker.status.toLowerCase()}${fill}${at}`,
    brokerOrderId: broker.brokerOrderId,
  });

  // A live single-leg/stock fill is mirrored into the Positions ledger so live
  // trades show on Positions / Journal like a manually-logged trade: an OPEN fill
  // creates a Position, a CLOSE fill records an exit against the matching open
  // position(s). A spread/combo doesn't map to one position (its single-leg
  // fields are null), so it's skipped. `filled` is terminal, so each runs at most
  // once. Both are best-effort — the order reconcile has already succeeded.
  const singleNameFill = target === 'filled' && (intent.assetKind === 'stock' || intent.optionType !== null);
  if (singleNameFill && intent.openClose === 'open') {
    recordFillAsPosition(updated, broker);
  } else if (singleNameFill && intent.openClose === 'close') {
    recordCloseAsExit(updated, broker);
  }

  return { ok: true, changed: true, intent: updated, broker };
}

/** Record a filled OPEN order as a tracked Position. Best-effort: a logging
 *  failure must not break order reconciliation. */
function recordFillAsPosition(intent: OrderIntentRecord, broker: WebullOrderStatus): void {
  try {
    createPosition({
      assetType: intent.assetKind,
      symbol: intent.symbol,
      side: intent.side === 'buy' ? 'long' : 'short',
      quantity: broker.filledQty ?? intent.quantity,
      entryPrice: broker.filledPrice ?? intent.limitPrice ?? 0,
      entryDate: new Date().toISOString().slice(0, 10),
      optionType: intent.optionType,
      strike: intent.strike,
      expiration: intent.expiration,
      multiplier: intent.assetKind === 'option' ? 100 : undefined,
      notes: `Auto-recorded from live order #${intent.id}${broker.brokerOrderId ? ` (broker ${broker.brokerOrderId})` : ''}`,
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
function recordCloseAsExit(intent: OrderIntentRecord, broker: WebullOrderStatus): void {
  try {
    let remaining = broker.filledQty ?? intent.quantity;
    if (remaining <= 0) return;
    const exitPrice = broker.filledPrice ?? intent.limitPrice ?? 0;
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
        notes: `Auto-recorded from live close order #${intent.id}${broker.brokerOrderId ? ` (broker ${broker.brokerOrderId})` : ''}`,
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
  results: Array<{ id: number; changed: boolean; state?: OrderState; status?: string; error?: string }>;
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
  for (const intent of working) {
    const r = await reconcileIntent(intent.id, accountId);
    if (r.changed) changed++;
    results.push({
      id: intent.id,
      changed: r.changed,
      state: r.intent?.state,
      status: r.broker?.status,
      error: r.error,
    });
  }
  return { ok: true, reconciled: working.length, changed, results };
}
