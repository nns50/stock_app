import { describe, it, expect } from 'vitest';
import {
  sma,
  smaSeries,
  ema,
  rsi,
  atr,
  trueRange,
  percentChange,
  relativeVolume,
  gapPercent,
  distanceFromMa,
  Bar,
} from '../src/indicators/indicators';

describe('smaSeries / sma', () => {
  it('warms up with nulls then averages a trailing window', () => {
    const s = smaSeries([1, 2, 3, 4, 5], 3);
    expect(s.slice(0, 2)).toEqual([null, null]);
    expect(s[2]).toBeCloseTo(2);
    expect(s[3]).toBeCloseTo(3);
    expect(s[4]).toBeCloseTo(4);
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4);
  });
});

describe('ema', () => {
  it('tracks a constant series to the constant', () => {
    expect(ema([5, 5, 5, 5, 5], 3)).toBeCloseTo(5);
  });
  it('responds faster than SMA to a jump (weights recent data)', () => {
    const values = [10, 10, 10, 10, 20];
    expect(ema(values, 4)!).toBeGreaterThan(sma(values, 4)!);
  });
});

describe('rsi', () => {
  it('is 100 for a monotonically rising series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBeCloseTo(100, 6);
  });
  it('is 0 for a monotonically falling series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(closes, 14)).toBeCloseTo(0, 6);
  });
  it('is ~50 for a symmetric zig-zag', () => {
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) {
      p += i % 2 === 0 ? 1 : -1;
      closes.push(p);
    }
    const v = rsi(closes, 14)!;
    expect(v).toBeGreaterThan(35);
    expect(v).toBeLessThan(65);
  });
});

describe('trueRange / atr', () => {
  it('true range accounts for gaps via the previous close', () => {
    const bar: Bar = { high: 12, low: 10, close: 11 };
    expect(trueRange(bar, 9)).toBe(3); // high(12) - prevClose(9)
  });
  it('atr is positive over a volatile series', () => {
    const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 2,
      low: 100 + i - 2,
      close: 100 + i,
    }));
    expect(atr(bars, 14)!).toBeGreaterThan(0);
  });
});

describe('derived helpers', () => {
  it('percentChange', () => {
    expect(percentChange(110, 100)).toBeCloseTo(10);
    expect(percentChange(100, 0)).toBeNull();
  });
  it('relativeVolume', () => {
    expect(relativeVolume(2_000_000, 1_000_000)).toBeCloseTo(2);
    expect(relativeVolume(1, 0)).toBeNull();
  });
  it('gapPercent', () => {
    expect(gapPercent(102, 100)).toBeCloseTo(2);
  });
  it('distanceFromMa', () => {
    expect(distanceFromMa(110, 100)).toBeCloseTo(10);
    expect(distanceFromMa(110, null)).toBeNull();
  });
});
