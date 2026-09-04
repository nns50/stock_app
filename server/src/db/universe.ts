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
  return (db.prepare('SELECT symbol FROM universe ORDER BY symbol').all() as { symbol: string }[]).map((r) => r.symbol);
}

export interface UniverseAddResult {
  /** Rows that did not exist before. */
  added: number;
  /** Existing rows whose NULL name/sector this call filled in. */
  backfilled: number;
}

/**
 * Add symbols, and backfill a missing `sector` (or `name`) on one that is
 * already there.
 *
 * The plain INSERT OR IGNORE this replaced discarded the sector silently
 * whenever the symbol existed, which made a wrong sector impossible to correct
 * through the API — there is no update route — and the only alternatives were
 * DELETE-then-re-add or `replaceUniverse`, which wipes all 528 rows.
 *
 * That cost six sessions. SPY and QQQ were added on 2026-08-27 to give the book
 * an index instrument, with sector NULL. `classifySector` reads the universe's
 * own sector FIRST and only falls through to Yahoo fundamentals when it is
 * missing — and fundamentals returns no sector for an ETF, so the screen
 * classified them `unknown` and skipped them on every tick. 200 of 200 journal
 * rows for each were `skipped_unknown_sector`, and neither was ever scored.
 * A NULL sector self-heals for an ordinary company (fundamentals fills it in);
 * for an ETF it never can.
 *
 * COALESCE, not overwrite: a stored value always wins, so re-adding a symbol
 * can never clobber a curated sector with a blank or a guess. Only NULL is
 * filled.
 */
export function addSymbols(symbols: { symbol: string; name?: string; sector?: string }[]): UniverseAddResult {
  const insert = db.prepare('INSERT OR IGNORE INTO universe(symbol, name, sector, added_at) VALUES (?, ?, ?, ?)');
  const backfill = db.prepare(
    `UPDATE universe SET name = COALESCE(name, ?), sector = COALESCE(sector, ?)
     WHERE symbol = ? AND ((name IS NULL AND ? IS NOT NULL) OR (sector IS NULL AND ? IS NOT NULL))`,
  );
  const now = Date.now();
  let added = 0;
  let backfilled = 0;
  const tx = db.transaction((items: { symbol: string; name?: string; sector?: string }[]) => {
    for (const it of items) {
      if (!it.symbol) continue;
      const sym = it.symbol.toUpperCase();
      const name = it.name ?? null;
      const sector = it.sector ?? null;
      const res = insert.run(sym, name, sector, now);
      if (res.changes > 0) {
        added += res.changes;
        continue;
      }
      backfilled += backfill.run(name, sector, sym, name, sector).changes;
    }
  });
  tx(symbols);
  return { added, backfilled };
}

export function removeSymbol(symbol: string): boolean {
  return db.prepare('DELETE FROM universe WHERE symbol = ?').run(symbol.toUpperCase()).changes > 0;
}

export function replaceUniverse(symbols: { symbol: string; name?: string; sector?: string }[]): number {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM universe').run();
    return addSymbols(symbols).added;
  });
  return tx();
}
