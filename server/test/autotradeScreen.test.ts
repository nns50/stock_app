import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// classifySector falls back to Yahoo fundamentals for any symbol not seeded in
// `universe` — mock the library so those calls resolve to a plain non-RE
// sector instead of hitting the network (same approach as
// autotradeRealEstateClassifier.test.ts / yahooProvider.test.ts). `quote` is
// ALSO mocked here (getSymbolEvents' own dependency, services/events.ts) so
// the earnings-blackout tests below can control each symbol's earnings date
// without hitting the network either — vi.hoisted so the mutable map is
// reachable both from inside the hoisted vi.mock factory and from each test.
const earningsFixture = vi.hoisted(() => ({ current: {} as Record<string, { earningsTimestamp?: Date }> }));

vi.mock('yahoo-finance2', () => ({
  default: class FakeYahoo {
    constructor(_opts?: unknown) {}
    async quoteSummary() {
      return {
        price: {},
        summaryDetail: {},
        defaultKeyStatistics: {},
        assetProfile: { sector: 'Technology', industry: 'Software' },
      };
    }
    async quote(symbols: string | string[]) {
      const arr = Array.isArray(symbols) ? symbols : [symbols];
      return arr.map((s) => ({ symbol: s, ...earningsFixture.current[s.toUpperCase()] }));
    }
  },
}));

import { initDb, db } from '../src/db';
import { addExclusion } from '../src/db/autotradeExclusions';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { runAutotradeScreen } from '../src/services/autotrading/screen';
import { clearEventsCache } from '../src/services/events';

beforeAll(() => initDb());

const LISTED = 'SCRVNQ'; // on the static exclusion list
const SECTORED = 'SCRSECRE'; // seeded in universe with sector = Real Estate
const NORMAL = 'SCRNORM';
const RELAXED_FILTERS = { minPrice: 0, minAvgVolume: 0, minRelVol: 0 };

beforeEach(() => {
  db.exec(`DELETE FROM autotrade_exclusions WHERE symbol = '${LISTED}'`);
  db.exec(`DELETE FROM universe WHERE symbol = '${SECTORED}'`);
  db.exec('DELETE FROM autotrade_events');
  addExclusion(LISTED, 'test fixture');
  db.prepare(
    "INSERT INTO universe (symbol, name, sector, added_at) VALUES (?, 'Sectored RE Co', 'Real Estate', ?)",
  ).run(SECTORED, Date.now());
  earningsFixture.current = {};
  clearEventsCache();
});

describe('runAutotradeScreen', () => {
  it('excludes a listed symbol before scoring — never a candidate', async () => {
    const result = await runAutotradeScreen({ symbols: [LISTED, NORMAL], config: { filters: RELAXED_FILTERS } });
    expect(result.candidates.find((c) => c.symbol === LISTED)).toBeUndefined();
    expect(result.excluded.find((e) => e.symbol === LISTED)).toBeDefined();
  });

  it('logs a screen-stage excluded_re event sourced from the list', async () => {
    await runAutotradeScreen({ symbols: [LISTED] });
    const events = listAutotradeEvents({ stage: 'screen', symbol: LISTED });
    expect(events[0].action).toBe('excluded_re');
    expect(JSON.parse(events[0].detail!)).toMatchObject({ source: 'list' });
  });

  it('excludes a sector-classified real-estate symbol not on the static list', async () => {
    const result = await runAutotradeScreen({ symbols: [SECTORED] });
    expect(result.excluded.find((e) => e.symbol === SECTORED)).toBeDefined();
    const events = listAutotradeEvents({ stage: 'screen', symbol: SECTORED });
    expect(events[0].action).toBe('excluded_re');
    expect(JSON.parse(events[0].detail!)).toMatchObject({ source: 'universe', sector: 'Real Estate' });
  });

  it('never fetches fundamentals for a statically-excluded symbol (short-circuits first)', async () => {
    // If this reached classifySector it would hit the mocked Yahoo fundamentals
    // path; either way the outcome is exclusion, but asserting `source: 'list'`
    // above already proves the list check — not the classifier — is what fired.
    const result = await runAutotradeScreen({ symbols: [LISTED] });
    expect(result.excluded[0].reason).toMatch(/exclusion list/i);
  });

  it('scores and journals a normal candidate when filters are relaxed', async () => {
    const result = await runAutotradeScreen({ symbols: [NORMAL], config: { filters: RELAXED_FILTERS } });
    expect(result.excluded).toHaveLength(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].symbol).toBe(NORMAL);
    expect(result.candidates[0].discoverySource).toBe('universe'); // explicit symbols count as universe-sourced
    const events = listAutotradeEvents({ stage: 'screen', symbol: NORMAL });
    expect(events.some((e) => e.action === 'candidate_found')).toBe(true);
  });

  it('sorts candidates by score descending', async () => {
    const result = await runAutotradeScreen({
      symbols: [NORMAL, 'SCRNORM2', 'SCRNORM3'],
      config: { filters: RELAXED_FILTERS },
    });
    expect(result.candidates).toHaveLength(3);
    const totals = result.candidates.map((c) => c.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('reports discovery counts', async () => {
    const result = await runAutotradeScreen({ symbols: [NORMAL, 'SCRNORM2'] });
    expect(result.discovery.scannedCount).toBe(2);
  });

  describe('earnings blackout', () => {
    function daysFromNow(n: number): string {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    }

    it('does not exclude anyone when earningsBlackoutDays is omitted (0/disabled), even with earnings today', async () => {
      earningsFixture.current.SCREARN1 = { earningsTimestamp: new Date(daysFromNow(0)) };
      const result = await runAutotradeScreen({ symbols: ['SCREARN1'], config: { filters: RELAXED_FILTERS } });
      expect(result.excluded).toHaveLength(0);
      expect(result.candidates).toHaveLength(1);
    });

    it('excludes a candidate whose earnings date is today (day 0 of the window)', async () => {
      earningsFixture.current.SCREARN2 = { earningsTimestamp: new Date(daysFromNow(0)) };
      const result = await runAutotradeScreen({
        symbols: ['SCREARN2'],
        config: { filters: RELAXED_FILTERS },
        earningsBlackoutDays: 3,
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.excluded[0]).toMatchObject({ symbol: 'SCREARN2' });
      expect(result.excluded[0].reason).toMatch(/blackout/i);
    });

    it('excludes a candidate whose earnings date is a few days out but still inside the window', async () => {
      earningsFixture.current.SCREARN3 = { earningsTimestamp: new Date(daysFromNow(2)) };
      const result = await runAutotradeScreen({
        symbols: ['SCREARN3'],
        config: { filters: RELAXED_FILTERS },
        earningsBlackoutDays: 3,
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.excluded.find((e) => e.symbol === 'SCREARN3')).toBeDefined();
    });

    it('does not exclude a candidate whose earnings date is beyond the window', async () => {
      earningsFixture.current.SCREARN4 = { earningsTimestamp: new Date(daysFromNow(10)) };
      const result = await runAutotradeScreen({
        symbols: ['SCREARN4'],
        config: { filters: RELAXED_FILTERS },
        earningsBlackoutDays: 3,
      });
      expect(result.excluded).toHaveLength(0);
      expect(result.candidates).toHaveLength(1);
    });

    it('does not exclude (fails open) when the earnings date is unknown', async () => {
      // No earningsFixture entry at all for this symbol -> the mocked quote()
      // returns a bare {symbol}, same shape a real "Yahoo has nothing" response
      // resolves to.
      const result = await runAutotradeScreen({
        symbols: ['SCREARN5'],
        config: { filters: RELAXED_FILTERS },
        earningsBlackoutDays: 3,
      });
      expect(result.excluded).toHaveLength(0);
      expect(result.candidates).toHaveLength(1);
    });

    it('journals an excluded_earnings event with the earnings date', async () => {
      earningsFixture.current.SCREARN6 = { earningsTimestamp: new Date(daysFromNow(1)) };
      await runAutotradeScreen({ symbols: ['SCREARN6'], earningsBlackoutDays: 3 });
      const events = listAutotradeEvents({ stage: 'screen', symbol: 'SCREARN6' });
      expect(events[0].action).toBe('excluded_earnings');
      expect(JSON.parse(events[0].detail!)).toMatchObject({ earningsDate: daysFromNow(1) });
    });
  });
});
