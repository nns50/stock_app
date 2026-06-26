import { randomUUID } from 'crypto';
import { webullClient, webullConfigured } from './account';
import type { OrderIntent, OrderType } from '../../services/trading/guardrails';

// ---------------------------------------------------------------------------
// Webull order bodies + the signed preview / place / cancel / status calls.
//
// Confirmed from the Trading API Reference: orders POST to
//   /openapi/trade/order/{preview,place,cancel}  with body
//   { account_id, new_orders: [order] }. The same unified endpoint handles both
// EQUITY orders (flat fields) and single-leg OPTION orders (instrument_type
// OPTION + option_strategy SINGLE + a `legs` array) — the option body matches
// the official Options Trading API request example. `buildWebullOrder`
// dispatches on assetKind.
// ---------------------------------------------------------------------------

/** Flat EQUITY order body. */
export type WebullOrderBody = Record<string, string>;
/** Any order payload (equity flat, or option with a nested `legs` array). */
export type WebullOrderPayload = Record<string, unknown>;

/** Our session → Webull's `support_trading_session` (confirmed: CORE|ALL|NIGHT). */
const SESSION_TO_WEBULL = { core: 'CORE', extended: 'ALL', overnight: 'NIGHT' } as const;

/** Our order type → Webull's `order_type`. */
const ORDER_TYPE_TO_WEBULL: Record<OrderType, string> = {
  market: 'MARKET',
  limit: 'LIMIT',
  stop_loss: 'STOP_LOSS',
  stop_loss_limit: 'STOP_LOSS_LIMIT',
};

/** The price fields a Webull body carries for this order type: limit_price for
 *  limit + stop-limit, stop_price for either stop type. */
function priceFields(intent: OrderIntent): Record<string, string> {
  const f: Record<string, string> = {};
  if ((intent.orderType === 'limit' || intent.orderType === 'stop_loss_limit') && intent.limitPrice !== undefined) {
    f.limit_price = String(intent.limitPrice);
  }
  if ((intent.orderType === 'stop_loss' || intent.orderType === 'stop_loss_limit') && intent.stopPrice !== undefined) {
    f.stop_price = String(intent.stopPrice);
  }
  return f;
}

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
    order_type: ORDER_TYPE_TO_WEBULL[intent.orderType],
    side: intent.side === 'buy' ? 'BUY' : 'SELL',
    quantity: String(intent.quantity),
    entrust_type: 'QTY',
    time_in_force: 'DAY',
    support_trading_session: SESSION_TO_WEBULL[intent.session ?? 'core'],
  };
  Object.assign(body, priceFields(intent));
  return body;
}

/**
 * Map our intent → a Webull single-leg OPTION order body, matching the official
 * "Buy Call (Limit)" request example in the Options Trading API docs. Options
 * support LIMIT / STOP_LOSS / STOP_LOSS_LIMIT (no MARKET — enforced upstream by
 * the guardrails). Key points the docs make explicit (and that live previews
 * confirmed): `side`, `market` and `symbol` are carried at the ORDER level, AND
 * the leg repeats `side`, `symbol`, `market` and `instrument_type:'OPTION'`. No
 * `position_intent` — the broker derives it.
 */
export function buildWebullOptionOrder(intent: OrderIntent, clientOrderId: string): WebullOrderPayload {
  const symbol = intent.symbol.toUpperCase();
  const side = intent.side === 'buy' ? 'BUY' : 'SELL';

  // Multi-leg VERTICAL spread: same envelope as a single leg (confirmed against
  // the COVERED_STOCK example) but option_strategy VERTICAL + N legs and a NET
  // limit. Order-level side = the net direction (debit BUY / credit SELL).
  if (intent.optionStrategy === 'VERTICAL' && intent.optionLegs && intent.optionLegs.length >= 2) {
    // Every leg of a 1:1 vertical carries the spread count (intent.quantity), so
    // the order-level and leg quantities always agree (a mismatch is rejected).
    const legs = intent.optionLegs.map((l) => ({
      side: l.side === 'buy' ? 'BUY' : 'SELL',
      quantity: String(intent.quantity),
      symbol,
      strike_price: String(l.strike),
      option_expire_date: l.expiration,
      instrument_type: 'OPTION',
      option_type: l.optionType.toUpperCase(),
      market: 'US',
    }));
    const body: WebullOrderPayload = {
      client_order_id: clientOrderId,
      combo_type: 'NORMAL',
      order_type: 'LIMIT',
      quantity: String(intent.quantity),
      option_strategy: 'VERTICAL',
      side,
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      instrument_type: 'OPTION',
      market: 'US',
      symbol,
      legs,
    };
    if (intent.limitPrice !== undefined) body.limit_price = String(intent.limitPrice); // NET debit/credit
    return body;
  }

  const leg: Record<string, string> = {
    side,
    quantity: String(intent.quantity),
    symbol,
    strike_price: intent.strike !== undefined ? String(intent.strike) : '',
    option_expire_date: intent.expiration ?? '',
    instrument_type: 'OPTION',
    option_type: (intent.optionType ?? 'call').toUpperCase(),
    market: 'US',
  };
  const body: WebullOrderPayload = {
    client_order_id: clientOrderId,
    combo_type: 'NORMAL',
    order_type: ORDER_TYPE_TO_WEBULL[intent.orderType],
    quantity: String(intent.quantity),
    option_strategy: 'SINGLE',
    side,
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    instrument_type: 'OPTION',
    market: 'US',
    symbol,
    legs: [leg],
  };
  Object.assign(body, priceFields(intent));
  return body;
}

/** Dispatch to the right body builder for this intent's asset kind. */
export function buildWebullOrder(intent: OrderIntent, clientOrderId: string): WebullOrderPayload {
  return intent.assetKind === 'option'
    ? buildWebullOptionOrder(intent, clientOrderId)
    : buildWebullStockOrder(intent, clientOrderId);
}

/** One bracket exit leg (opposite side of the entry): a take-profit LIMIT or a
 *  stop-loss STOP_LOSS, sharing the entry's symbol / qty / session. */
function bracketExit(
  intent: OrderIntent,
  comboType: 'STOP_PROFIT' | 'STOP_LOSS',
  orderType: 'LIMIT' | 'STOP_LOSS',
  price: number,
  clientOrderId: string,
): WebullOrderBody {
  const body: WebullOrderBody = {
    combo_type: comboType,
    client_order_id: clientOrderId,
    symbol: intent.symbol.toUpperCase(),
    instrument_type: 'EQUITY',
    market: 'US',
    order_type: orderType,
    side: intent.side === 'buy' ? 'SELL' : 'BUY', // exits close the entry
    quantity: String(intent.quantity),
    entrust_type: 'QTY',
    time_in_force: 'DAY',
    support_trading_session: SESSION_TO_WEBULL[intent.session ?? 'core'],
  };
  if (orderType === 'LIMIT') body.limit_price = String(price);
  else body.stop_price = String(price);
  return body;
}

/** The full `/order/{preview,place}` request payload (sans account_id). For a
 *  plain order it's one entry; for a stock bracket it's a MASTER entry plus
 *  STOP_PROFIT / STOP_LOSS legs linked by a `client_combo_order_id`. */
export interface WebullOrderRequest {
  new_orders: WebullOrderPayload[];
  client_combo_order_id?: string;
}

export function buildOrderRequest(intent: OrderIntent, clientOrderId: string): WebullOrderRequest {
  const b = intent.bracket;
  const braced = b && (b.takeProfitPrice !== undefined || b.stopLossPrice !== undefined);
  if (intent.assetKind === 'stock' && braced) {
    const master = buildWebullStockOrder(intent, clientOrderId);
    master.combo_type = 'MASTER';
    const new_orders: WebullOrderPayload[] = [master];
    if (b!.takeProfitPrice !== undefined) {
      new_orders.push(bracketExit(intent, 'STOP_PROFIT', 'LIMIT', b!.takeProfitPrice, newClientOrderId()));
    }
    if (b!.stopLossPrice !== undefined) {
      new_orders.push(bracketExit(intent, 'STOP_LOSS', 'STOP_LOSS', b!.stopLossPrice, newClientOrderId()));
    }
    return { new_orders, client_combo_order_id: newClientOrderId() };
  }
  return { new_orders: [buildWebullOrder(intent, clientOrderId)] };
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
 * POST an order (stock or single-leg option) to /openapi/trade/order/preview for
 * a COST ESTIMATE. PLACES NOTHING — this is the estimate endpoint. Never throws.
 */
export async function webullPreviewOrder(accountId: string, intent: OrderIntent): Promise<WebullPreview> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const r = await webullClient().call('POST', '/openapi/trade/order/preview', {
    body: { account_id: accountId, ...buildOrderRequest(intent, newClientOrderId()) },
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
  // Confirmed from a real place/history response: the broker order id is
  // `combo_order_id` (mirrored as the order's `order_id`); client_order_id is
  // our own key, used only as a last resort.
  const v = d?.order_id ?? d?.combo_order_id ?? d?.orderId ?? d?.id ?? d?.client_order_id;
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * PLACE a real order (stock or single-leg option) via /openapi/trade/order/place.
 * THIS SUBMITS A LIVE ORDER. The caller (placeOrder) must have already enforced
 * the env gate, the guardrails, the kill switch, and the confirmation — this only
 * does the signed POST. Uses the caller-provided clientOrderId for idempotency.
 */
export async function webullPlaceOrder(
  accountId: string,
  intent: OrderIntent,
  clientOrderId: string,
): Promise<WebullPlaceResult> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const r = await webullClient().call('POST', '/openapi/trade/order/place', {
    body: { account_id: accountId, ...buildOrderRequest(intent, clientOrderId) },
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

export interface WebullOrderStatus {
  ok: boolean;
  /** Whether an order matching our client_order_id was found at the broker. */
  found: boolean;
  /** Raw Webull status (uppercased), e.g. FILLED / CANCELLED / PARTIAL_FILLED. */
  status?: string;
  /** Broker order id (envelope `combo_order_id`, mirrored as the order's `order_id`). */
  brokerOrderId?: string;
  filledQty?: number;
  totalQty?: number;
  filledPrice?: number;
  /** The matched order envelope — kept so new fields can be read without a code change. */
  raw?: unknown;
  error?: string;
}

/** Order-list envelope shape (confirmed against a real /order/{open,history}). */
interface OrderEnvelope {
  client_order_id?: string;
  combo_order_id?: string;
  orders?: Array<Record<string, unknown>>;
}

function matchEnvelope(list: unknown, clientOrderId: string): OrderEnvelope | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as OrderEnvelope[]).find(
    (env) =>
      env?.client_order_id === clientOrderId ||
      (Array.isArray(env?.orders) &&
        env.orders.some((o) => (o as { client_order_id?: string })?.client_order_id === clientOrderId)),
  );
}

/**
 * Look up the live status of one of OUR orders by its client_order_id, scanning
 * open orders then history (which covers filled/cancelled). READ-ONLY — places
 * nothing, cancels nothing. Never throws.
 */
export async function webullOrderStatus(accountId: string, clientOrderId: string): Promise<WebullOrderStatus> {
  if (!webullConfigured()) return { ok: false, found: false, error: 'Webull is not configured.' };
  for (const path of ['/openapi/trade/order/open', '/openapi/trade/order/history']) {
    const r = await webullClient().call('GET', path, { query: { account_id: accountId }, surface: 'trade' });
    if (!r.ok) {
      const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
      return {
        ok: false,
        found: false,
        error: j.msg || j.message || j.error_msg || `Webull ${path} failed (${r.status})`,
      };
    }
    const env = matchEnvelope(r.data, clientOrderId);
    if (env) {
      const o = (Array.isArray(env.orders) ? (env.orders[0] ?? {}) : {}) as Record<string, unknown>;
      const brokerOrderId = env.combo_order_id ?? (o.order_id as string | undefined);
      return {
        ok: true,
        found: true,
        status: o.status ? String(o.status).toUpperCase() : undefined,
        brokerOrderId: brokerOrderId ? String(brokerOrderId) : undefined,
        filledQty: num(o.filled_quantity),
        totalQty: num(o.total_quantity),
        filledPrice: num(o.filled_price),
        raw: env,
      };
    }
  }
  return { ok: true, found: false };
}

export interface WebullCancelResult {
  ok: boolean;
  raw?: unknown;
  error?: string;
}

/**
 * Request cancellation of one of OUR orders via /openapi/trade/order/cancel,
 * keyed by its client_order_id (the broker idempotency key). A successful POST
 * is an ACCEPTED cancel REQUEST — the caller should reconcile to learn the true
 * terminal state (cancelled, or filled if it raced). Never throws.
 */
export async function webullCancelOrder(accountId: string, clientOrderId: string): Promise<WebullCancelResult> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const r = await webullClient().call('POST', '/openapi/trade/order/cancel', {
    body: { account_id: accountId, client_order_id: clientOrderId },
    surface: 'trade',
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return { ok: false, raw: r.data, error: j.msg || j.message || j.error_msg || `Webull cancel failed (${r.status})` };
  }
  return { ok: true, raw: r.data };
}

/** The fields a replace can change on a still-open order. */
export interface ReplacePatch {
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
}

export interface WebullReplaceResult {
  ok: boolean;
  raw?: unknown;
  error?: string;
}

/**
 * Modify one of OUR still-open orders via /openapi/trade/order/replace. Keyed by
 * client_order_id; carries only the changed quantity / limit_price / stop_price
 * (per the docs' `modify_orders` example). Never throws.
 */
export async function webullReplaceOrder(
  accountId: string,
  clientOrderId: string,
  patch: ReplacePatch,
): Promise<WebullReplaceResult> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const modify: Record<string, string> = { client_order_id: clientOrderId };
  if (patch.quantity !== undefined) modify.quantity = String(patch.quantity);
  if (patch.limitPrice !== undefined) modify.limit_price = String(patch.limitPrice);
  if (patch.stopPrice !== undefined) modify.stop_price = String(patch.stopPrice);
  const r = await webullClient().call('POST', '/openapi/trade/order/replace', {
    body: { account_id: accountId, modify_orders: [modify] },
    surface: 'trade',
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull replace failed (${r.status})`,
    };
  }
  return { ok: true, raw: r.data };
}
