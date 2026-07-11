import { db } from './index';

// ---------------------------------------------------------------------------
// Storage for the Phase 6 paper execution loop's simulated trades
// (docs/AUTOTRADING_SPEC.md — "Paper execution loop"). Deliberately separate
// from db/positions.ts (the human's real trading journal) — see the resolved
// decision in the spec on why. One row per round trip: open fields are always
// set; exit fields are null until closed, then set on the SAME row.
//
// Trailing stop / breakeven / partial profit-taking (added 2026-07-11):
// stopPrice is now MUTABLE while a position is open (ratchetPaperPositionStop)
// — it always reflects the CURRENT effective stop, which is what
// checkPaperExits() checks against. initialStopPrice is a snapshot taken once
// at open and never touched again, so R-multiple triggers stay stable no
// matter how far stopPrice has since ratcheted. A partial exit
// (partialClosePaperPosition) reduces `quantity` in place and sets
// partialExitTaken — the row stays 'open' with reduced size; the partial
// fill itself is only journaled as an autotradeEvent, not a second row here
// (this table remains one row per position, not a split position/exits
// table — riskAmount stays fixed at its original full-size value throughout,
// same convention as db/positions.ts's own remainingQuantity-vs-original-risk
// split).
// ---------------------------------------------------------------------------

export type PaperSide = 'buy' | 'sell';
export type PaperExitReason = 'stop' | 'target' | 'time_exit' | 'manual';

export interface OpenPaperPositionInput {
  symbol: string;
  side: PaperSide;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  /** $ risked at entry (|entry - stop| * quantity) — for R-multiple stats. */
  riskAmount: number;
  riskProfile: string;
  rationale: string;
}

export interface ClosePaperPositionInput {
  exitPrice: number;
  exitReason: PaperExitReason;
}

export interface PaperPosition {
  id: number;
  symbol: string;
  side: PaperSide;
  quantity: number;
  entryPrice: number;
  entryAt: number;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  status: 'open' | 'closed';
  exitPrice: number | null;
  exitAt: number | null;
  exitReason: PaperExitReason | null;
  /** Snapshot of stopPrice at open — never mutated again. Null only for a
   *  row that predates this feature. */
  initialStopPrice: number | null;
  /** Running high-water (long) / low-water (short) mark since entry, for the
   *  trailing-stop calculation. Null only for a row that predates this
   *  feature (or hasn't been checked even once yet). */
  bestPriceSinceEntry: number | null;
  /** Whether the one-time partial-exit trigger has already fired. */
  partialExitTaken: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ListPaperPositionsFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  /** Max rows to return (default 200, capped at 1000). */
  limit?: number;
}

interface Row {
  id: number;
  symbol: string;
  side: PaperSide;
  quantity: number;
  entry_price: number;
  entry_at: number;
  stop_price: number;
  target_price: number;
  risk_amount: number;
  risk_profile: string;
  rationale: string;
  status: 'open' | 'closed';
  exit_price: number | null;
  exit_at: number | null;
  exit_reason: PaperExitReason | null;
  initial_stop_price: number | null;
  best_price_since_entry: number | null;
  partial_exit_taken: number;
  created_at: number;
  updated_at: number;
}

function map(r: Row): PaperPosition {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    entryPrice: r.entry_price,
    entryAt: r.entry_at,
    stopPrice: r.stop_price,
    targetPrice: r.target_price,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    rationale: r.rationale,
    status: r.status,
    exitPrice: r.exit_price,
    exitAt: r.exit_at,
    exitReason: r.exit_reason,
    initialStopPrice: r.initial_stop_price,
    bestPriceSinceEntry: r.best_price_since_entry,
    partialExitTaken: r.partial_exit_taken === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Record a new paper fill — the execution stage's synthetic order placement.
 *  initial_stop_price and best_price_since_entry are seeded from stopPrice/
 *  entryPrice respectively, so trailing/breakeven/partial-exit logic has a
 *  stable baseline from the very first check cycle. */
export function openPaperPosition(input: OpenPaperPositionInput): PaperPosition {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autotrade_paper_positions
         (symbol, side, quantity, entry_price, entry_at, stop_price, target_price,
          risk_amount, risk_profile, rationale, status, initial_stop_price,
          best_price_since_entry, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    )
    .run(
      input.symbol.toUpperCase(),
      input.side,
      input.quantity,
      input.entryPrice,
      now,
      input.stopPrice,
      input.targetPrice,
      input.riskAmount,
      input.riskProfile,
      input.rationale,
      input.stopPrice,
      input.entryPrice,
      now,
      now,
    );
  return map(
    db.prepare('SELECT * FROM autotrade_paper_positions WHERE id = ?').get(Number(info.lastInsertRowid)) as Row,
  );
}

/** Close an open paper position (stop/target hit, or a manual close). A
 *  no-op (returns null) if `id` doesn't exist or is already closed — so a
 *  loop cycle that races a manual close can't double-close. */
export function closePaperPosition(id: number, input: ClosePaperPositionInput): PaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_paper_positions
       SET status = 'closed', exit_price = ?, exit_at = ?, exit_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(input.exitPrice, now, input.exitReason, now, id);
  // The WHERE clause makes this UPDATE conditional, but a conditional UPDATE
  // that matches zero rows still "succeeds" — checking `changes` (not just
  // re-SELECTing) is what actually distinguishes "closed just now" from
  // "already closed" or "no such id." Skipping this check previously let a
  // second, no-op close attempt return the stale row as if it had succeeded.
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM autotrade_paper_positions WHERE id = ?').get(id) as Row;
  return map(row);
}

/** Ratchet an open position's CURRENT effective stop (breakeven move or
 *  trailing) — an unconditional set, trusting the caller (execute.ts) to
 *  have already confirmed `newStopPrice` is more favorable than the
 *  existing one; this is a thin setter, not where that comparison lives.
 *  Never touches initial_stop_price. No-op (returns null) if `id` isn't
 *  open. */
export function ratchetPaperPositionStop(id: number, newStopPrice: number): PaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(`UPDATE autotrade_paper_positions SET stop_price = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
    .run(newStopPrice, now, id);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_paper_positions WHERE id = ?').get(id) as Row);
}

/** Record the best (most favorable) price seen since entry — the running
 *  high-water mark (long) / low-water mark (short) the trailing-stop
 *  calculation ratchets against. Unconditional set, trusting the caller to
 *  have already taken the max/min against the current value. No-op
 *  (returns null) if `id` isn't open. */
export function updatePaperPositionBestPrice(id: number, price: number): PaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_paper_positions SET best_price_since_entry = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    )
    .run(price, now, id);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_paper_positions WHERE id = ?').get(id) as Row);
}

export interface PartialClosePaperPositionInput {
  /** Shares/units closed — must be strictly less than the position's current
   *  quantity (a full close belongs to closePaperPosition instead). */
  quantity: number;
  exitPrice: number;
}

/** Scale out of an open position: reduces quantity in place and marks
 *  partial_exit_taken so the trigger doesn't re-fire next cycle. The
 *  position stays 'open' with the remainder — riskAmount is deliberately
 *  left untouched (it's the ORIGINAL full-size dollar risk, the R-multiple
 *  denominator for the life of the trade, same convention as
 *  db/positions.ts's remainingQuantity-vs-original-risk split). The closed
 *  slice itself isn't written anywhere structured beyond the caller's own
 *  journal event — this table stays one row per position, not a split
 *  position/exits table. No-op (returns null) if `id` isn't open or
 *  `quantity` isn't strictly less than the current quantity. */
export function partialClosePaperPosition(id: number, input: PartialClosePaperPositionInput): PaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_paper_positions
       SET quantity = quantity - ?, partial_exit_taken = 1, updated_at = ?
       WHERE id = ? AND status = 'open' AND ? < quantity`,
    )
    .run(input.quantity, now, id, input.quantity);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_paper_positions WHERE id = ?').get(id) as Row);
}

/** All currently-open paper positions, oldest first — what the loop checks
 *  for a stop/target hit every cycle. */
export function listOpenPaperPositions(): PaperPosition[] {
  const rows = db
    .prepare("SELECT * FROM autotrade_paper_positions WHERE status = 'open' ORDER BY entry_at ASC")
    .all() as Row[];
  return rows.map(map);
}

/** True if `symbol` already has an open paper position — the idempotency
 *  check that stops the loop from stacking a second position in the same
 *  name across consecutive cycles. */
export function hasOpenPaperPosition(symbol: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM autotrade_paper_positions WHERE symbol = ? AND status = 'open' LIMIT 1")
    .get(symbol.toUpperCase());
  return !!row;
}

/** Paper trade history (open + closed), newest first — for the Auto-Trade
 *  page's paper-journal view. */
export function listPaperPositions(filter: ListPaperPositionsFilter = {}): PaperPosition[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.symbol) {
    clauses.push('symbol = ?');
    params.push(filter.symbol.toUpperCase());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = db
    .prepare(`SELECT * FROM autotrade_paper_positions ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Row[];
  return rows.map(map);
}
