import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildAlertsTable } from '../src/db';

// The pre-option-alerts `alerts` table: a stale `kind` CHECK (only the original
// four kinds) and no option-contract columns. rebuildAlertsTable should copy
// rows through to the new schema and drop the CHECK.
const OLD_SCHEMA = `
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK(kind IN ('price','change','relvol','rsi')),
  operator          TEXT NOT NULL CHECK(operator IN ('above','below')),
  threshold         REAL NOT NULL,
  note              TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  triggered         INTEGER NOT NULL DEFAULT 0,
  last_value        REAL,
  trigger_message   TEXT,
  last_triggered_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);`;

describe('rebuildAlertsTable', () => {
  it('copies rows to the new schema and lifts the stale kind CHECK', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare(
      'INSERT INTO alerts(symbol, kind, operator, threshold, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('AAPL', 'price', 'above', 150, 'keep me', 1000, 1000);

    rebuildAlertsTable(db);

    const cols = (db.prepare('PRAGMA table_info(alerts)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('asset_type');
    expect(cols).toContain('option_type');
    expect(cols).toContain('plan');

    const row = db.prepare('SELECT symbol, kind, asset_type, note FROM alerts WHERE id = 1').get() as {
      symbol: string;
      kind: string;
      asset_type: string;
      note: string;
    };
    expect(row).toMatchObject({ symbol: 'AAPL', kind: 'price', asset_type: 'stock', note: 'keep me' });

    // kinds that the old CHECK rejected now insert fine
    expect(() =>
      db
        .prepare('INSERT INTO alerts(symbol, kind, operator, threshold, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('MSFT', 'high52', 'below', -2, 1, 1),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          'INSERT INTO alerts(symbol, asset_type, kind, operator, threshold, option_type, strike, expiration, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run('TSLA', 'option', 'optdelta', 'above', 0.5, 'call', 250, '2026-07-17', 'entry', 1, 1),
    ).not.toThrow();
  });

  it('is a no-op when the table is already on the new schema', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    rebuildAlertsTable(db);
    const before = db.prepare('PRAGMA table_info(alerts)').all().length;
    rebuildAlertsTable(db); // second call should detect asset_type and bail
    const after = db.prepare('PRAGMA table_info(alerts)').all().length;
    expect(after).toBe(before);
  });
});
