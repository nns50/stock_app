import { db } from './index';
import { LiveOptionsExitReason } from './autotradeLiveOptionsPositions';

// ---------------------------------------------------------------------------
// Metadata for order_intents the AUTOTRADE loop placed for LIVE options
// (Task #70) -- the options counterpart to db/autotradeLiveOrders.ts. Unlike
// equity, an options entry has no bracket (see db/index.ts's schema comment
// for why), so this table tracks TWO kinds of intent via `role`: an 'entry'
// (opens a position once filled) and an 'exit' (a separate closing order this
// loop places itself when the time-exit trigger fires, closes the position
// once filled).
//
// An entry row also carries the contract detail needed to materialize a
// position from a LATER reconcile pass (a separate call, potentially long
// after placement) -- order_intents has no column for a spread's second leg,
// and never stores the provider's own contract symbol at all. An exit row
// needs none of that: it already knows everything from the open position it
// references via position_id.
// ---------------------------------------------------------------------------

export type LiveOptionsOrderRole = 'entry' | 'exit';
export type LiveOptionsOrderKind = 'single_leg' | 'debit_spread';
export type LiveOptionsOrderSide = 'call' | 'put';

export interface LiveOptionsOrderMeta {
  intentId: number;
  symbol: string;
  role: LiveOptionsOrderRole;
  kind: LiveOptionsOrderKind;
  /** Entry rows only -- null for exit rows (see class header comment). */
  side: LiveOptionsOrderSide | null;
  contractSymbol: string | null;
  strike: number | null;
  shortContractSymbol: string | null;
  shortStrike: number | null;
  expiration: string | null;
  /** Risk-checked $ amount -- entry rows only, null for exit rows. */
  riskAmount: number | null;
  riskProfile: string;
  /** Entry: set once the fill materializes a position. Exit: known upfront
   *  (which open position this order is meant to close). */
  positionId: number | null;
  /** Exit rows only -- why this closing order was placed, carried through to
   *  closeLiveOptionsPosition() once the fill materializes. Null for entry
   *  rows, and for a pre-2026-07-16 exit row from before this column existed. */
  exitReason: LiveOptionsExitReason | null;
  /** Entry rows only — the Webull account this order executed in, carried
   *  forward to autotrade_live_options_positions.accountId once the fill
   *  materializes. Null for exit rows and legacy rows — see
   *  autotradeLiveOrders.ts's twin field for the full reasoning. */
  accountId: string | null;
  createdAt: number;
}

interface Row {
  intent_id: number;
  symbol: string;
  role: LiveOptionsOrderRole;
  kind: LiveOptionsOrderKind;
  side: LiveOptionsOrderSide | null;
  contract_symbol: string | null;
  strike: number | null;
  short_contract_symbol: string | null;
  short_strike: number | null;
  expiration: string | null;
  risk_amount: number | null;
  risk_profile: string;
  position_id: number | null;
  exit_reason: LiveOptionsExitReason | null;
  account_id: string | null;
  created_at: number;
}

function mapRow(r: Row): LiveOptionsOrderMeta {
  return {
    intentId: r.intent_id,
    symbol: r.symbol,
    role: r.role,
    kind: r.kind,
    side: r.side,
    contractSymbol: r.contract_symbol,
    strike: r.strike,
    shortContractSymbol: r.short_contract_symbol,
    shortStrike: r.short_strike,
    expiration: r.expiration,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    positionId: r.position_id,
    exitReason: r.exit_reason,
    accountId: r.account_id,
    createdAt: r.created_at,
  };
}

/** Record that `intentId` is an autotrade-placed LIVE OPTIONS entry order,
 *  carrying the contract detail needed to materialize a position once the
 *  fill is later observed. `shortContractSymbol`/`shortStrike` are
 *  debit-spread only. */
export function recordLiveOptionsEntryOrder(input: {
  intentId: number;
  symbol: string;
  kind: LiveOptionsOrderKind;
  side: LiveOptionsOrderSide;
  contractSymbol: string;
  strike: number;
  shortContractSymbol?: string;
  shortStrike?: number;
  expiration: string;
  riskAmount: number;
  riskProfile: string;
  accountId?: string | null;
}): LiveOptionsOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_options_orders
       (intent_id, symbol, role, kind, side, contract_symbol, strike, short_contract_symbol, short_strike,
        expiration, risk_amount, risk_profile, position_id, account_id, created_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.intentId,
    input.symbol.toUpperCase(),
    input.kind,
    input.side,
    input.contractSymbol,
    input.strike,
    input.shortContractSymbol ?? null,
    input.shortStrike ?? null,
    input.expiration,
    input.riskAmount,
    input.riskProfile,
    input.accountId ?? null,
    now,
  );
  return getLiveOptionsOrder(input.intentId)!;
}

/** Record that `intentId` is an autotrade-placed LIVE OPTIONS closing order
 *  for the already-open `positionId`. `exitReason` is required (not
 *  defaulted) so both callers -- checkLiveOptionsExits' own time-exit
 *  trigger and a human's manual close -- stay explicit about which one this
 *  is, rather than one of them silently relying on a fallback. */
export function recordLiveOptionsExitOrder(input: {
  intentId: number;
  symbol: string;
  kind: LiveOptionsOrderKind;
  riskProfile: string;
  positionId: number;
  exitReason: LiveOptionsExitReason;
}): LiveOptionsOrderMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_options_orders
       (intent_id, symbol, role, kind, side, contract_symbol, strike, short_contract_symbol, short_strike,
        expiration, risk_amount, risk_profile, position_id, exit_reason, created_at)
     VALUES (?, ?, 'exit', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    input.intentId,
    input.symbol.toUpperCase(),
    input.kind,
    input.riskProfile,
    input.positionId,
    input.exitReason,
    now,
  );
  return getLiveOptionsOrder(input.intentId)!;
}

export function getLiveOptionsOrder(intentId: number): LiveOptionsOrderMeta | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_options_orders WHERE intent_id = ?').get(intentId) as
    Row | undefined;
  return row ? mapRow(row) : undefined;
}

/** True when `intentId` was placed by autotrade's LIVE OPTIONS execution (vs.
 *  the human Trade page) — mirrors autotradeLiveOrders.ts's own
 *  isAutotradeIntent() for the equity side. Both live paths place orders into
 *  the SAME shared order_intents table (no "who placed this" column there),
 *  so services/trading/reconcile.ts's generic reconcile checks both this and
 *  the equity-side isAutotradeIntent() before ever touching an intent — see
 *  that fix's own history (2026-07-14) for why: skipping this check let the
 *  generic path race an autotrade-placed order's own reconcile and win,
 *  permanently locking autotrade's own reconcile out via the terminal-state
 *  guard once it did. */
export function isAutotradeOptionsIntent(intentId: number): boolean {
  return getLiveOptionsOrder(intentId) !== undefined;
}

/** Link a now-materialized live options position back to the ENTRY intent
 *  that produced it (mirrors autotradeLiveOrders.ts's setLiveOrderPositionId). */
export function setLiveOptionsOrderPositionId(intentId: number, positionId: number): void {
  db.prepare('UPDATE autotrade_live_options_orders SET position_id = ? WHERE intent_id = ?').run(positionId, intentId);
}

/**
 * Every autotrade-placed LIVE OPTIONS intent (entry or exit) still worth
 * polling. NOT simply "state isn't terminal and isn't filled" -- mirrors
 * autotradeLiveOrders.ts's own listPendingLiveOrders() nuance: a `filled`
 * intent whose materialization THREW (or hasn't been observed yet) must stay
 * visible here, or it would silently vanish with no path left to retry or
 * even notice the stuck row. Concretely:
 *   - a `filled` ENTRY stays pending while position_id is still NULL (the
 *     position was never successfully created);
 *   - a `filled` EXIT stays pending while its linked position is still
 *     'open' (the close was never successfully materialized).
 * Once materialization actually succeeds, the row naturally drops out.
 */
export function listPendingLiveOptionsOrders(): LiveOptionsOrderMeta[] {
  const rows = db
    .prepare(
      `SELECT alo.*
         FROM autotrade_live_options_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE oi.state NOT IN ('cancelled','rejected','expired')
          AND (
            oi.state != 'filled'
            OR (alo.role = 'entry' AND alo.position_id IS NULL)
            OR (
              alo.role = 'exit'
              AND alo.position_id IN (SELECT id FROM autotrade_live_options_positions WHERE status = 'open')
            )
          )
        ORDER BY alo.created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** Aggregate risk $ and count of autotrade options ENTRY orders that are
 *  PLACED but not yet materialized into a live options position (position_id
 *  IS NULL, intent not cancelled/rejected/expired). The counterpart to
 *  autotradeLiveOrders.ts's pendingLiveOrdersRisk() -- committed live risk with
 *  no position row yet (a live fill materializes only on a later reconcile
 *  tick). ENTRY only: an exit order is closing already-counted risk, not
 *  adding new risk, and exit rows carry no risk_amount anyway. */
export function pendingLiveOptionsOrdersRisk(): { risk: number; count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(alo.risk_amount), 0) AS risk, COUNT(*) AS count
         FROM autotrade_live_options_orders alo
         JOIN order_intents oi ON oi.id = alo.intent_id
        WHERE alo.role = 'entry' AND alo.position_id IS NULL
          AND oi.state NOT IN ('cancelled','rejected','expired')`,
    )
    .get() as { risk: number; count: number };
  return { risk: row.risk, count: row.count };
}

/** How many autotrade-placed LIVE OPTIONS entry intents exist at/after
 *  `sinceMs` -- the probation-window trade count. ENTRY only, mirroring
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
