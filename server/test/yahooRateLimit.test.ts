import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test drives the fake Yahoo through a scripted sequence of failures.
const state = vi.hoisted(() => ({ calls: 0, failWith: '' as string, failTimes: 0 }));

vi.mock('yahoo-finance2', () => ({
  default: class FakeYahoo {
    constructor(_opts?: unknown) {}
    async chart() {
      state.calls++;
      if (state.calls <= state.failTimes) throw new Error(state.failWith);
      return {
        quotes: [{ date: new Date('2026-08-24T00:00:00Z'), open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }],
      };
    }
    async quote() {
      return {};
    }
  },
}));

import { YahooProvider } from '../src/providers/YahooProvider';

/** Run `fn` while letting every backoff sleep elapse instantly. */
async function withElapsedTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    // Rate-limit backoff is 1.5s/3s/6s/12s (+jitter) plus a shared cooldown
    // wait per attempt — advance far past the whole sequence.
    await vi.advanceTimersByTimeAsync(300_000);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

describe('YahooProvider rate-limit handling', () => {
  beforeEach(() => {
    state.calls = 0;
    state.failWith = '';
    state.failTimes = 0;
    // The cooldown is deliberately shared process-wide; reset it so tests
    // don't inherit each other's backoff window.
    (YahooProvider as unknown as { rateLimitedUntil: number }).rateLimitedUntil = 0;
  });

  it('keeps retrying a rate limit past the ordinary blip budget, then succeeds', async () => {
    // 4 rate-limit failures: MORE than the 2-retry budget a plain blip gets,
    // so this only passes because rate limits earn their own larger budget.
    state.failWith = 'Too many requests';
    state.failTimes = 4;
    const p = new YahooProvider();
    const candles = await withElapsedTimers(() => p.getCandles('VALE', 'daily', { limit: 5 }));
    expect(state.calls).toBe(5); // 4 rejected, 5th succeeded
    expect(candles[0].close).toBe(10.5);
  });

  it('a plain transient blip keeps the SMALL budget — it is not given the rate-limit allowance', async () => {
    state.failWith = 'fetch failed (transient upstream blip)';
    state.failTimes = 99;
    const p = new YahooProvider();
    const err = await withElapsedTimers(() => p.getCandles('VALE', 'daily', { limit: 5 }).catch((e) => e as Error));
    expect(err).toBeInstanceOf(Error);
    expect(state.calls).toBe(3); // initial + 2 retries, unchanged
  });

  it('surfaces an unrelenting rate limit as a 429 rather than a generic 502', async () => {
    state.failWith = 'Too many requests';
    state.failTimes = 99;
    const p = new YahooProvider();
    const err = await withElapsedTimers(() =>
      p.getCandles('VALE', 'daily', { limit: 5 }).catch((e) => e as Error & { status?: number }),
    );
    expect((err as Error & { status?: number }).status).toBe(429);
    expect((err as Error).message).toMatch(/too many requests/i);
    // Larger budget than a blip's 3 attempts, and bounded — never unlimited.
    expect(state.calls).toBeGreaterThan(3);
    expect(state.calls).toBeLessThanOrEqual(7);
  });

  it('a rate limit opens a cooldown every OTHER caller waits out — the pool backs off together', async () => {
    state.failWith = 'Too many requests';
    state.failTimes = 1;
    const p = new YahooProvider();
    await withElapsedTimers(() => p.getCandles('VALE', 'daily', { limit: 5 }));
    // The cooldown is a static on the class, not per-instance, so a second
    // concurrent worker (its own provider or not) is held by the same window.
    const until = (YahooProvider as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
    expect(until).toBeGreaterThan(0);
  });
});
