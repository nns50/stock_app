import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildAutotradeOptionsPaperPositionsTable } from '../src/db';

// The pre-options-exit-toolkit `autotrade_options_paper_positions` table: a
// stale exit_reason CHECK (only 'time_exit'/'manual').
// rebuildAutotradeOptionsPaperPositionsTable should copy rows through to the
// new schema and widen the CHECK to also allow 'stop_loss'/'take_profit'.
const OLD_SCHEMA = `
CREATE TABLE autotrade_options_paper_positions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                 TEXT NOT NULL,
  side                   TEXT NOT NULL CHECK(side IN ('call','put')),
  kind                   TEXT NOT NULL DEFAULT 'single_leg',
  contract_symbol        TEXT NOT NULL,
  strike                 REAL NOT NULL,
  short_contract_symbol  TEXT,
  short_strike           REAL,
  expiration             TEXT NOT NULL,
  quantity               REAL NOT NULL,
  entry_price            REAL NOT NULL,
  short_entry_price      REAL,
  entry_at               INTEGER NOT NULL,
  risk_amount            REAL NOT NULL,
  risk_profile           TEXT NOT NULL,
  rationale              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exit_price             REAL,
  short_exit_price       REAL,
  exit_at                INTEGER,
  exit_reason            TEXT CHECK(exit_reason IN ('time_exit','manual') OR exit_reason IS NULL),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_autotrade_options_paper_positions_status ON autotrade_options_paper_positions(status, symbol);`;

describe('rebuildAutotradeOptionsPaperPositionsTable', () => {
  it('copies rows to the new schema and lifts the stale exit_reason CHECK', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare(
      `INSERT INTO autotrade_options_paper_positions
         (symbol, side, kind, contract_symbol, strike, expiration, quantity, entry_price, entry_at,
          risk_amount, risk_profile, rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'AAPL',
      'call',
      'single_leg',
      'AAPL240315C00100000',
      100,
      '2024-03-15',
      2,
      3.5,
      1000,
      700,
      'MODERATE',
      'keep me',
      'closed',
      1.2,
      2000,
      'time_exit',
      1000,
      2000,
    );

    rebuildAutotradeOptionsPaperPositionsTable(db);

    const row = db
      .prepare('SELECT symbol, rationale, exit_reason FROM autotrade_options_paper_positions WHERE id = 1')
      .get() as { symbol: string; rationale: string; exit_reason: string };
    expect(row).toMatchObject({ symbol: 'AAPL', rationale: 'keep me', exit_reason: 'time_exit' });

    // The index survives the rebuild.
    const indexes = db.prepare('PRAGMA index_list(autotrade_options_paper_positions)').all() as { name: string }[];
    expect(indexes.some((i) => i.name === 'idx_autotrade_options_paper_positions_status')).toBe(true);

    // 'stop_loss'/'take_profit', rejected by the old CHECK, now insert fine.
    expect(() =>
      db
        .prepare(
          `INSERT INTO autotrade_options_paper_positions
             (symbol, side, kind, contract_symbol, strike, expiration, quantity, entry_price, entry_at,
              risk_amount, risk_profile, rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'MSFT',
          'put',
          'single_leg',
          'MSFT240315P00200000',
          200,
          '2024-03-15',
          1,
          2.1,
          1000,
          210,
          'MODERATE',
          'r',
          'closed',
          3.4,
          3000,
          'take_profit',
          1000,
          3000,
        ),
    ).not.toThrow();
  });

  it('is a no-op when the table is already on the new schema', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    rebuildAutotradeOptionsPaperPositionsTable(db);
    const before = db.prepare('PRAGMA table_info(autotrade_options_paper_positions)').all().length;
    rebuildAutotradeOptionsPaperPositionsTable(db); // second call should detect 'stop_loss' and bail
    const after = db.prepare('PRAGMA table_info(autotrade_options_paper_positions)').all().length;
    expect(after).toBe(before);
  });
});
