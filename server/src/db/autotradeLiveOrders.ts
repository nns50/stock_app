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
  /** Entry rows only — the Webull account this order executed in, carried
   *  forward to positions.accountId once the fill materializes (the account
   *  can't be re-derived correctly at materialization time: it may no longer
   *  match whatever's currently configured). Null for exit rows (the
   *  position being closed already has its own account) and legacy rows. */
  accountId: string | null;
  /** Set on a scale-in ADD-ON order to the already-open position it pyramids
   *  into — its fill MERGES into that position (blended entry) rather than
   *  creating a new one. Null for normal entries and exits. */
  addonOfPositionId: number | null;
  /** Entry rows: conviction grade (A/B/C) from the signal's screener score,
   *  carried to positions.grade at materialization. Null for exit rows and
   *  legacy rows. */
  grade: string | null;
  /** Entry rows: at-entry context carried to the same-named positions columns
   *  at materialization, exactly like grade. Null for exit/legacy rows. */
  entryScore: number | null;
  entryComponents: Record<string, number> | null;
  /** The client_combo_order_id this client generated for the bracket, so a
   *  later modify can name the combo group. Null for pre-2026-09-04 rows and
   *  for orders placed without a bracket. */
  clientComboOrderId: string | null;
  marketRegime: string | null;
  marketAtrPct: number | null;
  /** Session VWAP at placement (2026-08-22 observer), carried to
   *  positions.entry_vwap at materialization. Null: exit rows, legacy rows,
   *  or an unmeasurable fetch. */
  entryVwap: number | null;
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
  account_id: string | null;
  addon_of_position_id: number | null;
  grade: string | null;
  entry_score: number | null;
  entry_components: string | null;
  client_combo_order_id: string | null;
  market_regime: string | null;
  market_atr_pct: number | null;
  entry_vwap: number | null;
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
    accountId: r.account_id,
    addonOfPositionId: r.addon_of_position_id ?? null,
    grade: r.grade ?? null,
    entryScore: r.entry_score ?? null,
    clientComboOrderId: r.client_combo_order_id ?? null,
    entryComponents: (() => {
      if (!r.entry_components) return null;
      try {
        const v: unknown = JSON.parse(r.entry_components);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : null;
      } catch {
        return null;
      }
    })(),
    marketRegime: r.market_regime ?? null,
    marketAtrPct: r.market_atr_pct ?? null,
    entryVwap: r.entry_vwap ?? null,
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
  accountId?: string | null;
  /** Conviction grade (A/B/C) from the signal's screener score, carried to
   *  positions.grade once the fill materializes. */
  grade?: string | null;
  /** At-entry context, carried to positions once the fill materializes —
   *  same lifecycle as grade above. */
  entryScore?: number | null;
  entryComponents?: Record<string, number> | null;
  marketRegime?: string | null;
  marketAtrPct?: number | null;
  entryVwap?: number | null;
  clientComboOrderId?: string | null;
}): LiveOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id, account_id, grade, entry_score, entry_components, market_regime, market_atr_pct, entry_vwap, client_combo_order_id, created_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.intentId,
    input.symbol.toUpperCase(),
    input.stopPrice,
    input.targetPrice,
    input.riskAmount,
    input.riskProfile,
    input.accountId ?? null,
    input.grade ?? null,
    input.entryScore ?? null,
    input.entryComponents ? JSON.stringify(input.entryComponents) : null,
    input.marketRegime ?? null,
    input.marketAtrPct ?? null,
    input.entryVwap ?? null,
    input.clientComboOrderId ?? null,
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

/** Record that `intentId` is an autotrade-placed live-equity SCALE-IN ADD-ON
 *  order pyramiding into the already-open `addonOfPositionId`. Role stays
 *  'entry' (it IS an opening order with its own bracket) but `position_id`
 *  stays NULL until its fill reconciles — reusing the exact "materialize once
 *  when position_id is null" idempotency the normal entry path has. Its own
 *  stop/target/risk are the add's (the added shares get their OWN protective
 *  bracket, so they're never naked), NOT the position's originals. */
export function recordLiveAddOnOrder(input: {
  intentId: number;
  symbol: string;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
  addonOfPositionId: number;
  accountId?: string | null;
}): LiveOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id, account_id, addon_of_position_id, created_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    input.intentId,
    input.symbol.toUpperCase(),
    input.stopPrice,
    input.targetPrice,
    input.riskAmount,
    input.riskProfile,
    input.accountId ?? null,
    input.addonOfPositionId,
    now,
  );
  return getLiveOrder(input.intentId)!;
}

/** How many scale-in ADD-ONs a live position has had committed — counts every
 *  add-on order for it whose intent isn't rejected/cancelled/expired (a placed
 *  or filled add is a real commitment; a rejected one never happened). This IS
 *  the live add-ons-taken count the liveMaxAddOns cap is enforced against. */
export function countLiveAddOns(positionId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM autotrade_live_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.addon_of_position_id = ? AND oi.state NOT IN ('rejected','cancelled','expired')`,
    )
    .get(positionId) as { n: number };
  return row.n;
}

export function getLiveOrder(intentId: number): LiveOrderMeta | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_orders WHERE intent_id = ?').get(intentId) as Row | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * The ENTRY order that produced `positionId`, found through this table's own
 * `position_id` link rather than `positions.source_intent_id`.
 *
 * Why both exist (2026-08-24): an ADOPTED position — one the generic Webull
 * position-sync imported before reconcile caught up, which
 * materializeEntryFill()/adoptOrphanedLivePositions() then retagged and
 * linked — never gets `source_intent_id` written (adoption deliberately can't
 * patch it post-creation). The link is recorded HERE instead, by
 * setLiveOrderPositionId. Anything that needs "which bracket owns this
 * position" must therefore fall back to this lookup, or an adopted position
 * is invisible to it forever. That is not hypothetical: on 2026-08-24 an
 * adopted CTVA position triggered the stagnation exit and failed to close on
 * every subsequent tick — 21 identical `live_time_exit_failed` events —
 * because the only lookup was via source_intent_id.
 *
 * Newest entry row wins: a scale-in adds further rows for the same position,
 * and the most recent one carries the live risk profile.
 */
export function getLiveEntryOrderForPosition(positionId: number): LiveOrderMeta | undefined {
  const row = db
    .prepare(
      `SELECT * FROM autotrade_live_orders
        WHERE position_id = ? AND role = 'entry'
        ORDER BY created_at DESC, intent_id DESC
        LIMIT 1`,
    )
    .get(positionId) as Row | undefined;
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
        WHERE alo.created_at >= ? AND alo.role = 'entry' AND alo.addon_of_position_id IS NULL
          AND oi.state NOT IN ('rejected','cancelled','expired')`,
    )
    .get(sinceMs) as { n: number };
  return row.n;
}
