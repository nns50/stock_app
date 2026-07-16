import { describe, it, expect } from 'vitest';
import { closedWeeklyIndexAsOf, indexAsOf } from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';

function candlesAt(...times: number[]): Candle[] {
  return times.map((time) => ({ time, open: time, high: time, low: time, close: time, volume: 1 }));
}

/** Brute-force reference: the original O(n)-from-0 implementation, kept here
 *  only as an oracle for the tests below (not the code under test). */
function bruteForce(candles: Candle[], asOfMs: number): number {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= asOfMs) idx = i;
    else break;
  }
  return idx;
}

describe('indexAsOf', () => {
  const candles = candlesAt(10, 20, 30, 40, 50);

  it('matches the brute-force result with no fromIndex (default behavior unchanged)', () => {
    for (const asOfMs of [0, 5, 10, 15, 30, 45, 50, 100]) {
      expect(indexAsOf(candles, asOfMs)).toBe(bruteForce(candles, asOfMs));
    }
  });

  it('returns -1 when asOfMs is before every candle', () => {
    expect(indexAsOf(candles, 5)).toBe(-1);
  });

  it('returns the last index when asOfMs is after every candle', () => {
    expect(indexAsOf(candles, 999)).toBe(4);
  });

  it('resuming from a previous result gives the same answer as scanning from scratch, across an increasing sequence', () => {
    const asOfSequence = [5, 10, 15, 25, 30, 35, 50, 60];
    let cursor = 0;
    for (const asOfMs of asOfSequence) {
      const fresh = bruteForce(candles, asOfMs);
      const resumed = indexAsOf(candles, asOfMs, cursor);
      expect(resumed).toBe(fresh);
      cursor = resumed; // mimics how a caller would thread the cursor forward
    }
  });

  it('resuming from -1 (no match yet) falls back to scanning from the start, still correct', () => {
    expect(indexAsOf(candles, 5, -1)).toBe(-1);
    expect(indexAsOf(candles, 10, -1)).toBe(0);
  });

  it('resuming from a positive index re-confirms and can advance past it', () => {
    // Previously resolved to index 1 (time=20) for some earlier asOfMs.
    expect(indexAsOf(candles, 20, 1)).toBe(1); // same day, no new bars
    expect(indexAsOf(candles, 45, 1)).toBe(3); // advances to time=40
  });

  it('handles an empty candles array', () => {
    expect(indexAsOf([], 100)).toBe(-1);
    expect(indexAsOf([], 100, 5)).toBe(-1);
  });
});

describe('closedWeeklyIndexAsOf (2026-07-16, multi-timeframe confirmation)', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  // Weekly candles at real 7-day spacing, "time" = each week's own start
  // (Monday), matching Candle.time's documented "start of the bar" contract.
  const mondayWeeklyCandles = candlesAt(10 * MS_PER_DAY, 17 * MS_PER_DAY, 24 * MS_PER_DAY, 31 * MS_PER_DAY);

  it('returns one index behind plain indexAsOf, not the same index', () => {
    const asOfMs = 25 * MS_PER_DAY; // inside the week starting day 24
    expect(indexAsOf(mondayWeeklyCandles, asOfMs)).toBe(2); // the week CONTAINING today
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, asOfMs)).toBe(1); // the last FULLY CLOSED week
  });

  it("CRITICAL — never uses the in-progress week's own candle, even on that week's own start day", () => {
    // asOfMs lands EXACTLY on the start of the week at index 2 (day 24) — a
    // naive indexAsOf-based lookup would treat this week as already usable
    // (time <= asOfMs), but day 24 is day ONE of that week, not day seven —
    // using it here would leak days 25-30's price action into a backtest
    // simulating day 24 itself.
    const asOfMs = 24 * MS_PER_DAY;
    expect(indexAsOf(mondayWeeklyCandles, asOfMs)).toBe(2); // naive lookup would pick this
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, asOfMs)).toBe(1); // must fall back one week
  });

  it('advances to the next closed week only once a full week has elapsed', () => {
    // One day before the week-3 boundary: still resolves to week 1 as the
    // last CLOSED week (week 2, started day 24, is not done until day 31).
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, 30 * MS_PER_DAY)).toBe(1);
    // The day week 3 actually starts: week 2 (index 2) is now the last closed one.
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, 31 * MS_PER_DAY)).toBe(2);
  });

  it('returns -1 before any week has fully closed yet (including during the very first week)', () => {
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, 5 * MS_PER_DAY)).toBe(-1); // before any data
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, 10 * MS_PER_DAY)).toBe(-1); // inside week 1, none closed yet
    expect(closedWeeklyIndexAsOf(mondayWeeklyCandles, 16 * MS_PER_DAY)).toBe(-1); // still inside week 1
  });

  it('returns -1 for an empty candles array', () => {
    expect(closedWeeklyIndexAsOf([], 100 * MS_PER_DAY)).toBe(-1);
  });

  it('stays correct against a Sunday-start weekly convention too — the guard makes no week-start-day assumption', () => {
    // Same spacing, shifted by 3 days — proves the "back up one index"
    // guard works regardless of which real-world weekday a provider's
    // weekly aggregate happens to start on (see backtest.ts's own doc
    // comment: this is deliberately NOT hardcoded to a specific weekday).
    const sundayWeeklyCandles = candlesAt(7 * MS_PER_DAY, 14 * MS_PER_DAY, 21 * MS_PER_DAY, 28 * MS_PER_DAY);
    const asOfMs = 21 * MS_PER_DAY; // exactly the start of the 3rd week
    expect(indexAsOf(sundayWeeklyCandles, asOfMs)).toBe(2);
    expect(closedWeeklyIndexAsOf(sundayWeeklyCandles, asOfMs)).toBe(1);
  });
});
