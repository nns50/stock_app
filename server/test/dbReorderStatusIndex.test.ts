import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { reorderStatusLeadingIndex } from '../src/db';

const OLD_SCHEMA = `
CREATE TABLE autotrade_paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX idx_autotrade_paper_positions_status ON autotrade_paper_positions(symbol, status);
`;

function usesIndexOnly(db: Database.Database, sql: string, indexName: string): boolean {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  return plan.some((p) => p.detail.includes(indexName)) && !plan.some((p) => p.detail.includes('SCAN'));
}

describe('reorderStatusLeadingIndex', () => {
  it('reorders an old (symbol, status) index to (status, symbol)', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);

    reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_paper_positions_status'")
      .get() as { sql: string };
    expect(row.sql).toMatch(/\(\s*status\s*,\s*symbol\s*\)/i);
  });

  it('a status-only query (no symbol filter) uses the reordered index without a table scan', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');
    expect(
      usesIndexOnly(
        db,
        "SELECT * FROM autotrade_paper_positions WHERE status = 'open'",
        'idx_autotrade_paper_positions_status',
      ),
    ).toBe(true);
  });

  it('the symbol+status point lookup still uses the index after reordering', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');
    expect(
      usesIndexOnly(
        db,
        "SELECT 1 FROM autotrade_paper_positions WHERE symbol = 'AAPL' AND status = 'open'",
        'idx_autotrade_paper_positions_status',
      ),
    ).toBe(true);
  });

  it('is a no-op once already status-leading (idempotent)', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');
    const after1 = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_paper_positions_status'")
      .get();
    reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');
    const after2 = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_paper_positions_status'")
      .get();
    expect(after2).toEqual(after1);
  });

  it('does nothing if the named index does not exist at all', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, symbol TEXT);');
    expect(() => reorderStatusLeadingIndex(db, 'idx_missing', 't')).not.toThrow();
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_missing'").get();
    expect(row).toBeUndefined();
  });
});
