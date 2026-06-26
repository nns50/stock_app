import { OrderIntentRecord, getIntent } from '../../db/orders';
import { canTransition, isTerminal } from './orderLifecycle';
import { WebullCancelResult, webullCancelOrder } from '../../providers/webull/orders';
import { ReconcileResult, reconcileIntent } from './reconcile';

// ---------------------------------------------------------------------------
// Cancel a live order (design §6). Unlike placing, cancelling REDUCES risk, so
// it deliberately does NOT require TRADING_ENABLED — you must always be able to
// pull a resting order. It only acts on orders that actually reached the broker
// and are still cancellable. A successful broker cancel is a REQUEST, so we
// immediately reconcile to record the true terminal state (cancelled, or filled
// if it raced the cancel).
// ---------------------------------------------------------------------------

export type CancelReason = 'not_found' | 'not_open' | 'broker_rejected' | 'requested';

export interface CancelResult {
  ok: boolean;
  /** True when the broker accepted the cancel request. */
  requested: boolean;
  reason: CancelReason;
  intent?: OrderIntentRecord;
  broker?: WebullCancelResult;
  /** The post-cancel reconcile (so the UI can show the resulting state immediately). */
  reconciled?: ReconcileResult;
  error?: string;
}

export async function cancelIntent(id: number, accountId: string): Promise<CancelResult> {
  const intent = getIntent(id);
  if (!intent) return { ok: false, requested: false, reason: 'not_found', error: `No order intent ${id}.` };
  if (isTerminal(intent.state)) {
    return { ok: true, requested: false, reason: 'not_open', intent, error: `order is already ${intent.state}` };
  }
  if (!intent.brokerOrderId || !canTransition(intent.state, 'cancelled')) {
    return {
      ok: true,
      requested: false,
      reason: 'not_open',
      intent,
      error: `order is not in a cancellable state (${intent.state})`,
    };
  }

  const broker = await webullCancelOrder(accountId, intent.idempotencyKey);
  if (!broker.ok) {
    return { ok: true, requested: false, reason: 'broker_rejected', intent, broker, error: broker.error };
  }

  // Cancel accepted — pull the true status (usually cancelled; filled if it raced).
  const reconciled = await reconcileIntent(id, accountId);
  return { ok: true, requested: true, reason: 'requested', intent: reconciled.intent ?? intent, broker, reconciled };
}
