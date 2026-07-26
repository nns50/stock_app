import { db } from './index';
import { safeJsonParse } from '../util/json';

export type AssetType = 'stock' | 'option';
export type Side = 'long' | 'short';
export type OptionType = 'call' | 'put';

/** One acknowledged pre-trade discipline rule, recorded with the entry. */
export interface ChecklistItem {
  rule: string;
  checked: boolean;
}

export interface PositionInput {
  assetType: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  /** Null ONLY where it is genuinely unknown — the Webull holdings endpoint
   *  reports an aggregate position with no open date, so an imported lot may
   *  legitimately have none. Manually logged trades always carry one. */
  entryDate: string | null;
  /** Optional local entry time (HH:MM) for time-of-day analytics. */
  entryTime?: string | null;
  fees?: number;
  optionType?: OptionType | null;
  strike?: number | null;
  expiration?: string | null;
  multiplier?: number;
  tags?: string[];
  grade?: string | null;
  notes?: string | null;
  checklist?: ChecklistItem[] | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  /** The order_intents.id whose live fill produced this position (entry-side
   *  execution-quality provenance). Omit for a manually logged/imported trade. */
  sourceIntentId?: number | null;
  /** The Webull account this lot lives in (imported/live-traded only). Omit
   *  for a manually-logged position — there's no brokerage account to record. */
  accountId?: string | null;
  /** At-entry context, stamped by autotrade's live materialization (see the
   *  positions DDL comment in db/index.ts). Omit for manual/imported trades. */
  entryScore?: number | null;
  /** 'risk-on' | 'neutral' | 'risk-off' — the market regime label at entry. */
  marketRegime?: string | null;
  /** Market (SPY) ATR% the loop read the cycle this entry was placed. */
  marketAtrPct?: number | null;
}

/** Why an exit happened. Stamped by autotrade's live exit materialization —
 *  'stop'/'target' from which bracket leg filled, 'time_exit' from the
 *  maxHoldDays close, 'manual' from a human-triggered close. Null (absent) for
 *  hand-logged exits and rows that predate the column. */
export type PositionExitReason = 'stop' | 'target' | 'time_exit' | 'manual';

export interface PositionExit {
  id: number;
  positionId: number;
  quantity: number;
  exitPrice: number;
  exitDate: string;
  fees: number;
  notes: string | null;
  /** The order_intents.id whose live fill produced this exit. */
  sourceIntentId: number | null;
  /** Why this exit happened — see PositionExitReason. */
  exitReason: PositionExitReason | null;
  createdAt: number;
}

export interface Position {
  id: number;
  assetType: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  /** Null means "we do not know when this was opened", not "today". Every
   *  statistic that needs a date excludes these rows rather than guessing —
   *  see services/pnl.ts and services/washSale.ts. */
  entryDate: string | null;
  entryTime: string | null;
  fees: number;
  optionType: OptionType | null;
  strike: number | null;
  expiration: string | null;
  multiplier: number;
  status: 'open' | 'closed';
  tags: string[];
  grade: string | null;
  notes: string | null;
  checklist: ChecklistItem[];
  stopPrice: number | null;
  targetPrice: number | null;
  sourceIntentId: number | null;
  accountId: string | null;
  /** At-entry context — autotrade-stamped, null for manual/imported trades
   *  and rows that predate these columns (see the DDL comment in db/index.ts). */
  entryScore: number | null;
  marketRegime: string | null;
  marketAtrPct: number | null;
  createdAt: number;
  updatedAt: number;
  exits: PositionExit[];
  /** Convenience: quantity remaining open. */
  remainingQuantity: number;
}

interface PositionRow {
  id: number;
  asset_type: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entry_price: number;
  entry_date: string | null;
  entry_time: string | null;
  fees: number;
  option_type: OptionType | null;
  strike: number | null;
  expiration: string | null;
  multiplier: number;
  status: 'open' | 'closed';
  tags: string | null;
  grade: string | null;
  notes: string | null;
  checklist: string | null;
  stop_price: number | null;
  target_price: number | null;
  source_intent_id: number | null;
  account_id: string | null;
  entry_score: number | null;
  market_regime: string | null;
  market_atr_pct: number | null;
  created_at: number;
  updated_at: number;
}

interface ExitRow {
  id: number;
  position_id: number;
  quantity: number;
  exit_price: number;
  exit_date: string;
  fees: number;
  notes: string | null;
  source_intent_id: number | null;
  exit_reason: PositionExitReason | null;
  created_at: number;
}

function mapExit(r: ExitRow): PositionExit {
  return {
    id: r.id,
    positionId: r.position_id,
    quantity: r.quantity,
    exitPrice: r.exit_price,
    exitDate: r.exit_date,
    fees: r.fees,
    notes: r.notes,
    sourceIntentId: r.source_intent_id,
    exitReason: r.exit_reason ?? null,
    createdAt: r.created_at,
  };
}

function exitsFor(positionId: number): PositionExit[] {
  return (
    db.prepare('SELECT * FROM position_exits WHERE position_id = ? ORDER BY exit_date, id').all(positionId) as ExitRow[]
  ).map(mapExit);
}

/** One query for every id instead of one per id — for listPositions() below,
 *  which otherwise fetches each returned position's own exits separately. */
function exitsForMany(positionIds: number[]): Map<number, PositionExit[]> {
  const byPosition = new Map<number, PositionExit[]>();
  if (positionIds.length === 0) return byPosition;
  const rows = db
    .prepare(
      `SELECT * FROM position_exits WHERE position_id IN (${positionIds.map(() => '?').join(',')}) ORDER BY exit_date, id`,
    )
    .all(...positionIds) as ExitRow[];
  for (const r of rows) {
    const exit = mapExit(r);
    const arr = byPosition.get(exit.positionId);
    if (arr) arr.push(exit);
    else byPosition.set(exit.positionId, [exit]);
  }
  return byPosition;
}

/** `exits`, when passed, must already be this row's own — a caller batching
 *  many rows (listPositions()) supplies its own pre-fetched slice instead of
 *  letting this function fetch it itself, one query per row. Omitted (the
 *  single-position callers below), it falls back to that one-off fetch. */
function mapPosition(row: PositionRow, exits?: PositionExit[]): Position {
  const resolvedExits = exits ?? exitsFor(row.id);
  const closedQty = resolvedExits.reduce((s, e) => s + e.quantity, 0);
  return {
    id: row.id,
    assetType: row.asset_type,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    entryPrice: row.entry_price,
    entryDate: row.entry_date,
    entryTime: row.entry_time,
    fees: row.fees,
    optionType: row.option_type,
    strike: row.strike,
    expiration: row.expiration,
    multiplier: row.multiplier,
    status: row.status,
    tags: safeJsonParse<string[]>(row.tags, []),
    grade: row.grade,
    notes: row.notes,
    checklist: safeJsonParse<ChecklistItem[]>(row.checklist, []),
    stopPrice: row.stop_price,
    targetPrice: row.target_price,
    sourceIntentId: row.source_intent_id,
    accountId: row.account_id,
    entryScore: row.entry_score ?? null,
    marketRegime: row.market_regime ?? null,
    marketAtrPct: row.market_atr_pct ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    exits: resolvedExits,
    remainingQuantity: Math.max(0, row.quantity - closedQty),
  };
}

/**
 * The date to ORDER a position by when a list needs some order and the entry
 * date may be unknown — falling back to the day the row was recorded.
 *
 * Never use this for a statistic. It is a proxy for sequencing, not a claim
 * about when the trade was opened; that distinction is the entire point of
 * letting entryDate be null. Deliberately UTC, to match the COALESCE in
 * listPositions' ORDER BY so the in-memory sorts agree with the SQL one.
 */
export function orderingDateOf(p: { entryDate: string | null; createdAt: number }): string {
  return p.entryDate ?? new Date(p.createdAt).toISOString().slice(0, 10);
}

export interface PositionFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  assetType?: AssetType;
  /** Exact-match a Webull account. A position with no recorded account
   *  (manually logged, or a legacy row from before this column existed)
   *  never matches unless includeUnassignedAccount is also set. */
  accountId?: string;
  /** Only meaningful together with accountId. Also matches positions with NO
   *  recorded account — safe for "is this symbol already tracked under this
   *  account" dedup checks (an unassigned row effectively gets claimed by
   *  whichever account's sync confirms it first). NEVER safe for
   *  close-detection: closing something we're not certain belongs to this
   *  account would risk the exact false-close bug this column exists to
   *  prevent, so the close-detector deliberately omits this flag. */
  includeUnassignedAccount?: boolean;
}

export function listPositions(filter: PositionFilter = {}): Position[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.symbol) {
    where.push('symbol = ?');
    params.push(filter.symbol.toUpperCase());
  }
  if (filter.assetType) {
    where.push('asset_type = ?');
    params.push(filter.assetType);
  }
  if (filter.accountId) {
    where.push(filter.includeUnassignedAccount ? '(account_id = ? OR account_id IS NULL)' : 'account_id = ?');
    params.push(filter.accountId);
  }
  // Ordering and analytics want different things: analytics need the truth
  // (null when unknown), but a list still needs SOME order. An undated lot
  // falls back to the day it was recorded, which is a sane proxy for "when did
  // this enter the book" without any of it leaking into a statistic — the
  // COALESCE lives here in the ORDER BY only, never in the selected value.
  const sql = `SELECT * FROM positions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(entry_date, date(created_at / 1000, 'unixepoch')) DESC, id DESC`;
  const rows = db.prepare(sql).all(...params) as PositionRow[];
  const exitsByPosition = exitsForMany(rows.map((r) => r.id));
  return rows.map((row) => mapPosition(row, exitsByPosition.get(row.id) ?? []));
}

export function getPosition(id: number): Position | undefined {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as PositionRow | undefined;
  return row ? mapPosition(row) : undefined;
}

/** Every distinct non-null account_id the journal has ever recorded (any
 *  status). Used by the Webull close-sync to tell a single-account setup —
 *  where an unassigned legacy row can only belong to the one account being
 *  synced — apart from a genuine multi-account one, where auto-closing an
 *  unassigned row could be a cross-account false close. A closed position
 *  still counts: it's proof that account existed. */
export function listKnownAccountIds(): string[] {
  const rows = db
    .prepare("SELECT DISTINCT account_id FROM positions WHERE account_id IS NOT NULL AND account_id != ''")
    .all() as { account_id: string }[];
  return rows.map((r) => r.account_id);
}

export function createPosition(input: PositionInput): Position {
  const now = Date.now();
  const multiplier = input.multiplier ?? (input.assetType === 'option' ? 100 : 1);
  const res = db
    .prepare(
      `INSERT INTO positions
        (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees,
         option_type, strike, expiration, multiplier, status, tags, grade, notes, checklist,
         stop_price, target_price, source_intent_id, account_id,
         entry_score, market_regime, market_atr_pct, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.assetType,
      input.symbol.toUpperCase(),
      input.side,
      input.quantity,
      input.entryPrice,
      input.entryDate,
      input.entryTime ?? null,
      input.fees ?? 0,
      input.optionType ?? null,
      input.strike ?? null,
      input.expiration ?? null,
      multiplier,
      input.tags ? JSON.stringify(input.tags) : null,
      input.grade ?? null,
      input.notes ?? null,
      input.checklist && input.checklist.length ? JSON.stringify(input.checklist) : null,
      input.stopPrice ?? null,
      input.targetPrice ?? null,
      input.sourceIntentId ?? null,
      input.accountId ?? null,
      input.entryScore ?? null,
      input.marketRegime ?? null,
      input.marketAtrPct ?? null,
      now,
      now,
    );
  return getPosition(Number(res.lastInsertRowid))!;
}

export interface PositionPatch {
  tags?: string[];
  grade?: string | null;
  notes?: string | null;
  entryPrice?: number;
  quantity?: number;
  fees?: number;
  entryDate?: string | null;
  entryTime?: string | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  /** Manual correction — e.g. tagging a legacy pre-migration row, or fixing
   *  a row the account-blind sync bug (2026-07-17 and earlier) mis-tracked. */
  accountId?: string | null;
}

export function updatePosition(id: number, patch: PositionPatch): Position | undefined {
  const existing = getPosition(id);
  if (!existing) return undefined;
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
  if (patch.grade !== undefined) set('grade', patch.grade);
  if (patch.notes !== undefined) set('notes', patch.notes);
  if (patch.entryPrice !== undefined) set('entry_price', patch.entryPrice);
  if (patch.quantity !== undefined) set('quantity', patch.quantity);
  if (patch.fees !== undefined) set('fees', patch.fees);
  if (patch.entryDate !== undefined) set('entry_date', patch.entryDate);
  if (patch.entryTime !== undefined) set('entry_time', patch.entryTime);
  if (patch.stopPrice !== undefined) set('stop_price', patch.stopPrice);
  if (patch.targetPrice !== undefined) set('target_price', patch.targetPrice);
  if (patch.accountId !== undefined) set('account_id', patch.accountId);
  if (fields.length === 0) return existing;
  set('updated_at', Date.now());
  params.push(id);
  db.prepare(`UPDATE positions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  recomputeStatus(id);
  return getPosition(id);
}

export function deletePosition(id: number): boolean {
  return db.prepare('DELETE FROM positions WHERE id = ?').run(id).changes > 0;
}

export interface ExitInput {
  quantity: number;
  exitPrice: number;
  exitDate: string;
  fees?: number;
  notes?: string | null;
  /** The order_intents.id whose live fill produced this exit. */
  sourceIntentId?: number | null;
  /** Why this exit happened — see PositionExitReason. Omit when unknown
   *  (hand-logged exits); never guess one. */
  exitReason?: PositionExitReason | null;
}

export function addExit(positionId: number, input: ExitInput): Position | undefined {
  const pos = getPosition(positionId);
  if (!pos) return undefined;
  const now = Date.now();
  db.prepare(
    `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, notes, source_intent_id, exit_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    positionId,
    input.quantity,
    input.exitPrice,
    input.exitDate,
    input.fees ?? 0,
    input.notes ?? null,
    input.sourceIntentId ?? null,
    input.exitReason ?? null,
    now,
  );
  recomputeStatus(positionId);
  return getPosition(positionId);
}

/**
 * Correct a recorded exit's PRICE in place, leaving its quantity and date alone.
 *
 * Narrow on purpose. This exists for one job — replacing an ESTIMATED exit price
 * with the real fill the broker reported (services/exitPriceBackfill.ts) — and a
 * general-purpose exit updater would be a much easier way to corrupt realized
 * P&L than anything that job needs. Quantity is deliberately not touchable here:
 * changing it would move the position's remaining size and could reopen a closed
 * position, so a quantity disagreement is a reason to REFUSE a correction, not
 * to apply one.
 *
 * Returns the refreshed position, or undefined if the exit id is unknown.
 */
export function correctExitPrice(exitId: number, exitPrice: number, notes: string): Position | undefined {
  const row = db.prepare('SELECT position_id FROM position_exits WHERE id = ?').get(exitId) as
    { position_id: number } | undefined;
  if (!row) return undefined;
  db.prepare('UPDATE position_exits SET exit_price = ?, notes = ? WHERE id = ?').run(exitPrice, notes, exitId);
  // Status is a function of QUANTITY, not price, so it cannot change here —
  // recomputed anyway so this can never silently leave a stale derived value.
  recomputeStatus(row.position_id);
  return getPosition(row.position_id);
}

export function deleteExit(exitId: number): boolean {
  const row = db.prepare('SELECT position_id FROM position_exits WHERE id = ?').get(exitId) as
    { position_id: number } | undefined;
  const changed = db.prepare('DELETE FROM position_exits WHERE id = ?').run(exitId).changes > 0;
  if (changed && row) recomputeStatus(row.position_id);
  return changed;
}

export interface ImportableExit {
  quantity: number;
  exitPrice: number;
  exitDate: string;
  fees?: number;
  notes?: string | null;
  sourceIntentId?: number | null;
  exitReason?: PositionExitReason | null;
  createdAt?: number;
}

export interface ImportablePosition {
  assetType: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  entryDate: string | null;
  entryTime?: string | null;
  fees?: number;
  optionType?: OptionType | null;
  strike?: number | null;
  expiration?: string | null;
  multiplier?: number;
  status?: 'open' | 'closed';
  tags?: string[];
  grade?: string | null;
  notes?: string | null;
  checklist?: ChecklistItem[] | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  sourceIntentId?: number | null;
  accountId?: string | null;
  entryScore?: number | null;
  marketRegime?: string | null;
  marketAtrPct?: number | null;
  createdAt?: number;
  updatedAt?: number;
  exits?: ImportableExit[];
}

export interface ImportResult {
  imported: number;
  replaced: boolean;
}

/**
 * Restore positions (and their exits) from a previous export. In 'replace' mode
 * existing positions are cleared first; 'merge' appends. Runs in a single
 * transaction so a bad payload leaves the DB untouched. New IDs are assigned.
 */
export function importPositions(positions: ImportablePosition[], mode: 'merge' | 'replace'): ImportResult {
  const insertPos = db.prepare(
    `INSERT INTO positions
       (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees,
        option_type, strike, expiration, multiplier, status, tags, grade, notes, checklist,
        stop_price, target_price, source_intent_id, account_id,
        entry_score, market_regime, market_atr_pct, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertExit = db.prepare(
    `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, notes, source_intent_id, exit_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const tx = db.transaction((items: ImportablePosition[]) => {
    if (mode === 'replace') db.prepare('DELETE FROM positions').run();
    const now = Date.now();
    let imported = 0;
    for (const p of items) {
      const multiplier = p.multiplier ?? (p.assetType === 'option' ? 100 : 1);
      const res = insertPos.run(
        p.assetType,
        p.symbol.toUpperCase(),
        p.side,
        p.quantity,
        p.entryPrice,
        p.entryDate,
        p.entryTime ?? null,
        p.fees ?? 0,
        p.optionType ?? null,
        p.strike ?? null,
        p.expiration ?? null,
        multiplier,
        p.status === 'closed' ? 'closed' : 'open',
        p.tags && p.tags.length ? JSON.stringify(p.tags) : null,
        p.grade ?? null,
        p.notes ?? null,
        p.checklist && p.checklist.length ? JSON.stringify(p.checklist) : null,
        p.stopPrice ?? null,
        p.targetPrice ?? null,
        p.sourceIntentId ?? null,
        p.accountId ?? null,
        p.entryScore ?? null,
        p.marketRegime ?? null,
        p.marketAtrPct ?? null,
        p.createdAt ?? now,
        p.updatedAt ?? now,
      );
      const pid = Number(res.lastInsertRowid);
      for (const e of p.exits ?? []) {
        insertExit.run(
          pid,
          e.quantity,
          e.exitPrice,
          e.exitDate,
          e.fees ?? 0,
          e.notes ?? null,
          e.sourceIntentId ?? null,
          e.exitReason ?? null,
          e.createdAt ?? now,
        );
      }
      recomputeStatus(pid);
      imported++;
    }
    return imported;
  });
  return { imported: tx(positions), replaced: mode === 'replace' };
}

/** Flip status to 'closed' once the position is fully exited (within epsilon). */
function recomputeStatus(positionId: number): void {
  const pos = getPosition(positionId);
  if (!pos) return;
  const status = pos.remainingQuantity <= 1e-9 ? 'closed' : 'open';
  if (status !== pos.status) {
    db.prepare('UPDATE positions SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), positionId);
  }
}
