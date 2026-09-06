import { describe, it, expect } from 'vitest';
import {
  computeSignificanceStats,
  checkOosEdgeConfirmation,
  MIN_RELIABLE_TRADES,
} from '../src/services/autotrading/significance';

/** mulberry32 — deterministic RNG so the Monte Carlo is reproducible in tests.
 *  Same copy riskOfRuin.test.ts uses for its own seeded Monte Carlo. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n trades oscillating tightly around `mean` (not perfectly flat — a
 *  perfectly constant sample makes bootstrap resampling degenerate in an
 *  uninteresting way, same "oscillating not flat" reasoning already used by
 *  this codebase's other Monte Carlo/simulation test fixtures). */
function oscillating(n: number, mean: number, noise: number): { pnl: number }[] {
  return Array.from({ length: n }, (_, i) => ({ pnl: mean + (i % 2 === 0 ? noise : -noise) }));
}

describe('computeSignificanceStats', () => {
  it('returns all-null stats for an empty trade list, without dividing by zero', () => {
    const stats = computeSignificanceStats([]);
    expect(stats).toEqual({
      sampleSize: 0,
      expectancy: null,
      ciLow: null,
      ciHigh: null,
      pValue: null,
      resamples: 0,
      reliable: false,
    });
  });

  it('computes expectancy as the exact mean of pnl, independent of resampling', () => {
    const stats = computeSignificanceStats([{ pnl: 100 }, { pnl: 200 }, { pnl: -50 }], { rng: mulberry32(1) });
    expect(stats.sampleSize).toBe(3);
    expect(stats.expectancy).toBe(83.33); // (100 + 200 - 50) / 3, rounded
  });

  it('flags reliable only at/above MIN_RELIABLE_TRADES (20)', () => {
    const below = computeSignificanceStats(oscillating(MIN_RELIABLE_TRADES - 1, 50, 5), { rng: mulberry32(1) });
    const atFloor = computeSignificanceStats(oscillating(MIN_RELIABLE_TRADES, 50, 5), { rng: mulberry32(1) });
    expect(below.reliable).toBe(false);
    expect(atFloor.reliable).toBe(true);
  });

  it('gives a p-value of exactly 1 for a perfectly sign-balanced (zero-mean) trade list', () => {
    // Alternating +100/-100 -> observed mean is exactly 0. The sign-flip
    // permutation test's "at least as extreme" check (|permuted mean| >=
    // |observed mean|) is then trivially true for every possible
    // permutation, since an absolute value can never be < 0 — so this
    // result is exact and seed-independent, not just a property check.
    const stats = computeSignificanceStats(oscillating(30, 0, 100), { rng: mulberry32(1) });
    expect(stats.expectancy).toBe(0);
    expect(stats.pValue).toBe(1);
  });

  it('reports a tight, entirely-positive CI and a small p-value for a clearly positive edge', () => {
    const stats = computeSignificanceStats(oscillating(30, 100, 5), { rng: mulberry32(2) });
    expect(stats.ciLow).toBeGreaterThan(0);
    expect(stats.pValue).toBeLessThan(0.05);
  });

  it('reports a tight, entirely-negative CI and a small p-value for a clearly negative edge (two-sided)', () => {
    const stats = computeSignificanceStats(oscillating(30, -100, 5), { rng: mulberry32(3) });
    expect(stats.ciHigh).toBeLessThan(0);
    expect(stats.pValue).toBeLessThan(0.05);
  });

  it('gives a noisy, weak edge a larger p-value than a clean, strong one of the same sample size', () => {
    const strong = computeSignificanceStats(oscillating(30, 100, 5), { rng: mulberry32(4) });
    // Alternating +50/-10 -> mean 20, but the underlying magnitudes (50 and
    // 10) are unbalanced enough that plenty of random sign reassignments
    // land a permuted mean at least as extreme as 20.
    const weak = computeSignificanceStats(oscillating(30, 20, 30), { rng: mulberry32(4) });
    expect(weak.pValue!).toBeGreaterThan(strong.pValue!);
  });

  it('keeps the point estimate inside its own bootstrap CI', () => {
    const stats = computeSignificanceStats(oscillating(40, 37, 61), { rng: mulberry32(5) });
    expect(stats.ciLow).toBeLessThanOrEqual(stats.expectancy!);
    expect(stats.ciHigh).toBeGreaterThanOrEqual(stats.expectancy!);
  });

  it('always returns a p-value in [0, 1]', () => {
    const stats = computeSignificanceStats(oscillating(25, 12, 45), { rng: mulberry32(6) });
    expect(stats.pValue).toBeGreaterThanOrEqual(0);
    expect(stats.pValue).toBeLessThanOrEqual(1);
  });

  it('is fully deterministic given the same seeded rng', () => {
    const trades = oscillating(15, 42, 17);
    const a = computeSignificanceStats(trades, { rng: mulberry32(9) });
    const b = computeSignificanceStats(trades, { rng: mulberry32(9) });
    expect(a).toEqual(b);
  });

  it('honors a custom resamples count and reports it back', () => {
    const stats = computeSignificanceStats(oscillating(10, 10, 3), { rng: mulberry32(1), resamples: 500 });
    expect(stats.resamples).toBe(500);
  });

  it('defaults resamples to DEFAULT_RESAMPLES (2000) when not specified', () => {
    const stats = computeSignificanceStats(oscillating(10, 10, 3), { rng: mulberry32(1) });
    expect(stats.resamples).toBe(2000);
  });
});

/** oscillating() speaks in {pnl}; the walk-forward guard speaks in R multiples
 *  (2026-09-06). The statistic is unit-agnostic, so the fixtures still exercise
 *  exactly the same arithmetic — this only relabels the quantity. */
const asR = (trades: { pnl: number }[]) => trades.map((t) => ({ rMultiple: t.pnl }));

describe('checkOosEdgeConfirmation (auto-tune walk-forward guard)', () => {
  it('confirms when the RECENT (out-of-sample) half is a reliable, entirely-positive sample', () => {
    // Old half bad, recent half good — the guard must judge on the RECENT half.
    const chrono = [...oscillating(40, -100, 5), ...oscillating(40, 100, 5)];
    const r = checkOosEdgeConfirmation(asR(chrono), { rng: mulberry32(1) });
    expect(r.confirmed).toBe(true);
    expect(r.oosSampleSize).toBe(40); // recent 50%
    expect(r.oosCiLowR).toBeGreaterThan(0);
  });

  it('does NOT confirm when the out-of-sample CI includes zero (edge decayed)', () => {
    const chrono = [...oscillating(40, 100, 5), ...oscillating(40, 0, 100)];
    const r = checkOosEdgeConfirmation(asR(chrono), { rng: mulberry32(2) });
    expect(r.confirmed).toBe(false);
  });

  it('does NOT confirm when the out-of-sample edge is negative', () => {
    const chrono = [...oscillating(40, 100, 5), ...oscillating(40, -50, 5)];
    const r = checkOosEdgeConfirmation(asR(chrono), { rng: mulberry32(3) });
    expect(r.confirmed).toBe(false);
  });

  it('does NOT confirm (conservatively) when the out-of-sample window is too thin to be reliable', () => {
    // 20 total → recent 50% = 10 trades < MIN_RELIABLE_TRADES, even though positive.
    const chrono = oscillating(20, 100, 5);
    const r = checkOosEdgeConfirmation(asR(chrono), { rng: mulberry32(4) });
    expect(r.confirmed).toBe(false);
    expect(r.reliable).toBe(false);
    expect(r.oosSampleSize).toBeLessThan(MIN_RELIABLE_TRADES);
  });

  it('honors a custom oosFraction for the window size', () => {
    const chrono = oscillating(100, 100, 5);
    const r = checkOosEdgeConfirmation(asR(chrono), { rng: mulberry32(5), oosFraction: 0.25 });
    expect(r.oosSampleSize).toBe(25);
  });
});
