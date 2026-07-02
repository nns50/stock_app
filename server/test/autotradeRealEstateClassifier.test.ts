import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock the library so the fundamentals fallback is tested without any network
// call — same approach as yahooProvider.test.ts. Symbol-keyed so different
// tests can exercise different sector/industry outcomes.
vi.mock('yahoo-finance2', () => {
  const PROFILES: Record<string, { sector?: string; industry?: string }> = {
    REITX: { sector: 'Real Estate', industry: 'REIT—Retail' },
    RESIX: { sector: 'Financials', industry: 'Real Estate Services' },
    TECHX: { sector: 'Technology', industry: 'Software' },
    NODATA: {},
  };
  return {
    default: class FakeYahoo {
      constructor(_opts?: unknown) {}
      async quoteSummary(symbol: string) {
        if (symbol === 'FAILX') throw new Error('not found'); // deterministic — no retry delay
        return { price: {}, summaryDetail: {}, defaultKeyStatistics: {}, assetProfile: PROFILES[symbol] ?? {} };
      }
    },
  };
});

import { initDb, db } from '../src/db';
import { classifySector } from '../src/services/autotrading/realEstateClassifier';

beforeAll(() => initDb());

const TEST_SYMBOLS = ['UNIVRE', 'REITX', 'RESIX', 'TECHX', 'FAILX', 'NODATA'];

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
});
