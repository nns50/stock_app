import { db } from './index';

// ---------------------------------------------------------------------------
// Storage for Task #70's live (real-money) options positions — the options
// counterpart to db/positions.ts's autotrade-tagged rows, kept as its own
// PARALLEL table rather than reusing `positions` for the same reason
// autotradeOptionsPaperPositions.ts is separate from autotradePaperPositions.ts:
// a debit spread has no short-leg column on `positions`, and this app's own
// established convention is a parallel table, never forcing a two-leg
// position into a single-leg-shaped ledger.
//
// A row is created once an ENTRY order's fill is confirmed (mirroring
// services/autotrading/liveExecute.ts's materializeEntryFill(), which does the
// same for equity against `positions`) — NOT at order-placement time, since a
// real broker fill isn't instantaneous. Closed the same way, once a CLOSING
// order's own fill is confirmed. See db/autotradeLiveOptionsOrders.ts for the
// order_intents-level tracking that drives this reconciliation.
// ---------------------------------------------------------------------------

export type LiveOptionsSide = 'call' | 'put';
export type LiveOptionsKind = 'single_leg' | 'debit_spread';
/** Why a live options position closed. 'stop_loss'/'take_profit' joined
 *  2026-07-26 (live price-based exits — the same values the paper table
 *  already used, so the two books' exit_reason vocabularies finally match);
 *  'manual' covers both a human-triggered close and the broker-truth sync's
 *  "gone at the broker" close (see syncLiveOptionsPositionsFromBroker). */
export type LiveOptionsExitReason = 'time_exit' | 'stop_loss' | 'take_profit' | 'manual';

export interface CreateLiveOptionsPositionInput {
  symbol: string;
  side: LiveOptionsSide;
  /** Defaults to 'single_leg'. */
  kind?: LiveOptionsKind;
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
  /** The long leg's filled premium for a debit spread. */
  entryPrice: number;
  /** $ risked at entry (full premium for single_leg; net debit x 100 for a
   *  spread) — for R-multiple stats. */
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  /** The Webull account this fill executed in (autotradeCfg.liveAccountId at
   *  entry time) — lets the broker-truth sync below tell one account's
   *  holdings apart from another's. Omit only for a legacy row that predates
   *  this column. */
  accountId?: string | null;
  /** At-entry context, carried from the entry order's own row (see
   *  db/autotradeLiveOptionsOrders.ts) — all optional/nullable. */
  grade?: string | null;
  entryScore?: number | null;
  ivRank?: number | null;
  marketRegime?: string | null;
  marketAtrPct?: number | null;
  /** Underlying price at entry, carried from the entry order row at
   *  materialization — see the column comment in db/index.ts. */
  underlyingAtEntry?: number | null;
}

export interface CloseLiveOptionsPositionInput {
  /** The long leg's filled exit premium for a debit spread. */
  exitPrice: number;
  /** The short leg's filled exit premium — debit spreads only. */
  shortExitPrice?: number;
  exitReason: LiveOptionsExitReason;
}

export interface LiveOptionsPosition {
  id: number;
  symbol: string;
  side: LiveOptionsSide;
  kind: LiveOptionsKind;
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
  exitReason: LiveOptionsExitReason | null;
  accountId: string | null;
  /** At-entry context — null for rows that predate these columns or where the
   *  best-effort read failed. See the DDL comment in db/index.ts. */
  grade: string | null;
  entryScore: number | null;
  ivRank: number | null;
  marketRegime: string | null;
  marketAtrPct: number | null;
  /** Underlying price at entry — the reference an underlying-based stop
   *  measures against (docs/SHORT_DATED_OPTIONS_SPEC.md). Null on rows that
   *  predate the column, which makes that stop silently inert for them. */
  underlyingAtEntry: number | null;
  /** Highest premium (net basis for a spread) seen since entry — the mark the
   *  give-back trail hangs off. Seeded to entryPrice at creation. */
  peakPremium: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListLiveOptionsPositionsFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  /** Max rows to return (default 200, capped at 1000). */
  limit?: number;
}

export interface OpenLiveOptionsPositionsFilter {
  /** Exact-match a Webull account. Omit to return every open position
   *  regardless of account (correct for order-dedup / split-check / the
   *  time-exit sweep, which don't care which account a position lives in —
   *  only the broker-truth sync in liveOptionsExecute.ts needs this). */
  accountId?: string;
  /** Only meaningful together with accountId — see PositionFilter's twin
   *  flag in db/positions.ts for the reasoning (permissive for dedup/claim,
   *  never for closing). */
  includeUnassignedAccount?: boolean;
}

interface Row {
  id: number;
  symbol: string;
  side: LiveOptionsSide;
  kind: LiveOptionsKind;
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
  exit_reason: LiveOptionsExitReason | null;
  account_id: string | null;
  grade: string | null;
  entry_score: number | null;
  iv_rank: number | null;
  market_regime: string | null;
  market_atr_pct: number | null;
  underlying_at_entry: number | null;
  peak_premium: number | null;
  created_at: number;
  updated_at: number;
}

function map(r: Row): LiveOptionsPosition {
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
    accountId: r.account_id,
    grade: r.grade ?? null,
    entryScore: r.entry_score ?? null,
    ivRank: r.iv_rank ?? null,
    marketRegime: r.market_regime ?? null,
    marketAtrPct: r.market_atr_pct ?? null,
    underlyingAtEntry: r.underlying_at_entry ?? null,
    peakPremium: r.peak_premium ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Materialize a confirmed real entry fill into a new live options position. */
/** Raise the peak-premium high-water mark. Only ever RAISES — the give-back
 *  trail measures a retrace from the best the position ever saw, so a lower
 *  reading is exactly the thing being measured, not a new peak. */
export function raiseLiveOptionsPeakPremium(id: number, premium: number): void {
  db.prepare(
    'UPDATE autotrade_live_options_positions SET peak_premium = ?, updated_at = ? ' +
      "WHERE id = ? AND status = 'open' AND (peak_premium IS NULL OR peak_premium < ?)",
  ).run(premium, Date.now(), id, premium);
}

export function createLiveOptionsPosition(input: CreateLiveOptionsPositionInput): LiveOptionsPosition {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autotrade_live_options_positions
         (symbol, side, kind, contract_symbol, strike, short_contract_symbol, short_strike,
          expiration, quantity, entry_price, short_entry_price, entry_at,
          risk_amount, risk_profile, rationale, status, account_id,
          grade, entry_score, iv_rank, market_regime, market_atr_pct,
          underlying_at_entry, peak_premium, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.accountId ?? null,
      input.grade ?? null,
      input.entryScore ?? null,
      input.ivRank ?? null,
      input.marketRegime ?? null,
      input.marketAtrPct ?? null,
      input.underlyingAtEntry ?? null,
      // The peak starts at the entry premium: a position has not been in
      // profit until it moves, so the give-back trail measures from here.
      input.entryPrice,
      now,
      now,
    );
  return map(
    db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(Number(info.lastInsertRowid)) as Row,
  );
}

/** Materialize a confirmed real exit fill against an open live options
 *  position. A no-op (returns null) if `id` doesn't exist or is already
 *  closed — defensive against a double-reconcile of the same fill. */
export function closeLiveOptionsPosition(id: number, input: CloseLiveOptionsPositionInput): LiveOptionsPosition | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE autotrade_live_options_positions
       SET status = 'closed', exit_price = ?, short_exit_price = ?, exit_at = ?, exit_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(input.exitPrice, input.shortExitPrice ?? null, now, input.exitReason, now, id);
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(id) as Row;
  return map(row);
}

/**
 * Merge a further instalment of the SAME entry order into an already-open live
 * options position: grow the contract count and blend the entry price toward
 * the new fill, so cost basis stays honest when an order fills in more than one
 * execution.
 *
 * Needed because this table holds one row per entry order (the intent's
 * position id is a single column), so a second instalment can't become its own
 * row the way the human Positions ledger books lots — it has to fold into the
 * first. A no-op (returns null) if the position is missing or already closed,
 * so a late fill on a position that's since been exited can't resurrect it.
 */
/** Reduce an OPEN position's contract count by `byQty`, leaving it open.
 *  For a partially-filled closing order: the row carries a single exit price /
 *  exit_at pair, so it cannot represent a part-closed position — and closing it
 *  outright on a partial fill drops the untouched contracts out of the ledger
 *  entirely (they leave listOpenLiveOptionsPositions, so nothing re-prices,
 *  re-exits, or reconciles them). Shrinking instead keeps the remainder visible
 *  and still being worked; the close is booked when the rest fills.
 *  Returns null if the position isn't open or `byQty` would not leave a
 *  positive remainder (the caller closes it properly in that case). */
export function reduceLiveOptionsPositionQuantity(id: number, byQty: number): LiveOptionsPosition | null {
  if (!Number.isFinite(byQty) || byQty <= 0) return null;
  const existing = db
    .prepare("SELECT * FROM autotrade_live_options_positions WHERE id = ? AND status = 'open'")
    .get(id) as Row | undefined;
  if (!existing) return null;
  const remaining = existing.quantity - byQty;
  if (remaining <= 0) return null;
  db.prepare('UPDATE autotrade_live_options_positions SET quantity = ?, updated_at = ? WHERE id = ?').run(
    remaining,
    Date.now(),
    id,
  );
  return map(db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(id) as Row);
}

export function blendLiveOptionsPositionEntry(
  id: number,
  addQuantity: number,
  addPrice: number,
): LiveOptionsPosition | null {
  const existing = db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(id) as Row | undefined;
  if (!existing || existing.status !== 'open' || addQuantity <= 0) return null;

  const newQty = existing.quantity + addQuantity;
  const blended = newQty > 0 ? (existing.entry_price * existing.quantity + addPrice * addQuantity) / newQty : addPrice;
  db.prepare(
    'UPDATE autotrade_live_options_positions SET quantity = ?, entry_price = ?, updated_at = ? WHERE id = ?',
  ).run(newQty, blended, Date.now(), id);
  return map(db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(id) as Row);
}

export function getLiveOptionsPosition(id: number): LiveOptionsPosition | undefined {
  const row = db.prepare('SELECT * FROM autotrade_live_options_positions WHERE id = ?').get(id) as Row | undefined;
  return row ? map(row) : undefined;
}

/** All currently-open live options positions, oldest first — what the loop
 *  checks for the time-exit trigger every cycle (unfiltered — a time-exit
 *  check doesn't care which account a position lives in). Pass `filter` to
 *  additionally scope by account, for the broker-truth sync in
 *  liveOptionsExecute.ts, which very much does care. */
export function listOpenLiveOptionsPositions(filter: OpenLiveOptionsPositionsFilter = {}): LiveOptionsPosition[] {
  const where = ["status = 'open'"];
  const params: unknown[] = [];
  if (filter.accountId) {
    where.push(filter.includeUnassignedAccount ? '(account_id = ? OR account_id IS NULL)' : 'account_id = ?');
    params.push(filter.accountId);
  }
  const rows = db
    .prepare(`SELECT * FROM autotrade_live_options_positions WHERE ${where.join(' AND ')} ORDER BY entry_at ASC`)
    .all(...params) as Row[];
  return rows.map(map);
}

/** Manual correction — claim a legacy pre-migration row for a specific
 *  account, or fix a row the account-blind sync bug (2026-07-17 and
 *  earlier) mis-tracked. */
export function setLiveOptionsPositionAccount(id: number, accountId: string | null): LiveOptionsPosition | undefined {
  db.prepare('UPDATE autotrade_live_options_positions SET account_id = ?, updated_at = ? WHERE id = ?').run(
    accountId,
    Date.now(),
    id,
  );
  return getLiveOptionsPosition(id);
}

/** Realized P&L of a live options position at `exitPrice` (and, for a debit
 *  spread, `shortExitPrice`) — per-contract premium × quantity × the standard
 *  US option multiplier of 100. Lives here (pure math on the row) so both the
 *  execution paths and the method-performance ledger use one formula. */
export function liveOptionsPnl(
  p: Pick<LiveOptionsPosition, 'kind' | 'entryPrice' | 'shortEntryPrice' | 'quantity' | 'shortExitPrice'>,
  exitPrice: number,
  shortExitPrice: number | null = p.shortExitPrice,
): number {
  if (p.kind === 'debit_spread') {
    const netDebitAtEntry = p.entryPrice - (p.shortEntryPrice ?? 0);
    const netCreditAtExit = exitPrice - (shortExitPrice ?? 0);
    return (netCreditAtExit - netDebitAtEntry) * p.quantity * 100;
  }
  return (exitPrice - p.entryPrice) * p.quantity * 100;
}

/** True if `symbol` (the underlying) already has an open live options
 *  position — mirrors autotradeOptionsPaperPositions.ts's own idempotency
 *  check, per-underlying not per-contract. */
export function hasOpenLiveOptionsPosition(symbol: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM autotrade_live_options_positions WHERE symbol = ? AND status = 'open' LIMIT 1")
    .get(symbol.toUpperCase());
  return !!row;
}

/** Live options trade history (open + closed), newest first — for the
 *  Auto-Trade page's live options positions view. */
export function listLiveOptionsPositions(filter: ListLiveOptionsPositionsFilter = {}): LiveOptionsPosition[] {
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
    .prepare(`SELECT * FROM autotrade_live_options_positions ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Row[];
  return rows.map(map);
}
