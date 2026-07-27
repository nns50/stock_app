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

// getNews (services/news.ts) is mocked separately from the yahoo-finance2
// mock above — it already fails closed to [] on any error (see its own
// try/catch), so this isn't strictly required for safety, but mocking it
// directly gives full control over headline content per test, which a
// through-the-library mock wouldn't (search() would need its own fixture
// data threading).
vi.mock('../src/services/news', () => ({ getNews: vi.fn().mockResolvedValue([]) }));
// Movers discovery (AutotradeConfig.moversDiscoveryEnabled, 2026-07-27): mock
// both the configured() gate and the fetch so the tests below can flip
// discovery on/off without a real Webull credential in the environment.
vi.mock('../src/providers/webull/account', () => ({ webullConfigured: vi.fn(() => false) }));
vi.mock('../src/providers/webull/movers', () => ({
  webullMovers: vi.fn(async () => ({ ok: true, movers: [] })),
}));

import { initDb, db } from '../src/db';
import { addExclusion } from '../src/db/autotradeExclusions';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import {
  runAutotradeScreen,
  resetCandleIndicatorCache,
  resetWeeklyIndicatorCache,
} from '../src/services/autotrading/screen';
import { clearEventsCache } from '../src/services/events';
import { getProvider } from '../src/providers';
import { getNews } from '../src/services/news';

const mockGetNews = vi.mocked(getNews);
// eslint-disable-next-line import/first
import { webullConfigured } from '../src/providers/webull/account';
// eslint-disable-next-line import/first
import { webullMovers } from '../src/providers/webull/movers';
const mockWebullConfigured = vi.mocked(webullConfigured);
const mockWebullMovers = vi.mocked(webullMovers);

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
  resetWeeklyIndicatorCache();
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

  describe('directionMode', () => {
    function trendCandles(closes: number[], lastTime: number) {
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
    const lastTime = Date.UTC(2026, 5, 1);
    const uptrend = trendCandles(
      Array.from({ length: 60 }, (_, i) => 100 + i),
      lastTime,
    );
    const downtrend = trendCandles(
      Array.from({ length: 60 }, (_, i) => 200 - i),
      lastTime,
    );

    // getQuote is ALSO mocked (to undefined) in every test below, not just
    // getCandles — scoreSymbol prefers quote?.last/changePct/etc. over the
    // candle-derived equivalents whenever a quote is present (screener.ts's
    // computeIndicators), so leaving it unmocked lets the test provider's own
    // synthetic quote silently override the deliberately-crafted up/down
    // candle trend these tests depend on. Matches screener.test.ts's own
    // scoreSymbol(..., undefined, ...) convention for the same reason.
    function mockCandles(bySymbol: (symbol: string) => typeof uptrend) {
      const candles = vi
        .spyOn(getProvider(), 'getCandles')
        .mockImplementation(async (s: string) => bySymbol(s) as never);
      const quote = vi.spyOn(getProvider(), 'getQuote').mockResolvedValue(undefined as never);
      return () => {
        candles.mockRestore();
        quote.mockRestore();
      };
    }

    it("defaults to config.direction ('long') when directionMode is omitted — never considers the short side", async () => {
      const restore = mockCandles(() => downtrend);
      // screen.ts only enforces hard filters (price/volume/RSI-range/opt-in
      // trend-alignment) — RELAXED_FILTERS has none of those tight enough to
      // reject a candidate purely on a low score, so a downtrend still
      // "passes" scored as a (weak) LONG when directionMode is omitted. What
      // this test actually proves: omitting directionMode never even LOOKS at
      // the short side, unlike 'both' mode scoring this exact same downtrend
      // as 'short' with a much higher total (see the 'both' test below).
      const longOnly = await runAutotradeScreen({ symbols: ['SCRDOWN'], config: { filters: RELAXED_FILTERS } });
      const c = longOnly.candidates.find((c) => c.symbol === 'SCRDOWN')!;
      expect(c.direction).toBe('long');

      const both = await runAutotradeScreen({
        symbols: ['SCRDOWN'],
        config: { filters: RELAXED_FILTERS },
        directionMode: 'both',
      });
      const bothC = both.candidates.find((c) => c.symbol === 'SCRDOWN')!;
      expect(bothC.direction).toBe('short');
      expect(bothC.total).toBeGreaterThan(c.total); // 'both' found the genuinely stronger setup long-only mode missed
      restore();
    });

    it("directionMode:'short' scores every candidate as short, tagging the result 'short'", async () => {
      const restore = mockCandles(() => downtrend);
      const result = await runAutotradeScreen({
        symbols: ['SCRSHORT'],
        config: { filters: RELAXED_FILTERS },
        directionMode: 'short',
      });
      const c = result.candidates.find((c) => c.symbol === 'SCRSHORT');
      expect(c?.direction).toBe('short');
      restore();
    });

    it("directionMode:'both' — an uptrend symbol qualifies long, a downtrend symbol qualifies short, in the SAME screen call", async () => {
      const restore = mockCandles((symbol) => (symbol === 'SCRUP' ? uptrend : downtrend));

      const result = await runAutotradeScreen({
        symbols: ['SCRUP', 'SCRDN'],
        config: { filters: RELAXED_FILTERS },
        directionMode: 'both',
      });

      const up = result.candidates.find((c) => c.symbol === 'SCRUP');
      const dn = result.candidates.find((c) => c.symbol === 'SCRDN');
      expect(up?.direction).toBe('long');
      expect(dn?.direction).toBe('short');
      restore();
    });

    it("directionMode:'both' never emits two candidates (long AND short) for the same symbol", async () => {
      const restore = mockCandles(() => uptrend);
      const result = await runAutotradeScreen({
        symbols: ['SCRONE'],
        config: { filters: RELAXED_FILTERS },
        directionMode: 'both',
      });
      expect(result.candidates.filter((c) => c.symbol === 'SCRONE')).toHaveLength(1);
      restore();
    });

    it('journals the resolved direction on candidate_found', async () => {
      const restore = mockCandles(() => downtrend);
      await runAutotradeScreen({ symbols: ['SCRJRNL'], config: { filters: RELAXED_FILTERS }, directionMode: 'both' });
      const events = listAutotradeEvents({ stage: 'screen', symbol: 'SCRJRNL' });
      const found = events.find((e) => e.action === 'candidate_found');
      expect(JSON.parse(found!.detail!)).toMatchObject({ direction: 'short' });
      restore();
    });
  });

  describe('weekly trend alignment (multi-timeframe confirmation, 2026-07-16)', () => {
    const lastTime = Date.UTC(2026, 5, 1);

    // A daily uptrend ending at close=159 — same shape as the directionMode
    // describe block's own trendCandles() helper above, redefined locally
    // per this file's existing per-describe-block convention (see
    // 'candle-indicator caching' and 'directionMode' above, each with their
    // own private candle builder rather than a single shared one).
    function dailyUptrend() {
      const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
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
    const daily = dailyUptrend(); // last close = 159

    // A flat WEEKLY series at a known, controlled level — screen.ts's
    // cachedWeeklyIndicatorsFor() drops the last (possibly in-progress) bar
    // before computing, so 25 raw candles -> 24 used -> comfortably above
    // the default 20-period maShort window.
    function flatWeekly(level: number) {
      return Array.from({ length: 25 }, (_, i) => ({
        time: lastTime - (24 - i) * 7 * 86_400_000,
        open: level,
        high: level * 1.01,
        low: level * 0.99,
        close: level,
        volume: 1_000_000,
      }));
    }

    // Mirrors the directionMode describe block's own mockCandles() helper:
    // getQuote is mocked to undefined too, so scoreSymbol falls back to the
    // candle-derived price instead of a synthetic quote silently overriding
    // the deliberately-crafted daily/weekly fixtures below.
    function mockByTimeframe(weeklyLevel: number) {
      const candles = vi
        .spyOn(getProvider(), 'getCandles')
        .mockImplementation(
          async (_symbol: string, timeframe: string) =>
            (timeframe === 'weekly' ? flatWeekly(weeklyLevel) : daily) as never,
        );
      const quote = vi.spyOn(getProvider(), 'getQuote').mockResolvedValue(undefined as never);
      return () => {
        candles.mockRestore();
        quote.mockRestore();
      };
    }

    it("does not fetch weekly candles when the filter is off (default) — same don't-do-unrequested-work gate as earningsBlackoutDays", async () => {
      const spy = vi.spyOn(getProvider(), 'getCandles');
      await runAutotradeScreen({ symbols: ['SCRWK1'], config: { filters: RELAXED_FILTERS } });
      expect(spy.mock.calls.some(([, timeframe]) => timeframe === 'weekly')).toBe(false);
      spy.mockRestore();
    });

    it('fetches weekly candles for the scanned symbol when the filter is enabled', async () => {
      const spy = vi.spyOn(getProvider(), 'getCandles');
      await runAutotradeScreen({
        symbols: ['SCRWK2'],
        config: { filters: { ...RELAXED_FILTERS, requireWeeklyTrendAlignment: true } },
      });
      expect(spy.mock.calls.some(([symbol, timeframe]) => symbol === 'SCRWK2' && timeframe === 'weekly')).toBe(true);
      spy.mockRestore();
    });

    it('blocks a candidate whose daily setup disagrees with its weekly trend', async () => {
      // Weekly MA far ABOVE the daily uptrend's price (159) -> long-aligned
      // check (price > weeklyMaShort) fails.
      const restore = mockByTimeframe(500);
      const result = await runAutotradeScreen({
        symbols: ['SCRWKBLOCK'],
        config: { filters: { ...RELAXED_FILTERS, requireWeeklyTrendAlignment: true } },
      });
      expect(result.candidates.find((c) => c.symbol === 'SCRWKBLOCK')).toBeUndefined();
      // Not an exclusion/skip/error — a routine filtered-out non-match, same
      // as any other failed scoring filter (see screen.ts's own comment on
      // why these are just omitted rather than journaled).
      expect(result.excluded.find((e) => e.symbol === 'SCRWKBLOCK')).toBeUndefined();
      expect(result.errors.find((e) => e.symbol === 'SCRWKBLOCK')).toBeUndefined();
      restore();
    });

    it('passes a candidate whose daily setup agrees with its weekly trend', async () => {
      // Weekly MA far BELOW the daily uptrend's price (159) -> long-aligned.
      const restore = mockByTimeframe(50);
      const result = await runAutotradeScreen({
        symbols: ['SCRWKPASS'],
        config: { filters: { ...RELAXED_FILTERS, requireWeeklyTrendAlignment: true } },
      });
      expect(result.candidates.find((c) => c.symbol === 'SCRWKPASS')).toBeDefined();
      restore();
    });

    it('the same disagreeing weekly data does NOT block when the filter is left off (isolates the block above to the filter itself)', async () => {
      const restore = mockByTimeframe(500);
      const result = await runAutotradeScreen({
        symbols: ['SCRWKCTRL'],
        config: { filters: RELAXED_FILTERS }, // requireWeeklyTrendAlignment omitted
      });
      expect(result.candidates.find((c) => c.symbol === 'SCRWKCTRL')).toBeDefined();
      restore();
    });
  });

  describe('relative strength vs. benchmark (2026-07-17)', () => {
    const lastTime = Date.UTC(2026, 5, 1);

    // Same shape as the weekly-trend block's own dailyUptrend() above,
    // redefined locally per this file's established per-describe-block
    // convention. Last close = 159; default relativeStrengthLookbackDays
    // (20) reads back to close index 39 = 100+39 = 139, so the candidate's
    // own lookback return is (159-139)/139*100 ≈ +14.39%.
    function dailyUptrend() {
      const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
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
    const daily = dailyUptrend();

    // A benchmark series walking from startClose by dailyStep/bar — dailyStep
    // 0 gives an exactly-flat (0%) benchmark return regardless of the level
    // chosen; a nonzero step gives a precisely controlled nonzero return, so
    // the tests below can pick a benchmark that the candidate's own ~+14.39%
    // clearly beats or clearly trails.
    function benchmarkTrend(startClose: number, dailyStep: number) {
      const closes = Array.from({ length: 60 }, (_, i) => startClose + i * dailyStep);
      return closes.map((close, i) => ({
        time: lastTime - (59 - i) * 86_400_000,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000_000,
      }));
    }

    // Mirrors mockByTimeframe() above, switching on the SYMBOL argument
    // instead of the timeframe one — the scanned candidate's own daily
    // candles vs. the configured benchmark symbol's own daily candles are
    // both fetched via the same getCandles(symbol, 'daily', ...) shape.
    function mockBySymbol(benchmarkSymbol: string, benchmarkCandles: ReturnType<typeof benchmarkTrend>) {
      const candles = vi
        .spyOn(getProvider(), 'getCandles')
        .mockImplementation(async (symbol: string) => (symbol === benchmarkSymbol ? benchmarkCandles : daily) as never);
      const quote = vi.spyOn(getProvider(), 'getQuote').mockResolvedValue(undefined as never);
      return () => {
        candles.mockRestore();
        quote.mockRestore();
      };
    }

    it("does not fetch benchmark candles when weights.relativeStrength is 0 (default) — same don't-do-unrequested-work gate as weekly trend", async () => {
      const spy = vi.spyOn(getProvider(), 'getCandles');
      await runAutotradeScreen({ symbols: ['SCRRS1'], config: { filters: RELAXED_FILTERS } });
      expect(spy.mock.calls.some(([symbol]) => symbol === 'SPY')).toBe(false);
      spy.mockRestore();
    });

    it('fetches the configured benchmark symbol once (not per-candidate) when the weight is nonzero', async () => {
      const restore = mockBySymbol('SPY', benchmarkTrend(100, 0));
      await runAutotradeScreen({
        symbols: ['SCRRS2', 'SCRRS3'],
        config: { filters: RELAXED_FILTERS, weights: { relativeStrength: 25 } as any, benchmarkSymbol: 'SPY' },
      });
      const spy = getProvider().getCandles as unknown as { mock: { calls: unknown[][] } };
      const benchmarkCalls = spy.mock.calls.filter(([symbol]) => symbol === 'SPY');
      expect(benchmarkCalls).toHaveLength(1); // once for the whole cycle, not once per symbol
      restore();
    });

    it('scores a candidate that beat a flat benchmark above the SAME candidate compared against a benchmark that beat it', async () => {
      const flatBenchmark = mockBySymbol('SPY', benchmarkTrend(100, 0)); // 0% -> candidate's own +14.39% is pure excess
      const weak = await runAutotradeScreen({
        symbols: ['SCRRSWEAK'],
        config: { filters: RELAXED_FILTERS, weights: { relativeStrength: 100 } as any, benchmarkSymbol: 'SPY' },
      });
      flatBenchmark();

      resetCandleIndicatorCache();
      // Rises from 100 by 2/bar -> ~+22.5% over the 20-day window, comfortably
      // past the candidate's own +14.39%, so the candidate's excess goes negative.
      const strongBenchmark = mockBySymbol('SPY', benchmarkTrend(100, 2));
      const strong = await runAutotradeScreen({
        symbols: ['SCRRSSTRONG'],
        config: { filters: RELAXED_FILTERS, weights: { relativeStrength: 100 } as any, benchmarkSymbol: 'SPY' },
      });
      strongBenchmark();

      const weakScore = weak.candidates.find((c) => c.symbol === 'SCRRSWEAK')!.total;
      const strongScore = strong.candidates.find((c) => c.symbol === 'SCRRSSTRONG')!.total;
      expect(weakScore).toBeGreaterThan(strongScore);
    });

    it('a failed benchmark fetch degrades to a 0 relativeStrength contribution rather than failing the whole screen', async () => {
      const candles = vi
        .spyOn(getProvider(), 'getCandles')
        .mockImplementation(async (symbol: string) =>
          symbol === 'SPY' ? Promise.reject(new Error('no data')) : (daily as never),
        );
      const quote = vi.spyOn(getProvider(), 'getQuote').mockResolvedValue(undefined as never);
      const result = await runAutotradeScreen({
        symbols: ['SCRRSFAIL'],
        config: { filters: RELAXED_FILTERS, weights: { relativeStrength: 25 } as any, benchmarkSymbol: 'SPY' },
      });
      expect(result.errors.find((e) => e.symbol === 'SCRRSFAIL')).toBeUndefined();
      expect(result.candidates.find((c) => c.symbol === 'SCRRSFAIL')).toBeDefined();
      candles.mockRestore();
      quote.mockRestore();
    });
  });

  describe('sentiment (2026-07-18)', () => {
    beforeEach(() => mockGetNews.mockReset().mockResolvedValue([]));

    it("does not fetch headlines when weights.sentiment is 0 (default) — same don't-do-unrequested-work gate as relativeStrength/weekly trend", async () => {
      await runAutotradeScreen({ symbols: ['SCRSENT1'], config: { filters: RELAXED_FILTERS } });
      expect(mockGetNews).not.toHaveBeenCalled();
    });

    it('fetches headlines per-candidate (not once for the whole cycle, unlike the benchmark) when the weight is nonzero', async () => {
      await runAutotradeScreen({
        symbols: ['SCRSENT2', 'SCRSENT3'],
        config: { filters: RELAXED_FILTERS, weights: { sentiment: 25 } as any },
      });
      expect(mockGetNews).toHaveBeenCalledWith('SCRSENT2');
      expect(mockGetNews).toHaveBeenCalledWith('SCRSENT3');
      expect(mockGetNews).toHaveBeenCalledTimes(2);
    });

    it('scores a candidate with net-positive headlines above the SAME candidate with net-negative ones', async () => {
      mockGetNews.mockImplementation(async (symbol) =>
        symbol === 'SCRSENTPOS'
          ? [{ title: 'Acme beats estimates and raises guidance', link: 'x' }]
          : [{ title: 'Acme misses estimates and cuts guidance', link: 'x' }],
      );
      const result = await runAutotradeScreen({
        symbols: ['SCRSENTPOS', 'SCRSENTNEG'],
        config: { filters: RELAXED_FILTERS, weights: { sentiment: 100 } as any },
      });
      const posScore = result.candidates.find((c) => c.symbol === 'SCRSENTPOS')!.total;
      const negScore = result.candidates.find((c) => c.symbol === 'SCRSENTNEG')!.total;
      expect(posScore).toBeGreaterThan(negScore);
    });

    it('a failed headline fetch degrades to a 0 sentiment contribution rather than failing the whole candidate', async () => {
      // getNews() already fails closed to [] internally in production; this
      // test mocks a rejection directly to exercise screen.ts's OWN
      // .catch(() => []) around the call (belt-and-suspenders, matching
      // benchmarkLookbackReturnPct's own explicit catch above) — the
      // candidate's other components must still score normally.
      // mockImplementationOnce (not the persistent mockImplementation): only
      // one candidate is screened here, so a one-shot rejection is enough —
      // and a *persistent* rejecting implementation left configured on this
      // shared, vi.mock-factory-created mock trips Vitest's unhandled-
      // rejection detector as a false alarm in this vitest version, even
      // though screen.ts's own .catch(() => []) demonstrably handles it (this
      // exact failure mode was confirmed in isolation: swap back to
      // mockImplementation to reproduce). mockRejectedValueOnce works too;
      // this form was chosen to keep matching the "constructed only when
      // invoked" style used elsewhere in this describe block.
      mockGetNews.mockImplementationOnce(async () => {
        throw new Error('rate limited');
      });
      const result = await runAutotradeScreen({
        symbols: ['SCRSENTFAIL'],
        config: { filters: RELAXED_FILTERS, weights: { sentiment: 25 } as any },
      });
      expect(result.errors.find((e) => e.symbol === 'SCRSENTFAIL')).toBeUndefined();
      const candidate = result.candidates.find((c) => c.symbol === 'SCRSENTFAIL');
      expect(candidate).toBeDefined();
      expect(candidate!.indicators.sentimentNetScore).toBe(0);
    });
  });
});

describe('movers discovery gate (moversDiscoveryEnabled, 2026-07-27)', () => {
  beforeEach(() => {
    mockWebullConfigured.mockReset().mockReturnValue(true);
    mockWebullMovers.mockReset().mockResolvedValue({ ok: true, movers: [] } as never);
  });

  it('fetches premarket movers by default when Webull is configured (unchanged behavior)', async () => {
    await runAutotradeScreen({ config: { filters: { minRelVol: 0 } } });
    expect(mockWebullMovers).toHaveBeenCalledWith('unusual', 20, 'premarket');
    expect(mockWebullMovers).toHaveBeenCalledWith('gainers', 20, 'premarket');
  });

  it('skips the movers fetch entirely when moversEnabled is false — universe-only discovery', async () => {
    await runAutotradeScreen({ config: { filters: { minRelVol: 0 } }, moversEnabled: false });
    expect(mockWebullMovers).not.toHaveBeenCalled();
  });

  it('never fetches movers when explicit symbols bypass discovery, regardless of the flag', async () => {
    await runAutotradeScreen({ symbols: ['AAPL'], config: { filters: { minRelVol: 0 } }, moversEnabled: true });
    expect(mockWebullMovers).not.toHaveBeenCalled();
  });
});
