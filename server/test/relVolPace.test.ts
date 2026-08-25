import { describe, it, expect } from 'vitest';
import { relVolMedian, relVolPace, MIN_PACE_SAMPLES } from '../src/indicators/relVolPace';

/** `n` samples centred on `mid` — enough to clear MIN_PACE_SAMPLES. */
const around = (mid: number, n = MIN_PACE_SAMPLES + 5) =>
  Array.from({ length: n }, (_, i) => mid + (i - Math.floor(n / 2)) * (mid / 100));

describe('relVolMedian', () => {
  it('is the middle of the scored universe', () => {
    expect(relVolMedian(around(0.1))).toBeCloseTo(0.1, 6);
  });

  it('averages the two middles on an even count', () => {
    const xs = [...Array.from({ length: MIN_PACE_SAMPLES }, () => 1), 3, 5];
    expect(relVolMedian(xs)).toBe(1);
  });

  it('ignores nulls, zeros and junk rather than letting them drag the middle down', () => {
    // A symbol with no volume data is not a symbol trading at zero pace.
    const xs = [...around(0.2), null, undefined, 0, -1, NaN, Infinity];
    expect(relVolMedian(xs)).toBeCloseTo(0.2, 6);
  });

  it('refuses to estimate from too few samples', () => {
    expect(relVolMedian([0.1, 0.2, 0.3])).toBeNull();
    expect(relVolMedian(Array.from({ length: MIN_PACE_SAMPLES - 1 }, () => 0.1))).toBeNull();
    expect(relVolMedian(Array.from({ length: MIN_PACE_SAMPLES }, () => 0.1))).toBe(0.1);
  });
});

describe('relVolPace', () => {
  it('reads as a multiple of the market’s current pace', () => {
    expect(relVolPace(0.35, 0.1)).toBe(3.5);
    expect(relVolPace(0.1, 0.1)).toBe(1);
    expect(relVolPace(0.05, 0.1)).toBe(0.5);
  });

  // The whole point: the SAME stock, trading at the same relative pace, must
  // read the same at any hour — even though its raw relVolume has quadrupled.
  it('is time-of-day neutral, where raw relVolume is not', () => {
    const morning = relVolPace(0.2, 0.1); // 10:00 — market median 0.10
    const afternoon = relVolPace(1.6, 0.8); // 15:00 — market median 0.80
    expect(morning).toBe(2);
    expect(afternoon).toBe(2);
    // Under a fixed raw floor of 1.0 the morning reading fails and the
    // afternoon one passes, despite being the identical relative behaviour.
    expect(0.2 >= 1).toBe(false);
    expect(1.6 >= 1).toBe(true);
  });

  it('cancels a market-wide quiet or busy day', () => {
    // Quiet day: everything depressed, but this stock is still 2x its peers.
    expect(relVolPace(0.06, 0.03)).toBe(2);
    // Busy day: everything elevated, and 0.5 is now only average — a fixed
    // floor would wave it through as "unusual volume" when it is not.
    expect(relVolPace(0.5, 0.5)).toBe(1);
  });

  it('has no opinion rather than a guess when it cannot measure', () => {
    expect(relVolPace(0.35, null)).toBeNull(); // no median
    expect(relVolPace(null, 0.1)).toBeNull(); // no volume for the symbol
    expect(relVolPace(undefined, 0.1)).toBeNull();
    expect(relVolPace(NaN, 0.1)).toBeNull();
    expect(relVolPace(0.35, 0)).toBeNull(); // degenerate denominator
  });

  it('reproduces the live reading that motivated it', () => {
    // 2026-08-25 10:47 ET, 261 symbols scored: median 0.10, and the threshold
    // in force was a RAW 0.35 — which was really "3.5x the market" without
    // anyone having chosen that number.
    expect(relVolPace(0.35, 0.1)).toBe(3.5);
    // p90 that morning was 0.19 — not quite twice the median.
    expect(relVolPace(0.19, 0.1)).toBe(1.9);
  });
});
