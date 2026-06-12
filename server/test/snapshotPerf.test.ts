import { describe, it, expect } from 'vitest';
import { SnapshotPick } from '../src/db/snapshots';
import { computeSnapshotPerformance, directionalReturn } from '../src/services/snapshotPerf';

describe('directionalReturn', () => {
  it('is raw return for long, flipped for short', () => {
    expect(directionalReturn(100, 110, 'long')).toBeCloseTo(10);
    expect(directionalReturn(100, 90, 'long')).toBeCloseTo(-10);
    expect(directionalReturn(100, 90, 'short')).toBeCloseTo(10); // short wins when price drops
    expect(directionalReturn(100, 110, 'short')).toBeCloseTo(-10);
  });
});

describe('computeSnapshotPerformance', () => {
  const picks: SnapshotPick[] = [
    { rank: 1, symbol: 'AAA', score: 80, priceAtRun: 100 },
    { rank: 2, symbol: 'BBB', score: 70, priceAtRun: 50 },
    { rank: 3, symbol: 'CCC', score: 60, priceAtRun: 200 },
  ];

  it('aggregates direction-adjusted returns, hit rate, and extremes', () => {
    const prices = new Map<string, number | null>([
      ['AAA', 110], // +10%
      ['BBB', 45], // -10%
      ['CCC', null], // not evaluated
    ]);
    const perf = computeSnapshotPerformance('long', picks, prices);
    expect(perf.evaluated).toBe(2);
    expect(perf.avgReturnPct).toBeCloseTo(0); // (+10 -10)/2
    expect(perf.hitRate).toBeCloseTo(50); // 1 of 2 positive
    expect(perf.bestReturnPct).toBeCloseTo(10);
    expect(perf.worstReturnPct).toBeCloseTo(-10);
    expect(perf.picks.find((p) => p.symbol === 'CCC')?.returnPct).toBeNull();
  });

  it('flips returns for a short snapshot', () => {
    const prices = new Map<string, number | null>([['AAA', 90]]); // long would be -10
    const perf = computeSnapshotPerformance('short', [picks[0]], prices);
    expect(perf.avgReturnPct).toBeCloseTo(10); // short profits as price falls
    expect(perf.hitRate).toBeCloseTo(100);
  });

  it('returns null metrics when nothing can be priced', () => {
    const perf = computeSnapshotPerformance('long', picks, new Map());
    expect(perf.evaluated).toBe(0);
    expect(perf.avgReturnPct).toBeNull();
    expect(perf.hitRate).toBeNull();
  });
});
