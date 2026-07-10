import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { topUpUniverseOnce } from '../src/db';

// Minimal schema for just the two tables topUpUniverseOnce touches, mirroring
// db/index.ts's SCHEMA. Uses a throwaway in-memory DB (not the shared vitest
// DB) so this can freely exercise empty/partial/marker states without
// clobbering other test files' universe rows.
const SCHEMA = `
CREATE TABLE universe (
  symbol     TEXT PRIMARY KEY,
  name       TEXT,
  sector     TEXT,
  added_at   INTEGER NOT NULL
);
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);`;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

const countUniverse = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM universe').get() as { n: number }).n;
const hasSymbol = (db: Database.Database, symbol: string) =>
  !!db.prepare('SELECT 1 FROM universe WHERE symbol = ?').get(symbol);

// ZBH (Zimmer Biomet) is only in the 2026-07 delta file (sp500_topup_2026_07.json).
// AAPL predates the expansion — it's in sp500.json's original 124 but deliberately
// NOT in the delta file, so it's a stand-in for "a symbol the top-up must never
// touch either way" throughout these tests.

describe('topUpUniverseOnce', () => {
  it('populates a fresh/empty universe table with just the delta of newly-added symbols', () => {
    const db = freshDb();
    topUpUniverseOnce(db);
    const n = countUniverse(db);
    expect(n).toBeGreaterThan(300); // the delta file alone is 383 symbols
    expect(hasSymbol(db, 'ZBH')).toBe(true); // only present after the expansion
    expect(hasSymbol(db, 'AAPL')).toBe(false); // pre-expansion symbol, not in the delta file
  });

  it('additively tops up a table already seeded with the pre-expansion universe, without touching existing rows', () => {
    const db = freshDb();
    // Stand-in for a real production DB seeded before this expansion shipped.
    db.prepare('INSERT INTO universe(symbol, name, sector, added_at) VALUES (?, ?, ?, ?)').run(
      'AAPL',
      'Custom Name — do not overwrite',
      'Custom Sector',
      12345,
    );

    topUpUniverseOnce(db);

    expect(countUniverse(db)).toBeGreaterThan(300);
    expect(hasSymbol(db, 'ZBH')).toBe(true); // new symbol got added
    const aapl = db.prepare('SELECT name, sector, added_at FROM universe WHERE symbol = ?').get('AAPL') as {
      name: string;
      sector: string;
      added_at: number;
    };
    expect(aapl).toEqual({ name: 'Custom Name — do not overwrite', sector: 'Custom Sector', added_at: 12345 }); // untouched — AAPL isn't in the delta file at all
  });

  it('does not resurrect a pre-expansion symbol a user removed before the migration ever ran', () => {
    // The bug this guards against: naively diffing the FULL current sp500.json
    // (which still lists AAPL, since it's a union of old+new) against "not
    // currently in the table" can't tell "never seeded" apart from "user removed
    // it on purpose" — and would wrongly re-add it. Reading only the frozen delta
    // file sidesteps this entirely, since AAPL was never in that file to begin with.
    const db = freshDb();
    // No AAPL row at all — simulates a user who removed it from their live universe.

    topUpUniverseOnce(db);

    expect(hasSymbol(db, 'AAPL')).toBe(false);
    expect(hasSymbol(db, 'ZBH')).toBe(true); // the delta itself still applies normally
  });

  it('is an idempotent no-op on a second call (already topped up)', () => {
    const db = freshDb();
    topUpUniverseOnce(db);
    const first = countUniverse(db);

    topUpUniverseOnce(db);
    const second = countUniverse(db);

    expect(second).toBe(first);
  });

  it('respects the settings marker: never re-applies once set, even against an empty table', () => {
    const db = freshDb();
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
      'universeTopUp',
      JSON.stringify({ appliedAt: 1, added: 0 }),
      1,
    );

    topUpUniverseOnce(db);

    expect(countUniverse(db)).toBe(0); // marker present → bails before touching universe at all
  });

  it('sets the settings marker after applying, so a later call is a true no-op gated on it', () => {
    const db = freshDb();
    topUpUniverseOnce(db);

    const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get('universeTopUp') as
      | { value: string }
      | undefined;
    expect(marker).toBeDefined();
    const parsed = JSON.parse(marker!.value) as { appliedAt: number; added: number };
    expect(parsed.added).toBeGreaterThan(300);
  });

  it('respects a user removing a top-up-added symbol afterwards (does not re-add on a later call)', () => {
    const db = freshDb();
    topUpUniverseOnce(db);
    expect(hasSymbol(db, 'ZBH')).toBe(true);

    db.prepare('DELETE FROM universe WHERE symbol = ?').run('ZBH');
    topUpUniverseOnce(db); // second call: marker is already set, must not resurrect the removed symbol

    expect(hasSymbol(db, 'ZBH')).toBe(false);
  });
});
