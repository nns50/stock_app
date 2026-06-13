import { describe, it, expect } from 'vitest';
import { computeBenchmark } from '../src/services/benchmark';

describe('computeBenchmark', () => {
  it('computes benchmark return, user return and alpha', () => {
    const r = computeBenchmark({
      symbol: 'SPY',
      startDate: '2026-01-01',
      endDate: '2026-03-01',
      benchStart: 500,
      benchEnd: 525, // +5%
      totalRealized: 2000,
      accountSize: 25000, // +8%
    });
    expect(r.benchmarkReturnPct).toBe(5);
    expect(r.userReturnPct).toBe(8);
    expect(r.alphaPct).toBe(3); // beat the index by 3%
  });

  it('leaves user return / alpha null without an account size', () => {
    const r = computeBenchmark({
      symbol: 'SPY',
      startDate: '2026-01-01',
      endDate: '2026-03-01',
      benchStart: 500,
      benchEnd: 480,
      totalRealized: 1000,
      accountSize: null,
    });
    expect(r.benchmarkReturnPct).toBe(-4);
    expect(r.userReturnPct).toBeNull();
    expect(r.alphaPct).toBeNull();
  });

  it('is null-safe when the benchmark could not be priced', () => {
    const r = computeBenchmark({
      symbol: 'SPY',
      startDate: null,
      endDate: null,
      benchStart: null,
      benchEnd: null,
      totalRealized: 0,
      accountSize: 25000,
    });
    expect(r.benchmarkReturnPct).toBeNull();
    expect(r.userReturnPct).toBe(0);
    expect(r.alphaPct).toBeNull();
  });
});
