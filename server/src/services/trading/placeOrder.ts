import { config } from '../../config';
import { AccountState, GuardrailReport, OrderIntent, blockingFailures, evaluateGuardrails } from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { OrderIntentRecord, countTodaysOrders, createIntent, transitionIntent } from '../../db/orders';
import { webullAccountState } from '../../providers/webull/accountState';
import { WebullPlaceResult, newClientOrderId, webullPlaceStockOrder } from '../../providers/webull/orders';

// ---------------------------------------------------------------------------
// Place a single live STOCK order — the ONLY path that can move real money
// (design §6, Phase 3). Server-authoritative: it re-pulls account state and
// re-runs the guardrails HERE and never trusts anything the client computed.
//
// An order fires ONLY when ALL of these hold:
//   1) TRADING_ENABLED is set on the server (deploy-level master gate),
//   2) the type-to-confirm phrase matches the order,
//   3) every guardrail passes against FRESH account state — which includes
//      config.enabled, the kill switch being off, the caps, and buying power.
//
// Every attempt (blocked, broker-rejected, or placed) is written to the audit
// trail via the order lifecycle. Stock only; options are a later slice.
// ---------------------------------------------------------------------------

export type PlaceReason =
  | 'trading_disabled'
  | 'unsupported'
  | 'not_confirmed'
  | 'account_error'
  | 'blocked'
  | 'broker_rejected'
  | 'placed';

export interface PlaceResult {
  /** The request was processed (not whether an order was placed). */
  ok: boolean;
  /** True only when a live order was submitted AND the broker accepted it. */
  placed: boolean;
  reason: PlaceReason;
  guardrails?: GuardrailReport;
  accountState?: AccountState;
  intent?: OrderIntentRecord;
  broker?: WebullPlaceResult;
  error?: string;
}

/** The exact phrase the client must echo to arm a place (type-to-confirm). */
export function placeConfirmation(intent: OrderIntent): string {
  return `${intent.side.toUpperCase()} ${intent.quantity} ${intent.symbol.toUpperCase()}`;
}

export async function placeStockOrder(
  intent: OrderIntent,
  accountId: string,
  confirmation: string,
): Promise<PlaceResult> {
  // 1) Deploy-level master gate — dead unless TRADING_ENABLED is set on the box.
  if (!config.trading.placeEnabled) {
    return {
      ok: true,
      placed: false,
      reason: 'trading_disabled',
      error: 'Order placement is disabled on the server (TRADING_ENABLED is not set).',
    };
  }
  if (intent.assetKind !== 'stock') {
    return { ok: true, placed: false, reason: 'unsupported', error: 'Live placement currently supports stocks only.' };
  }
  // 2) Type-to-confirm, re-checked server-side so a blind/automated POST can't place.
  if (confirmation.trim().toUpperCase() !== placeConfirmation(intent)) {
    return { ok: true, placed: false, reason: 'not_confirmed', error: 'Confirmation phrase did not match the order.' };
  }

  // Fresh, authoritative account state (never client-supplied), with today's real
  // order count folded in for the max-orders/day rule.
  const acct = await webullAccountState(accountId, intent.symbol);
  if (!acct.ok || !acct.state) {
    return { ok: true, placed: false, reason: 'account_error', error: acct.error ?? 'Could not load account state.' };
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };

  // 3) Re-run the guardrails server-side.
  const cfg = getTradingConfig();
  const guardrails = evaluateGuardrails(intent, accountState, cfg);

  const clientOrderId = newClientOrderId();
  const intentRec = createIntent(intent, clientOrderId); // draft (audited)

  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    const rejected = transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
    return { ok: true, placed: false, reason: 'blocked', guardrails, accountState, intent: rejected };
  }

  // Walk the lifecycle, then submit.
  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live)' });
  transitionIntent(intentRec.id, 'confirmed', { detail: `confirmed: ${confirmation.trim()}` });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });

  const broker = await webullPlaceStockOrder(accountId, intent, clientOrderId);

  if (broker.ok) {
    const acked = transitionIntent(intentRec.id, 'acknowledged', {
      brokerOrderId: broker.orderId,
      detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
    });
    return { ok: true, placed: true, reason: 'placed', guardrails, accountState, intent: acked, broker };
  }

  const rej = transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
  return { ok: true, placed: false, reason: 'broker_rejected', guardrails, accountState, intent: rej, broker };
}
