import { describe, it, expect, vi } from 'vitest';

// Shared state for the mock (vi.hoisted so it's available inside the factory).
const state = vi.hoisted(() => ({ chartCalls: 0 }));

vi.mock('yahoo-finance2', () => ({
  default: class FakeYahoo {
    constructor(_opts?: unknown) {}
    async chart() {
      state.chartCalls++;
      if (state.chartCalls === 1) throw new Error('fetch failed (transient upstream blip)');
      return {
        quotes: [{ date: new Date('2026-06-10T00:00:00Z'), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }],
      };
    }
    async quote() {
      throw new Error('not found'); // deterministic -> must NOT be retried
    }
  },
}));

import { YahooProvider } from '../src/providers/YahooProvider';

describe('YahooProvider retry/backoff', () => {
  it('retries a transient failure and then succeeds', async () => {
    const p = new YahooProvider();
    const candles = await p.getCandles('AAPL', 'daily', { limit: 5 });
    expect(state.chartCalls).toBe(2); // failed once, retried, succeeded
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(100.5);
  });

  it('does not retry deterministic (not-found) errors', async () => {
    const p = new YahooProvider();
    const spy = vi.spyOn(p as any, 'mapQuote');
    await expect(p.getQuote('ZZZZ')).rejects.toThrow(/not found/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('warmup never throws, even when the priming call fails', async () => {
    const p = new YahooProvider();
    await expect(p.warmup()).resolves.toBeUndefined();
  });
});
