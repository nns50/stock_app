import { config } from '../../config';
import { GuardrailReport, OrderIntent, blockingFailures, evaluateGuardrails } from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { OrderIntentRecord, countTodaysOrders, getIntent, isComboOrder, recordReplace } from '../../db/orders';
import { canTransition, isTerminal } from './orderLifecycle';
import { webullAccountState } from '../../providers/webull/accountState';
import { marketOpenContext } from './marketHours';
import { ReplacePatch, WebullReplaceResult, webullReplaceOrder } from '../../providers/webull/orders';
import { ReconcileResult, reconcileIntent } from './reconcile';

// ---------------------------------------------------------------------------
// Replace (modify) a still-open order's quantity / limit / stop price. A replace
// can INCREASE exposure, so it is gated exactly like placing: TRADING_ENABLED +
// the guardrails re-run against the MODIFIED order (caps, buying power, kill
// switch, enabled). On broker accept we record the new values + an audit event,
// then reconcile. Keyed by client_order_id (the docs' `modify_orders` shape).
// ---------------------------------------------------------------------------

export type ReplaceReason =
  | 'trading_disabled'
  | 'not_found'
  | 'not_open'
  | 'not_modifiable'
  | 'no_change'
  | 'account_error'
  | 'blocked'
  | 'broker_rejected'
  /** The broker never answered. The modify may or may not have applied — see
   *  the ambiguous branch in replaceIntent() below. NOT a rejection. */
  | 'outcome_unknown'
  | 'replaced';

export interface ReplaceResult {
  ok: boolean;
  replaced: boolean;
  reason: ReplaceReason;
  guardrails?: GuardrailReport;
  intent?: OrderIntentRecord;
  broker?: WebullReplaceResult;
  reconciled?: ReconcileResult;
  error?: string;
}

/** Rebuild an OrderIntent from the stored record + requested changes so the
 *  guardrails can re-evaluate the MODIFIED order. `referencePrice` is set to the
 *  effective price (the record doesn't persist a separate reference). */
function modifiedIntent(rec: OrderIntentRecord, patch: ReplacePatch): OrderIntent {
  const limitPrice = patch.limitPrice ?? rec.limitPrice ?? undefined;
  const effectivePrice = patch.limitPrice ?? patch.stopPrice ?? rec.limitPrice ?? undefined;
  return {
    symbol: rec.symbol,
    assetKind: rec.assetKind,
    side: rec.side,
    openClose: rec.openClose,
    quantity: patch.quantity ?? rec.quantity,
    orderType: rec.orderType,
    limitPrice,
    stopPrice: patch.stopPrice,
    referencePrice: effectivePrice,
    optionType: rec.optionType ?? undefined,
    strike: rec.strike ?? undefined,
    expiration: rec.expiration ?? undefined,
    multiplier: rec.assetKind === 'option' ? 100 : undefined,
  };
}

export async function replaceIntent(id: number, accountId: string, patch: ReplacePatch): Promise<ReplaceResult> {
  if (!config.trading.placeEnabled) {
    return {
      ok: true,
      replaced: false,
      reason: 'trading_disabled',
      error: 'Order placement is disabled on the server (TRADING_ENABLED is not set).',
    };
  }
  const rec = getIntent(id);
  if (!rec) return { ok: false, replaced: false, reason: 'not_found', error: `No order intent ${id}.` };
  // Only an order still live at the broker can be modified.
  if (isTerminal(rec.state) || !rec.brokerOrderId || !canTransition(rec.state, 'cancelled')) {
    return {
      ok: true,
      replaced: false,
      reason: 'not_open',
      intent: rec,
      error: `order is not modifiable (${rec.state})`,
    };
  }
  // A multi-leg spread / bracket is a combo of broker orders keyed by a combo id;
  // the single-key `modify_orders` shape would change one leg and leave the rest
  // stale. Refuse it (no broker call) and tell the user to cancel + re-place.
  if (isComboOrder(rec)) {
    return {
      ok: true,
      replaced: false,
      reason: 'not_modifiable',
      intent: rec,
      error: rec.isBracket
        ? 'A bracketed order has linked exit legs — cancel and re-place to change it.'
        : 'A multi-leg spread is a single combo order — cancel and re-place to change it.',
    };
  }
  if (patch.quantity === undefined && patch.limitPrice === undefined && patch.stopPrice === undefined) {
    return { ok: true, replaced: false, reason: 'no_change', intent: rec, error: 'no changes requested' };
  }

  // Pass the order's instrument so the naked_short / position_size checks count
  // THAT instrument (this exact option contract, or stock), not a cross-asset
  // per-underlying sum. A replace only changes qty/price, never the instrument.
  const acct = await webullAccountState(accountId, rec.symbol, {
    assetKind: rec.assetKind,
    strike: rec.strike ?? undefined,
    expiration: rec.expiration ?? undefined,
    optionType: rec.optionType ?? undefined,
  });
  if (!acct.ok || !acct.state) {
    return {
      ok: true,
      replaced: false,
      reason: 'account_error',
      intent: rec,
      error: acct.error ?? 'Could not load account state.',
    };
  }
  // Fail CLOSED if positions couldn't be read (see placeOrder.ts) — a
  // fabricated 0 would under-count a real holding for position_size.
  if (acct.positionsUnavailable) {
    return {
      ok: true,
      replaced: false,
      reason: 'account_error',
      intent: rec,
      error:
        'Could not verify current positions with the broker — modify blocked rather than sized against an unknown position.',
    };
  }
  const modified = modifiedIntent(rec, patch);
  const guardrails = evaluateGuardrails(
    modified,
    { ...acct.state, ordersToday: countTodaysOrders() },
    getTradingConfig(),
    { marketOpen: marketOpenContext(modified) },
  );
  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    return { ok: true, replaced: false, reason: 'blocked', guardrails, intent: rec, error: `blocked: ${reasons}` };
  }

  const broker = await webullReplaceOrder(accountId, rec.idempotencyKey, patch);

  // We never heard back, so we do not know whether the modify applied. Both
  // available guesses are wrong in a way that costs real money:
  //
  //   record it   — if it did NOT apply, our stored quantity now exceeds the
  //                 order's, and computeFillDelta would book MORE than was
  //                 ordered: invented shares, the one thing fillDelta.ts exists
  //                 to prevent.
  //   reject it   — if it DID apply, our stored quantity is short of the
  //                 order's, and computeFillDelta clamps every future booking
  //                 to that stale ceiling. A replace that raised 100 → 200 then
  //                 fills 200; we book 100 with a warning, and the other 100
  //                 shares are unbookable by ANY path — real exposure that no
  //                 ledger, risk cap or P&L figure can ever see. This was the
  //                 old behavior, since every !ok became 'broker_rejected'.
  //
  // So guess neither: don't touch the record, and reconcile — the broker's own
  // total_quantity settles it authoritatively (see reconcileIntent's drift
  // check), which is strictly better than either inference.
  if (!broker.ok && broker.ambiguous) {
    const reconciled = await reconcileIntent(id, accountId);
    return {
      ok: true,
      replaced: false,
      reason: 'outcome_unknown',
      guardrails,
      intent: reconciled.intent ?? rec,
      broker,
      reconciled,
      error:
        `The broker did not respond, so it is unknown whether this change was applied (${broker.error}). ` +
        `The order was left as-is and re-checked against the broker — confirm its current quantity and ` +
        `price before changing it again.`,
    };
  }
  if (!broker.ok) {
    return {
      ok: true,
      replaced: false,
      reason: 'broker_rejected',
      guardrails,
      intent: rec,
      broker,
      error: broker.error,
    };
  }

  const detail =
    'replaced: ' +
    [
      patch.quantity !== undefined ? `qty ${patch.quantity}` : '',
      patch.limitPrice !== undefined ? `limit ${patch.limitPrice}` : '',
      patch.stopPrice !== undefined ? `stop ${patch.stopPrice}` : '',
    ]
      .filter(Boolean)
      .join(', ');
  const updated = recordReplace(id, { quantity: patch.quantity, limitPrice: patch.limitPrice }, detail);
  const reconciled = await reconcileIntent(id, accountId);
  return {
    ok: true,
    replaced: true,
    reason: 'replaced',
    guardrails,
    intent: reconciled.intent ?? updated,
    broker,
    reconciled,
  };
}
