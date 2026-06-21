import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the library; track quote calls so we can prove caching.
vi.mock('yahoo-finance2', () => {
  const state = { calls: 0 };
  class FakeYahoo {
    constructor(_opts?: unknown) {}
    async quote(symbols: string | string[]) {
      state.calls++;
      const one = (s: string) => ({
        symbol: s,
        earningsTimestamp: new Date('2026-07-31T12:00:00Z'),
        earningsTimestampStart: new Date('2026-07-31T12:00:00Z'),
        earningsTimestampEnd: new Date('2026-07-31T12:00:00Z'),
        exDividendDate: new Date('2026-08-10T00:00:00Z'),
      });
      return Array.isArray(symbols) ? symbols.map(one) : one(symbols);
    }
  }
  return { default: FakeYahoo, __state: state };
});

import * as yf from 'yahoo-finance2';
import { getSymbolEvents, clearEventsCache } from '../src/services/events';

const state = (yf as unknown as { __state: { calls: number } }).__state;

beforeEach(() => {
  clearEventsCache();
  state.calls = 0;
});

describe('events service', () => {
  it('maps earnings + ex-dividend dates and keeps the canonical symbol', async () => {
    const r = await getSymbolEvents(['aapl', 'BRK.B']);
    const aapl = r.find((e) => e.symbol === 'AAPL');
    expect(aapl?.earningsDate).toBe('2026-07-31');
    expect(aapl?.earningsEstimated).toBe(false); // start == end
    expect(aapl?.exDividendDate).toBe('2026-08-10');
    // BRK.B is queried as BRK-B but returned under the canonical dotted symbol.
    expect(r.find((e) => e.symbol === 'BRK.B')).toBeTruthy();
  });

  it('caches results so repeat lookups do not re-hit Yahoo', async () => {
    await getSymbolEvents(['AAPL']);
    expect(state.calls).toBe(1);
    await getSymbolEvents(['AAPL']); // cached
    expect(state.calls).toBe(1);
    await getSymbolEvents(['AAPL', 'MSFT']); // only MSFT is missing
    expect(state.calls).toBe(2);
  });

  it('returns nothing for an empty symbol list (no upstream call)', async () => {
    expect(await getSymbolEvents([])).toEqual([]);
    expect(state.calls).toBe(0);
  });
});
