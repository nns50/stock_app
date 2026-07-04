import { db } from './index';

// ---------------------------------------------------------------------------
// Metadata for order_intents the AUTOTRADE loop placed for LIVE options
// (Task #70) — the options counterpart to db/autotradeLiveOrders.ts. Unlike
// equity, an options entry has no bracket (see db/index.ts's schema comment
// for why), so this table tracks TWO kinds of intent via `role`: an 'entry'
// (opens a position once filled) and an 'exit' (a separate closing order this
// loop places itself when the time-exit trigger fires, closes the position
// once filled). Both are single-shot: once an intent transitions to 'filled',
// it's fully reconciled in that same pass (open or close) and never needs
// re-polling on the SAME intent again — there's no bracket child leg to keep
// watching for, unlike equity's own live_orders table.
// ---------------------------------------------------------------------------

export type LiveOptionsOrderRole = 'entry' | 'exit';
export type LiveOptionsOrderKind = 'single_leg' | 'debit_spread';

export interface LiveOptionsOrderMeta {
  intentId: number;
  symbol: string;
  role: LiveOptionsOrderRole;
  kind: LiveOptionsOrderKind;
  /** Risk-checked $ amount — entry rows only, null for exit rows. */
  riskAmount: number | null;
  riskProfile: string;
  /** Entry: set once the fill materializes a position. Exit: known upfront
   *  (which open position this order is meant to close). */
  positionId: number | null;
  createdAt: number;
}

interface Row {
  intent_id: number;
  symbol: string;
  role: LiveOptionsOrderRole;
  kind: LiveOptionsOrderKind;
  risk_amount: number | null;
  risk_profile: string;
  position_id: number | null;
  created_at: number;
}

function mapRow(r: Row): LiveOptionsOrderMeta {
  return {
    intentId: r.intent_id,
    symbol: r.symbol,
    role: r.role,
    kind: r.kind,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    positionId: r.position_id,
    createdAt: r.created_at,
  };
}

/** Record that `intentId` is an autotrade-placed LIVE OPTIONS entry order. */
export function recordLiveOptionsEntryOrder(input: {
  intentId: number;
  symbol: string;
  kind: LiveOptionsOrderKind;
  riskAmount: number;
  riskProfile: string;
}): LiveOptionsOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_options_orders (intent_id, symbol, role, kind, risk_amount, risk_profile, position_id, created_at)
     VALUES (?, ?, 'entry', ?, ?, ?, NULL, ?)`,
  ).run(input.intentId, input.symbol.toUpperCase(), input.kind, input.riskAmount, input.riskProfile, now);
  return getLiveOptionsOrder(input.intentId)!;
}

/** Record that `intentId` is an autotrade-placed LIVE OPTIONS closing order
 *  for the already-open `positionId`. */
export function recordLiveOptionsExitOrder(input: {
  intentId: number;
  symbol: string;
  kind: LiveOptionsOrderKind;
  riskProfile: string;
  positionId: number;
}): LiveOptionsOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_options_orders (intent_id, symbol, role, kind, risk_amount, risk_profile, position_id, created_at)
     VALUES (?, ?, 'exit', ?, NULL, ?, ?, ?)`,
  ).run(input.intentId, input.symbol.toUpperCase(), input.kind, input.riskProfile, input.positionId, now);
  return getLiveOptionsOrder(input.intentId)!;
}

export function getLiveOptionsOrder(intentId: number): LiveOptionsOrderMeta | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_options_orders WHERE intent_id = ?').get(intentId) as
    | Row
    | undefined;
  return row ? mapRow(row) : undefined;
}

/** Link a now-materialized live options position back to the ENTRY intent
 *  that produced it (mirrors autotradeLiveOrders.ts's setLiveOrderPositionId). */
export function setLiveOptionsOrderPositionId(intentId: number, positionId: number): void {
  db.prepare('UPDATE autotrade_live_options_orders SET position_id = ? WHERE intent_id = ?').run(positionId, intentId);
}

/**
 * Every autotrade-placed LIVE OPTIONS intent (entry or exit) still worth
 * polling: non-terminal AND not yet filled. Once `filled`, the SAME
 * reconcile pass that observes it materializes the position open/close
 * immediately (see services/autotrading/liveOptionsExecute.ts) — unlike
 * equity's bracket, there's no child leg left to keep watching for on that
 * intent afterward, so 'filled' rows simply drop out here on the next call.
 */
export function listPendingLiveOptionsOrders(): LiveOptionsOrderMeta[] {
  const rows = db
    .prepare(
      `SELECT alo.*
         FROM autotrade_live_options_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE oi.state NOT IN ('cancelled','rejected','expired','filled')
        ORDER BY alo.created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** How many autotrade-placed LIVE OPTIONS entry intents exist at/after
 *  `sinceMs` — the probation-window trade count. ENTRY only, mirroring
 *  autotradeLiveOrders.ts's countLiveOrdersSince() (an exit is closing an
 *  already-counted trade, not a new one). Same "placed, not just filled"
 *  and "expired counts as never-became-a-real-trade" semantics. */
export function countLiveOptionsOrdersSince(sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM autotrade_live_options_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.created_at >= ? AND alo.role = 'entry' AND oi.state NOT IN ('rejected','cancelled','expired')`,
    )
    .get(sinceMs) as { n: number };
  return row.n;
}
