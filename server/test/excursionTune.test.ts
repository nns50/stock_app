import { describe, it, expect } from 'vitest';
import { computeExcursionTune } from '../src/services/autotrading/excursionTune';
import { aggregateExcursions, TradeExcursion } from '../src/services/excursion';

let seq = 0;
/** A winning trade's excursion row (realizedR > 0), with a given adverse (maeR,
 *  <= 0) and favorable (mfeR, >= 0) excursion in R. */
function winner(maeR: number, mfeR: number, realizedR = 1): TradeExcursion {
  seq += 1;
  return {
    positionId: seq,
    symbol: 'AAA',
    side: 'long',
    entryDate: '2026-01-01',
    mfePct: 0,
    maePct: 0,
    mfeR,
    maeR,
    realizedR,
    capturedPct: mfeR > 0 ? Math.round((realizedR / mfeR) * 100) : null,
    resolution: 'daily',
  };
}
/** A losing trade (realizedR <= 0) — excluded from the winner-only signals. */
function loser(maeR: number, mfeR: number): TradeExcursion {
  return { ...winner(maeR, mfeR, -1), realizedR: -1, capturedPct: null };
}

const BOUNDS = { minTrades: 2, maxStep: 0.25 };

describe('computeExcursionTune', () => {
  it('returns an empty patch with a warning below the winner sample floor', () => {
    const report = aggregateExcursions([winner(-0.3, 2.5)]); // only 1 winner, need 2
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/1 winning trade.*need 2/);
    expect(r.diagnostics.winners).toBe(1);
  });

  it('ignores losing trades when counting winners (censored MAE is unreliable)', () => {
    // 3 losers + 1 winner => only 1 usable winner, still below the floor.
    const report = aggregateExcursions([loser(-1, 0.2), loser(-1, 0.1), loser(-1, 0.3), winner(-0.3, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch).toEqual({});
    expect(r.diagnostics.winners).toBe(1);
  });

  it('tightens the stop when winners take little heat, bounded by maxStep', () => {
    // winners only dip to 0.3R => the 1R stop is looser than needed => tighten.
    const report = aggregateExcursions([winner(-0.3, 2.5), winner(-0.3, 2.5), winner(-0.3, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch.stopAtrMultiple).toBe(1.25); // 1.5 − maxStep(0.25); raw target of ~2.0 leaves target unchanged
    expect(r.patch.targetRMultiple).toBeUndefined();
    expect(r.diagnostics.avgWinnerHeatR).toBe(0.3);
  });

  it('widens the stop when winners routinely take near-full-R heat', () => {
    const report = aggregateExcursions([winner(-1, 2.5), winner(-1, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    // p90 of {1, 1} = 1R of heat, x1.1 allowance => 1.5 x 1.1 = 1.65. It still
    // widens, just less eagerly than the old mean x 1.3 (which gave 1.95 -> 1.75).
    expect(r.patch.stopAtrMultiple).toBe(1.65);
  });

  it('raises the target toward winners’ favorable peak', () => {
    // heat 0.91 keeps the stop unchanged (0.91 x 1.1 ~ 1.0R of room); MFE 5R
    // pulls the target up.
    const report = aggregateExcursions([winner(-0.91, 5), winner(-0.91, 5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch.targetRMultiple).toBe(2.25); // 2 + maxStep(0.25)
    expect(r.patch.stopAtrMultiple).toBeUndefined();
  });

  it('lowers the target when winners rarely reach it', () => {
    const report = aggregateExcursions([winner(-0.77, 1), winner(-0.77, 1)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 3 }, BOUNDS);
    expect(r.patch.targetRMultiple).toBe(2.75); // 3 − maxStep(0.25)
  });

  it('never pushes a multiple past its absolute safety clamp', () => {
    // Tiny heat + a big step would drive the stop below 0.5×ATR; clamp holds it.
    const report = aggregateExcursions([winner(-0.1, 2.5), winner(-0.1, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 0.6, targetRMultiple: 2 }, { minTrades: 2, maxStep: 5 });
    expect(r.patch.stopAtrMultiple).toBe(0.5); // STOP_MULT_MIN, not lower
  });

  it('makes no change (and says so) when the geometry already matches the excursion', () => {
    // heat 0.91 => needed room ~1.0R => stop unchanged; MFE 2.5 × 0.8 = 2.0 => target unchanged.
    const report = aggregateExcursions([winner(-0.91, 2.5), winner(-0.91, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/already matches/);
  });
});

describe('computeExcursionTune — stop room covers the tail, not the mean (2026-08-27)', () => {
  /** The real first sample: 9 winners, heat clustered mid-range with a tail
   *  pressed against 1R. Heat is bounded above by 1R by construction — a trade
   *  that took more never became a winner — so the mean sits well below where
   *  the hardest-won winners actually live. */
  const REAL_HEAT = [0, 0.18, 0.29, 0.49, 0.5, 0.52, 0.53, 0.67, 1.0];
  const realWinners = REAL_HEAT.map((h) => winner(-h, 2.5));

  it('keeps enough room for the winners the mean would have stopped out', () => {
    const report = aggregateExcursions(realWinners);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, { minTrades: 9, maxStep: 5 });
    // Room actually granted, as a fraction of the current 1R stop.
    const roomR = (r.patch.stopAtrMultiple ?? 1.5) / 1.5;
    const stoppedOut = REAL_HEAT.filter((h) => h > roomR);
    // The old mean x 1.3 = 0.604R gave up 2 of 9 winners, including the 1.00R one.
    expect(0.46 * 1.3).toBeLessThan(0.67);
    expect(stoppedOut.length).toBeLessThanOrEqual(1);
    expect(roomR).toBeGreaterThan(0.46 * 1.3);
  });

  it('still tightens when winners genuinely do not use the room', () => {
    // The tuner must not become inert — a book whose winners never take heat
    // should still get a tighter stop and the larger size that comes with it.
    const report = aggregateExcursions(Array.from({ length: 9 }, () => winner(-0.1, 2.5)));
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, { minTrades: 9, maxStep: 5 });
    expect(r.patch.stopAtrMultiple).toBeLessThan(1.5);
  });

  it('is driven by the percentile, not by an outlier-dragged mean', () => {
    // One enormous-heat winner must not, by itself, widen the stop the way it
    // would drag a mean. Eight quiet winners and one at the 1R ceiling.
    const skewed = aggregateExcursions([...Array.from({ length: 8 }, () => winner(-0.1, 2.5)), winner(-1, 2.5)]);
    const r = computeExcursionTune(skewed, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, { minTrades: 9, maxStep: 5 });
    // Mean heat is 0.2 here; p90 is far higher, so the stop stays wider than a
    // mean-driven tuner would have set — but still tightens off 1.5.
    expect(r.patch.stopAtrMultiple).toBeLessThan(1.5);
    expect(r.patch.stopAtrMultiple).toBeGreaterThan(1.5 * 0.2 * 1.1);
  });
});

describe('computeExcursionTune sample freshness (2026-07-25)', () => {
  /** Same as `winner` above, but with an explicit entry date. */
  function winnerOn(entryDate: string, maeR: number, mfeR: number): TradeExcursion {
    return { ...winner(maeR, mfeR), entryDate };
  }
  const at = (iso: string) => new Date(iso).getTime();

  it('ignores trades entered under the previous exit geometry', () => {
    // maeR and mfeR are denominated in each trade's OWN stop at entry, so a
    // trade taken before a change cannot judge the geometry that replaced it.
    const report = aggregateExcursions([winnerOn('2026-01-01', -0.5, 2.5), winnerOn('2026-01-02', -0.5, 2.5)]);
    const r = computeExcursionTune(
      report,
      { stopAtrMultiple: 1.5, targetRMultiple: 2 },
      { minTrades: 2, maxStep: 0.25, sampleSince: at('2026-02-01') },
    );
    expect(r.patch).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/entered under the previous exit geometry/);
  });

  it('does not walk the stop down run after run on an unchanged sample', () => {
    // The regression: neededRoomR = 0.5 * 1.3 = 0.65 applied multiplicatively to
    // an already-corrected stop gave 1.5 -> 1.25 -> 1.0 -> 0.75 -> 0.5 (the floor)
    // off a sample that never changed. Once a run has acted, the same trades are
    // stale, so the next run must find nothing to do until new trades close.
    const sample = [winnerOn('2026-01-01', -0.5, 2.5), winnerOn('2026-01-02', -0.5, 2.5)];
    const report = aggregateExcursions(sample);

    const first = computeExcursionTune(
      report,
      { stopAtrMultiple: 1.5, targetRMultiple: 2 },
      { minTrades: 2, maxStep: 0.25, sampleSince: null },
    );
    expect(first.patch.stopAtrMultiple).toBe(1.25); // one bounded correction

    // autoTune stamps autoTuneExitTunedAt when it applies the patch; the next run
    // passes it back and the same trades no longer qualify.
    const second = computeExcursionTune(
      report,
      { stopAtrMultiple: 1.25, targetRMultiple: 2 },
      { minTrades: 2, maxStep: 0.25, sampleSince: at('2026-01-03') },
    );
    expect(second.patch.stopAtrMultiple).toBeUndefined();
  });

  it('acts again once enough trades have closed under the new geometry', () => {
    const report = aggregateExcursions([
      winnerOn('2026-01-01', -0.5, 2.5), // stale
      winnerOn('2026-02-02', -0.5, 2.5), // fresh
      winnerOn('2026-02-03', -0.5, 2.5), // fresh
    ]);
    const r = computeExcursionTune(
      report,
      { stopAtrMultiple: 1.25, targetRMultiple: 2 },
      { minTrades: 2, maxStep: 0.25, sampleSince: at('2026-02-01') },
    );
    expect(r.diagnostics.winners).toBe(2);
    expect(r.patch.stopAtrMultiple).toBe(1);
  });
});
