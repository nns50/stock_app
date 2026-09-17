import { describe, it, expect } from 'vitest';
import { percentile } from '../src/util/percentile';

// One definition for the excursion tuner and the excursion report (2026-09-17):
// two copies of a percentile are how the stop a tuner sizes and the heat a
// report shows come to disagree by a rank.
describe('percentile', () => {
  it('reads 0 on an empty sample and the value itself on one', () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([0.37], 10)).toBe(0.37);
    expect(percentile([0.37], 90)).toBe(0.37);
  });

  it('interpolates linearly between ranks', () => {
    const xs = [1, 2, 3, 4];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 50)).toBe(2.5);
    expect(percentile(xs, 90)).toBeCloseTo(3.7, 10);
    expect(percentile(xs, 100)).toBe(4);
  });

  it('does not care about input order, and does not sort the caller’s array', () => {
    const xs = [4, 1, 3, 2];
    expect(percentile(xs, 50)).toBe(2.5);
    expect(xs).toEqual([4, 1, 3, 2]);
  });
});
