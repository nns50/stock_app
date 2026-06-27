import { OrderIntentRecord, getIntent, transitionIntent } from '../../db/orders';
import { createPosition } from '../../db/positions';
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

export async function reconcileIntent(id: number, accountId: string): Promise<ReconcileResult> {
  const intent = getIntent(id);
  if (!intent) return { ok: false, changed: false, error: `No order intent ${id}.` };
  // Nothing to do once an order is in a terminal state.
  if (isTerminal(intent.state)) return { ok: true, changed: false, intent };

  const broker = await webullOrderStatus(accountId, intent.idempotencyKey);
  if (!broker.ok) return { ok: false, changed: false, intent, broker, error: broker.error };
  if (!broker.found || !broker.status) return { ok: true, changed: false, intent, broker };

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

  // A live OPEN fill becomes a tracked Position (so it shows on Positions /
  // Journal), mirroring a manually-logged trade. Single-leg/stock only: a
  // spread/combo doesn't map to one position (its single-leg fields are null),
  // and a CLOSE reduces an existing position (not auto-matched yet). `filled` is
  // terminal, so this transition — and the record — happens at most once.
  if (
    target === 'filled' &&
    intent.openClose === 'open' &&
    (intent.assetKind === 'stock' || intent.optionType !== null)
  ) {
    recordFillAsPosition(updated, broker);
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
    });
  } catch {
    // Swallow — the order reconcile already succeeded; position logging is a bonus.
  }
}
