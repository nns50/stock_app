import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildAutotradeLiveOrdersTable, rebuildAutotradeLiveOptionsOrdersTable } from '../src/db';

// An older `order_intents` + live-orders pair whose FK has no ON DELETE CASCADE
// (order_events, its sibling, already did). Without the cascade, a leftover
// live-order row blocks an unrelated DELETE FROM order_intents with a FOREIGN
// KEY constraint error.
//
// This models the REAL state the rebuild operates on in migrate(): the columns
// added by later ALTER TABLE statements (account_id / addon_of_position_id /
// grade on the equity table; exit_reason / account_id on the options table)
// are ALREADY present, because those ALTERs run BEFORE the rebuild. The rebuild
// must carry them (and their data) across the table recreation.
const OLD_SCHEMA = `
CREATE TABLE order_intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  symbol          TEXT NOT NULL,
  state           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE autotrade_live_orders (
  intent_id     INTEGER PRIMARY KEY REFERENCES order_intents(id),
  symbol        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'entry',
  stop_price    REAL NOT NULL,
  target_price  REAL NOT NULL,
  risk_amount   REAL NOT NULL,
  risk_profile  TEXT NOT NULL,
  position_id   INTEGER,
  account_id    TEXT,
  addon_of_position_id INTEGER,
  grade         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE autotrade_live_options_orders (
  intent_id             INTEGER PRIMARY KEY REFERENCES order_intents(id),
  symbol                TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK(role IN ('entry','exit')),
  kind                  TEXT NOT NULL DEFAULT 'single_leg',
  side                  TEXT CHECK(side IN ('call','put') OR side IS NULL),
  contract_symbol       TEXT,
  strike                REAL,
  short_contract_symbol TEXT,
  short_strike          REAL,
  expiration            TEXT,
  risk_amount   REAL,
  risk_profile  TEXT NOT NULL,
  position_id   INTEGER,
  exit_reason   TEXT CHECK(exit_reason IN ('time_exit','manual') OR exit_reason IS NULL),
  account_id    TEXT,
  created_at    INTEGER NOT NULL
);`;

const insertIntent = (db: Database.Database, key: string) =>
  db
    .prepare(`INSERT INTO order_intents (idempotency_key, symbol, state, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(key, 'AAPL', 'draft', 1, 1).lastInsertRowid as number;

describe('rebuildAutotradeLiveOrdersTable', () => {
  it('adds ON DELETE CASCADE while preserving rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    const intentId = insertIntent(db, 'k1');
    db.prepare(
      `INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(intentId, 'AAPL', 'entry', 95, 110, 50, 'balanced', 1);

    // Before: a leftover live-order row blocks deleting its own intent.
    expect(() => db.prepare('DELETE FROM order_intents WHERE id = ?').run(intentId)).toThrow(/FOREIGN KEY/);

    rebuildAutotradeLiveOrdersTable(db);

    expect(
      (db.prepare('SELECT symbol FROM autotrade_live_orders WHERE intent_id = ?').get(intentId) as { symbol: string })
        .symbol,
    ).toBe('AAPL');

    // After: deleting the intent now cascades to its live-order row.
    db.prepare('DELETE FROM order_intents WHERE id = ?').run(intentId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM autotrade_live_orders').get() as { n: number }).toEqual({ n: 0 });
  });

  it('is a no-op once the cascade is already present (idempotent)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    rebuildAutotradeLiveOrdersTable(db);
    const cols = db.prepare('PRAGMA table_info(autotrade_live_orders)').all().length;
    rebuildAutotradeLiveOrdersTable(db);
    expect(db.prepare('PRAGMA table_info(autotrade_live_orders)').all().length).toBe(cols);
  });

  // Regression: in the REAL migrate() order, the ALTERs that add account_id /
  // addon_of_position_id / grade run BEFORE this rebuild, so the pre-CASCADE
  // table already carries those columns and their data. A rebuild that omitted
  // them from its CREATE + INSERT...SELECT silently dropped both columns and data.
  it('preserves post-ALTER columns and their data (account_id, addon_of_position_id, grade)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    const intentId = insertIntent(db, 'k1b');
    db.prepare(
      `INSERT INTO autotrade_live_orders
         (intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id,
          account_id, addon_of_position_id, grade, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(intentId, 'AAPL', 'entry', 95, 110, 50, 'balanced', 7, 'acct-123', 42, 'A', 1);

    rebuildAutotradeLiveOrdersTable(db);

    const names = (db.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(names).toEqual(expect.arrayContaining(['account_id', 'addon_of_position_id', 'grade']));
    const row = db
      .prepare('SELECT account_id, addon_of_position_id, grade FROM autotrade_live_orders WHERE intent_id = ?')
      .get(intentId);
    expect(row).toEqual({ account_id: 'acct-123', addon_of_position_id: 42, grade: 'A' });
  });
});

describe('rebuildAutotradeLiveOptionsOrdersTable', () => {
  it('adds ON DELETE CASCADE while preserving rows (including spread columns)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    const intentId = insertIntent(db, 'k2');
    db.prepare(
      `INSERT INTO autotrade_live_options_orders
         (intent_id, symbol, role, kind, side, contract_symbol, strike, short_contract_symbol, short_strike,
          expiration, risk_amount, risk_profile, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      intentId,
      'AAPL',
      'entry',
      'debit_spread',
      'call',
      'AAPL240119C00190000',
      190,
      'AAPL240119C00200000',
      200,
      '2030-01-18',
      300,
      'balanced',
      1,
    );

    // Before: a leftover live-options-order row blocks deleting its own intent.
    expect(() => db.prepare('DELETE FROM order_intents WHERE id = ?').run(intentId)).toThrow(/FOREIGN KEY/);

    rebuildAutotradeLiveOptionsOrdersTable(db);

    const row = db
      .prepare('SELECT kind, short_strike FROM autotrade_live_options_orders WHERE intent_id = ?')
      .get(intentId) as { kind: string; short_strike: number };
    expect(row).toEqual({ kind: 'debit_spread', short_strike: 200 });

    // After: deleting the intent now cascades to its live-options-order row.
    db.prepare('DELETE FROM order_intents WHERE id = ?').run(intentId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM autotrade_live_options_orders').get() as { n: number }).toEqual({
      n: 0,
    });
  });

  it('is a no-op once the cascade is already present (idempotent)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    rebuildAutotradeLiveOptionsOrdersTable(db);
    const cols = db.prepare('PRAGMA table_info(autotrade_live_options_orders)').all().length;
    rebuildAutotradeLiveOptionsOrdersTable(db);
    expect(db.prepare('PRAGMA table_info(autotrade_live_options_orders)').all().length).toBe(cols);
  });

  // Regression: exit_reason and account_id are added by ALTERs that run before
  // this rebuild in migrate(); a rebuild omitting them dropped the columns and
  // their data on any pre-CASCADE DB.
  it('preserves post-ALTER columns and their data (exit_reason, account_id)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    const intentId = insertIntent(db, 'k2b');
    db.prepare(
      `INSERT INTO autotrade_live_options_orders
         (intent_id, symbol, role, kind, position_id, exit_reason, account_id, risk_profile, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(intentId, 'AAPL', 'exit', 'single_leg', 9, 'time_exit', 'acct-777', 'balanced', 1);

    rebuildAutotradeLiveOptionsOrdersTable(db);

    const names = (db.prepare('PRAGMA table_info(autotrade_live_options_orders)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(names).toEqual(expect.arrayContaining(['exit_reason', 'account_id']));
    const row = db
      .prepare('SELECT exit_reason, account_id FROM autotrade_live_options_orders WHERE intent_id = ?')
      .get(intentId);
    expect(row).toEqual({ exit_reason: 'time_exit', account_id: 'acct-777' });
  });
});
