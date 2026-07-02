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
    // Simulates a stalled connection: the server accepts it but never responds.
    // yahoo-finance2 ships with its own queue timeout unset, so nothing but our
    // own wrapper rescues a caller from this.
    async quoteSummary() {
      return new Promise(() => {});
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

  it('does not hang forever on a stalled request — rejects after the bounded per-attempt timeout instead of waiting indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const p = new YahooProvider();
      const result = p.getFundamentals('AAPL').catch((e) => e as Error);
      // 3 total attempts (2 retries) x a 15s per-attempt timeout, plus backoff
      // sleeps between them — advance well past all of it in one go.
      await vi.advanceTimersByTimeAsync(70_000);
      const err = await result;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
