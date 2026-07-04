import { db } from './index';

// ---------------------------------------------------------------------------
// Storage for the Phase 12 options paper execution loop's simulated trades
// (docs/AUTOTRADING_SPEC.md — "Options paper execution & expiration
// management"). The options counterpart to autotradePaperPositions.ts — a
// deliberate PARALLEL table/module, not a shared/unioned one, since a long
// option position is identified by contract (strike/expiration/side), not a
// buy/sell direction + stop/target price. One row per round trip: open
// fields are always set; exit fields are null until closed, then set on the
// SAME row (no partial fills/exits, matching every other engine here).
// ---------------------------------------------------------------------------

export type OptionsPaperSide = 'call' | 'put';
export type OptionsPaperKind = 'single_leg' | 'debit_spread';
export type OptionsPaperExitReason = 'time_exit' | 'manual';

export interface OpenOptionsPaperPositionInput {
  symbol: string;
  side: OptionsPaperSide;
  /** Defaults to 'single_leg'. */
  kind?: OptionsPaperKind;
  /** The long leg's contract for a debit spread. */
  contractSymbol: string;
  /** The long leg's strike for a debit spread. */
  strike: number;
  /** Debit spreads only — the short leg's contract/strike/entry premium. */
  shortContractSymbol?: string;
  shortStrike?: number;
  shortEntryPrice?: number;
  expiration: string;
  /** Contracts (single_leg) or spreads (debit_spread). */
  quantity: number;
  /** The long leg's fill premium for a debit spread. */
  entryPrice: number;
  /** $ risked at entry (full premium for single_leg; net debit x 100 for a
   *  spread) — for R-multiple stats. */
  riskAmount: number;
  riskProfile: string;
  rationale: string;
}

export interface CloseOptionsPaperPositionInput {
  /** The long leg's exit premium for a debit spread. */
  exitPrice: number;
  /** The short leg's exit premium — debit spreads only. */
  shortExitPrice?: number;
  exitReason: OptionsPaperExitReason;
}

export interface OptionsPaperPosition {
  id: number;
  symbol: string;
  side: OptionsPaperSide;
  kind: OptionsPaperKind;
  contractSymbol: string;
  strike: number;
  shortContractSymbol: string | null;
  shortStrike: number | null;
  expiration: string;
  quantity: number;
  entryPrice: number;
  shortEntryPrice: number | null;
  entryAt: number;
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  status: 'open' | 'closed';
  exitPrice: number | null;
  shortExitPrice: number | null;
  exitAt: number | null;
  exitReason: OptionsPaperExitReason | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListOptionsPaperPositionsFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  /** Max rows to return (default 200, capped at 1000). */
  limit?: number;
}

interface Row {
  id: number;
  symbol: string;
  side: OptionsPaperSide;
  kind: OptionsPaperKind;
  contract_symbol: string;
  strike: number;
  short_contract_symbol: string | null;
  short_strike: number | null;
  expiration: string;
  quantity: number;
  entry_price: number;
  short_entry_price: number | null;
  entry_at: number;
  risk_amount: number;
  risk_profile: string;
  rationale: string;
  status: 'open' | 'closed';
  exit_price: number | null;
  short_exit_price: number | null;
  exit_at: number | null;
  exit_reason: OptionsPaperExitReason | null;
  created_at: number;
  updated_at: number;
}

function map(r: Row): OptionsPaperPosition {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    kind: r.kind,
    contractSymbol: r.contract_symbol,
    strike: r.strike,
    shortContractSymbol: r.short_contract_symbol,
    shortStrike: r.short_strike,
    expiration: r.expiration,
    quantity: r.quantity,
    entryPrice: r.entry_price,
    shortEntryPrice: r.short_entry_price,
    entryAt: r.entry_at,
    riskAmount: r.risk_amount,
    riskProfile: r.risk_profile,
    rationale: r.rationale,
    status: r.status,
    exitPrice: r.exit_price,
    shortExitPrice: r.short_exit_price,
    exitAt: r.exit_at,
    exitReason: r.exit_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Record a new options paper fill — the execution stage's synthetic order placement. */
export function openOptionsPaperPosition(input: OpenOptionsPaperPositionInput): OptionsPaperPosition {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autotrade_options_paper_positions
         (symbol, side, kind, contract_symbol, strike, short_contract_symbol, short_strike,
          expiration, quantity, entry_price, short_entry_price, entry_at,
          risk_amount, risk_profile, rationale, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      input.symbol.toUpperCase(),
      input.side,
      input.kind ?? 'single_leg',
      input.contractSymbol,
      input.strike,
      input.shortContractSymbol ?? null,
      input.shortStrike ?? null,
      input.expiration,
      input.quantity,
      input.entryPrice,
      input.shortEntryPrice ?? null,
      now,
      input.riskAmount,
      input.riskProfile,
      input.rationale,
      now,
      now,
    );
  return map(
    db.prepare('SELECT * FROM autotrade_options_paper_positions WHERE id = ?').get(Number(info.lastInsertRowid)) as Row,
  );
}

/** Close an open options paper position (time-exit trigger, or a manual
 *  close). A no-op (returns null) if `id` doesn't exist or is already
 *  closed — so a loop cycle that races a manual close can't double-close. */
export function closeOptionsPaperPosition(
  id: number,
  input: CloseOptionsPaperPositionInput,
): OptionsPaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_options_paper_positions
       SET status = 'closed', exit_price = ?, short_exit_price = ?, exit_at = ?, exit_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(input.exitPrice, input.shortExitPrice ?? null, now, input.exitReason, now, id);
  // The WHERE clause makes this UPDATE conditional, but a conditional UPDATE
  // that matches zero rows still "succeeds" — checking `changes` (not just
  // re-SELECTing) is what actually distinguishes "closed just now" from
  // "already closed" or "no such id" (mirrors autotradePaperPositions.ts).
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM autotrade_options_paper_positions WHERE id = ?').get(id) as Row;
  return map(row);
}

/** All currently-open options paper positions, oldest first — what the loop
 *  checks for a time-exit trigger every cycle. */
export function listOpenOptionsPaperPositions(): OptionsPaperPosition[] {
  const rows = db
    .prepare("SELECT * FROM autotrade_options_paper_positions WHERE status = 'open' ORDER BY entry_at ASC")
    .all() as Row[];
  return rows.map(map);
}

/** True if `symbol` (the underlying) already has an open options paper
 *  position — the idempotency check that stops the loop from stacking a
 *  second position on the same underlying across consecutive cycles.
 *  Per-underlying, not per-contract, matching optionsDecide.ts producing at
 *  most one signal per underlying per cycle. */
export function hasOpenOptionsPaperPosition(symbol: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM autotrade_options_paper_positions WHERE symbol = ? AND status = 'open' LIMIT 1")
    .get(symbol.toUpperCase());
  return !!row;
}

/** Options paper trade history (open + closed), newest first — for the
 *  Auto-Trade page's options paper-journal view. */
export function listOptionsPaperPositions(filter: ListOptionsPaperPositionsFilter = {}): OptionsPaperPosition[] {
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
    .prepare(`SELECT * FROM autotrade_options_paper_positions ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Row[];
  return rows.map(map);
}
