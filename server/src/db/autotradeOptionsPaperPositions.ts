import { db } from './index';

// ---------------------------------------------------------------------------
// Storage for the Phase 12 options paper execution loop's simulated trades
// (docs/AUTOTRADING_SPEC.md — "Options paper execution & expiration
// management"). The options counterpart to autotradePaperPositions.ts — a
// deliberate PARALLEL table/module, not a shared/unioned one, since a long
// option position is identified by contract (strike/expiration/side), not a
// buy/sell direction + stop/target price. One row per round trip: open
// fields are always set; exit fields are null until closed, then set on the
// SAME row.
//
// Trailing stop / breakeven / partial profit-taking (added 2026-07-17,
// mirroring autotradePaperPositions.ts's own trio): quantity CAN now shrink
// in place via partialCloseOptionsPaperPosition — the row stays 'open' with
// reduced size, the closed slice itself only journaled by the caller, same
// "one row per position, not a split position/exits table" convention.
// stop_floor_pct is the % counterpart to stopPrice: a long option has no
// stop PRICE to ratchet, so this instead stores the ratcheted MINIMUM
// acceptable unrealized gain % (net debit basis, for a spread) once a
// breakeven/trailing event first fires; null means "nothing has ratcheted
// yet, defer to the live optionsStopLossPct config" — checkOptionsPaperExits
// prefers this column over the live config once it's set. best_basis_since_entry
// is the running peak of that same basis — always a running MAX (options are
// always opened long), never a long/short branch the way equity's
// high/low-water mark needs.
// ---------------------------------------------------------------------------

export type OptionsPaperSide = 'call' | 'put';
export type OptionsPaperKind = 'single_leg' | 'debit_spread';
export type OptionsPaperExitReason = 'time_exit' | 'stop_loss' | 'take_profit' | 'manual';

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
  /** Conviction grade (A/B/C) from the underlying's screener score, or null. */
  grade?: string | null;
  /** The raw screener total (0-100) the grade was bucketed from, or null. */
  entryScore?: number | null;
  /** IV rank (0-100) the decision stage gated on, or null. */
  ivRank?: number | null;
  /** Market regime label at entry ('risk-on' | 'neutral' | 'risk-off'), or
   *  null when the best-effort regime read failed that cycle. */
  marketRegime?: string | null;
  /** Market (SPY) ATR% the loop read the cycle this entry was placed, or null. */
  marketAtrPct?: number | null;
  /** The underlying's price at entry — the reference an underlying-based stop
   *  measures against (docs/SHORT_DATED_OPTIONS_SPEC.md). Only the short-dated
   *  ladder reads it; every other rule here works off premium. */
  underlyingAtEntry?: number | null;
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
  /** Running peak of (mark − short mark) since entry, for the trailing
   *  calculation. Null only for a row that predates this feature or hasn't
   *  been checked even once yet. */
  bestBasisSinceEntry: number | null;
  /** Ratcheted minimum acceptable unrealized gain % (net debit basis, for a
   *  spread). Null until a breakeven/trailing event first fires — until
   *  then, checkOptionsPaperExits() uses the live optionsStopLossPct config
   *  instead. */
  stopFloorPct: number | null;
  /** Whether the one-time partial-exit trigger has already fired. */
  partialExitTaken: boolean;
  /** At-entry context — null for rows that predate these columns or where the
   *  best-effort read failed. See the DDL comment in db/index.ts. */
  grade: string | null;
  entryScore: number | null;
  ivRank: number | null;
  marketRegime: string | null;
  marketAtrPct: number | null;
  /** The underlying's price at entry (2026-08-27). Null on rows that predate
   *  the column, which leaves the short-dated ladder's underlying stop and
   *  stagnation cut silently inert for them rather than guessing a reference. */
  underlyingAtEntry: number | null;
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
  best_basis_since_entry: number | null;
  stop_floor_pct: number | null;
  partial_exit_taken: number;
  grade: string | null;
  entry_score: number | null;
  iv_rank: number | null;
  market_regime: string | null;
  market_atr_pct: number | null;
  underlying_at_entry: number | null;
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
    bestBasisSinceEntry: r.best_basis_since_entry,
    stopFloorPct: r.stop_floor_pct,
    partialExitTaken: r.partial_exit_taken === 1,
    grade: r.grade ?? null,
    entryScore: r.entry_score ?? null,
    ivRank: r.iv_rank ?? null,
    marketRegime: r.market_regime ?? null,
    marketAtrPct: r.market_atr_pct ?? null,
    underlyingAtEntry: r.underlying_at_entry ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Record a new options paper fill — the execution stage's synthetic order
 *  placement. best_basis_since_entry is seeded from the entry basis (entry
 *  premium, minus the short leg's for a spread) so the trailing calculation
 *  has a stable baseline from the very first check cycle — mirrors
 *  autotradePaperPositions.ts's own initial_stop_price/best_price_since_entry
 *  seeding. */
export function openOptionsPaperPosition(input: OpenOptionsPaperPositionInput): OptionsPaperPosition {
  const now = Date.now();
  const entryBasis = input.entryPrice - (input.shortEntryPrice ?? 0);
  const info = db
    .prepare(
      `INSERT INTO autotrade_options_paper_positions
         (symbol, side, kind, contract_symbol, strike, short_contract_symbol, short_strike,
          expiration, quantity, entry_price, short_entry_price, entry_at,
          risk_amount, risk_profile, rationale, status, best_basis_since_entry,
          grade, entry_score, iv_rank, market_regime, market_atr_pct, underlying_at_entry,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entryBasis,
      input.grade ?? null,
      input.entryScore ?? null,
      input.ivRank ?? null,
      input.marketRegime ?? null,
      input.marketAtrPct ?? null,
      input.underlyingAtEntry ?? null,
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

/** Record the best (highest) net basis seen since entry — the running peak
 *  the trailing calculation ratchets against. Unconditional set, trusting
 *  the caller to have already taken the max against the current value.
 *  No-op (returns null) if `id` isn't open. Mirrors
 *  autotradePaperPositions.ts's own updatePaperPositionBestPrice. */
export function updateOptionsPaperPositionBestBasis(id: number, basis: number): OptionsPaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_options_paper_positions SET best_basis_since_entry = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(basis, now, id);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_options_paper_positions WHERE id = ?').get(id) as Row);
}

/** Ratchet an open position's stop floor (breakeven move or trailing) — an
 *  unconditional set, trusting the caller (optionsExecute.ts) to have
 *  already confirmed `newFloorPct` is more protective than the existing one
 *  (or the live config, if nothing has ratcheted yet). No-op (returns null)
 *  if `id` isn't open. Mirrors autotradePaperPositions.ts's own
 *  ratchetPaperPositionStop. */
export function ratchetOptionsPaperPositionStopFloor(id: number, newFloorPct: number): OptionsPaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_options_paper_positions SET stop_floor_pct = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(newFloorPct, now, id);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_options_paper_positions WHERE id = ?').get(id) as Row);
}

export interface PartialCloseOptionsPaperPositionInput {
  /** Contracts/spreads closed — must be strictly less than the position's
   *  current quantity (a full close belongs to closeOptionsPaperPosition
   *  instead). */
  quantity: number;
  /** The long leg's exit premium for the closed slice. */
  exitPrice: number;
  /** The short leg's exit premium for the closed slice — debit spreads only. */
  shortExitPrice?: number;
}

/** Scale out of an open options position: reduces quantity in place and
 *  marks partial_exit_taken so the trigger doesn't re-fire. The position
 *  stays 'open' with the remainder — riskAmount is deliberately left
 *  untouched (the ORIGINAL full-size dollar risk, for the life of the
 *  trade). The closed slice itself isn't written anywhere structured beyond
 *  the caller's own journal event. No-op (returns null) if `id` isn't open
 *  or `quantity` isn't strictly less than the current quantity. Mirrors
 *  autotradePaperPositions.ts's own partialClosePaperPosition. */
export function partialCloseOptionsPaperPosition(
  id: number,
  input: PartialCloseOptionsPaperPositionInput,
): OptionsPaperPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_options_paper_positions
       SET quantity = quantity - ?, partial_exit_taken = 1, updated_at = ?
       WHERE id = ? AND status = 'open' AND ? < quantity`,
    )
    .run(input.quantity, now, id, input.quantity);
  if (info.changes === 0) return null;
  return map(db.prepare('SELECT * FROM autotrade_options_paper_positions WHERE id = ?').get(id) as Row);
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
