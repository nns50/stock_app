import { db } from './index';
import { assertTransition, INITIAL_STATE, OrderState } from '../services/trading/orderLifecycle';
import { AssetKind, OpenClose, OptionType, OrderIntent, OrderSide, OrderType } from '../services/trading/guardrails';

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
  optionType: OptionType | null;
  strike: number | null;
  expiration: string | null;
  state: OrderState;
  brokerOrderId: string | null;
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
  option_type: OptionType | null;
  strike: number | null;
  expiration: string | null;
  state: OrderState;
  broker_order_id: string | null;
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
    optionType: r.option_type,
    strike: r.strike,
    expiration: r.expiration,
    state: r.state,
    brokerOrderId: r.broker_order_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getIntent(id: number): OrderIntentRecord | undefined {
  const r = db.prepare('SELECT * FROM order_intents WHERE id = ?').get(id) as IntentRow | undefined;
  return r ? mapIntent(r) : undefined;
}

/**
 * Create a `draft` intent for an order. Idempotent: the same key returns the
 * existing intent rather than inserting a duplicate. Records a creation event.
 */
export function createIntent(input: OrderIntent, idempotencyKey: string): OrderIntentRecord {
  const existing = db.prepare('SELECT * FROM order_intents WHERE idempotency_key = ?').get(idempotencyKey) as
    | IntentRow
    | undefined;
  if (existing) return mapIntent(existing);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO order_intents
        (idempotency_key, symbol, asset_kind, side, open_close, quantity, order_type, limit_price,
         option_type, strike, expiration, state, broker_order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.optionType ?? null,
      input.strike ?? null,
      input.expiration ?? null,
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
 * Record a broker-accepted REPLACE: update the stored quantity / limit price to
 * the new values and append an audit event at the current state (a replace is
 * not a lifecycle transition). Stop price isn't a stored column, so it's only in
 * the event detail. Returns the refreshed record.
 */
export function recordReplace(
  id: number,
  patch: { quantity?: number; limitPrice?: number },
  detail: string,
): OrderIntentRecord {
  const current = getIntent(id);
  if (!current) throw new Error(`No order intent ${id}`);
  const now = Date.now();
  db.prepare(
    'UPDATE order_intents SET quantity = COALESCE(?, quantity), limit_price = COALESCE(?, limit_price), updated_at = ? WHERE id = ?',
  ).run(patch.quantity ?? null, patch.limitPrice ?? null, now, id);
  db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
    id,
    current.state,
    detail,
    now,
  );
  return getIntent(id)!;
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
 * How many orders were actually SUBMITTED to the broker today — counted from the
 * audit trail (a `submitted` event), so guardrail- or pre-flight-rejected orders
 * (which never reached the broker) don't count. Feeds the max-orders/day rule.
 */
export function countTodaysOrders(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const row = db
    .prepare("SELECT COUNT(DISTINCT intent_id) AS n FROM order_events WHERE state = 'submitted' AND created_at >= ?")
    .get(start.getTime()) as { n: number };
  return row.n;
}
