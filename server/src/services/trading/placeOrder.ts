import { config } from '../../config';
import {
  AccountState,
  GuardrailReport,
  OrderIntent,
  blockingFailures,
  evaluateGuardrails,
  wouldOpenShort,
} from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { OrderIntentRecord, countTodaysOrders, createIntent, transitionIntent } from '../../db/orders';
import { webullAccountState, webullAccountType } from '../../providers/webull/accountState';
import { marketOpenContext } from './marketHours';
import { WebullPlaceResult, newClientOrderId, webullPlaceOrder } from '../../providers/webull/orders';
import { resolveStockPrices } from '../quotes';

// ---------------------------------------------------------------------------
// Place a single live order (stock or single-leg option) — the ONLY path that
// can move real money (design §6, Phase 3). Server-authoritative: it re-pulls
// account state and re-runs the guardrails HERE, never trusting the client.
//
// An order fires ONLY when ALL of these hold:
//   1) TRADING_ENABLED is set on the server (deploy-level master gate),
//   2) the type-to-confirm phrase matches the order,
//   3) every guardrail passes against FRESH account state — which includes
//      config.enabled, the kill switch being off, the caps, and buying power.
//
// Every attempt (blocked, broker-rejected, or placed) is written to the audit
// trail via the order lifecycle.
// ---------------------------------------------------------------------------

export type PlaceReason =
  | 'trading_disabled'
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

/** Re-derive the fat-finger reference SERVER-side for a STOCK LIMIT order,
 *  overriding whatever the client sent — a client can otherwise omit
 *  `referencePrice` (downgrading fat_finger to a warning) or set it equal to an
 *  absurd limit (making the deviation 0). Uses a fresh quote (cache-resilient
 *  via resolveStockPrices); a market-data miss falls back to the client value
 *  (no worse than before). `referencePrice` is guardrail-only — never sent to
 *  the broker — so overriding it is safe. Options keep the client's mark for now
 *  (a per-contract chain fetch on the place path is heavier; the confirmed
 *  weakening was on the stock path). */
async function withServerReference(intent: OrderIntent): Promise<OrderIntent> {
  if (intent.orderType !== 'limit' || intent.assetKind !== 'stock') return intent;
  let ref: number | undefined;
  try {
    const px = (await resolveStockPrices([intent.symbol])).get(intent.symbol.toUpperCase())?.price;
    if (typeof px === 'number' && Number.isFinite(px) && px > 0) ref = px;
  } catch {
    // market-data miss — fall back to the client value below
  }
  return ref !== undefined ? { ...intent, referencePrice: ref } : intent;
}

export async function placeOrder(intent: OrderIntent, accountId: string, confirmation: string): Promise<PlaceResult> {
  // 1) Deploy-level master gate — dead unless TRADING_ENABLED is set on the box.
  if (!config.trading.placeEnabled) {
    return {
      ok: true,
      placed: false,
      reason: 'trading_disabled',
      error: 'Order placement is disabled on the server (TRADING_ENABLED is not set).',
    };
  }
  // 2) Type-to-confirm, re-checked server-side so a blind/automated POST can't place.
  if (confirmation.trim().toUpperCase() !== placeConfirmation(intent)) {
    return { ok: true, placed: false, reason: 'not_confirmed', error: 'Confirmation phrase did not match the order.' };
  }

  // Fresh, authoritative account state (never client-supplied), with today's real
  // order count folded in for the max-orders/day rule. Pass the order's own
  // instrument so the naked_short / position_size checks see the quantity of
  // THAT instrument (this exact option contract, or stock), not a cross-asset
  // per-underlying sum — long stock must not silently cover a short option.
  const acct = await webullAccountState(accountId, intent.symbol, {
    assetKind: intent.assetKind,
    strike: intent.strike,
    expiration: intent.expiration,
    optionType: intent.optionType,
  });
  if (!acct.ok || !acct.state) {
    return { ok: true, placed: false, reason: 'account_error', error: acct.error ?? 'Could not load account state.' };
  }
  // Fail CLOSED if the broker's positions couldn't be read: a fabricated 0
  // would under-count a real holding and let the position_size cap be breached.
  if (acct.positionsUnavailable) {
    return {
      ok: true,
      placed: false,
      reason: 'account_error',
      error:
        'Could not verify current positions with the broker — order blocked rather than sized against an unknown position.',
    };
  }
  const accountType =
    intent.optionStrategy === 'VERTICAL' || intent.optionStrategy === 'IRON_CONDOR'
      ? await webullAccountType(accountId)
      : undefined;
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(), accountType };

  // Re-derive the fat-finger reference from fresh market data (never the
  // client's) so the guardrail can't be omitted or spoofed away.
  const priced = await withServerReference(intent);

  // 3) Re-run the guardrails server-side.
  const cfg = getTradingConfig();
  const guardrails = evaluateGuardrails(priced, accountState, cfg, { marketOpen: marketOpenContext(priced) });
  // Only matters for a permitted short (allowNakedShort — naked_short above
  // already blocks it otherwise): submit Webull's own SHORT side instead of a
  // plain SELL so the broker's real-time locate/borrow check runs at order time.
  const isShort = wouldOpenShort(priced, accountState);

  const clientOrderId = newClientOrderId();
  const intentRec = createIntent(priced, clientOrderId); // draft (audited)

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

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId, isShort);

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
