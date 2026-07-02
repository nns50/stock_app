import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { addExclusion, isExcluded, listExclusions, removeExclusion } from '../src/db/autotradeExclusions';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_exclusions'));

describe('autotrade exclusion list', () => {
  it('seeds the default real-estate ETFs on an empty table', () => {
    initDb(); // re-run: seedAutotradeExclusionsIfEmpty only acts when the table is empty
    const list = listExclusions();
    expect(list.length).toBeGreaterThan(0);
    const vnq = list.find((e) => e.symbol === 'VNQ');
    expect(vnq?.source).toBe('default');
    expect(vnq?.reason).toMatch(/real estate/i);
  });

  it('adds a user exclusion and reports it excluded (case-insensitive)', () => {
    const rec = addExclusion('spg', 'Simon Property Group — REIT');
    expect(rec.symbol).toBe('SPG');
    expect(rec.source).toBe('user');
    expect(isExcluded('spg')).toBe(true);
    expect(isExcluded('SPG')).toBe(true);
  });

  it('is not excluded when absent', () => {
    expect(isExcluded('AAPL')).toBe(false);
  });

  it('updates the reason on a re-add without changing source', () => {
    addExclusion('SPG', 'first reason');
    const rec = addExclusion('SPG', 'updated reason');
    expect(rec.reason).toBe('updated reason');
    expect(rec.source).toBe('user');
    expect(listExclusions().filter((e) => e.symbol === 'SPG')).toHaveLength(1);
  });

  it("preserves a default entry's source when re-added by a user submission", () => {
    db.prepare(
      "INSERT INTO autotrade_exclusions (symbol, reason, source, created_at) VALUES ('VNQ', 'seeded', 'default', ?)",
    ).run(Date.now());
    const rec = addExclusion('VNQ', 'resubmitted');
    expect(rec.source).toBe('default');
    expect(rec.reason).toBe('resubmitted');
  });

  it('removes a symbol and reports false for an unknown one', () => {
    addExclusion('SPG');
    expect(removeExclusion('spg')).toBe(true);
    expect(isExcluded('SPG')).toBe(false);
    expect(removeExclusion('SPG')).toBe(false);
  });

  it('lists alphabetically', () => {
    addExclusion('SPG');
    addExclusion('O');
    addExclusion('PLD');
    expect(listExclusions().map((e) => e.symbol)).toEqual(['O', 'PLD', 'SPG']);
  });
});
