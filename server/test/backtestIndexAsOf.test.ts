import { describe, it, expect } from 'vitest';
import { indexAsOf } from '../src/services/autotrading/backtest';
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
