import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn(), getProviderStatus: vi.fn() }));

import { getProvider, getProviderStatus } from '../src/providers';
import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { getIvHistory, recordAtmIv } from '../src/db/ivHistory';
import { etToday } from '../src/util/marketDate';
import { ScreenCandidate } from '../src/services/autotrading/screen';
import {
  defaultAutotradeEntryConfig,
  defaultOptionsDecisionConfig,
  generateOptionsSignal,
  runOptionsDecision,
} from '../src/services/autotrading/optionsDecide';
import { Candle, OptionsChain } from '../src/providers/types';

const mockGetProvider = vi.mocked(getProvider);
const mockGetProviderStatus = vi.mocked(getProviderStatus);

const OPTIONS_CAPABLE_STATUS = {
  name: 'mock',
  synthetic: true,
  configured: true,
  capabilities: { quotes: true, candles: true, options: true, fundamentals: true },
};

function candidate(symbol = 'AAPL', price = 100, direction: 'long' | 'short' = 'long'): ScreenCandidate {
  return {
    symbol,
    price,
    direction,
    total: 70,
    passedFilters: true,
    filterReasons: [],
    components: [],
    indicators: {
      price,
      changePct: 0,
      maShort: null,
      maLong: null,
      distShortPct: null,
      distLongPct: null,
      rsi: null,
      atr: 2,
      atrPct: 2,
      relVolume: null,
      avgVolume: null,
      volume: null,
      gapPct: null,
      weeklyMaShort: null,
      symbolLookbackReturnPct: null,
      benchmarkLookbackReturnPct: null,
      sentimentNetScore: null,
    },
    discoverySource: 'universe',
    relVolPace: null,
  };
}

/** A minimal, deterministic chain — one strike, calls and puts both priced so
 *  they pass entryRules.ts's default liquidity/spread/delta rules. */
function chainFor(expiration: string, opts: { delta?: number; mark?: number } = {}): OptionsChain {
  const delta = opts.delta ?? 0.45;
  const mark = opts.mark ?? 3;
  const contract = (type: 'call' | 'put') => ({
    symbol: `AAPL-${expiration}-${type}`,
    underlying: 'AAPL',
    type,
    strike: 100,
    expiration,
    bid: mark - 0.05,
    ask: mark + 0.05,
    mark,
    volume: 500,
    openInterest: 1000,
    greeks: { delta: type === 'call' ? delta : -delta, iv: 0.4 },
  });
  return { underlying: 'AAPL', expiration, underlyingPrice: 100, calls: [contract('call')], puts: [contract('put')] };
}

/** A two-strike chain for a debit-spread test: one contract in the long leg's
 *  own delta band (0.30-0.60, defaultAutotradeEntryConfig's default) and one
 *  further OTM in the short leg's band (SHORT_LEG_DELTA_BAND: 0.15-0.25).
 *  callShortStrike/putShortStrike differ since "further OTM" points opposite
 *  ways per side (higher strike for a call, lower for a put). */
function spreadChainFor(
  expiration: string,
  opts: {
    longStrike?: number;
    longDelta?: number;
    longMark?: number;
    callShortStrike?: number;
    putShortStrike?: number;
    shortDelta?: number;
    shortMark?: number;
  } = {},
): OptionsChain {
  const {
    longStrike = 100,
    longDelta = 0.45,
    longMark = 3,
    callShortStrike = 110,
    putShortStrike = 90,
    shortDelta = 0.2,
    shortMark = 1,
  } = opts;
  // A fixed ±0.02 (not ±0.05, as chainFor() above uses) keeps the spread %
  // comfortably under maxSpreadPct: 10 even at the short leg's low $1 mark —
  // ask-bid = 0.05 at mark 1 lands almost exactly AT the 10% boundary, where
  // floating-point rounding (1.05 - 0.95 = 0.10000000000000009) can push a
  // fixture over the limit unpredictably.
  const mk = (type: 'call' | 'put', strike: number, delta: number, mark: number, tag: string) => ({
    symbol: `AAPL-${expiration}-${type}-${tag}`,
    underlying: 'AAPL',
    type,
    strike,
    expiration,
    bid: mark - 0.02,
    ask: mark + 0.02,
    mark,
    volume: 500,
    openInterest: 1000,
    greeks: { delta: type === 'call' ? delta : -delta, iv: 0.4 },
  });
  return {
    underlying: 'AAPL',
    expiration,
    underlyingPrice: 100,
    calls: [
      mk('call', longStrike, longDelta, longMark, 'long'),
      mk('call', callShortStrike, shortDelta, shortMark, 'short'),
    ],
    puts: [
      mk('put', longStrike, longDelta, longMark, 'long'),
      mk('put', putShortStrike, shortDelta, shortMark, 'short'),
    ],
  };
}

/** N days out from "now", YYYY-MM-DD (UTC), safely inside the default 7-60d window at N=21. */
function expirationDaysOut(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** `count` daily candles ending "today", with a GROWING daily oscillation
 *  (not constant — a fixed swing produces a nearly-flat realizedVolSeries
 *  where min/max differ only by float noise, and rankFrom()'s ratio blows up
 *  to +-Infinity instead of its intended min===max => rank=50 fallback).
 *  Tuned so the resulting realized-vol range straddles chainFor()'s fixed
 *  0.4 IV around its 25th-30th percentile — comfortably under the confirmed
 *  ivRankMax: 70 ceiling. Needs count >= 35 for realizedVolSeries' 20-day
 *  rolling window to produce the 15 points computeIvContext's hv-estimate
 *  fallback requires. */
function candlesFor(count: number, basePrice = 100): Candle[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const amplitude = 0.006 + 0.045 * (i / count); // 0.6% swings growing to 5.1%
    price *= 1 + amplitude * (i % 2 === 0 ? 1 : -1);
    out.push({
      time: Date.now() - (count - i) * dayMs,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1_000_000,
    });
  }
  return out;
}

/** Backfills a RANGE of historical IV samples (not a flat value — computeIvContext's
 *  rankFrom() falls back to rank=50 whenever min===max, which would make every
 *  test pass the ivRankMax check regardless of the "current" chain IV). */
function fillIvHistory(symbol: string, samples: number, opts: { min?: number; max?: number } = {}): void {
  const { min = 0.2, max = 0.6 } = opts;
  for (let i = 0; i < samples; i++) {
    // ET calendar date, matching how generateOptionsSignal keys TODAY's sample
    // (etToday). A raw UTC date here collides with today's ET date during the
    // ~20:00-ET-to-UTC-midnight window (UTC is already tomorrow), so the newest
    // backfilled day and today's sample land on the same (symbol,date) key and
    // getIvHistory returns one row fewer than seeded.
    const date = etToday(Date.now() - (samples - i) * 24 * 60 * 60 * 1000);
    const value = samples === 1 ? min : min + ((max - min) * i) / (samples - 1);
    recordAtmIv(symbol, value, date);
  }
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec("DELETE FROM iv_history; DELETE FROM autotrade_events WHERE symbol = 'AAPL'");
  mockGetProviderStatus.mockReset().mockReturnValue(OPTIONS_CAPABLE_STATUS);
  mockGetProvider.mockReset();
});

describe('generateOptionsSignal', () => {
  it('fails closed when both real IV history AND a realized-vol estimate are too short', async () => {
    fillIvHistory('AAPL', 5); // below the 15-sample 'history' threshold
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration)),
      getCandles: vi.fn(async () => candlesFor(10)), // too few for a 15-point hv-estimate either
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/insufficient iv data/i);
  });

  it('falls back to a realized-vol estimate when real history is short but price history exists, and labels it as such', async () => {
    fillIvHistory('AAPL', 5); // below the 15-sample 'history' threshold
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
      getCandles: vi.fn(async () => candlesFor(40)),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signal.rationale).toMatch(/estimated from realized volatility/i);
  });

  it('does not bother fetching candles once real history already has 15+ samples', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
    const expiration = expirationDaysOut(21);
    const getCandles = vi.fn(async () => candlesFor(40));
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
      getCandles,
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signal.rationale).not.toMatch(/estimated from realized volatility/i);
    expect(getCandles).not.toHaveBeenCalled();
  });

  it("still records today's ATM IV even when the candidate is skipped for insufficient history", async () => {
    fillIvHistory('AAPL', 3);
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration)),
      getCandles: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getProvider>);

    await generateOptionsSignal(candidate());
    expect(getIvHistory('AAPL').length).toBe(4); // 3 backfilled + today's new sample
  });

  it('skips when no expiration falls within the configured DTE window', async () => {
    fillIvHistory('AAPL', 20);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expirationDaysOut(1), expirationDaysOut(200)]), // both outside [7,60]
      getOptionsChain: vi.fn(),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no expiration within the configured dte window/i);
  });

  // The DTE window is configured in whole days and used to be compared against
  // FRACTIONAL time-to-expiry, so on a Wednesday every Friday contract in the
  // market scored 2.27 against a maxDte of 2 and was rejected. Measured on the
  // live book that Wednesday: 214 of 218 candidates skipped for "No expiration
  // within the configured DTE window [0, 2] days", while DE, TXN and the rest
  // all listed the 2026-09-04 expiry the window was supposed to admit.
  it('admits a Friday expiry from a Wednesday under a 0-2 DTE window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-02T13:35:00Z')); // Wed 09:35 ET
      fillIvHistory('AAPL', 20);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => ['2026-09-04']), // the Friday weekly
        getOptionsChain: vi.fn(async () => chainFor('2026-09-04', { mark: 3 })),
        getCandles: vi.fn(async () => candlesFor(40)),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        entryConfig: { minDaysToExpiration: 0, maxDaysToExpiration: 2 },
      });

      expect(result.ok, !result.ok ? result.reason : '').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects a Friday expiry from a Monday under the same window', async () => {
    // The window must still MEAN something — 4 calendar days is outside [0, 2].
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-31T13:35:00Z')); // Mon 09:35 ET
      fillIvHistory('AAPL', 20);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => ['2026-09-04']),
        getOptionsChain: vi.fn(),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        entryConfig: { minDaysToExpiration: 0, maxDaysToExpiration: 2 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no expiration within the configured dte window/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // A FAILED candle fetch and a genuinely short price history are different
  // facts, and `.catch(() => [])` made them the same one. Measured on the live
  // book: TXN, AMD, INTC, NOW and PLTR all reported "not enough price history"
  // inside a 20-symbol batch while /api/candles returned 200 daily bars for
  // each, and every one cleared the gate when decided alone — provider rate
  // limiting under batch load, described as missing data.
  describe('a failed candle fetch is not a short price history', () => {
    it('names the fetch failure rather than blaming the price history', async () => {
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expirationDaysOut(21)]),
        getOptionsChain: vi.fn(async () => chainFor(expirationDaysOut(21), { mark: 3 })),
        getCandles: vi.fn(async () => {
          throw new Error('Too many requests');
        }),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/FAILED/);
        expect(result.reason).toMatch(/Too many requests/);
        expect(result.reason).not.toMatch(/not enough price history/i);
      }
    });

    it('still blames the price history when the fetch SUCCEEDS and returns too little', async () => {
      // The other half — without this, the test above would pass even if the
      // message had simply been reworded for every case.
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expirationDaysOut(21)]),
        getOptionsChain: vi.fn(async () => chainFor(expirationDaysOut(21), { mark: 3 })),
        getCandles: vi.fn(async () => candlesFor(5)), // real answer, genuinely too short
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not enough price history/i);
        expect(result.reason).not.toMatch(/FAILED/);
      }
    });
  });

  it('skips when the expirations fetch itself fails', async () => {
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/failed to fetch option expirations/i);
  });

  it('skips when IV rank is above the confirmed ivRankMax: 70 ceiling', async () => {
    // History range [0.1, 0.2]; the fixture chain's IV is 0.4 -> rank clamps to 100, above 70.
    fillIvHistory('AAPL', 20, { min: 0.1, max: 0.2 });
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration)),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no contract passed entry rules/i);
  });

  it('produces a long-call signal when everything lines up (direction: long)', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 }); // history centered near the chain's own 0.4 IV -> mid rank, under 70
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signal.side).toBe('call');
    expect(result.signal.symbol).toBe('AAPL');
    if (result.signal.kind !== 'single_leg') throw new Error('expected a single-leg signal');
    expect(result.signal.strike).toBe(100);
    expect(result.signal.expiration).toBe(expiration);
    expect(result.signal.premium).toBe(3);
    expect(result.signal.maxLossPerContract).toBe(300); // premium x 100, defined risk by construction
    expect(result.signal.score).toBe(70); // carried from the screener's own score, not the contract's own rank
  });

  it('produces a long-put signal when direction is short', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate('AAPL', 100, 'short'), defaultOptionsDecisionConfig());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signal.side).toBe('put');
  });

  it('picks the nearest in-window expiration when several qualify', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
    const near = expirationDaysOut(10);
    const far = expirationDaysOut(45);
    mockGetProvider.mockReturnValue({
      // Deliberately out of order — the function must sort, not trust input order.
      getOptionsExpirations: vi.fn(async () => [far, near]),
      getOptionsChain: vi.fn(async (_symbol: string, expiration: string) => chainFor(expiration, { mark: 3 })),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await generateOptionsSignal(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signal.expiration).toBe(near);
  });

  describe('IV/RV cheapness gate (maxIvRvRatio)', () => {
    /** Calm candles: constant ±0.2% daily oscillation -> 20-day realized vol
     *  ≈ 0.03 annualized, far below the fixture chain's fixed 0.4 IV — so a
     *  1.0 gate reads the premium as rich (ratio ≈ 12). candlesFor()'s own
     *  growing 0.6-5.1% swings land RV ≈ 0.6+, the cheap side of the same gate. */
    function calmCandles(count: number, basePrice = 100): Candle[] {
      const dayMs = 24 * 60 * 60 * 1000;
      const out: Candle[] = [];
      let price = basePrice;
      for (let i = 0; i < count; i++) {
        price *= 1 + 0.002 * (i % 2 === 0 ? 1 : -1);
        out.push({
          time: Date.now() - (count - i) * dayMs,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1_000_000,
        });
      }
      return out;
    }

    it('skips when implied vol is rich relative to realized vol, fetching candles just for the gate', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 }); // rank ~50 — passes the ivRankMax ceiling
      const expiration = expirationDaysOut(21);
      const getCandles = vi.fn(async () => calmCandles(40));
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
        getCandles,
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        maxIvRvRatio: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/IV\/RV \d+(\.\d+)? above max 1/);
      // Real IV history was sufficient, so this fetch happened for the GATE, not the rank fallback.
      expect(getCandles).toHaveBeenCalled();
    });

    it('passes a cheap-premium candidate and stamps the ratio into the rationale', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
        getCandles: vi.fn(async () => candlesFor(40)), // volatile underlying -> RV above the 0.4 chain IV
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        maxIvRvRatio: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.signal.rationale).toMatch(/IV\/RV 0\.\d\d/);
    });

    it('fails closed when the gate is on but realized vol cannot be computed', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
        getCandles: vi.fn(async () => []), // no daily history at all
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        maxIvRvRatio: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/realized volatility could not be computed/i);
    });
  });

  describe('debit spread (strategyType: debit_spread)', () => {
    it('produces a call debit-spread signal with a short leg further OTM than the long leg', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => spreadChainFor(expiration)),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate('AAPL', 100, 'long'), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'debit_spread',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.kind).toBe('debit_spread');
      if (result.signal.kind !== 'debit_spread') return;
      expect(result.signal.side).toBe('call');
      expect(result.signal.longStrike).toBe(100);
      expect(result.signal.shortStrike).toBe(110); // further OTM (higher) than the long leg
      expect(result.signal.longPremium).toBe(3);
      expect(result.signal.shortPremium).toBe(1);
      expect(result.signal.netDebit).toBe(2); // 3 - 1
      expect(result.signal.width).toBe(10); // 110 - 100
      expect(result.signal.maxLossPerContract).toBe(200); // net debit x 100
      expect(result.signal.maxProfitPerContract).toBe(800); // (width - net debit) x 100
      expect(result.signal.rationale).toMatch(/debit spread/i);
    });

    it('produces a put debit-spread signal with the short leg at a LOWER strike than the long leg', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => spreadChainFor(expiration)),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate('AAPL', 100, 'short'), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'debit_spread',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.kind).toBe('debit_spread');
      if (result.signal.kind !== 'debit_spread') return;
      expect(result.signal.side).toBe('put');
      expect(result.signal.longStrike).toBe(100);
      expect(result.signal.shortStrike).toBe(90); // further OTM (lower) than the long leg
    });

    it('skips when no short-leg contract exists further OTM than the long leg', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => chainFor(expiration)), // single-strike chain — no short leg available
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'debit_spread',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no short-leg contract/i);
    });

    it('skips when the short leg premium would leave a net credit instead of a net debit', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        // Short leg priced ABOVE the long leg — not a real spread chain, but
        // exercises the net-debit guard deterministically.
        getOptionsChain: vi.fn(async () => spreadChainFor(expiration, { longMark: 1, shortMark: 3 })),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'debit_spread',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/not a net debit/i);
    });
  });

  describe('strategyType: auto (IV-rank-adaptive)', () => {
    it('resolves to single_leg when IV rank is below AUTO_STRATEGY_IV_RANK_THRESHOLD (50)', async () => {
      fillIvHistory('AAPL', 20, { min: 0.3, max: 0.7 }); // chain IV 0.4 -> rank ~25, below 50
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'auto',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.kind).toBe('single_leg');
      expect(result.signal.rationale).toMatch(/^auto-selected/i);
    });

    it('resolves to debit_spread when IV rank is at/above AUTO_STRATEGY_IV_RANK_THRESHOLD (50)', async () => {
      // chain IV 0.4 -> rank ~67: above the 50 auto threshold but still under
      // the 70 ivRankMax ceiling, so entryRules doesn't reject the contract first.
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.5 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => spreadChainFor(expiration)), // needs a further-OTM short leg available
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'auto',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.kind).toBe('debit_spread');
      expect(result.signal.rationale).toMatch(/^auto-selected/i);
    });

    it('does NOT add the auto-selected rationale prefix for an explicit (non-auto) strategyType', async () => {
      fillIvHistory('AAPL', 20, { min: 0.2, max: 0.5 });
      const expiration = expirationDaysOut(21);
      mockGetProvider.mockReturnValue({
        getOptionsExpirations: vi.fn(async () => [expiration]),
        getOptionsChain: vi.fn(async () => spreadChainFor(expiration)),
      } as unknown as ReturnType<typeof getProvider>);

      const result = await generateOptionsSignal(candidate(), {
        ...defaultOptionsDecisionConfig(),
        strategyType: 'debit_spread',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.rationale).not.toMatch(/auto-selected/i);
    });
  });
});

describe('defaultAutotradeEntryConfig', () => {
  it("adds the confirmed ivRankMax: 70 ceiling on top of entryRules.ts's own defaults", () => {
    const cfg = defaultAutotradeEntryConfig('call');
    expect(cfg.ivRankMax).toBe(70);
    expect(cfg.minDaysToExpiration).toBe(7);
    expect(cfg.maxDaysToExpiration).toBe(60);
  });
});

describe('runOptionsDecision', () => {
  it('skips every candidate without attempting any provider call when the provider lacks options capability', async () => {
    mockGetProviderStatus.mockReturnValue({
      ...OPTIONS_CAPABLE_STATUS,
      capabilities: { ...OPTIONS_CAPABLE_STATUS.capabilities, options: false },
    });
    const getOptionsExpirations = vi.fn();
    mockGetProvider.mockReturnValue({ getOptionsExpirations } as unknown as ReturnType<typeof getProvider>);

    const result = await runOptionsDecision([candidate('AAPL'), candidate('MSFT')]);
    expect(result.signals).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toMatch(/not available from the configured provider/i);
    expect(getOptionsExpirations).not.toHaveBeenCalled();
  });

  it('journals options_signal_generated and no_options_signal per candidate outcome', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async (symbol: string) => (symbol === 'AAPL' ? [expiration] : [])),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await runOptionsDecision([candidate('AAPL'), candidate('MSFT')]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].symbol).toBe('AAPL');
    expect(result.skipped).toEqual([
      { symbol: 'MSFT', reason: expect.stringMatching(/no expiration within the configured dte window/i) },
    ]);

    const aaplEvents = listAutotradeEvents({ stage: 'decision', symbol: 'AAPL' });
    expect(aaplEvents.some((e) => e.action === 'options_signal_generated')).toBe(true);
    const msftEvents = listAutotradeEvents({ stage: 'decision', symbol: 'MSFT' });
    expect(msftEvents.some((e) => e.action === 'no_options_signal')).toBe(true);
  });

  it('produces a call AND a put from ONE batch when candidates have mixed direction — the equity long/short + options follow-up', async () => {
    fillIvHistory('AAPL', 20, { min: 0.2, max: 0.6 });
    fillIvHistory('MSFT', 20, { min: 0.2, max: 0.6 });
    const expiration = expirationDaysOut(21);
    mockGetProvider.mockReturnValue({
      getOptionsExpirations: vi.fn(async () => [expiration]),
      getOptionsChain: vi.fn(async () => chainFor(expiration, { mark: 3 })),
    } as unknown as ReturnType<typeof getProvider>);

    const result = await runOptionsDecision([candidate('AAPL', 100, 'long'), candidate('MSFT', 100, 'short')]);
    expect(result.skipped).toEqual([]);
    expect(result.signals).toHaveLength(2);
    const bySymbol = Object.fromEntries(result.signals.map((s) => [s.symbol, s.side]));
    expect(bySymbol).toEqual({ AAPL: 'call', MSFT: 'put' });
  });
});
