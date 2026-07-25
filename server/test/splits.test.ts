import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the library; track chart calls so we can prove caching and the
// per-symbol (not batched) call shape.
vi.mock('yahoo-finance2', () => {
  const state = { calls: 0, lastOptions: undefined as unknown };
  class FakeYahoo {
    constructor(_opts?: unknown) {}
    async chart(symbol: string, options?: { events?: string }) {
      state.calls++;
      state.lastOptions = options;
      if (symbol === 'SPLIT') {
        return {
          events: {
            splits: [{ date: new Date('2026-07-05T00:00:00Z'), numerator: 4, denominator: 1, splitRatio: '4:1' }],
          },
        };
      }
      if (symbol === 'FAIL') throw new Error('network error');
      return { events: {} }; // no splits
    }
  }
  return { default: FakeYahoo, __state: state };
});

import * as yf from 'yahoo-finance2';
import { getRecentSplits, clearSplitsCache } from '../src/services/splits';

const state = (yf as unknown as { __state: { calls: number; lastOptions: unknown } }).__state;

beforeEach(() => {
  clearSplitsCache();
  state.calls = 0;
  state.lastOptions = undefined;
});

describe('splits service', () => {
  it('maps a detected split', async () => {
    const r = await getRecentSplits(['SPLIT'], 7);
    expect(r.get('SPLIT')).toEqual([{ date: '2026-07-05', splitRatio: '4:1', numerator: 4, denominator: 1 }]);
  });

  it('resolves to an empty array for a symbol with no recent split', async () => {
    const r = await getRecentSplits(['NORM'], 7);
    expect(r.get('NORM')).toEqual([]);
  });

  it('fails silent (empty array), not throwing, on a fetch error', async () => {
    const r = await getRecentSplits(['FAIL'], 7);
    expect(r.get('FAIL')).toEqual([]);
  });

  it('requests the split event type with the given lookback window', async () => {
    await getRecentSplits(['SPLIT'], 7);
    expect((state.lastOptions as { events?: string })?.events).toBe('split');
  });

  it('caches results so repeat lookups do not re-hit Yahoo', async () => {
    await getRecentSplits(['SPLIT'], 7);
    expect(state.calls).toBe(1);
    await getRecentSplits(['SPLIT'], 7); // cached
    expect(state.calls).toBe(1);
    await getRecentSplits(['SPLIT', 'NORM'], 7); // only NORM is missing
    expect(state.calls).toBe(2);
  });

  it('returns an empty map for an empty symbol list (no upstream call)', async () => {
    expect((await getRecentSplits([], 7)).size).toBe(0);
    expect(state.calls).toBe(0);
  });
});
