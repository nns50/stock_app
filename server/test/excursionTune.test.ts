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
    expect(r.patch.stopAtrMultiple).toBe(1.75); // 1.5 + maxStep(0.25)
  });

  it('raises the target toward winners’ favorable peak', () => {
    // heat 0.77 keeps the stop unchanged; MFE 5R pulls the target up.
    const report = aggregateExcursions([winner(-0.77, 5), winner(-0.77, 5)]);
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
    // heat 0.77 => needed room ~1.0R => stop unchanged; MFE 2.5 × 0.8 = 2.0 => target unchanged.
    const report = aggregateExcursions([winner(-0.77, 2.5), winner(-0.77, 2.5)]);
    const r = computeExcursionTune(report, { stopAtrMultiple: 1.5, targetRMultiple: 2 }, BOUNDS);
    expect(r.patch).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/already matches/);
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
