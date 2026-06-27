import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, listPositions } from '../src/db/positions';
import { getSetting, setSetting } from '../src/db/settings';
import { safeJsonParse } from '../src/util/json';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM positions; DELETE FROM settings;'));

describe('safeJsonParse', () => {
  it('parses valid JSON, and falls back on null / malformed input', () => {
    expect(safeJsonParse('[1,2]', [])).toEqual([1, 2]);
    expect(safeJsonParse<number[]>('[bad', [])).toEqual([]);
    expect(safeJsonParse(null, 'fallback')).toBe('fallback');
    expect(safeJsonParse(undefined, 7)).toBe(7);
  });
});

// A single row with a corrupt JSON column must not 500 the whole read path
// (Positions / Journal / export all funnel through mapPosition).
describe('DB read resilience', () => {
  it('reads a position with corrupt tags / checklist JSON without throwing', () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.5,
      entryDate: '2026-06-01',
      tags: ['live'],
    });
    db.prepare('UPDATE positions SET tags = ?, checklist = ? WHERE id = ?').run('[not json', '{also bad', p.id);

    let rows: ReturnType<typeof listPositions> = [];
    expect(() => {
      rows = listPositions({ symbol: 'AMC' });
    }).not.toThrow();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]); // graceful fallback, not a crash
    expect(rows[0].checklist).toEqual([]);
  });

  it('reads a setting with a corrupt value as undefined', () => {
    setSetting('screener.config', { a: 1 });
    expect(getSetting('screener.config')).toEqual({ a: 1 });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{broken', 'screener.config');
    expect(getSetting('screener.config')).toBeUndefined();
  });
});
