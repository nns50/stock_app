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
import { classifySector } from '../src/services/autotrading/realEstateClassifier';

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
});
