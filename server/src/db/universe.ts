import { db } from './index';

export interface UniverseSymbol {
  symbol: string;
  name: string | null;
  sector: string | null;
  addedAt: number;
}

interface UniverseRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  added_at: number;
}

function map(row: UniverseRow): UniverseSymbol {
  return { symbol: row.symbol, name: row.name, sector: row.sector, addedAt: row.added_at };
}

export function listUniverse(): UniverseSymbol[] {
  return (db.prepare('SELECT * FROM universe ORDER BY symbol').all() as UniverseRow[]).map(map);
}

export function listUniverseSymbols(): string[] {
  return (db.prepare('SELECT symbol FROM universe ORDER BY symbol').all() as { symbol: string }[]).map(
    (r) => r.symbol,
  );
}

export function addSymbols(symbols: { symbol: string; name?: string; sector?: string }[]): number {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO universe(symbol, name, sector, added_at) VALUES (?, ?, ?, ?)',
  );
  const now = Date.now();
  let added = 0;
  const tx = db.transaction((items: { symbol: string; name?: string; sector?: string }[]) => {
    for (const it of items) {
      if (!it.symbol) continue;
      const res = insert.run(it.symbol.toUpperCase(), it.name ?? null, it.sector ?? null, now);
      added += res.changes;
    }
  });
  tx(symbols);
  return added;
}

export function removeSymbol(symbol: string): boolean {
  return db.prepare('DELETE FROM universe WHERE symbol = ?').run(symbol.toUpperCase()).changes > 0;
}

export function replaceUniverse(symbols: { symbol: string; name?: string; sector?: string }[]): number {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM universe').run();
    return addSymbols(symbols);
  });
  return tx();
}
