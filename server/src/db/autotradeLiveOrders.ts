import { db } from './index';

// ---------------------------------------------------------------------------
// Metadata for order_intents the AUTOTRADE loop placed (Phase 8), distinct
// from the human Trade page's orders in the SAME shared order_intents table.
// order_intents itself carries no "who placed this" column, so this is a thin
// side table keyed on intent_id — not a duplicate of order or position data.
// See db/index.ts's schema comment for the full rationale.
// ---------------------------------------------------------------------------

export interface LiveOrderMeta {
  intentId: number;
  symbol: string;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
  positionId: number | null;
  createdAt: number;
}

interface Row {
  intent_id: number;
  symbol: string;
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
    stopPrice: r.stop_price,
    targetPrice: r.target_price,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    positionId: r.position_id,
    createdAt: r.created_at,
  };
}

/** Record that `intentId` is an autotrade-placed order, with the signal's
 *  intended stop/target/risk to carry over once the fill materializes into a
 *  real `positions` row. */
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
    `INSERT INTO autotrade_live_orders (intent_id, symbol, stop_price, target_price, risk_amount, risk_profile, position_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
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

export function getLiveOrder(intentId: number): LiveOrderMeta | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_orders WHERE intent_id = ?').get(intentId) as Row | undefined;
  return row ? mapRow(row) : undefined;
}

/** True when `intentId` was placed by autotrade (vs. the human Trade page). */
export function isAutotradeIntent(intentId: number): boolean {
  return getLiveOrder(intentId) !== undefined;
}

/** Link a now-materialized `positions` row back to the order intent that produced it. */
export function setLiveOrderPositionId(intentId: number, positionId: number): void {
  db.prepare('UPDATE autotrade_live_orders SET position_id = ? WHERE intent_id = ?').run(positionId, intentId);
}

/**
 * Every autotrade-placed intent still worth polling — callers fetch the full
 * intent record via db/orders.ts's getIntent(intentId) for the broker-facing
 * fields (idempotencyKey, openClose, quantity, ...) this table doesn't
 * duplicate.
 *
 * NOT simply "state isn't terminal": a bracket's `order_intents.state` only
 * ever reflects the MASTER (entry) leg (see WebullOrderLeg's caveat) — it
 * reads `filled` the instant the ENTRY fills and stays that way forever,
 * even while a linked STOP_LOSS/STOP_PROFIT exit leg is still working. A
 * `filled` intent therefore stays "pending" here as long as its linked
 * position (if any) is still open — once that position is closed (the exit
 * leg materialized), it naturally drops out and this function stops
 * re-polling it forever.
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
            OR alo.position_id IS NULL
            OR alo.position_id IN (SELECT id FROM positions WHERE status = 'open')
          )
        ORDER BY alo.created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** How many autotrade-placed live intents exist at/after `sinceMs` — the
 *  probation-window trade count (services/autotrading/liveExecute.ts). Counts
 *  an intent the moment it's placed (not just once filled): an order that's
 *  working or filled both represent a real, already-committed live trade for
 *  probation-sizing purposes — a rejected/cancelled one does not. */
export function countLiveOrdersSince(sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM autotrade_live_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.created_at >= ? AND oi.state NOT IN ('rejected','cancelled')`,
    )
    .get(sinceMs) as { n: number };
  return row.n;
}
