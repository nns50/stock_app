import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, db } from '../src/db';

// The at-entry ML regime label (2026-09-08) lives on six tables: the four
// position tables and the two live ORDER tables, because a live position's
// at-entry context is copied from its order row at materialization. A table
// missing the column would silently drop the stamp on one book.
const TABLES = [
  'positions',
  'autotrade_paper_positions',
  'autotrade_options_paper_positions',
  'autotrade_live_options_positions',
  'autotrade_live_orders',
  'autotrade_live_options_orders',
];

beforeAll(() => initDb());

describe('ml_regime column', () => {
  it.each(TABLES)('exists on %s, nullable, beside market_regime', (table) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number }[];
    const col = cols.find((c) => c.name === 'ml_regime');
    expect(col, `${table} has no ml_regime column`).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(cols.some((c) => c.name === 'market_regime')).toBe(true);
  });
});
