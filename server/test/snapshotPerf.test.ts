import { describe, it, expect } from 'vitest';
import { SnapshotPick } from '../src/db/snapshots';
import { computeEdgeReport, computeSnapshotPerformance, directionalReturn } from '../src/services/snapshotPerf';

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

describe('computeEdgeReport', () => {
  const pick = (rank: number, symbol: string, priceAtRun: number): SnapshotPick => ({
    rank,
    symbol,
    score: 100 - rank,
    priceAtRun,
  });
  // Two long snapshots; top-ranked names move up more than lower-ranked ones.
  const snaps = [
    { direction: 'long' as const, picks: [pick(1, 'AAA', 100), pick(2, 'BBB', 100), pick(11, 'LOW', 100)] },
    { direction: 'long' as const, picks: [pick(3, 'CCC', 100), pick(5, 'DDD', 100)] },
  ];
  const now: Record<string, number> = { AAA: 110, BBB: 108, CCC: 106, DDD: 102, LOW: 95 };

  it('aggregates overall and by rank tier (top tiers should out-return)', () => {
    const r = computeEdgeReport(snaps, (s) => now[s] ?? null);
    expect(r.snapshots).toBe(2);
    expect(r.evaluated).toBe(5);
    const tier = Object.fromEntries(r.byRank.map((b) => [b.label, b]));
    expect(tier['Rank 1-3'].avgReturnPct).toBeCloseTo(8); // (10+8+6)/3
    expect(tier['Rank 4-10'].avgReturnPct).toBeCloseTo(2); // DDD +2
    expect(tier['Rank 11+'].avgReturnPct).toBeCloseTo(-5); // LOW -5
    expect(tier['Rank 1-3'].avgReturnPct).toBeGreaterThan(tier['Rank 11+'].avgReturnPct);
  });

  it('skips picks without a current price and is empty-safe', () => {
    const r = computeEdgeReport([{ direction: 'long', picks: [pick(1, 'ZZZ', 100)] }], () => null);
    expect(r.evaluated).toBe(0);
    expect(r.avgReturnPct).toBeNull();
    expect(r.byRank).toEqual([]);
  });
});
