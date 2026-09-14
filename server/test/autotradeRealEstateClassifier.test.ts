import { describe, it, expect, vi, beforeAll } from 'vitest';

// Shared state for the mock (vi.hoisted so it's available inside the factory).
const state = vi.hoisted(() => ({ callCounts: {} as Record<string, number> }));

// Mock the library so the fundamentals fallback is tested without any network
// call — same approach as yahooProvider.test.ts. Symbol-keyed so different
// tests can exercise different sector/industry outcomes.
vi.mock('yahoo-finance2', () => {
  const PROFILES: Record<string, { sector?: string; industry?: string }> = {
    REITX: { sector: 'Real Estate', industry: 'REIT—Retail' },
    RESIX: { sector: 'Financials', industry: 'Real Estate Services' },
    TECHX: { sector: 'Technology', industry: 'Software' },
    NODATA: {},
    CACHEX: { sector: 'Technology', industry: 'Software' },
  };
  return {
    default: class FakeYahoo {
      constructor(_opts?: unknown) {}
      async quoteSummary(symbol: string) {
        state.callCounts[symbol] = (state.callCounts[symbol] ?? 0) + 1;
        if (symbol === 'FAILX') throw new Error('not found'); // deterministic — no retry delay
        return { price: {}, summaryDetail: {}, defaultKeyStatistics: {}, assetProfile: PROFILES[symbol] ?? {} };
      }
    },
  };
});

import { initDb, db } from '../src/db';
import {
  classifySector,
  buildUniverseSectorMap,
  isRealEstateSector,
  listRealEstateBans,
} from '../src/services/autotrading/realEstateClassifier';

beforeAll(() => initDb());

const TEST_SYMBOLS = ['UNIVRE', 'REITX', 'RESIX', 'TECHX', 'FAILX', 'NODATA', 'CACHEX'];

describe('real estate sector/industry classifier', () => {
  beforeAll(() => {
    // Defensive: keep these fake symbols out of `universe` so each test hits
    // the code path it means to (universe lookup vs. fundamentals fallback).
    db.exec(`DELETE FROM universe WHERE symbol IN (${TEST_SYMBOLS.map((s) => `'${s}'`).join(',')})`);
  });

  it('classifies from universe.sector with no network call, when present', async () => {
    db.prepare(
      "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('UNIVRE', 'Universe RE Co', 'Real Estate', ?)",
    ).run(Date.now());
    const r = await classifySector('UNIVRE');
    expect(r.outcome).toBe('real_estate');
    expect(r.source).toBe('universe');
    db.exec("DELETE FROM universe WHERE symbol = 'UNIVRE'");
  });

  it('falls back to fundamentals when absent from universe, matching sector', async () => {
    const r = await classifySector('REITX');
    expect(r.outcome).toBe('real_estate');
    expect(r.source).toBe('fundamentals');
    expect(r.sector).toBe('Real Estate');
  });

  it('matches on industry even when sector alone would not hit', async () => {
    const r = await classifySector('RESIX');
    expect(r.outcome).toBe('real_estate');
    expect(r.industry).toBe('Real Estate Services');
  });

  it('clears a normal non-real-estate symbol', async () => {
    const r = await classifySector('TECHX');
    expect(r.outcome).toBe('clear');
  });

  it('returns unknown (not clear) on a fundamentals fetch failure', async () => {
    const r = await classifySector('FAILX');
    expect(r.outcome).toBe('unknown');
  });

  it('returns unknown when fundamentals have neither field', async () => {
    const r = await classifySector('NODATA');
    expect(r.outcome).toBe('unknown');
  });

  describe('durable cache (avoids re-fetching Yahoo every cycle)', () => {
    it('caches a successful classification — a second call for the same symbol does not hit Yahoo again', async () => {
      const first = await classifySector('CACHEX');
      expect(first.outcome).toBe('clear');
      expect(state.callCounts.CACHEX).toBe(1);

      const second = await classifySector('CACHEX');
      expect(second.outcome).toBe('clear');
      expect(second.sector).toBe('Technology'); // served from cache, not re-fetched
      expect(state.callCounts.CACHEX).toBe(1); // still 1 — no second Yahoo call
    });

    it('does not retry an unknown result within the shorter negative-cache TTL', async () => {
      await classifySector('FAILX'); // first call: genuinely fetches and fails
      const callsAfterFirst = state.callCounts.FAILX;
      const again = await classifySector('FAILX');
      expect(again.outcome).toBe('unknown');
      expect(state.callCounts.FAILX).toBe(callsAfterFirst); // no new Yahoo call this soon
    });

    it('retries an unknown result once the negative-cache TTL has actually elapsed', async () => {
      await classifySector('FAILX');
      const callsAfterFirst = state.callCounts.FAILX;
      // Back-date the cache row past the 30-minute negative TTL, simulating
      // time having actually passed.
      db.prepare("UPDATE autotrade_sector_cache SET updated_at = ? WHERE symbol = 'FAILX'").run(
        Date.now() - 31 * 60 * 1000,
      );
      await classifySector('FAILX');
      expect(state.callCounts.FAILX).toBe(callsAfterFirst + 1); // retried this time
    });
  });

  describe('universeSectorBySymbol (hoisted lookup — avoids a fresh listUniverse() scan per symbol)', () => {
    it('buildUniverseSectorMap() maps only symbols that have a sector', () => {
      db.prepare(
        "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('MAPRE', 'Map RE Co', 'Real Estate', ?)",
      ).run(Date.now());
      db.prepare(
        "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('MAPNOSEC', 'No Sector Co', NULL, ?)",
      ).run(Date.now());
      const map = buildUniverseSectorMap();
      expect(map.get('MAPRE')).toBe('Real Estate');
      expect(map.has('MAPNOSEC')).toBe(false);
      db.exec("DELETE FROM universe WHERE symbol IN ('MAPRE', 'MAPNOSEC')");
    });

    it('classifySector uses the passed map instead of querying the DB, with no network call', async () => {
      // MAPTECH is deliberately absent from both `universe` and the Yahoo
      // fixture's PROFILES — if this fell through to a DB lookup or a
      // network fetch it would return 'unknown', not 'clear'.
      const map = new Map([['MAPTECH', 'Technology']]);
      const r = await classifySector('MAPTECH', map);
      expect(r).toMatchObject({ outcome: 'clear', sector: 'Technology', source: 'universe' });
      expect(state.callCounts.MAPTECH).toBeUndefined();
    });

    it('falls through to fundamentals when the passed map has no entry for the symbol', async () => {
      const map = new Map([['SOMEOTHER', 'Technology']]);
      const r = await classifySector('TECHX', map);
      expect(r).toMatchObject({ outcome: 'clear', source: 'fundamentals' });
    });
  });
});

// ---------------------------------------------------------------------------
// The standing ban list behind the Auto page's "Auto-classified" tab.
// ---------------------------------------------------------------------------
describe('listRealEstateBans', () => {
  beforeAll(() => {
    db.exec("DELETE FROM universe WHERE symbol LIKE 'BAN%'");
    db.exec("DELETE FROM autotrade_sector_cache WHERE symbol LIKE 'BAN%'");
  });

  it('reads BOTH stores, because the universe path never writes the cache', async () => {
    // The trap. classifySector returns EARLY on a universe sector hit and does
    // not write autotrade_sector_cache, so a cache-only read would have missed
    // all 29 names banned on 2026-09-14 — every one of them universe-sourced.
    db.prepare(
      "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('BANU', 'Uni REIT', 'Real Estate', ?)",
    ).run(Date.now());
    db.prepare(
      "INSERT INTO autotrade_sector_cache (symbol, outcome, sector, industry, updated_at) VALUES ('BANF', 'real_estate', 'Financials', 'REIT—Retail', ?)",
    ).run(Date.now());

    // Prove the premise rather than assuming it: classifying the universe name
    // must leave the cache empty.
    await classifySector('BANU');
    expect(db.prepare("SELECT 1 FROM autotrade_sector_cache WHERE symbol = 'BANU'").get()).toBeUndefined();

    const bans = listRealEstateBans().filter((b) => b.symbol.startsWith('BAN'));
    expect(bans.map((b) => b.symbol)).toEqual(['BANF', 'BANU']);
    expect(bans.find((b) => b.symbol === 'BANU')).toMatchObject({ source: 'universe', sector: 'Real Estate' });
    expect(bans.find((b) => b.symbol === 'BANF')).toMatchObject({ source: 'fundamentals', industry: 'REIT—Retail' });
  });

  it('leaves out the names the check would clear', async () => {
    db.prepare(
      "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('BANOK', 'Tech Co', 'Technology', ?)",
    ).run(Date.now());
    db.prepare(
      "INSERT INTO autotrade_sector_cache (symbol, outcome, sector, industry, updated_at) VALUES ('BANCL', 'clear', 'Technology', 'Software', ?)",
    ).run(Date.now());
    const syms = listRealEstateBans().map((b) => b.symbol);
    expect(syms).not.toContain('BANOK');
    expect(syms).not.toContain('BANCL');
  });

  it('reports a symbol in both stores the way the SCREEN would see it', async () => {
    // classifySector reads universe first, so that is the answer that governs.
    db.prepare(
      "INSERT INTO universe (symbol, name, sector, added_at) VALUES ('BANB', 'Both Co', 'Real Estate', ?)",
    ).run(Date.now());
    db.prepare(
      "INSERT INTO autotrade_sector_cache (symbol, outcome, sector, industry, updated_at) VALUES ('BANB', 'real_estate', 'Financials', 'REIT—Office', ?)",
    ).run(Date.now());
    const row = listRealEstateBans().find((b) => b.symbol === 'BANB');
    expect(row).toMatchObject({ source: 'universe', sector: 'Real Estate' });
  });

  it('shares ONE pattern test with the live classification', () => {
    // Two copies of "what counts as real estate" would agree today and not for
    // long, and the ban list is the thing an operator audits the screen by.
    expect(isRealEstateSector('Real Estate')).toBe(true);
    expect(isRealEstateSector(undefined, 'REIT—Retail')).toBe(true);
    expect(isRealEstateSector('Financials', 'Real Estate Services')).toBe(true);
    expect(isRealEstateSector('Technology', 'Software')).toBe(false);
    expect(isRealEstateSector()).toBe(false);
  });
});
