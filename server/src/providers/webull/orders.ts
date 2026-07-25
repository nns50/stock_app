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

/** Rounds to the nearest cent before stringifying -- the last checkpoint
 *  before a price reaches the broker. Webull rejects the WHOLE order
 *  (bracket legs included) if any price isn't an exact $0.01 increment;
 *  an upstream caller doing its own arithmetic (an ATR-based stop/target,
 *  a computed net debit/credit) can easily produce a sub-penny float that
 *  looks fine right up until Webull's own tick-size validation rejects it.
 *  Confirmed in production: an unrounded ATR-derived stop/target blocked
 *  EVERY live bracket order with "Price increment should be 0.01..." until
 *  fixed at the source (decide.ts) -- this is the defensive backstop so no
 *  other caller, present or future, can reintroduce the same failure mode
 *  here at the one place every live order price actually gets sent. */
function priceStr(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The price fields a Webull body carries for this order type: limit_price for
 *  limit + stop-limit, stop_price for either stop type. */
function priceFields(intent: OrderIntent): Record<string, string> {
  const f: Record<string, string> = {};
  if ((intent.orderType === 'limit' || intent.orderType === 'stop_loss_limit') && intent.limitPrice !== undefined) {
    f.limit_price = priceStr(intent.limitPrice);
  }
  if ((intent.orderType === 'stop_loss' || intent.orderType === 'stop_loss_limit') && intent.stopPrice !== undefined) {
    f.stop_price = priceStr(intent.stopPrice);
  }
  return f;
}

/** A fresh broker idempotency key (client_order_id, ≤32 chars). */
export function newClientOrderId(): string {
  return randomUUID().replace(/-/g, ''); // 32 hex chars
}

/** Map our intent → a Webull EQUITY order body. Stock only. A sell that only
 *  closes/reduces a long uses SELL; a sell that would open/extend a net-short
 *  position (per guardrails.ts's wouldOpenShort()) uses Webull's own distinct
 *  SHORT side instead, so the broker's real-time locate/borrow check applies —
 *  naked shorts are still blocked upstream by the guardrails when disallowed,
 *  this only affects which side value a PERMITTED short is submitted as. */
export function buildWebullStockOrder(intent: OrderIntent, clientOrderId: string, isShort = false): WebullOrderBody {
  const body: WebullOrderBody = {
    combo_type: 'NORMAL',
    client_order_id: clientOrderId,
    symbol: intent.symbol.toUpperCase(),
    instrument_type: 'EQUITY',
    market: 'US',
    order_type: ORDER_TYPE_TO_WEBULL[intent.orderType],
    side: intent.side === 'buy' ? 'BUY' : isShort ? 'SHORT' : 'SELL',
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
    if (intent.limitPrice !== undefined) body.limit_price = priceStr(intent.limitPrice); // NET debit/credit
    return body;
  }

  // Covered call / buy-write: long stock + short call as a COVERED_STOCK combo.
  // Same envelope as the vertical (itself confirmed against the COVERED_STOCK
  // example): order-level side = net direction (BUY = debit), limit_price = net
  // debit, plus an EQUITY leg (100 shares/contract) and the option leg. INFERRED —
  // confirm via a live preview before placing, exactly as the vertical was.
  if (intent.optionStrategy === 'COVERED' && intent.optionLegs && intent.optionLegs.length >= 1) {
    const call = intent.optionLegs[0];
    const legs = [
      { side: 'BUY', quantity: String(intent.quantity * 100), symbol, instrument_type: 'EQUITY', market: 'US' },
      {
        side: call.side === 'buy' ? 'BUY' : 'SELL',
        quantity: String(intent.quantity),
        symbol,
        strike_price: String(call.strike),
        option_expire_date: call.expiration,
        instrument_type: 'OPTION',
        option_type: call.optionType.toUpperCase(),
        market: 'US',
      },
    ];
    const body: WebullOrderPayload = {
      client_order_id: clientOrderId,
      combo_type: 'NORMAL',
      order_type: 'LIMIT',
      quantity: String(intent.quantity),
      option_strategy: 'COVERED_STOCK',
      side,
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      instrument_type: 'OPTION',
      market: 'US',
      symbol,
      legs,
    };
    if (intent.limitPrice !== undefined) body.limit_price = priceStr(intent.limitPrice); // NET debit
    return body;
  }

  // Iron condor: 4 option legs (a call spread + a put spread) as one IRON_CONDOR
  // order — same envelope as the (broker-confirmed) vertical, order-level net
  // side/limit. Net credit ⇒ Side = Sell. INFERRED — confirm via a live preview.
  if (intent.optionStrategy === 'IRON_CONDOR' && intent.optionLegs && intent.optionLegs.length >= 4) {
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
      option_strategy: 'IRON_CONDOR',
      side,
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      instrument_type: 'OPTION',
      market: 'US',
      symbol,
      legs,
    };
    if (intent.limitPrice !== undefined) body.limit_price = priceStr(intent.limitPrice); // NET credit/debit
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

/** Dispatch to the right body builder for this intent's asset kind. `isShort`
 *  only matters for stocks — Webull has no equivalent distinct SHORT side for
 *  options (a bearish options position sells to open a call/put instead). */
export function buildWebullOrder(intent: OrderIntent, clientOrderId: string, isShort = false): WebullOrderPayload {
  return intent.assetKind === 'option'
    ? buildWebullOptionOrder(intent, clientOrderId)
    : buildWebullStockOrder(intent, clientOrderId, isShort);
}

/** One bracket exit leg (opposite side of the entry): a take-profit LIMIT or a
 *  stop-loss STOP_LOSS, sharing the entry's symbol / qty / session.
 *
 *  GTC, not DAY — unlike the entry leg (still DAY; a stale unfilled entry
 *  shouldn't keep trying at yesterday's price), an exit leg is protecting an
 *  ALREADY-open position. A DAY exit that doesn't fill by the close gets
 *  cancelled by the broker at end of day, and nothing in this app currently
 *  detects that or re-arms a fresh bracket — the position would then sit
 *  fully unprotected (no resting stop) until it happens to hit maxHoldDays
 *  (if that's even enabled; it defaults to off) or a human notices. Confirmed
 *  against Webull's own API docs that stock equity orders support GTC on the
 *  SELL side (unlike single-leg OPTION orders — optionBracketExit() below
 *  stays DAY, since Webull restricts option sell-side orders to DAY-only;
 *  GTC there isn't just untested, it's documented as unsupported). Webull
 *  itself auto-expires a GTC order after 90 calendar days — not infinite —
 *  so this doesn't replace maxHoldDays as a backstop, it just closes the
 *  same-trading-day gap that previously left a position unprotected almost
 *  immediately instead of after 90 days. */
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
    time_in_force: 'GTC',
    support_trading_session: SESSION_TO_WEBULL[intent.session ?? 'core'],
  };
  if (orderType === 'LIMIT') body.limit_price = priceStr(price);
  else body.stop_price = priceStr(price);
  return body;
}

/** One OPTION bracket exit leg (opposite side, to close the entry): a take-profit
 *  LIMIT or a stop-loss STOP_LOSS on the same contract. INFERRED from the stock
 *  bracket + single-leg option bodies — confirm via Preview before placing.
 *
 *  Stays DAY (unlike bracketExit()'s stock exit legs, now GTC) — Webull
 *  restricts OPTION sell-side orders to DAY-only, and an exit leg closing a
 *  long option position IS a sell-side order. This is a real, currently-
 *  unaddressed gap: a live options bracket's exit legs can still expire
 *  unfilled at the close the same way stock's used to, with nothing
 *  detecting or re-arming it. Fixing that needs a different approach (detect
 *  the gap, place a fresh bracket) with its own failure modes — deliberately
 *  not attempted here; see AUTOTRADING_SPEC.md's existing partial-exit-for-
 *  live deferral note for why a naive cancel-then-replace has a real window
 *  with no resting stop at all if the replace step fails after the cancel
 *  succeeds. */
function optionBracketExit(
  intent: OrderIntent,
  comboType: 'STOP_PROFIT' | 'STOP_LOSS',
  orderType: 'LIMIT' | 'STOP_LOSS',
  price: number,
  clientOrderId: string,
): WebullOrderPayload {
  const symbol = intent.symbol.toUpperCase();
  const exitSide = intent.side === 'buy' ? 'SELL' : 'BUY'; // exits close the entry
  const leg: Record<string, string> = {
    side: exitSide,
    quantity: String(intent.quantity),
    symbol,
    strike_price: intent.strike !== undefined ? String(intent.strike) : '',
    option_expire_date: intent.expiration ?? '',
    instrument_type: 'OPTION',
    option_type: (intent.optionType ?? 'call').toUpperCase(),
    market: 'US',
  };
  const body: WebullOrderPayload = {
    combo_type: comboType,
    client_order_id: clientOrderId,
    order_type: orderType,
    quantity: String(intent.quantity),
    option_strategy: 'SINGLE',
    side: exitSide,
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    instrument_type: 'OPTION',
    market: 'US',
    symbol,
    legs: [leg],
  };
  if (orderType === 'LIMIT') body.limit_price = priceStr(price);
  else body.stop_price = priceStr(price);
  return body;
}

/** The full `/order/{preview,place}` request payload (sans account_id). For a
 *  plain order it's one entry; for a stock bracket it's a MASTER entry plus
 *  STOP_PROFIT / STOP_LOSS legs linked by a `client_combo_order_id`. */
export interface WebullOrderRequest {
  new_orders: WebullOrderPayload[];
  client_combo_order_id?: string;
}

export function buildOrderRequest(intent: OrderIntent, clientOrderId: string, isShort = false): WebullOrderRequest {
  const b = intent.bracket;
  const braced = b && (b.takeProfitPrice !== undefined || b.stopLossPrice !== undefined);
  // Brackets attach to a single-name entry: a stock, or a single-leg option.
  const isSingleOption = intent.assetKind === 'option' && (intent.optionStrategy ?? 'SINGLE') === 'SINGLE';
  if ((intent.assetKind === 'stock' || isSingleOption) && braced) {
    const master = buildWebullOrder(intent, clientOrderId, isShort); // stock or single-leg option entry
    master.combo_type = 'MASTER';
    const exit = (
      comboType: 'STOP_PROFIT' | 'STOP_LOSS',
      orderType: 'LIMIT' | 'STOP_LOSS',
      price: number,
    ): WebullOrderPayload =>
      intent.assetKind === 'stock'
        ? bracketExit(intent, comboType, orderType, price, newClientOrderId())
        : optionBracketExit(intent, comboType, orderType, price, newClientOrderId());
    const new_orders: WebullOrderPayload[] = [master];
    if (b!.takeProfitPrice !== undefined) new_orders.push(exit('STOP_PROFIT', 'LIMIT', b!.takeProfitPrice));
    if (b!.stopLossPrice !== undefined) new_orders.push(exit('STOP_LOSS', 'STOP_LOSS', b!.stopLossPrice));
    return { new_orders, client_combo_order_id: newClientOrderId() };
  }
  return { new_orders: [buildWebullOrder(intent, clientOrderId, isShort)] };
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
export async function webullPreviewOrder(
  accountId: string,
  intent: OrderIntent,
  isShort = false,
): Promise<WebullPreview> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const r = await webullClient().call('POST', '/openapi/trade/order/preview', {
    body: { account_id: accountId, ...buildOrderRequest(intent, newClientOrderId(), isShort) },
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
  /** The placement's outcome is UNKNOWN, not known-rejected: the request may or
   *  may not have reached the broker and been accepted. Distinguishing the two
   *  matters because a placement is nonIdempotent — treating "we never heard
   *  back" as "definitely rejected" lets the next cycle place the same real
   *  order a second time. Callers must keep an ambiguous placement pollable
   *  rather than terminal; webullOrderStatus looks orders up by CLIENT order id,
   *  so the outcome can be resolved later even with no broker id in hand. */
  ambiguous?: boolean;
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
  isShort = false,
): Promise<WebullPlaceResult> {
  if (!webullConfigured()) return { ok: false, error: 'Webull is not configured.' };
  const r = await webullClient().call('POST', '/openapi/trade/order/place', {
    body: { account_id: accountId, ...buildOrderRequest(intent, clientOrderId, isShort) },
    surface: 'trade',
    // Never transparently retry a placement — a lost response could hide a fill,
    // and a retry would double-submit. Reconcile against broker state instead.
    nonIdempotent: true,
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull place failed (${r.status})`,
      // status 0 is a network error or the client's own timeout abort — the
      // request may well have arrived. 429 can come back AFTER acceptance (the
      // client's own retry logic says as much), and a 5xx may have been raised
      // after the order was processed. Only a definite 4xx refusal means the
      // broker looked at it and said no.
      ambiguous: r.status === 0 || r.status === 429 || r.status >= 500,
    };
  }
  return { ok: true, orderId: pickOrderId(r.data), raw: r.data };
}

/** One sub-order within a combo (bracket MASTER/STOP_PROFIT/STOP_LOSS, or a
 *  spread's legs) as echoed back by the broker.
 *
 *  CONFIRMED against a real account (npm run capture:broker, Q3) — and the
 *  answer was not what this file assumed. A bracket does NOT come back as one
 *  envelope with three nested legs. It comes back as THREE SEPARATE top-level
 *  envelopes sharing a `combo_order_id`, each wrapping its own single leg, with
 *  `combo_type` carried on the ENVELOPE rather than on the leg inside it.
 *
 *  Both halves of that broke the old reading. Only the matched envelope was
 *  ever examined, so `legs` never held more than the entry itself, and
 *  `combo_type` was looked for one level below where it lives, so every
 *  `comboType` filter matched nothing. The visible consequence was that a
 *  bracket exit was never detected through the order path at all: a stop or
 *  target fill was only ever picked up later by the broker-truth position sync,
 *  which books it at an ESTIMATED price, so realized P&L on every bracketed
 *  trade was an approximation of a fill we could have read exactly.
 *
 *  `comboType` is now populated from the envelope (falling back to the leg, so
 *  a nested response would still work). Nothing DEPENDS on its value, though —
 *  see collectLegs() for why role identification uses our own client_order_id
 *  instead. */
export interface WebullOrderLeg {
  comboType?: string;
  orderType?: string;
  status?: string;
  filledQty?: number;
  filledPrice?: number;
  brokerOrderId?: string;
  /** This leg's own client_order_id. The bracket's exit legs each got their own
   *  at placement (buildOrderRequest), which is what lets a leg be told apart
   *  from the entry without trusting `comboType`. */
  clientOrderId?: string;
  /** True for the leg whose client_order_id is the one we asked about — i.e.
   *  the order WE placed, the bracket's entry. Positive identification rather
   *  than an inference from a label. */
  isRequested?: boolean;
}

/**
 * Is this combo leg one of the bracket's EXIT legs — i.e. not the order the
 * caller asked about?
 *
 * Prefers positive identification: `isRequested` comes from matching our own
 * client_order_id, which we generated, so it holds regardless of what the
 * broker calls the legs. A leg carrying some OTHER client_order_id is
 * definitively a sibling. Only when the id is missing entirely does this fall
 * back to the `combo_type` label — the signal that turned out to be absent from
 * the leg on a real account, which is why it is the fallback and not the test.
 */
export function isExitLeg(leg: WebullOrderLeg): boolean {
  if (leg.isRequested) return false;
  if (leg.clientOrderId !== undefined) return true;
  return !!leg.comboType && leg.comboType !== 'MASTER';
}

export interface WebullOrderStatus {
  ok: boolean;
  /** Whether an order matching our client_order_id was found at the broker. */
  found: boolean;
  /** Raw Webull status (uppercased), e.g. FILLED / CANCELLED / PARTIAL_FILLED.
   *  For a combo (bracket/spread), this is specifically the FIRST leg
   *  (orders[0], the MASTER for a bracket) — see `legs` for every sub-order. */
  status?: string;
  /** Broker order id (envelope `combo_order_id`, mirrored as the order's `order_id`). */
  brokerOrderId?: string;
  filledQty?: number;
  totalQty?: number;
  filledPrice?: number;
  /** Every sub-order in the combo (length 1 for a plain order; up to 3 for a
   *  bracket). See WebullOrderLeg's caveat — best-effort, not yet
   *  probe-confirmed for a real bracket fill. */
  legs?: WebullOrderLeg[];
  /** The matched order envelope — kept so new fields can be read without a code change. */
  raw?: unknown;
  error?: string;
}

/** Order-list envelope shape (confirmed against a real /order/{open,history}).
 *
 *  `combo_type` sits HERE, at the envelope level — not on the rows inside
 *  `orders`. A bracket is three of these sharing one `combo_order_id`. */
interface OrderEnvelope {
  client_order_id?: string;
  combo_type?: string;
  combo_order_id?: string;
  orders?: Array<Record<string, unknown>>;
}

function mapLeg(
  o: Record<string, unknown>,
  envelope?: OrderEnvelope,
  requestedClientOrderId?: string,
  /** The envelope's own client_order_id, passed ONLY when this envelope wraps a
   *  single leg — i.e. the flat shape, where the envelope and the leg are the
   *  same order. Inheriting it into a MULTI-leg envelope would give every
   *  nested leg the same id and make each one look like the requested order. */
  inheritableClientOrderId?: string,
): WebullOrderLeg {
  // Envelope first: that is where the broker actually puts it. The leg-level
  // read stays as a fallback so a nested response (which is what this file
  // originally assumed, and what a different endpoint or a future version might
  // still return) keeps working unchanged.
  const comboType =
    typeof envelope?.combo_type === 'string'
      ? envelope.combo_type
      : typeof o.combo_type === 'string'
        ? o.combo_type
        : undefined;
  const clientOrderId = typeof o.client_order_id === 'string' ? o.client_order_id : inheritableClientOrderId;
  return {
    comboType,
    orderType: typeof o.order_type === 'string' ? o.order_type : undefined,
    status: o.status ? String(o.status).toUpperCase() : undefined,
    filledQty: num(o.filled_quantity),
    filledPrice: num(o.filled_price),
    brokerOrderId: o.order_id !== undefined && o.order_id !== null ? String(o.order_id) : undefined,
    clientOrderId,
    isRequested: !!clientOrderId && clientOrderId === requestedClientOrderId,
  };
}

/**
 * Every leg of the combo the matched envelope belongs to.
 *
 * A bracket is several top-level envelopes sharing a `combo_order_id` (see
 * OrderEnvelope), so the legs have to be gathered ACROSS the list rather than
 * read out of one envelope's `orders`. A plain order has no siblings and yields
 * exactly its own leg, unchanged from before.
 *
 * Role identification deliberately does not rest on `combo_type`. The leg whose
 * client_order_id is the one we asked about is the order WE placed — that is
 * positive identification from something we generated ourselves, and it holds
 * whatever the broker chooses to call the legs. `comboType` is passed through
 * for diagnostics and for callers that want the label, but a caller can tell
 * entry from exit with `isRequested` alone.
 */
function collectLegs(list: unknown, matched: OrderEnvelope, requestedClientOrderId: string): WebullOrderLeg[] {
  const envelopes = Array.isArray(list) ? (list as OrderEnvelope[]) : [];
  const comboId = matched.combo_order_id;
  const siblings =
    comboId === undefined || comboId === null || comboId === ''
      ? [matched]
      : envelopes.filter((e) => e?.combo_order_id === comboId);
  const group = siblings.length > 0 ? siblings : [matched];

  const legs: WebullOrderLeg[] = [];
  for (const env of group) {
    const rows = Array.isArray(env.orders) && env.orders.length ? env.orders : [env as Record<string, unknown>];
    // Only a single-leg envelope can lend its id to its leg — see mapLeg.
    const inheritable = rows.length === 1 && typeof env.client_order_id === 'string' ? env.client_order_id : undefined;
    for (const row of rows) {
      legs.push(mapLeg(row as Record<string, unknown>, env, requestedClientOrderId, inheritable));
    }
  }
  return legs;
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
      // Every leg of the combo, gathered across sibling envelopes sharing this
      // one's combo_order_id — see collectLegs. Previously only THIS envelope's
      // own `orders` was read, which for a real bracket is just the entry.
      const legs = collectLegs(r.data, env, clientOrderId);
      const orders = Array.isArray(env.orders) && env.orders.length ? env.orders : [env as Record<string, unknown>];
      // The top-level status describes the order the caller ASKED about, so
      // identify that row by strongest available evidence, in order:
      //
      //   1. its client_order_id is the one we asked about — positive, from an
      //      id we generated ourselves, and what the real (flat) shape gives us
      //   2. it is tagged combo_type MASTER on the leg — the nested-and-tagged
      //      shape this file originally assumed. Unobserved in practice so far,
      //      but costless to keep and the only signal if a different endpoint
      //      or a later API version returns that shape
      //   3. positional fallback — a plain order, where orders[0] is the order
      //
      // Falling straight to (3) is what made this worth fixing: for a bracket it
      // can read a cancelled OCO sibling's status as the entry's own.
      const o = (orders.find((leg) => (leg as { client_order_id?: string })?.client_order_id === clientOrderId) ??
        orders.find((leg) => (leg as { combo_type?: string })?.combo_type === 'MASTER') ??
        orders[0] ??
        {}) as Record<string, unknown>;
      const brokerOrderId = env.combo_order_id ?? (o.order_id as string | undefined);
      return {
        ok: true,
        found: true,
        status: o.status ? String(o.status).toUpperCase() : undefined,
        brokerOrderId: brokerOrderId ? String(brokerOrderId) : undefined,
        filledQty: num(o.filled_quantity),
        totalQty: num(o.total_quantity),
        filledPrice: num(o.filled_price),
        legs: legs.length ? legs : undefined,
        raw: env,
      };
    }
  }
  return { ok: true, found: false };
}

/** One currently-open (resting/working) order at the broker, flattened out of
 *  its combo envelope. `side`/`symbol` are parsed leniently across the field
 *  names Webull has been seen to use, since a bracket's exit legs are echoed
 *  back with their OWN client_order_id (buildOrderRequest) — which we never
 *  persisted, so the broker's open-orders list is the only way to recover them
 *  for an already-open position. */
export interface WebullOpenOrder {
  clientOrderId?: string;
  brokerOrderId?: string;
  symbol?: string;
  /** Normalized to 'buy' | 'sell' when determinable, else undefined (in which
   *  case the caller must NOT assume a side — fail closed rather than cancel a
   *  wrong-side order). */
  side?: 'buy' | 'sell';
  status?: string;
  comboType?: string;
}

export interface WebullOpenOrdersResult {
  ok: boolean;
  orders: WebullOpenOrder[];
  /** The raw broker payload, kept so a first live run can reveal the real field
   *  shape if the lenient parsing below misses anything. */
  raw?: unknown;
  error?: string;
}

function normalizeSide(v: unknown): 'buy' | 'sell' | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  if (['BUY', 'B', 'BOT', 'LONG', 'BUY_TO_OPEN', 'BUY_TO_CLOSE'].includes(s)) return 'buy';
  if (['SELL', 'S', 'SLD', 'SHORT', 'SELL_TO_OPEN', 'SELL_TO_CLOSE'].includes(s)) return 'sell';
  return undefined;
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function mapOpenOrder(o: Record<string, unknown>): WebullOpenOrder {
  return {
    clientOrderId: pickStr(o, ['client_order_id', 'clientOrderId']),
    brokerOrderId: pickStr(o, ['order_id', 'orderId', 'combo_order_id']),
    symbol: pickStr(o, ['symbol', 'ticker', 'instrument_symbol', 'stock_symbol']),
    side: normalizeSide(o.side ?? o.action ?? o.order_side ?? o.buy_sell ?? o.trade_side ?? o.direction),
    status: o.status ? String(o.status).toUpperCase() : undefined,
    comboType: typeof o.combo_type === 'string' ? o.combo_type : undefined,
  };
}

/**
 * READ-ONLY list of every currently-open order for the account, flattened
 * across combo envelopes to one entry per sub-order. Places/cancels nothing;
 * never throws. Used to find a bracket's resting stop/target legs so a
 * manual/force close can cancel them first — the master-id cancel does NOT
 * reach the exit legs (each has its own client_order_id), confirmed against a
 * real account where a close was rejected as "will reverse an existing
 * position" until the resting stop/target was cancelled by hand.
 */
export async function listWebullOpenOrders(accountId: string): Promise<WebullOpenOrdersResult> {
  if (!webullConfigured()) return { ok: false, orders: [], error: 'Webull is not configured.' };
  const r = await webullClient().call('GET', '/openapi/trade/order/open', {
    query: { account_id: accountId },
    surface: 'trade',
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      orders: [],
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull open-orders failed (${r.status})`,
    };
  }
  const envelopes = Array.isArray(r.data) ? (r.data as OrderEnvelope[]) : [];
  const orders: WebullOpenOrder[] = [];
  for (const env of envelopes) {
    const subs = Array.isArray(env.orders) && env.orders.length ? env.orders : [env as Record<string, unknown>];
    for (const o of subs) orders.push(mapOpenOrder(o as Record<string, unknown>));
  }
  return { ok: true, orders, raw: r.data };
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
  /** The modify's outcome is UNKNOWN, not known-rejected — same three statuses
   *  and the same reasoning as WebullPlaceResult.ambiguous. It matters for a
   *  different reason here: a replace that was APPLIED but whose response was
   *  lost leaves our stored quantity/limit describing an order the broker no
   *  longer has. Callers must not record the change (we don't know it landed)
   *  and must not report a rejection either — reconcile against broker state. */
  ambiguous?: boolean;
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
  if (patch.limitPrice !== undefined) modify.limit_price = priceStr(patch.limitPrice);
  if (patch.stopPrice !== undefined) modify.stop_price = priceStr(patch.stopPrice);
  const r = await webullClient().call('POST', '/openapi/trade/order/replace', {
    body: { account_id: accountId, modify_orders: [modify] },
    surface: 'trade',
    // A modify is a state change on a live order; don't blind-retry a lost
    // response (the first may have applied). Reconcile instead.
    nonIdempotent: true,
  });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      raw: r.data,
      error: j.msg || j.message || j.error_msg || `Webull replace failed (${r.status})`,
      // Identical classification to webullPlaceOrder's: status 0 is a network
      // error or our own timeout abort (the request may well have arrived and
      // been applied), 429 can come back AFTER acceptance, and a 5xx may be
      // raised after processing. Only a definite 4xx means the broker looked
      // at the modify and refused it.
      ambiguous: r.status === 0 || r.status === 429 || r.status >= 500,
    };
  }
  return { ok: true, raw: r.data };
}
