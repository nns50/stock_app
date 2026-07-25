import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildAutotradePaperPositionsTable } from '../src/db';

// The pre-max-hold-days `autotrade_paper_positions` table: a stale exit_reason
// CHECK (only 'stop'/'target'/'manual'). rebuildAutotradePaperPositionsTable
// should copy rows through to the new schema and widen the CHECK to also
// allow 'time_exit'.
const OLD_SCHEMA = `
CREATE TABLE autotrade_paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK(side IN ('buy','sell')),
  quantity      REAL NOT NULL,
  entry_price   REAL NOT NULL,
  entry_at      INTEGER NOT NULL,
  stop_price    REAL NOT NULL,
  target_price  REAL NOT NULL,
  risk_amount   REAL NOT NULL,
  risk_profile  TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exit_price    REAL,
  exit_at       INTEGER,
  exit_reason   TEXT CHECK(exit_reason IN ('stop','target','manual') OR exit_reason IS NULL),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_autotrade_paper_positions_status ON autotrade_paper_positions(symbol, status);`;

describe('rebuildAutotradePaperPositionsTable', () => {
  it('copies rows to the new schema and lifts the stale exit_reason CHECK', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare(
      `INSERT INTO autotrade_paper_positions
         (symbol, side, quantity, entry_price, entry_at, stop_price, target_price, risk_amount, risk_profile,
          rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('AAPL', 'buy', 10, 100, 1000, 95, 110, 50, 'MODERATE', 'keep me', 'closed', 110, 2000, 'target', 1000, 2000);

    rebuildAutotradePaperPositionsTable(db);

    const row = db
      .prepare('SELECT symbol, rationale, exit_reason FROM autotrade_paper_positions WHERE id = 1')
      .get() as {
      symbol: string;
      rationale: string;
      exit_reason: string;
    };
    expect(row).toMatchObject({ symbol: 'AAPL', rationale: 'keep me', exit_reason: 'target' });

    // The index survives the rebuild.
    const indexes = db.prepare('PRAGMA index_list(autotrade_paper_positions)').all() as { name: string }[];
    expect(indexes.some((i) => i.name === 'idx_autotrade_paper_positions_status')).toBe(true);

    // 'time_exit', rejected by the old CHECK, now inserts fine.
    expect(() =>
      db
        .prepare(
          `INSERT INTO autotrade_paper_positions
             (symbol, side, quantity, entry_price, entry_at, stop_price, target_price, risk_amount, risk_profile,
              rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('MSFT', 'buy', 5, 200, 1000, 190, 220, 50, 'MODERATE', 'r', 'closed', 205, 3000, 'time_exit', 1000, 3000),
    ).not.toThrow();
  });

  it('is a no-op when the table is already on the new schema', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    rebuildAutotradePaperPositionsTable(db);
    const before = db.prepare('PRAGMA table_info(autotrade_paper_positions)').all().length;
    rebuildAutotradePaperPositionsTable(db); // second call should detect 'time_exit' and bail
    const after = db.prepare('PRAGMA table_info(autotrade_paper_positions)').all().length;
    expect(after).toBe(before);
  });
});
