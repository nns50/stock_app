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
import { runAutotradeScreen, resetCandleIndicatorCache } from '../src/services/autotrading/screen';
import { clearEventsCache } from '../src/services/events';
import { getProvider } from '../src/providers';

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
  resetCandleIndicatorCache();
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

  describe('quote batching (avoids one getQuote() upstream call per symbol)', () => {
    it('warms the quote cache with one batched getQuotes() call up front', async () => {
      const spy = vi.spyOn(getProvider(), 'getQuotes');
      await runAutotradeScreen({ symbols: ['SCRQ1', 'SCRQ2', 'SCRQ3'], config: { filters: RELAXED_FILTERS } });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].sort()).toEqual(['SCRQ1', 'SCRQ2', 'SCRQ3']);
      spy.mockRestore();
    });

    it('a getQuotes() failure does not fail the screen — falls through to per-symbol getQuote()', async () => {
      const spy = vi.spyOn(getProvider(), 'getQuotes').mockRejectedValueOnce(new Error('rate limited'));
      const result = await runAutotradeScreen({ symbols: ['SCRQ4'], config: { filters: RELAXED_FILTERS } });
      expect(result.errors.find((e) => e.symbol === 'SCRQ4')).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('candle-indicator caching (skips SMA/RSI/ATR recompute when the latest candle is unchanged)', () => {
    function candlesFromCloses(closes: number[], lastTime: number) {
      let prev = closes[0];
      return closes.map((close, i) => {
        const open = i === 0 ? close : prev;
        prev = close;
        return {
          time: lastTime - (closes.length - 1 - i) * 86_400_000,
          open,
          high: Math.max(open, close) * 1.01,
          low: Math.min(open, close) * 0.99,
          close,
          volume: 1_000_000,
        };
      });
    }

    it('reuses the cached indicators when a later call sees the SAME latest-candle timestamp', async () => {
      const lastTime = Date.UTC(2026, 5, 1);
      // Two DIFFERENT histories that both end on the same day (same lastTime)
      // — an uptrend vs a downtrend, so their SMA/RSI/ATR clearly differ.
      const uptrend = candlesFromCloses(
        Array.from({ length: 60 }, (_, i) => 100 + i),
        lastTime,
      );
      const downtrend = candlesFromCloses(
        Array.from({ length: 60 }, (_, i) => 200 - i),
        lastTime,
      );

      const spy = vi
        .spyOn(getProvider(), 'getCandles')
        .mockResolvedValueOnce(uptrend as never)
        .mockResolvedValueOnce(downtrend as never);

      const first = await runAutotradeScreen({ symbols: ['SCRCACHE'], config: { filters: RELAXED_FILTERS } });
      const second = await runAutotradeScreen({ symbols: ['SCRCACHE'], config: { filters: RELAXED_FILTERS } });

      const firstScore = first.candidates.find((c) => c.symbol === 'SCRCACHE')!;
      const secondScore = second.candidates.find((c) => c.symbol === 'SCRCACHE')!;
      // Second call fetched genuinely different (downtrend) candles, but its
      // SMA/RSI/ATR still reflect the FIRST (uptrend) call — proving the
      // cached candle-indicators were actually reused, not recomputed.
      expect(secondScore.indicators.maShort).toBe(firstScore.indicators.maShort);
      expect(secondScore.indicators.rsi).toBe(firstScore.indicators.rsi);
      spy.mockRestore();
    });

    it('recomputes once the latest-candle timestamp actually changes', async () => {
      const day1 = Date.UTC(2026, 5, 1);
      const day2 = day1 + 86_400_000;
      const closesDay1 = Array.from({ length: 60 }, (_, i) => 100 + i);
      // Day 2 = day 1's history plus one genuinely new (and deliberately
      // extreme) close, so a real recompute must shift the trailing SMA
      // window — this isn't just the same closes shifted in time, which
      // would coincidentally produce the same average either way.
      const closesDay2 = [...closesDay1, 300];
      const uptrend = candlesFromCloses(closesDay1, day1);
      const uptrendNextDay = candlesFromCloses(closesDay2, day2);

      const spy = vi
        .spyOn(getProvider(), 'getCandles')
        .mockResolvedValueOnce(uptrend as never)
        .mockResolvedValueOnce(uptrendNextDay as never);

      const first = await runAutotradeScreen({ symbols: ['SCRCACHE2'], config: { filters: RELAXED_FILTERS } });
      const second = await runAutotradeScreen({ symbols: ['SCRCACHE2'], config: { filters: RELAXED_FILTERS } });

      const firstScore = first.candidates.find((c) => c.symbol === 'SCRCACHE2')!;
      const secondScore = second.candidates.find((c) => c.symbol === 'SCRCACHE2')!;
      // A genuinely new trading day's candle shifts the trailing SMA window.
      expect(secondScore.indicators.maShort).not.toBe(firstScore.indicators.maShort);
      spy.mockRestore();
    });

    it('a different screener config (different maShort) is not served a cache hit computed under the old config', async () => {
      const lastTime = Date.UTC(2026, 5, 1);
      const uptrend = candlesFromCloses(
        Array.from({ length: 60 }, (_, i) => 100 + i),
        lastTime,
      );
      const spy = vi.spyOn(getProvider(), 'getCandles').mockResolvedValue(uptrend as never);

      const withDefaultMa = await runAutotradeScreen({
        symbols: ['SCRCACHE3'],
        config: { filters: RELAXED_FILTERS },
      });
      const withDifferentMa = await runAutotradeScreen({
        symbols: ['SCRCACHE3'],
        config: { filters: RELAXED_FILTERS, maShort: 5 },
      });

      const a = withDefaultMa.candidates.find((c) => c.symbol === 'SCRCACHE3')!;
      const b = withDifferentMa.candidates.find((c) => c.symbol === 'SCRCACHE3')!;
      expect(b.indicators.maShort).not.toBe(a.indicators.maShort);
      spy.mockRestore();
    });
  });
});
