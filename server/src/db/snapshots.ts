import { db } from './index';

export type Direction = 'long' | 'short';

export interface SnapshotPick {
  rank: number;
  symbol: string;
  score: number;
  priceAtRun: number;
}

export interface Snapshot {
  id: number;
  createdAt: number;
  direction: Direction;
  note: string | null;
  picks: SnapshotPick[];
}

export interface SnapshotSummary {
  id: number;
  createdAt: number;
  direction: Direction;
  note: string | null;
  pickCount: number;
}

interface SnapshotRow {
  id: number;
  created_at: number;
  direction: Direction;
  note: string | null;
}

interface PickRow {
  rank: number;
  symbol: string;
  score: number;
  price_at_run: number;
}

function picksFor(snapshotId: number): SnapshotPick[] {
  const rows = db
    .prepare('SELECT rank, symbol, score, price_at_run FROM screener_picks WHERE snapshot_id = ? ORDER BY rank')
    .all(snapshotId) as PickRow[];
  return rows.map((r) => ({ rank: r.rank, symbol: r.symbol, score: r.score, priceAtRun: r.price_at_run }));
}

export function createSnapshot(
  direction: Direction,
  note: string | null,
  picks: { symbol: string; score: number; price: number }[],
): Snapshot {
  const now = Date.now();
  const insertSnap = db.prepare('INSERT INTO screener_snapshots(created_at, direction, note) VALUES (?, ?, ?)');
  const insertPick = db.prepare(
    'INSERT INTO screener_picks(snapshot_id, rank, symbol, score, price_at_run) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    const id = Number(insertSnap.run(now, direction, note).lastInsertRowid);
    picks.forEach((p, i) => insertPick.run(id, i + 1, p.symbol.toUpperCase(), p.score, p.price));
    return id;
  });
  const id = tx();
  return getSnapshot(id)!;
}

export function listSnapshots(): SnapshotSummary[] {
  const rows = db.prepare('SELECT * FROM screener_snapshots ORDER BY created_at DESC').all() as SnapshotRow[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    direction: r.direction,
    note: r.note,
    pickCount: (db.prepare('SELECT COUNT(*) AS n FROM screener_picks WHERE snapshot_id = ?').get(r.id) as { n: number })
      .n,
  }));
}

export function getSnapshot(id: number): Snapshot | undefined {
  const row = db.prepare('SELECT * FROM screener_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
  if (!row) return undefined;
  return { id: row.id, createdAt: row.created_at, direction: row.direction, note: row.note, picks: picksFor(id) };
}

export function deleteSnapshot(id: number): boolean {
  return db.prepare('DELETE FROM screener_snapshots WHERE id = ?').run(id).changes > 0;
}
