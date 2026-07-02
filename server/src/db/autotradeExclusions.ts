import { db } from './index';

// ---------------------------------------------------------------------------
// The real-estate exclusion list (docs/AUTOTRADING_SPEC.md — EXCLUDED SECTOR).
// Seeded once from data/reExclusions.json (see seedAutotradeExclusionsIfEmpty
// in db/index.ts); freely add/removable afterwards. This is one of two checks
// the screening stage runs — the other is a sector/industry classification
// lookup (Phase 2), for real-estate names not on this hand-maintained list.
// ---------------------------------------------------------------------------

export type ExclusionSource = 'default' | 'user';

export interface ExclusionRecord {
  symbol: string;
  reason: string | null;
  source: ExclusionSource;
  createdAt: number;
}

interface Row {
  symbol: string;
  reason: string | null;
  source: ExclusionSource;
  created_at: number;
}

function map(r: Row): ExclusionRecord {
  return { symbol: r.symbol, reason: r.reason, source: r.source, createdAt: r.created_at };
}

/** The full exclusion list, alphabetical. */
export function listExclusions(): ExclusionRecord[] {
  return (db.prepare('SELECT * FROM autotrade_exclusions ORDER BY symbol ASC').all() as Row[]).map(map);
}

/** True when `symbol` is on the exclusion list (case-insensitive). */
export function isExcluded(symbol: string): boolean {
  return !!db.prepare('SELECT 1 FROM autotrade_exclusions WHERE symbol = ?').get(symbol.toUpperCase());
}

/** Add (or update the reason on) a user-added exclusion. Re-adding an existing
 *  default entry updates its reason but leaves its `source` as 'default' — a
 *  user re-submitting a seeded symbol shouldn't reclassify its provenance. */
export function addExclusion(symbol: string, reason?: string): ExclusionRecord {
  const sym = symbol.toUpperCase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_exclusions (symbol, reason, source, created_at) VALUES (?, ?, 'user', ?)
     ON CONFLICT(symbol) DO UPDATE SET reason = excluded.reason`,
  ).run(sym, reason ?? null, now);
  return map(db.prepare('SELECT * FROM autotrade_exclusions WHERE symbol = ?').get(sym) as Row);
}

/** Remove a symbol from the exclusion list (default or user-added). Returns
 *  false if it wasn't on the list. */
export function removeExclusion(symbol: string): boolean {
  return db.prepare('DELETE FROM autotrade_exclusions WHERE symbol = ?').run(symbol.toUpperCase()).changes > 0;
}
