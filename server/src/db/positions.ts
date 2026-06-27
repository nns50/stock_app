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
  entryDate: string;
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
}

export interface PositionExit {
  id: number;
  positionId: number;
  quantity: number;
  exitPrice: number;
  exitDate: string;
  fees: number;
  notes: string | null;
  createdAt: number;
}

export interface Position {
  id: number;
  assetType: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  entryDate: string;
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
  entry_date: string;
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
    createdAt: r.created_at,
  };
}

function exitsFor(positionId: number): PositionExit[] {
  return (
    db.prepare('SELECT * FROM position_exits WHERE position_id = ? ORDER BY exit_date, id').all(positionId) as ExitRow[]
  ).map(mapExit);
}

function mapPosition(row: PositionRow): Position {
  const exits = exitsFor(row.id);
  const closedQty = exits.reduce((s, e) => s + e.quantity, 0);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    exits,
    remainingQuantity: Math.max(0, row.quantity - closedQty),
  };
}

export interface PositionFilter {
  status?: 'open' | 'closed';
  symbol?: string;
  assetType?: AssetType;
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
  const sql = `SELECT * FROM positions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY entry_date DESC, id DESC`;
  return (db.prepare(sql).all(...params) as PositionRow[]).map(mapPosition);
}

export function getPosition(id: number): Position | undefined {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as PositionRow | undefined;
  return row ? mapPosition(row) : undefined;
}

export function createPosition(input: PositionInput): Position {
  const now = Date.now();
  const multiplier = input.multiplier ?? (input.assetType === 'option' ? 100 : 1);
  const res = db
    .prepare(
      `INSERT INTO positions
        (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees,
         option_type, strike, expiration, multiplier, status, tags, grade, notes, checklist,
         stop_price, target_price, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`,
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
  entryDate?: string;
  entryTime?: string | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
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
}

export function addExit(positionId: number, input: ExitInput): Position | undefined {
  const pos = getPosition(positionId);
  if (!pos) return undefined;
  const now = Date.now();
  db.prepare(
    `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, notes, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(positionId, input.quantity, input.exitPrice, input.exitDate, input.fees ?? 0, input.notes ?? null, now);
  recomputeStatus(positionId);
  return getPosition(positionId);
}

export function deleteExit(exitId: number): boolean {
  const row = db.prepare('SELECT position_id FROM position_exits WHERE id = ?').get(exitId) as
    | { position_id: number }
    | undefined;
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
  createdAt?: number;
}

export interface ImportablePosition {
  assetType: AssetType;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  entryDate: string;
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
        stop_price, target_price, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertExit = db.prepare(
    `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, notes, created_at)
     VALUES (?,?,?,?,?,?,?)`,
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
        p.createdAt ?? now,
        p.updatedAt ?? now,
      );
      const pid = Number(res.lastInsertRowid);
      for (const e of p.exits ?? []) {
        insertExit.run(pid, e.quantity, e.exitPrice, e.exitDate, e.fees ?? 0, e.notes ?? null, e.createdAt ?? now);
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
