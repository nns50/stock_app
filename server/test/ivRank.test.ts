import { describe, it, expect } from 'vitest';
import { Candle, OptionContract, OptionsChain } from '../src/providers/types';
import { atmIvOfChain, computeIvContext, realizedVolSeries } from '../src/services/ivRank';

function leg(type: 'call' | 'put', strike: number, iv: number): OptionContract {
  return { symbol: `X${strike}${type}`, underlying: 'X', type, strike, expiration: '2026-07-01', greeks: { iv } };
}

describe('atmIvOfChain', () => {
  it('averages the call and put IV at the strike nearest spot', () => {
    const chain: OptionsChain = {
      underlying: 'X',
      expiration: '2026-07-01',
      underlyingPrice: 100,
      calls: [leg('call', 95, 0.3), leg('call', 100, 0.25), leg('call', 105, 0.28)],
      puts: [leg('put', 100, 0.27), leg('put', 105, 0.31)],
    };
    expect(atmIvOfChain(chain)).toBeCloseTo(0.26, 6); // (0.25 + 0.27) / 2
  });

  it('returns undefined without an underlying price or IVs', () => {
    expect(atmIvOfChain({ underlying: 'X', expiration: '2026-07-01', calls: [], puts: [] })).toBeUndefined();
  });
});

describe('computeIvContext', () => {
  // Exact integer samples (20..39) so the percentile boundary is unambiguous.
  const history = Array.from({ length: 20 }, (_, i) => 20 + i);

  it('ranks against accumulated history', () => {
    const ctx = computeIvContext(30, history);
    expect(ctx.method).toBe('history');
    expect(ctx.samples).toBe(20);
    expect(ctx.ivRank).toBeCloseTo(52.63, 1); // (30-20)/(39-20)
    expect(ctx.ivPercentile).toBeCloseTo(55, 5); // 11 of 20 <= 30
  });

  it('falls back to a realized-vol estimate when history is thin', () => {
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      time: i,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i + (i % 2 === 0 ? 0.5 : -0.5),
      volume: 1000,
    }));
    const ctx = computeIvContext(0.3, [], candles);
    expect(ctx.method).toBe('hv-estimate');
    expect(ctx.ivRank).not.toBeNull();
  });

  it('reports insufficient when there is no current IV', () => {
    expect(computeIvContext(undefined, history).method).toBe('insufficient');
  });
});

describe('realizedVolSeries', () => {
  it('produces annualized positive vols', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      time: i,
      open: 100,
      high: 101,
      low: 99,
      close: 100 * (1 + 0.01 * Math.sin(i)),
      volume: 1000,
    }));
    const hv = realizedVolSeries(candles, 20);
    expect(hv.length).toBeGreaterThan(0);
    expect(hv.every((v) => v > 0)).toBe(true);
  });
});
