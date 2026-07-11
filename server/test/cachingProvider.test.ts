import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CachingProvider } from '../src/providers/CachingProvider';
import {
  Candle,
  CandleQuery,
  Fundamentals,
  MarketDataProvider,
  OptionsChain,
  Quote,
  Timeframe,
} from '../src/providers/types';

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i,
    open: i,
    high: i,
    low: i,
    close: i,
    volume: 1,
  }));
}

function makeBaseProvider(): MarketDataProvider & { getCandles: ReturnType<typeof vi.fn> } {
  const getCandles = vi.fn(async (_symbol: string, _timeframe: Timeframe, query?: CandleQuery) =>
    makeCandles(query?.limit ?? 100),
  );
  return {
    name: 'fake',
    synthetic: true,
    capabilities: { quotes: true, candles: true, options: true, fundamentals: true },
    getQuote: vi.fn(async (symbol: string): Promise<Quote> => ({ symbol, last: 1, changePct: 0 }) as Quote),
    getCandles,
    getOptionsExpirations: vi.fn(async (): Promise<string[]> => []),
    getOptionsChain: vi.fn(async (): Promise<OptionsChain> => ({}) as OptionsChain),
    getFundamentals: vi.fn(async (): Promise<Fundamentals> => ({}) as Fundamentals),
  };
}

describe('CachingProvider.getCandles — shared cache for plain "last N bars" queries', () => {
  let base: ReturnType<typeof makeBaseProvider>;
  let provider: CachingProvider;

  beforeEach(() => {
    base = makeBaseProvider();
    provider = new CachingProvider(base, { quoteTtlMs: 60_000, candleTtlMs: 60_000 });
  });

  it("a second call with a smaller-or-equal limit is served from the first call's cache (no second upstream fetch)", async () => {
    const first = await provider.getCandles('AAPL', 'daily', { limit: 120 });
    const second = await provider.getCandles('AAPL', 'daily', { limit: 31 });
    expect(base.getCandles).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(120);
    expect(second).toHaveLength(31);
    // Sliced from the tail (most recent), matching the "limit = max bars to
    // return (most recent)" contract — not the first 31.
    expect(second[0].time).toBe(89);
    expect(second[30].time).toBe(119);
  });

  it('a later call asking for MORE bars than cached triggers exactly one refetch, extending the cache', async () => {
    await provider.getCandles('AAPL', 'daily', { limit: 120 });
    const bigger = await provider.getCandles('AAPL', 'daily', { limit: 260 });
    expect(base.getCandles).toHaveBeenCalledTimes(2);
    expect(bigger).toHaveLength(260);

    // A third call for anything <= 260 now reuses the extended cache.
    const third = await provider.getCandles('AAPL', 'daily', { limit: 31 });
    expect(base.getCandles).toHaveBeenCalledTimes(2);
    expect(third).toHaveLength(31);
  });

  it('each caller gets back exactly the limit it asked for, regardless of call order', async () => {
    const a = await provider.getCandles('MSFT', 'daily', { limit: 31 });
    const b = await provider.getCandles('MSFT', 'daily', { limit: 260 });
    const c = await provider.getCandles('MSFT', 'daily', { limit: 120 });
    expect(a).toHaveLength(31);
    expect(b).toHaveLength(260);
    expect(c).toHaveLength(120);
  });

  it('different symbols do not share a cache entry', async () => {
    await provider.getCandles('AAPL', 'daily', { limit: 120 });
    await provider.getCandles('MSFT', 'daily', { limit: 120 });
    expect(base.getCandles).toHaveBeenCalledTimes(2);
  });

  it('a query with no limit at all is cached and reused as-is', async () => {
    const first = await provider.getCandles('AAPL', 'daily');
    const second = await provider.getCandles('AAPL', 'daily');
    expect(base.getCandles).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('start/end range queries keep their own exact cache key, independent of the plain-limit cache', async () => {
    const ranged = await provider.getCandles('AAPL', 'daily', { start: '2026-01-01', end: '2026-02-01' });
    await provider.getCandles('AAPL', 'daily', { limit: 120 });
    // The range query and the plain-limit query never shared work — two
    // upstream fetches, one for each.
    expect(base.getCandles).toHaveBeenCalledTimes(2);
    expect(ranged).toHaveLength(100); // this fake ignores start/end and just uses its own default limit path
  });
});
