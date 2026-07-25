import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/db/universe', () => ({ listUniverseSymbols: vi.fn(() => []) }));

import { getProvider } from '../src/providers';
import { listUniverseSymbols } from '../src/db/universe';
import {
  classifyRegime,
  computeMarketRegime,
  _resetMarketRegimeCache,
  MAX_BREADTH_SYMBOLS,
  RegimeInputs,
} from '../src/services/marketRegime';

const mockGetProvider = vi.mocked(getProvider);
const mockUniverse = vi.mocked(listUniverseSymbols);

function baseInputs(over: Partial<RegimeInputs> = {}): RegimeInputs {
  return {
    proxySymbol: 'SPY',
    proxyClose: 100,
    proxySma50: 100,
    proxySma200: 100,
    marketAtrPct: 3,
    breadthPct: 50,
    breadthSampleSize: 100,
    asOf: 0,
    ...over,
  };
}

function candlesFrom(closes: number[]) {
  return closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 0 }));
}

describe('classifyRegime — pure', () => {
  it('calls a strong uptrend + broad + calm tape risk-on', () => {
    const r = classifyRegime(
      baseInputs({ proxyClose: 110, proxySma50: 104, proxySma200: 100, breadthPct: 70, marketAtrPct: 1.2 }),
    );
    expect(r.label).toBe('risk-on');
    expect(r.score).toBe(4); // all four components risk-on
    expect(r.resolvedComponents).toBe(4);
  });

  it('calls a downtrend + narrow + stressed tape risk-off', () => {
    const r = classifyRegime(
      baseInputs({ proxyClose: 90, proxySma50: 96, proxySma200: 100, breadthPct: 30, marketAtrPct: 6 }),
    );
    expect(r.label).toBe('risk-off');
    expect(r.score).toBe(-4);
  });

  it('sits neutral when signals are mixed / inside their bands', () => {
    // price basically on both MAs (inside ±1% band), breadth ~50%, vol mid
    const r = classifyRegime(
      baseInputs({ proxyClose: 100, proxySma50: 100, proxySma200: 100, breadthPct: 50, marketAtrPct: 3 }),
    );
    expect(r.label).toBe('neutral');
    expect(r.score).toBe(0);
  });

  it('reports unresolved inputs as `unknown` and leaves them out of resolvedComponents', () => {
    const r = classifyRegime(
      baseInputs({ proxyClose: null, proxySma50: null, proxySma200: null, breadthPct: null, marketAtrPct: null }),
    );
    expect(r.components.every((c) => c.signal === 'unknown')).toBe(true);
    expect(r.resolvedComponents).toBe(0);
    expect(r.score).toBe(0);
    expect(r.label).toBe('neutral'); // never a fake regime out of thin air
  });

  it('needs a 2+ margin, not a bare majority, to leave neutral', () => {
    // above the 200-day (risk-on) but sitting on the 50-day (neutral); breadth
    // & vol neutral -> score 1 -> still neutral
    const r = classifyRegime(
      baseInputs({ proxyClose: 105, proxySma50: 105, proxySma200: 100, breadthPct: 50, marketAtrPct: 3 }),
    );
    expect(r.score).toBe(1);
    expect(r.label).toBe('neutral');
  });
});

describe('computeMarketRegime — async orchestrator', () => {
  beforeEach(() => {
    mockGetProvider.mockReset();
    mockUniverse.mockReset();
    mockUniverse.mockReturnValue([]);
    _resetMarketRegimeCache();
  });

  it('classifies from the proxy daily history and an empty universe (breadth unknown)', async () => {
    // rising series: last close well above both MAs
    const closes = Array.from({ length: 210 }, (_, i) => 100 + i * 0.5);
    const getCandles = vi.fn(async () => candlesFrom(closes));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeMarketRegime({ force: true });
    expect(r.proxySymbol).toBe('SPY');
    expect(r.breadthPct).toBeNull();
    expect(r.breadthSampleSize).toBe(0);
    expect(r.components.find((c) => c.key === 'breadth')?.signal).toBe('unknown');
    // uptrend components should read risk-on
    expect(r.components.find((c) => c.key === 'trend200')?.signal).toBe('risk-on');
  });

  it('computes breadth as % of universe names above their own 50-day average', async () => {
    mockUniverse.mockReturnValue(['AAA', 'BBB', 'CCC', 'DDD']);
    const getCandles = vi.fn(async (symbol: string) => {
      if (symbol === 'SPY') return candlesFrom(Array.from({ length: 210 }, () => 100));
      // AAA/BBB above their 50-MA (rising), CCC/DDD below (falling)
      const rising = symbol === 'AAA' || symbol === 'BBB';
      return candlesFrom(Array.from({ length: 60 }, (_, i) => (rising ? 50 + i : 120 - i)));
    });
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeMarketRegime({ force: true });
    expect(r.breadthSampleSize).toBe(4);
    expect(r.breadthPct).toBe(50); // 2 of 4 above
  });

  it('excludes a name whose candles fail to fetch from the breadth denominator', async () => {
    mockUniverse.mockReturnValue(['AAA', 'BAD']);
    const getCandles = vi.fn(async (symbol: string) => {
      if (symbol === 'BAD') throw new Error('rate limited');
      return candlesFrom(Array.from({ length: 60 }, (_, i) => 50 + i)); // AAA rising -> above
    });
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeMarketRegime({ force: true });
    expect(r.breadthSampleSize).toBe(1); // BAD dropped, not counted as below
    expect(r.breadthPct).toBe(100);
  });

  it('caps the breadth sample at MAX_BREADTH_SYMBOLS', async () => {
    mockUniverse.mockReturnValue(Array.from({ length: MAX_BREADTH_SYMBOLS + 25 }, (_, i) => `S${i}`));
    const getCandles = vi.fn(async () => candlesFrom(Array.from({ length: 60 }, (_, i) => 50 + i)));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeMarketRegime({ force: true });
    expect(r.breadthSampleSize).toBe(MAX_BREADTH_SYMBOLS);
  });

  it('caches within the TTL — a second call does not re-hit the provider', async () => {
    const getCandles = vi.fn(async () => candlesFrom(Array.from({ length: 210 }, () => 100)));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    await computeMarketRegime({ force: true });
    const callsAfterFirst = getCandles.mock.calls.length;
    await computeMarketRegime(); // no force -> served from cache
    expect(getCandles.mock.calls.length).toBe(callsAfterFirst);
  });
});
