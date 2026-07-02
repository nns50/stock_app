import { db } from './index';

// ---------------------------------------------------------------------------
// Storage for the Phase 6 paper execution loop's simulated trades
// (docs/AUTOTRADING_SPEC.md — "Paper execution loop"). Deliberately separate
// from db/positions.ts (the human's real trading journal) — see the resolved
// decision in the spec on why. One row per round trip: open fields are always
// set; exit fields are null until closed, then set on the SAME row (no
// partial fills/exits anywhere in this engine — decide.ts, riskCheck.ts, and
// backtest.ts's SimulatedTrade are all single entry -> single exit already).
// ---------------------------------------------------------------------------

export type PaperSide = 'buy' | 'sell';
export type PaperExitReason = 'stop' | 'target' | 'manual';

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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Record a new paper fill — the execution stage's synthetic order placement. */
export function openPaperPosition(input: OpenPaperPositionInput): PaperPosition {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autotrade_paper_positions
         (symbol, side, quantity, entry_price, entry_at, stop_price, target_price,
          risk_amount, risk_profile, rationale, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
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
