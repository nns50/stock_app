import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildAutotradeLiveOrdersTable, rebuildAutotradeLiveOptionsOrdersTable } from '../src/db';

// An older `order_intents` + `autotrade_live_orders` pair: the live-orders
// FK has no ON DELETE CASCADE (order_events, its sibling, already did).
// Without the cascade, a leftover live-order row blocks an unrelated
// DELETE FROM order_intents with a FOREIGN KEY constraint error.
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
});
