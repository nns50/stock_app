import { describe, it, expect } from 'vitest';
import { Candle } from '../src/providers/types';
import { TradeExcursion } from '../src/services/excursion';
import {
  ExitGeometry,
  ValidationTrade,
  fitOnce,
  fitToFixedPoint,
  replayUnderGeometry,
  validateExitTuneRules,
} from '../src/services/autotrading/exitTuneValidation';

/** A deterministic PRNG, so a bootstrap CI in a test is a fixed number rather
 *  than a coin flip. Same mulberry32 the other Monte Carlo tests use. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const OPTS = { rng: seeded(7), resamples: 400 };

const bar = (high: number, low: number, close = (high + low) / 2): Candle => ({
  time: 0,
  open: (high + low) / 2,
  high,
  low,
  close,
  volume: 1000,
});

let seq = 0;
/** An INTRADAY excursion row — the only resolution the tuner reads. */
function row(maeR: number, mfeR: number, realizedR: number, entryDate = '2026-08-01'): TradeExcursion {
  seq += 1;
  return {
    positionId: seq,
    symbol: 'AAA',
    side: 'long',
    entryDate,
    mfePct: 0,
    maePct: 0,
    mfeR,
    maeR,
    realizedR,
    capturedPct: mfeR > 0 ? Math.round((realizedR / mfeR) * 100) : null,
    resolution: 'intraday',
  };
}

/** Entry 100, initial stop 95 — 1R is $5 a share under the CURRENT geometry. */
function trade(bars: Candle[], entryDate = '2026-08-01', excursion = row(-0.5, 2.5, 2, entryDate)): ValidationTrade {
  seq += 1;
  return {
    positionId: seq,
    symbol: 'AAA',
    entryDate,
    side: 'long',
    entryPrice: 100,
    initialStopPrice: 95,
    bars,
    excursion,
  };
}

const CURRENT: ExitGeometry = { stopAtrMultiple: 1.5, targetRMultiple: 2 };
const NO_TRAIL = { breakevenTriggerR: 0, trailStartR: 0, trailStopR: 0 };
const BOUNDS = { minTrades: 2, maxStep: 0.25 };

describe('replayUnderGeometry — a candidate stop is a SCALED stop, in its own R', () => {
  it('places the candidate stop at candidate/current of the real distance', () => {
    // The trade dips to 97.4 (−0.52R under the traded 5-point stop) and then
    // runs to 112. Under the current geometry it reaches the 2R target at 110.
    const bars = [bar(101, 97.4), bar(112, 100)];
    const t = trade(bars);

    const asTraded = replayUnderGeometry(t, CURRENT, CURRENT, NO_TRAIL);
    expect(asTraded).toMatchObject({ reason: 'target', exitR: 2 });

    // Halve stopAtrMultiple and the stop sits at 97.50, above that first dip.
    const halved = replayUnderGeometry(t, CURRENT, { stopAtrMultiple: 0.75, targetRMultiple: 2 }, NO_TRAIL);
    expect(halved).toMatchObject({ reason: 'stop', exitR: -1 });
  });

  it('reports the candidate arm in the candidate’s own R, which is the same DOLLARS', () => {
    // No dip at all: straight to 105, i.e. +1R on the traded 5-point stop.
    // Under a halved stop that same move is +2R of a half-sized R — the same
    // money, because the sizer buys twice the shares for the same risk budget.
    // So a 2R target is REACHED there and missed here.
    const bars = [bar(105.01, 100), bar(105.5, 104)];
    const t = trade(bars);
    expect(replayUnderGeometry(t, CURRENT, CURRENT, NO_TRAIL)?.reason).toBe('time_exit');
    expect(replayUnderGeometry(t, CURRENT, { stopAtrMultiple: 0.75, targetRMultiple: 2 }, NO_TRAIL)).toMatchObject({
      reason: 'target',
      exitR: 2,
    });
  });

  it('returns null for a trade with no bars rather than a zero', () => {
    expect(replayUnderGeometry(trade([]), CURRENT, CURRENT, NO_TRAIL)).toBeNull();
  });
});

describe('fitToFixedPoint — where the rule comes to REST, not where one step lands', () => {
  it('walks the stop to its floor in five bounded steps on a stationary sample', () => {
    // This is task #47's finding as a test. Winners taking 0.5R of heat give
    // neededRoomR = 0.55, and re-applying that to an already-corrected stop
    // gives 1.5 -> 1.25 -> 1.00 -> 0.75 -> 0.50 (STOP_MULT_MIN). Each single
    // run moves 0.25 and looks unremarkable; the sum is a 3x tightening.
    const rows = [row(-0.5, 2.5, 2), row(-0.5, 2.5, 2)];

    const step = fitOnce(rows, CURRENT, BOUNDS);
    expect(step.geometry).toEqual({ stopAtrMultiple: 1.25, targetRMultiple: 2 });

    const rest = fitToFixedPoint(rows, CURRENT, BOUNDS);
    expect(rest.geometry).toEqual({ stopAtrMultiple: 0.5, targetRMultiple: 2 });
    expect(rest.runs).toBe(5);
    expect(rest.converged).toBe(true);
  });

  it('stops where the rule stops, when the geometry already fits', () => {
    // heat 0.91 => ~1R of room needed; MFE 2.5 x 0.8 = the 2R target already set.
    const rows = [row(-0.91, 2.5, 2), row(-0.91, 2.5, 2)];
    const rest = fitToFixedPoint(rows, CURRENT, BOUNDS);
    expect(rest.geometry).toEqual(CURRENT);
    expect(rest.runs).toBe(1);
  });

  it('cannot move below the winner floor, however many runs it is given', () => {
    const rest = fitToFixedPoint([row(-0.1, 5, 2)], CURRENT, BOUNDS); // 1 winner, need 2
    expect(rest.geometry).toEqual(CURRENT);
    expect(rest.warnings.join(' ')).toMatch(/need 2/);
  });
});

describe('validateExitTuneRules', () => {
  /** `n` copies of a trade whose path dips to `low` before running to `high`. */
  const many = (n: number, low: number, high: number, from = 1) =>
    Array.from({ length: n }, (_, i) =>
      trade([bar(100.5, low), bar(high, 100)], `2026-08-${String(from + i).padStart(2, '0')}`),
    );

  it('fits on the OLDER slice and scores on the newer one', () => {
    const trades = many(24, 99, 112);
    const v = validateExitTuneRules(trades, CURRENT, NO_TRAIL, BOUNDS, OPTS);
    expect(v.holdout.train.trades).toBe(12);
    expect(v.holdout.test.trades).toBe(12);
    expect(v.holdout.train.to! < v.holdout.test.from!).toBe(true);
    // Scored on the test slice only — the fit's own trades are not in it.
    expect(v.holdout.oneStep.comparison.trades).toBe(12);
    expect(v.inSample.oneStep.comparison.trades).toBe(24);
  });

  it('fits on the training rows ALONE — the test slice must not reach the rule', () => {
    // The older half took 0.5R of heat (the rule wants a tighter stop); the
    // newer half took 0.91R (the rule wants the stop left where it is). Fitting
    // on everything gives "no change", so a fit that has seen the test slice
    // and one that has not produce visibly different geometries here.
    const trades = [
      ...many(12, 99, 112, 1).map((t) => ({ ...t, excursion: { ...t.excursion, maeR: -0.5 } })),
      ...many(12, 99, 112, 13).map((t) => ({ ...t, excursion: { ...t.excursion, maeR: -0.91 } })),
    ];
    const v = validateExitTuneRules(trades, CURRENT, NO_TRAIL, BOUNDS, OPTS);
    expect(v.holdout.oneStep.fit.geometry.stopAtrMultiple).toBe(1.25); // fitted on the 0.5R half only
    expect(v.inSample.oneStep.fit.geometry.stopAtrMultiple).toBe(1.5); // fitted on both halves
  });

  it('prices the fixed point, which is the geometry the tuner would end up trading', () => {
    // Every trade dips to 97.4 (−0.52R) and then runs past the 2R target. The
    // rule reads that heat and walks the stop to 0.50xATR — where the stop sits
    // at 98.33 and every one of these trades is stopped out for −1R instead.
    const trades = many(40, 97.4, 112);
    const v = validateExitTuneRules(trades, CURRENT, NO_TRAIL, BOUNDS, OPTS);

    expect(v.holdout.fixedPoint.fit.geometry.stopAtrMultiple).toBe(0.5);
    expect(v.holdout.fixedPoint.comparison.current.replay.meanR).toBe(2);
    expect(v.holdout.fixedPoint.comparison.candidate.replay.meanR).toBe(-1);
    expect(v.holdout.fixedPoint.comparison.meanDiffR).toBe(-3);
    expect(v.holdout.fixedPoint.comparison.verdict).toBe('worse');
  });

  it('says no_change when the rule leaves the geometry alone', () => {
    const trades = many(40, 99, 112).map((t) => ({ ...t, excursion: { ...t.excursion, maeR: -0.91, mfeR: 2.5 } }));
    const v = validateExitTuneRules(trades, CURRENT, NO_TRAIL, BOUNDS, OPTS);
    expect(v.holdout.oneStep.fit.geometry).toEqual(CURRENT);
    expect(v.holdout.oneStep.comparison.verdict).toBe('no_change');
    expect(v.holdout.oneStep.comparison.meanDiffR).toBe(0);
  });

  it('refuses a directional verdict on a sample too thin to support one', () => {
    // Four trades whose every paired difference is negative. A bootstrap CI over
    // four numbers excludes zero easily; that is not evidence, and calling it
    // 'worse' here would make the verdict a function of sample size.
    const v = validateExitTuneRules(many(8, 97.4, 112), CURRENT, NO_TRAIL, BOUNDS, OPTS);
    expect(v.holdout.fixedPoint.comparison.meanDiffR).toBeLessThan(0);
    expect(v.holdout.fixedPoint.comparison.verdict).toBe('insufficient');
  });

  it('drops a trade from BOTH arms when either arm cannot replay it', () => {
    // An unpaired trade would put one geometry against a population the other
    // never saw — the exact comparison the exit-replay route's `actual` field
    // exists to avoid.
    const trades = [...many(40, 97.4, 112), trade([], '2026-08-30'), trade([], '2026-08-31')];
    const v = validateExitTuneRules(trades, CURRENT, NO_TRAIL, BOUNDS, OPTS);
    expect(v.coverage.supplied).toBe(42);
    expect(v.coverage.unpaired).toBe(2);
    expect(v.holdout.fixedPoint.comparison.candidate.replay.trades).toBe(
      v.holdout.fixedPoint.comparison.current.replay.trades,
    );
  });
});
