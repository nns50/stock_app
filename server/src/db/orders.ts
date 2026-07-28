import { db } from './index';
import { assertTransition, INITIAL_STATE, OrderState } from '../services/trading/orderLifecycle';
import {
  AssetKind,
  OpenClose,
  OptionStrategy,
  OptionType,
  OrderIntent,
  OrderSide,
  OrderType,
} from '../services/trading/guardrails';

// ---------------------------------------------------------------------------
// Persistence + immutable audit trail for order intents (design §6/§7). Every
// intent starts in `draft` and only moves through legal lifecycle transitions;
// each transition appends an `order_events` row, so the full history of an
// order is reconstructable. Idempotency is enforced by a unique client key, so
// a retried/double-clicked submit can never create two intents.
//
// This stores and sequences orders — it does NOT submit them or call a broker.
// ---------------------------------------------------------------------------

export interface OrderIntentRecord {
  id: number;
  idempotencyKey: string;
  symbol: string;
  assetKind: AssetKind;
  side: OrderSide;
  openClose: OpenClose;
  quantity: number;
  orderType: OrderType;
  limitPrice: number | null;
  /** Trigger price for stop_loss / stop_loss_limit orders; null otherwise (and
   *  null on rows created before 2026-07-28, when it wasn't persisted). */
  stopPrice: number | null;
  optionType: OptionType | null;
  strike: number | null;
  expiration: string | null;
  /** Option strategy this order was placed as ('SINGLE' for a single-leg option;
   *  null for a stock). A multi-leg value marks a combo that can't be modified in place. */
  optionStrategy: OptionStrategy | null;
  /** True when placed as a bracket (a MASTER entry plus linked exit legs). */
  isBracket: boolean;
  state: OrderState;
  brokerOrderId: string | null;
  /** Quantity of this order already mirrored into the Positions ledger. The
   *  high-water mark that makes partial-fill materialization idempotent across
   *  the three independent reconcile callers. */
  materializedQty: number;
  /** Total cost already booked for `materializedQty`. Differencing this against
   *  the broker's (quantity × average price) recovers the incremental price of
   *  a new partial, which an average alone can't give. */
  materializedNotional: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrderEventRecord {
  id: number;
  intentId: number;
  state: OrderState;
  detail: string | null;
  createdAt: number;
}

interface IntentRow {
  id: number;
  idempotency_key: string;
  symbol: string;
  asset_kind: AssetKind;
  side: OrderSide;
  open_close: OpenClose;
  quantity: number;
  order_type: OrderType;
  limit_price: number | null;
  stop_price: number | null;
  option_type: OptionType | null;
  strike: number | null;
  expiration: string | null;
  option_strategy: OptionStrategy | null;
  is_bracket: number;
  state: OrderState;
  broker_order_id: string | null;
  materialized_qty: number;
  materialized_notional: number;
  created_at: number;
  updated_at: number;
}

function mapIntent(r: IntentRow): OrderIntentRecord {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    symbol: r.symbol,
    assetKind: r.asset_kind,
    side: r.side,
    openClose: r.open_close,
    quantity: r.quantity,
    orderType: r.order_type,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price ?? null,
    optionType: r.option_type,
    strike: r.strike,
    expiration: r.expiration,
    optionStrategy: r.option_strategy,
    isBracket: r.is_bracket === 1,
    state: r.state,
    brokerOrderId: r.broker_order_id,
    materializedQty: r.materialized_qty ?? 0,
    materializedNotional: r.materialized_notional ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getIntent(id: number): OrderIntentRecord | undefined {
  const r = db.prepare('SELECT * FROM order_intents WHERE id = ?').get(id) as IntentRow | undefined;
  return r ? mapIntent(r) : undefined;
}

/** Batched form of getIntent — one query for the whole set instead of one
 *  per id, for callers reconciling a list of pending orders (liveExecute.ts /
 *  liveOptionsExecute.ts) rather than looking up a single known id. Ids not
 *  found are simply absent from the returned map. */
export function getIntents(ids: number[]): Map<number, OrderIntentRecord> {
  const map = new Map<number, OrderIntentRecord>();
  const uniq = Array.from(new Set(ids));
  if (uniq.length === 0) return map;
  const rows = db
    .prepare(`SELECT * FROM order_intents WHERE id IN (${uniq.map(() => '?').join(',')})`)
    .all(...uniq) as IntentRow[];
  for (const r of rows) map.set(r.id, mapIntent(r));
  return map;
}

/**
 * True when an order was placed as a multi-order combo — a multi-leg option
 * strategy (vertical / covered / iron condor) OR a bracket (a MASTER entry plus
 * linked exit legs). Such orders span several broker orders, so the single-key
 * `modify_orders` replace can't safely change them (it would touch one leg and
 * leave the rest stale); the safe path is cancel + re-place.
 */
export function isComboOrder(rec: Pick<OrderIntentRecord, 'optionStrategy' | 'isBracket'>): boolean {
  return rec.isBracket || (rec.optionStrategy !== null && rec.optionStrategy !== 'SINGLE');
}

/**
 * Create a `draft` intent for an order. Idempotent: the same key returns the
 * existing intent rather than inserting a duplicate. Records a creation event.
 */
export function createIntent(input: OrderIntent, idempotencyKey: string): OrderIntentRecord {
  const existing = db.prepare('SELECT * FROM order_intents WHERE idempotency_key = ?').get(idempotencyKey) as
    IntentRow | undefined;
  if (existing) return mapIntent(existing);

  // Persist enough to know later whether this was a multi-order combo: the
  // strategy (SINGLE for a single-leg option, NULL for a stock) and whether a
  // bracket was attached. The replace path uses these to refuse an unsafe
  // single-key modify of a spread / bracket.
  const optionStrategy = input.assetKind === 'option' ? (input.optionStrategy ?? 'SINGLE') : null;
  const isBracket =
    input.bracket && (input.bracket.takeProfitPrice !== undefined || input.bracket.stopLossPrice !== undefined) ? 1 : 0;

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO order_intents
        (idempotency_key, symbol, asset_kind, side, open_close, quantity, order_type, limit_price, stop_price,
         option_type, strike, expiration, option_strategy, is_bracket, state, broker_order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      idempotencyKey,
      input.symbol.toUpperCase(),
      input.assetKind,
      input.side,
      input.openClose,
      input.quantity,
      input.orderType,
      input.limitPrice ?? null,
      input.stopPrice ?? null,
      input.optionType ?? null,
      input.strike ?? null,
      input.expiration ?? null,
      optionStrategy,
      isBracket,
      INITIAL_STATE,
      null,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
    id,
    INITIAL_STATE,
    'created',
    now,
  );
  return getIntent(id)!;
}

/**
 * Move an intent to `to`, validated against the lifecycle machine (throws
 * IllegalTransitionError on an illegal jump). Appends an audit event and,
 * optionally, records the broker order id once known.
 */
export function transitionIntent(
  id: number,
  to: OrderState,
  opts: { detail?: string; brokerOrderId?: string } = {},
): OrderIntentRecord {
  const current = getIntent(id);
  if (!current) throw new Error(`No order intent ${id}`);
  assertTransition(current.state, to);

  const now = Date.now();
  db.prepare(
    'UPDATE order_intents SET state = ?, broker_order_id = COALESCE(?, broker_order_id), updated_at = ? WHERE id = ?',
  ).run(to, opts.brokerOrderId ?? null, now, id);
  db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
    id,
    to,
    opts.detail ?? null,
    now,
  );
  return getIntent(id)!;
}

/**
 * Record a broker-accepted REPLACE: update the stored quantity / limit price /
 * stop price to the new values and append an audit event at the current state
 * (a replace is not a lifecycle transition). Returns the refreshed record.
 */
export function recordReplace(
  id: number,
  patch: { quantity?: number; limitPrice?: number; stopPrice?: number },
  detail: string,
): OrderIntentRecord {
  const current = getIntent(id);
  if (!current) throw new Error(`No order intent ${id}`);
  const now = Date.now();
  db.prepare(
    'UPDATE order_intents SET quantity = COALESCE(?, quantity), limit_price = COALESCE(?, limit_price), stop_price = COALESCE(?, stop_price), updated_at = ? WHERE id = ?',
  ).run(patch.quantity ?? null, patch.limitPrice ?? null, patch.stopPrice ?? null, now, id);
  db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
    id,
    current.state,
    detail,
    now,
  );
  return getIntent(id)!;
}

/**
 * Advance the materialization high-water mark after a fill has been mirrored
 * into the Positions ledger. Both figures are ADDITIVE deltas, not absolutes,
 * and the UPDATE is guarded so the mark can only ever move forward: if a
 * concurrent reconcile already booked past this point, the WHERE clause makes
 * this a no-op instead of rewinding it. Returns true when this call was the one
 * that advanced it.
 *
 * SQLite (better-sqlite3) is synchronous and single-threaded here, so this
 * plus reading the mark in the same tick is effectively atomic; the guard
 * covers the ordering of the three independent reconcile callers rather than
 * true parallel writes.
 */
export function advanceMaterialized(id: number, addQty: number, addNotional: number): boolean {
  const info = db
    .prepare(
      `UPDATE order_intents
          SET materialized_qty = materialized_qty + ?,
              materialized_notional = materialized_notional + ?,
              updated_at = ?
        WHERE id = ? AND materialized_qty + ? > materialized_qty`,
    )
    .run(addQty, addNotional, Date.now(), id, addQty);
  return info.changes > 0;
}

/**
 * Append an audit event at the intent's CURRENT state — a note, not a lifecycle
 * transition. Used to record materialization decisions (including refusals),
 * so an order's history explains why a fill was or wasn't mirrored into
 * Positions without inventing a state the machine doesn't have.
 */
export function recordIntentNote(id: number, detail: string): void {
  const current = getIntent(id);
  if (!current) return;
  db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
    id,
    current.state,
    detail,
    Date.now(),
  );
}

/**
 * Append an audit note only if that exact detail isn't already on the intent,
 * reporting whether it wrote.
 *
 * For a condition re-observed on every poll — an unrecognized broker status,
 * say, which the reconcilers see again every 60s for as long as it persists —
 * the FIRST observation is the informative one. Repeating it would bury the
 * trail it exists to make readable, and would let one stuck order fill the
 * journal. The return value also gives callers a natural once-per-condition
 * hook for a louder notification.
 */
export function recordIntentNoteOnce(id: number, detail: string): boolean {
  if (getEvents(id).some((e) => e.detail === detail)) return false;
  recordIntentNote(id, detail);
  return true;
}

/** The audit trail for an intent, oldest first. */
export function getEvents(intentId: number): OrderEventRecord[] {
  return (
    db.prepare('SELECT * FROM order_events WHERE intent_id = ? ORDER BY id ASC').all(intentId) as Array<{
      id: number;
      intent_id: number;
      state: OrderState;
      detail: string | null;
      created_at: number;
    }>
  ).map((e) => ({ id: e.id, intentId: e.intent_id, state: e.state, detail: e.detail, createdAt: e.created_at }));
}

/** List intents, newest first; optionally filter by state. */
export function listIntents(opts: { state?: OrderState } = {}): OrderIntentRecord[] {
  const rows = opts.state
    ? (db.prepare('SELECT * FROM order_intents WHERE state = ? ORDER BY id DESC').all(opts.state) as IntentRow[])
    : (db.prepare('SELECT * FROM order_intents ORDER BY id DESC').all() as IntentRow[]);
  return rows.map(mapIntent);
}

/**
 * Epoch ms of the most recent US-market (ET) midnight for `now`. The daily
 * order cap must reset on the trading-day boundary, not the server's local
 * midnight — on a UTC-deployed box local midnight is ~20:00 ET, mid-session,
 * so the cap would reset in the middle of the trading day and count against the
 * wrong 24-hour bucket. (Handles EST/EDT via the ET wall clock; a sub-hour DST
 * skew at the 1-2am boundary is immaterial to a per-day count.)
 */
function etDayStart(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const msSinceEtMidnight = (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return now - msSinceEtMidnight;
}

/**
 * How many orders count against the daily max-orders/day rule today. An order
 * counts only if it actually reached the broker (a `submitted` event since the
 * ET trading-day start) AND wasn't rejected:
 *   - guardrail- / pre-flight-rejected orders never submit, so they're already out;
 *   - a BROKER rejection is `submitted → rejected`, so it has a `submitted` event —
 *     exclude it by its current state, since a rejected order never entered the
 *     market and shouldn't burn a slot (e.g. a dozen rejected $0.01 limits in a row).
 * Working/acknowledged/filled/cancelled/expired orders all still count — they hit
 * the market.
 */
export function countTodaysOrders(now = Date.now()): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT e.intent_id) AS n
         FROM order_events e
         JOIN order_intents i ON i.id = e.intent_id
        WHERE e.state = 'submitted' AND e.created_at >= ? AND i.state != 'rejected'`,
    )
    .get(etDayStart(now)) as { n: number };
  return row.n;
}
