import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { reorderAutotradeEventsStageIndex } from '../src/db';

const OLD_SCHEMA = `
CREATE TABLE autotrade_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  stage      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_autotrade_events_stage ON autotrade_events(stage);
`;

function usesIndexOnly(db: Database.Database, sql: string, indexName: string): boolean {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  return plan.some((p) => p.detail.includes(indexName)) && !plan.some((p) => p.detail.includes('SCAN'));
}

describe('reorderAutotradeEventsStageIndex', () => {
  it('reorders an old (stage) index to (stage, id)', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);

    reorderAutotradeEventsStageIndex(db);

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_events_stage'")
      .get() as { sql: string };
    expect(row.sql).toMatch(/\(\s*stage\s*,\s*id\s*\)/i);
  });

  it('a stage-filtered, id-ordered dashboard-style read uses the index with no table scan', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    reorderAutotradeEventsStageIndex(db);
    expect(
      usesIndexOnly(
        db,
        "SELECT * FROM autotrade_events WHERE stage = 'risk_check' ORDER BY id DESC LIMIT 200",
        'idx_autotrade_events_stage',
      ),
    ).toBe(true);
  });

  it('preserves existing rows', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, created_at) VALUES ('AAPL', 'risk_check', 'approved', 1)",
    ).run();
    reorderAutotradeEventsStageIndex(db);
    const row = db.prepare('SELECT symbol, stage FROM autotrade_events WHERE id = 1').get();
    expect(row).toEqual({ symbol: 'AAPL', stage: 'risk_check' });
  });

  it('is a no-op once already (stage, id) (idempotent)', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    reorderAutotradeEventsStageIndex(db);
    const after1 = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_events_stage'")
      .get();
    reorderAutotradeEventsStageIndex(db);
    const after2 = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_events_stage'")
      .get();
    expect(after2).toEqual(after1);
  });
});
