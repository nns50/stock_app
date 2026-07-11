import { db } from './index';

// ---------------------------------------------------------------------------
// Metadata for order_intents the AUTOTRADE loop placed (Phase 8), distinct
// from the human Trade page's orders in the SAME shared order_intents table.
// order_intents itself carries no "who placed this" column, so this is a thin
// side table keyed on intent_id — not a duplicate of order or position data.
// See db/index.ts's schema comment for the full rationale.
//
// role (added 2026-07-11, max-hold-days force-close): 'entry' (the bracket
// order — sole use of this table until now) or 'exit' — a separate closing
// order this loop places itself once maxHoldDays elapses without a stop/
// target hit, mirroring autotradeLiveOptionsOrders.ts's own role split. An
// exit row has no real stop/target/risk of its own (it's closing, not sizing
// a new position); those columns store 0 for it rather than NULL, since
// they're NOT NULL for a pre-existing DB's sake (see recordLiveExitOrder).
// ---------------------------------------------------------------------------

export type LiveOrderRole = 'entry' | 'exit';

export interface LiveOrderMeta {
  intentId: number;
  symbol: string;
  role: LiveOrderRole;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
  /** Entry: set once the fill materializes into a `positions` row. Exit:
   *  known upfront (the already-open position this order is meant to close). */
  positionId: number | null;
  createdAt: number;
}

interface Row {
  intent_id: number;
  symbol: string;
  role: LiveOrderRole;
  stop_price: number;
  target_price: number;
  risk_amount: number;
  risk_profile: string;
  position_id: number | null;
  created_at: number;
}

function mapRow(r: Row): LiveOrderMeta {
  return {
    intentId: r.intent_id,
    symbol: r.symbol,
    role: r.role,
    stopPrice: r.stop_price,
    targetPrice: r.target_price,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    positionId: r.position_id,
    createdAt: r.created_at,
  };
}

/** Record that `intentId` is an autotrade-placed ENTRY order, with the
 *  signal's intended stop/target/risk to carry over once the fill
 *  materializes into a real `positions` row. */
export function recordLiveOrder(input: {
  intentId: number;
  symbol: string;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
}): LiveOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id, created_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, NULL, ?)`,
  ).run(
    input.intentId,
    input.symbol.toUpperCase(),
    input.stopPrice,
    input.targetPrice,
    input.riskAmount,
    input.riskProfile,
    now,
  );
  return getLiveOrder(input.intentId)!;
}

/** Record that `intentId` is an autotrade-placed live-equity closing order
 *  for the already-open `positionId` (the maxHoldDays force-close path —
 *  services/autotrading/liveExecute.ts's checkLiveEquityTimeExits()). Stores
 *  0, not NULL, for stop/target/risk — this table's columns predate this
 *  role and stay NOT NULL for a pre-existing DB's sake; an exit order adds no
 *  new risk and has no stop/target of its own. */
export function recordLiveExitOrder(input: {
  intentId: number;
  symbol: string;
  riskProfile: string;
  positionId: number;
}): LiveOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id, created_at)
     VALUES (?, ?, 'exit', 0, 0, 0, ?, ?, ?)`,
  ).run(input.intentId, input.symbol.toUpperCase(), input.riskProfile, input.positionId, now);
  return getLiveOrder(input.intentId)!;
}

export function getLiveOrder(intentId: number): LiveOrderMeta | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_orders WHERE intent_id = ?').get(intentId) as Row | undefined;
  return row ? mapRow(row) : undefined;
}

/** True when `intentId` was placed by autotrade (vs. the human Trade page). */
export function isAutotradeIntent(intentId: number): boolean {
  return getLiveOrder(intentId) !== undefined;
}

/** Link a now-materialized `positions` row back to the ENTRY order intent
 *  that produced it (mirrors autotradeLiveOptionsOrders.ts's
 *  setLiveOptionsOrderPositionId). */
export function setLiveOrderPositionId(intentId: number, positionId: number): void {
  db.prepare('UPDATE autotrade_live_orders SET position_id = ? WHERE intent_id = ?').run(positionId, intentId);
}

/**
 * Every autotrade-placed intent still worth polling (entry or exit) —
 * callers fetch the full intent record via db/orders.ts's getIntent(intentId)
 * for the broker-facing fields (idempotencyKey, openClose, quantity, ...)
 * this table doesn't duplicate.
 *
 * Role-aware, mirroring autotradeLiveOptionsOrders.ts's own
 * listPendingLiveOptionsOrders() nuance:
 *   - a `filled` ENTRY stays pending as long as its linked position (if any)
 *     is still open — NOT simply "state isn't terminal": a bracket's
 *     `order_intents.state` only ever reflects the MASTER (entry) leg (see
 *     WebullOrderLeg's caveat) — it reads `filled` the instant the ENTRY
 *     fills and stays that way forever, even while a linked STOP_LOSS/
 *     STOP_PROFIT exit leg is still working at the broker. Polling must
 *     continue so that leg's eventual fill gets detected.
 *   - a `filled` EXIT stays pending while its linked position is still
 *     'open' (the close was never successfully materialized) — a genuinely
 *     new closing order, not a bracket leg, so no further legs to watch for
 *     once ITS OWN fill is recorded.
 */
export function listPendingLiveOrders(): LiveOrderMeta[] {
  const rows = db
    .prepare(
      `SELECT alo.*
         FROM autotrade_live_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE oi.state NOT IN ('cancelled','rejected','expired')
          AND (
            oi.state != 'filled'
            OR (alo.role = 'entry' AND (alo.position_id IS NULL OR alo.position_id IN (SELECT id FROM positions WHERE status = 'open')))
            OR (alo.role = 'exit' AND alo.position_id IN (SELECT id FROM positions WHERE status = 'open'))
          )
        ORDER BY alo.created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** Aggregate risk $ and count of autotrade equity ENTRY orders that are
 *  PLACED but not yet materialized into a `positions` row (position_id IS
 *  NULL, and the intent isn't cancelled/rejected/expired). A live fill only
 *  becomes a position row on a LATER reconcile tick, so an order placed
 *  earlier in the same tick (or a prior tick, still working) carries real
 *  committed risk that no position-based snapshot can see yet. The execution
 *  batches add this to the position-based open risk so two batches in one
 *  tick can't each re-spend the same budget headroom (see runLiveExecution /
 *  runLiveOptionsExecution). ENTRY only, mirroring
 *  pendingLiveOptionsOrdersRisk(): an exit is closing already-counted risk,
 *  not adding new risk (and always carries position_id, so it would never
 *  match the NULL check anyway — the explicit role check is just as
 *  defensive/explicit as the options version). */
export function pendingLiveOrdersRisk(): { risk: number; count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(alo.risk_amount), 0) AS risk, COUNT(*) AS count
         FROM autotrade_live_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.role = 'entry' AND alo.position_id IS NULL AND oi.state NOT IN ('cancelled','rejected','expired')`,
    )
    .get() as { risk: number; count: number };
  return { risk: row.risk, count: row.count };
}

/** How many autotrade-placed live ENTRY intents exist at/after `sinceMs` —
 *  the probation-window trade count (services/autotrading/liveExecute.ts).
 *  Counts an intent the moment it's placed (not just once filled): an order
 *  that's working or filled both represent a real, already-committed live
 *  trade for probation-sizing purposes — a rejected/cancelled/expired one
 *  does not (expired means the broker never filled it before it timed out —
 *  the same "never became a real trade" category as rejected/cancelled, not
 *  a distinct one). ENTRY only, mirroring countLiveOptionsOrdersSince(): a
 *  time-exit closing order is closing an already-counted trade, not a new one. */
export function countLiveOrdersSince(sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM autotrade_live_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.created_at >= ? AND alo.role = 'entry' AND oi.state NOT IN ('rejected','cancelled','expired')`,
    )
    .get(sinceMs) as { n: number };
  return row.n;
}
