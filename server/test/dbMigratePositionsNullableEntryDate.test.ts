import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildPositionsTableForNullableEntryDate } from '../src/db';

// ---------------------------------------------------------------------------
// The positions rebuild is the only one in this codebase with a DEPENDENT
// table: position_exits.position_id is REFERENCES positions(id) ON DELETE
// CASCADE. A careless rebuild therefore deletes the entire realized-P&L
// history as a side effect of dropping the old table — silently, and with the
// new table looking perfectly healthy afterwards.
//
// These tests exist for that one hazard. They build the OLD schema by hand
// (NOT NULL entry_date, with the real foreign key) so the migration is
// exercised against what a live database actually looks like.
// ---------------------------------------------------------------------------

const OLD_POSITIONS_SQL = `
CREATE TABLE positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type  TEXT NOT NULL CHECK(asset_type IN ('stock','option')),
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('long','short')),
  quantity    REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_date  TEXT NOT NULL,
  entry_time  TEXT,
  fees        REAL NOT NULL DEFAULT 0,
  option_type TEXT CHECK(option_type IN ('call','put') OR option_type IS NULL),
  strike      REAL,
  expiration  TEXT,
  multiplier  INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  tags        TEXT,
  grade       TEXT,
  notes       TEXT,
  checklist   TEXT,
  stop_price  REAL,
  target_price REAL,
  source_intent_id INTEGER,
  account_id  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE position_exits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  exit_price  REAL NOT NULL,
  exit_date   TEXT NOT NULL,
  fees        REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  source_intent_id INTEGER,
  created_at  INTEGER NOT NULL
);`;

function oldDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(OLD_POSITIONS_SQL);
  const insertPos = db.prepare(
    `INSERT INTO positions (id, asset_type, symbol, side, quantity, entry_price, entry_date, fees,
                            multiplier, status, tags, account_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,1,?,?,?,1,1)`,
  );
  insertPos.run(7, 'stock', 'AAPL', 'long', 100, 90, '2026-07-01', 'closed', '["webull"]', 'ACC1');
  insertPos.run(9, 'stock', 'MSFT', 'long', 50, 400, '2026-07-02', 'open', null, null);
  const insertExit = db.prepare(
    `INSERT INTO position_exits (id, position_id, quantity, exit_price, exit_date, fees, notes, created_at)
     VALUES (?,?,?,?,?,0,?,1)`,
  );
  insertExit.run(1, 7, 60, 110, '2026-07-10', 'partial');
  insertExit.run(2, 7, 40, 115, '2026-07-11', 'rest');
  return db;
}

describe('rebuildPositionsTableForNullableEntryDate', () => {
  it('does not take the exits down with it — the whole point of this migration', () => {
    const db = oldDb();
    expect(db.prepare('SELECT COUNT(*) c FROM position_exits').get()).toEqual({ c: 2 });

    rebuildPositionsTableForNullableEntryDate(db);

    // Dropping the old table under an ON DELETE CASCADE would have wiped these.
    const exits = db.prepare('SELECT id, position_id, exit_price FROM position_exits ORDER BY id').all();
    expect(exits).toEqual([
      { id: 1, position_id: 7, exit_price: 110 },
      { id: 2, position_id: 7, exit_price: 115 },
    ]);
  });

  it('preserves position ids exactly, since the exits point at them', () => {
    const db = oldDb();
    rebuildPositionsTableForNullableEntryDate(db);
    expect(db.prepare('SELECT id, symbol FROM positions ORDER BY id').all()).toEqual([
      { id: 7, symbol: 'AAPL' },
      { id: 9, symbol: 'MSFT' },
    ]);
  });

  it('carries every column across, not just the ones the migration cares about', () => {
    const db = oldDb();
    rebuildPositionsTableForNullableEntryDate(db);
    expect(db.prepare('SELECT * FROM positions WHERE id = 7').get()).toMatchObject({
      asset_type: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entry_price: 90,
      entry_date: '2026-07-01',
      status: 'closed',
      tags: '["webull"]',
      account_id: 'ACC1',
    });
  });

  it('actually accepts a null entry date afterwards', () => {
    const db = oldDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date,
                                  fees, multiplier, status, created_at, updated_at)
           VALUES ('stock','NVDA','long',1,100,NULL,0,1,'open',1,1)`,
        )
        .run(),
    ).toThrow(); // NOT NULL still in force before the migration

    rebuildPositionsTableForNullableEntryDate(db);

    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date,
                              fees, multiplier, status, created_at, updated_at)
       VALUES ('stock','NVDA','long',1,100,NULL,0,1,'open',1,1)`,
    ).run();
    expect(db.prepare("SELECT entry_date FROM positions WHERE symbol = 'NVDA'").get()).toEqual({ entry_date: null });
  });

  it('leaves the foreign key intact and still cascading', () => {
    const db = oldDb();
    rebuildPositionsTableForNullableEntryDate(db);

    // The rename-old-first ordering would have left this FK pointing at a
    // dropped `positions_old`, so nothing would cascade and foreign_key_check
    // would report the orphans.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare('DELETE FROM positions WHERE id = 7').run();
    expect(db.prepare('SELECT COUNT(*) c FROM position_exits').get()).toEqual({ c: 0 });
  });

  it('restores foreign-key enforcement afterwards', () => {
    const db = oldDb();
    rebuildPositionsTableForNullableEntryDate(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is a no-op on a database that has already been migrated', () => {
    const db = oldDb();
    rebuildPositionsTableForNullableEntryDate(db);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'positions'").get();

    rebuildPositionsTableForNullableEntryDate(db);

    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'positions'").get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) c FROM position_exits').get()).toEqual({ c: 2 });
  });

  it('survives an older table that never got the later ADD COLUMNs', () => {
    // The explicit-column copy intersects with what the live table has, so a
    // pre-account_id database migrates instead of failing on "no such column".
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_type TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
        quantity REAL NOT NULL, entry_price REAL NOT NULL, entry_date TEXT NOT NULL,
        fees REAL NOT NULL DEFAULT 0, multiplier INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open', tags TEXT, grade TEXT, notes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );`);
    db.prepare(
      `INSERT INTO positions (id, asset_type, symbol, side, quantity, entry_price, entry_date, created_at, updated_at)
       VALUES (3,'stock','KO','long',10,60,'2026-06-01',1,1)`,
    ).run();

    rebuildPositionsTableForNullableEntryDate(db);

    expect(db.prepare('SELECT id, symbol, entry_date FROM positions').all()).toEqual([
      { id: 3, symbol: 'KO', entry_date: '2026-06-01' },
    ]);
    // ...and the columns it never had come back as the new table's defaults.
    expect(db.prepare('SELECT account_id, entry_time FROM positions WHERE id = 3').get()).toEqual({
      account_id: null,
      entry_time: null,
    });
  });
});
