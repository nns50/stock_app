import { randomUUID } from 'crypto';
import { webullClient, webullConfigured } from './account';
import type { OrderIntent } from '../../services/trading/guardrails';

// ---------------------------------------------------------------------------
// Webull order bodies + the PREVIEW call (cost estimate — places NOTHING).
//
// Confirmed from the Trading API Reference: orders POST to
//   /openapi/trade/order/preview  and  /openapi/trade/order/place
// with body { account_id, new_orders: [order] }. Stock order fields are from
// the docs (Getting Started example). Options use SEPARATE endpoints
// (Preview/Place Options) whose paths aren't in the scrape yet — handled in a
// follow-up; this module is STOCK only.
//
// Nothing here places an order: only buildWebullStockOrder (pure) and
// webullPreviewStockOrder (the estimate endpoint) live here. Place/cancel are a
// later, separately-reviewed slice.
// ---------------------------------------------------------------------------

export type WebullOrderBody = Record<string, string>;

/** A fresh broker idempotency key (client_order_id, ≤32 chars). */
export function newClientOrderId(): string {
  return randomUUID().replace(/-/g, ''); // 32 hex chars
}

/** Map our intent → a Webull EQUITY order body. Stock only; assumes BUY/SELL
 *  (naked short is blocked upstream by the guardrails). */
export function buildWebullStockOrder(intent: OrderIntent, clientOrderId: string): WebullOrderBody {
  const body: WebullOrderBody = {
    combo_type: 'NORMAL',
    client_order_id: clientOrderId,
    symbol: intent.symbol.toUpperCase(),
    instrument_type: 'EQUITY',
    market: 'US',
    order_type: intent.orderType === 'limit' ? 'LIMIT' : 'MARKET',
    side: intent.side === 'buy' ? 'BUY' : 'SELL',
    quantity: String(intent.quantity),
    entrust_type: 'QTY',
    time_in_force: 'DAY',
    support_trading_session: 'CORE',
  };
  if (intent.orderType === 'limit' && intent.limitPrice !== undefined) {
    body.limit_price = String(intent.limitPrice);
  }
  return body;
}

export interface WebullPreview {
  ok: boolean;
  /** Raw broker payload — always included so the real estimate fields can be read. */
  raw?: unknown;
  /** Best-effort parsed estimate (field names refined against the first live run). */
  estimate?: { costUsd?: number; commissionUsd?: number; buyingPowerAfterUsd?: number };
  error?: string;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * POST a stock order to /openapi/trade/order/preview for a COST ESTIMATE.
 * PLACES NOTHING — this is the estimate endpoint. Never throws.
 */
export async function webullPreviewStockOrder(accountId: string, intent: OrderIntent): Promise<WebullPreview> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const order = buildWebullStockOrder(intent, newClientOrderId());
  const r = await webullClient().call('POST', '/openapi/trade/order/preview', {
    body: { account_id: accountId, new_orders: [order] },
    surface: 'trade',
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull preview failed (${r.status})`,
    };
  }
  // Defensive parse; the raw payload is always returned so the real field names
  // can be confirmed and tightened after the first live preview.
  const d = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown>;
  return {
    ok: true,
    raw: r.data,
    estimate: {
      costUsd: num(d?.estimated_cost ?? d?.est_cost ?? d?.cost ?? d?.amount),
      commissionUsd: num(d?.estimated_commission ?? d?.commission ?? d?.fees),
      buyingPowerAfterUsd: num(d?.buying_power_after ?? d?.remaining_buying_power),
    },
  };
}

export interface WebullPlaceResult {
  ok: boolean;
  /** The broker's order id, once placed. */
  orderId?: string;
  raw?: unknown;
  error?: string;
}

function pickOrderId(data: unknown): string | undefined {
  const d = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const v = d?.order_id ?? d?.orderId ?? d?.id ?? d?.client_order_id;
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * PLACE a real stock order via /openapi/trade/order/place. THIS SUBMITS A LIVE
 * ORDER. The caller (placeStockOrder) must have already enforced the env gate,
 * the guardrails, the kill switch, and the confirmation — this only does the
 * signed POST. Uses the caller-provided clientOrderId for broker idempotency.
 */
export async function webullPlaceStockOrder(
  accountId: string,
  intent: OrderIntent,
  clientOrderId: string,
): Promise<WebullPlaceResult> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const order = buildWebullStockOrder(intent, clientOrderId);
  const r = await webullClient().call('POST', '/openapi/trade/order/place', {
    body: { account_id: accountId, new_orders: [order] },
    surface: 'trade',
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull place failed (${r.status})`,
    };
  }
  return { ok: true, orderId: pickOrderId(r.data), raw: r.data };
}
