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

describe('regime_target_factor column (2026-09-08)', () => {
  it.each(TABLES)('exists on %s, nullable REAL, beside ml_regime', (table) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number }[];
    const col = cols.find((c) => c.name === 'regime_target_factor');
    expect(col, `${table} has no regime_target_factor column`).toBeDefined();
    expect(col?.type).toBe('REAL');
    expect(col?.notnull).toBe(0);
  });
});

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
