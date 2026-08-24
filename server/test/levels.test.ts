import { describe, it, expect } from 'vitest';
import { detectLevels, findPivots, surroundingLevels } from '../src/indicators/levels';
import type { Bar } from '../src/indicators/indicators';

/** A bar with a given high/low; close defaults to the midpoint. */
const bar = (high: number, low: number): Bar => ({ high, low, close: (high + low) / 2 });
/** Flat filler bars that can never form a pivot against the extremes around them. */
const flat = (n: number, high = 100, low = 99) => Array.from({ length: n }, () => bar(high, low));

describe('findPivots', () => {
  it('confirms a swing high only when it is the extreme on BOTH sides', () => {
    // index:      0..3 flat, 4 = spike, 5..8 flat
    const bars = [...flat(4), bar(110, 105), ...flat(4)];
    const highs = findPivots(bars, 3).filter((p) => p.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0]).toMatchObject({ index: 4, price: 110 });
  });

  it('finds swing lows the same way', () => {
    const bars = [...flat(4), bar(95, 90), ...flat(4)];
    const lows = findPivots(bars, 3).filter((p) => p.kind === 'low');
    expect(lows).toHaveLength(1);
    expect(lows[0]).toMatchObject({ index: 4, price: 90 });
  });

  it('never reports a pivot in the last `pivotWindow` bars — an unconfirmed extreme is not structure', () => {
    // The spike is the FINAL bar: nothing to its right can confirm it.
    const bars = [...flat(8), bar(200, 195)];
    expect(findPivots(bars, 3).some((p) => p.price === 200)).toBe(false);
  });

  it('reports a flat double-top once, at the end of the plateau', () => {
    const bars = [...flat(4), bar(110, 105), bar(110, 105), ...flat(4)];
    const highs = findPivots(bars, 3).filter((p) => p.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0].index).toBe(5); // the LAST bar of the tie, not both
  });

  it('returns nothing when there are too few bars to confirm anything', () => {
    expect(findPivots(flat(4), 3)).toEqual([]);
  });
});

describe('detectLevels', () => {
  it('merges repeated tests of the same area into ONE zone, not three', () => {
    // Three highs at ~110 (110.0 / 110.4 / 109.8 — all inside 0.75%).
    const bars = [...flat(4), bar(110.0, 105), ...flat(6), bar(110.4, 105), ...flat(6), bar(109.8, 105), ...flat(4)];
    const levels = detectLevels(bars, { pivotWindow: 3, tolerancePct: 0.75 });
    const zone = levels.find((l) => Math.abs(l.price - 110) < 1);
    expect(zone).toBeDefined();
    expect(zone!.touches).toBe(3);
    expect(zone!.from).toBe('highs');
  });

  it('keeps genuinely separate areas apart', () => {
    const bars = [...flat(4), bar(110, 105), ...flat(6), bar(130, 125), ...flat(4)];
    const levels = detectLevels(bars, { pivotWindow: 3, tolerancePct: 0.75 });
    const prices = levels.map((l) => Math.round(l.price));
    expect(prices).toEqual(expect.arrayContaining([110, 130]));
  });

  it('ranks a thrice-tested level above a once-touched one', () => {
    const bars = [
      ...flat(4),
      bar(110, 105),
      ...flat(6),
      bar(110.2, 105),
      ...flat(6),
      bar(110.1, 105),
      ...flat(6),
      bar(130, 125),
      ...flat(4),
    ];
    const levels = detectLevels(bars, { pivotWindow: 3, tolerancePct: 0.75 });
    expect(levels[0].touches).toBe(3);
    expect(levels[0].strength).toBeGreaterThan(levels[levels.length - 1].strength);
  });

  it('drops pivots older than the lookback window', () => {
    const bars = [...flat(4), bar(110, 105), ...flat(60), bar(130, 125), ...flat(4)];
    const recentOnly = detectLevels(bars, { pivotWindow: 3, lookbackBars: 20 });
    expect(recentOnly.some((l) => Math.abs(l.price - 110) < 1)).toBe(false);
    expect(recentOnly.some((l) => Math.abs(l.price - 130) < 1)).toBe(true);
  });

  it('returns nothing rather than inventing a level from too little history', () => {
    expect(detectLevels(flat(3), { pivotWindow: 3 })).toEqual([]);
  });
});

describe('surroundingLevels', () => {
  const bars = [...flat(4), bar(90, 85), ...flat(6), bar(130, 125), ...flat(4)];
  const levels = detectLevels(bars, { pivotWindow: 3 });

  it('classifies by where price is NOW — the same zone is resistance below it and support above it', () => {
    const under = surroundingLevels(levels, 100);
    expect(Math.round(under.above!.price)).toBe(130); // overhead wall
    expect(Math.round(under.below!.price)).toBe(85); // floor beneath

    // Price has since broken out above 130: that wall is now the floor.
    const over = surroundingLevels(levels, 140);
    expect(Math.round(over.below!.price)).toBe(130);
    expect(over.above).toBeNull();
  });

  it('treats a zone price is standing INSIDE as neither above nor below', () => {
    const inside = surroundingLevels(levels, 130);
    expect(inside.above).toBeNull();
    expect(inside.below).not.toBeNull();
    expect(Math.round(inside.below!.price)).toBe(85);
  });

  it('honours a minimum strength so a lone stale touch is not treated as a wall', () => {
    expect(surroundingLevels(levels, 100, 1.1)).toEqual({ above: null, below: null });
  });
});
