import { describe, it, expect } from 'vitest';
import {
  REGIME_FEATURES,
  RV_WINDOW,
  buildFeatures,
  driftScore,
  forwardFilter,
  logGaussianDensity,
  logsumexp,
  predictedNext,
  standardize,
} from '../src/services/hmmForward';

// ---------------------------------------------------------------------------
// The forward filter and the feature builder, checked against numbers worked
// by hand and against numpy — independent of the shipped model. The parity
// with the Python reference on REAL rows is regimeModelParity.test.ts.
// ---------------------------------------------------------------------------

describe('logsumexp', () => {
  it('handles the edge cases the filter produces', () => {
    expect(logsumexp([-Infinity, -Infinity])).toBe(-Infinity);
    expect(logsumexp([0, -Infinity])).toBeCloseTo(0, 12);
    expect(logsumexp([1000, 1000])).toBeCloseTo(1000 + Math.log(2), 12);
    expect(logsumexp([])).toBe(-Infinity);
  });
});

describe('logGaussianDensity', () => {
  it('matches the closed form in one dimension', () => {
    expect(logGaussianDensity([0], [0], [[1]], 0)).toBeCloseTo(-0.5 * Math.log(2 * Math.PI), 12);
    // N(2; 0, 1): −0.5·(ln 2π + 4)
    expect(logGaussianDensity([2], [0], [[1]], 0)).toBeCloseTo(-0.5 * (Math.log(2 * Math.PI) + 4), 12);
  });

  it('matches the closed form in two dimensions with a hand-inverted covariance', () => {
    // Σ = [[2, .3], [.3, 1]] → |Σ| = 1.91, Σ⁻¹ = (1/1.91)·[[1, −.3], [−.3, 2]]
    const det = 1.91;
    const precision = [
      [1 / det, -0.3 / det],
      [-0.3 / det, 2 / det],
    ];
    const x = [0.4, -0.2];
    const mean = [0.1, 0.1];
    const d = [x[0] - mean[0], x[1] - mean[1]];
    const maha =
      d[0] * (precision[0][0] * d[0] + precision[0][1] * d[1]) +
      d[1] * (precision[1][0] * d[0] + precision[1][1] * d[1]);
    const expected = -0.5 * (2 * Math.log(2 * Math.PI) + Math.log(det) + maha);
    expect(logGaussianDensity(x, mean, precision, Math.log(det))).toBeCloseTo(expected, 12);
  });
});

describe('the hand-computed two-state toy', () => {
  // μ = 0 / 2, unit variance, π = [.5, .5], A = [[.9, .1], [.2, .8]], x = [0, 2].
  const params = {
    startprob: [0.5, 0.5],
    transmat: [
      [0.9, 0.1],
      [0.2, 0.8],
    ],
    states: [
      { mean: [0], precision: [[1]], logDet: 0 },
      { mean: [2], precision: [[1]], logDet: 0 },
    ],
  };

  it('filters to the worked posteriors, log-likelihood and prediction', () => {
    const { posteriors, logLikelihood, stepLogLik } = forwardFilter(params, [[0], [2]]);
    expect(posteriors[0][0]).toBeCloseTo(0.880797, 6);
    expect(posteriors[0][1]).toBeCloseTo(0.119203, 6);
    expect(posteriors[1][0]).toBeCloseTo(0.375944, 6);
    expect(posteriors[1][1]).toBeCloseTo(0.624056, 6);
    expect(logLikelihood).toBeCloseTo(-3.6284, 4);
    expect(stepLogLik[0] + stepLogLik[1]).toBeCloseTo(logLikelihood, 12);
    const next = predictedNext(posteriors[1], params.transmat);
    expect(next[0]).toBeCloseTo(0.463161, 6);
    expect(next[1]).toBeCloseTo(0.536839, 6);
  });

  it('every posterior row sums to one', () => {
    const { posteriors } = forwardFilter(params, [[0], [2], [-1], [3]]);
    for (const row of posteriors) expect(row[0] + row[1]).toBeCloseTo(1, 12);
  });

  it('refuses an empty window', () => {
    expect(() => forwardFilter(params, [])).toThrow(/at least one/);
  });
});

/** n business-day-ish dates from 2024-01-01 (weekdays only, not holiday-aware). */
function dates(n: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function sampleStd(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

describe('buildFeatures', () => {
  const ds = dates(30);
  const closes = ds.map((_, i) => 100 * Math.exp(i * 0.001 + Math.sin(i) * 0.01));
  const sp500 = ds.map((date, i) => ({ date, value: closes[i] }));
  const vix = ds.map((date, i) => ({ date, value: 12 + i * 0.25 }));

  it('starts on the 21st close and matches the formulas', () => {
    const rows = buildFeatures(sp500, vix);
    expect(rows).toHaveLength(30 - RV_WINDOW);
    expect(rows[0].date).toBe(ds[RV_WINDOW]);
    const logRet = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    expect(rows[0].ret).toBeCloseTo(logRet[RV_WINDOW - 1], 12);
    expect(rows[0].logRv20).toBeCloseTo(Math.log(sampleStd(logRet.slice(0, RV_WINDOW))), 12);
    expect(rows[0].logVix).toBeCloseTo(Math.log(12 + RV_WINDOW * 0.25), 12);
  });

  it('drops a VIX hole without breaking the return chain', () => {
    const rows = buildFeatures(
      sp500,
      vix.filter((p) => p.date !== ds[25]),
    );
    expect(rows.find((r) => r.date === ds[25])).toBeUndefined();
    const after = rows.find((r) => r.date === ds[26]);
    expect(after?.ret).toBeCloseTo(Math.log(closes[26] / closes[25]), 12);
  });

  it('makes a two-session return across an S&P 500 hole', () => {
    const rows = buildFeatures(
      sp500.filter((p) => p.date !== ds[25]),
      vix,
    );
    const after = rows.find((r) => r.date === ds[26]);
    expect(after?.ret).toBeCloseTo(Math.log(closes[26] / closes[24]), 12);
  });

  it('sorts unsorted input and keeps the last of a duplicated date', () => {
    const shuffled = [...sp500].reverse();
    const dup = [...shuffled, { date: ds[29], value: closes[29] * 2 }];
    const rows = buildFeatures(dup, vix);
    expect(rows[rows.length - 1].date).toBe(ds[29]);
    expect(rows[rows.length - 1].ret).toBeCloseTo(Math.log((closes[29] * 2) / closes[28]), 12);
  });

  it('drops rows a non-positive close would poison', () => {
    const bad = sp500.map((p, i) => (i === 25 ? { ...p, value: 0 } : p));
    const rows = buildFeatures(bad, vix);
    expect(rows.find((r) => r.date === ds[25])).toBeUndefined();
    expect(rows.every((r) => Number.isFinite(r.ret) && Number.isFinite(r.logRv20))).toBe(true);
  });
});

describe('standardize', () => {
  it('follows the column order the spec names', () => {
    const rows = [{ date: 'd', ret: 1, logVix: 2, logRv20: 3 }];
    const spec = { features: ['logRv20', 'ret', 'logVix'] as const, mean: [0, 0, 0], scale: [1, 2, 4] };
    expect(standardize(rows, spec)[0]).toEqual([3, 0.5, 0.5]);
    expect(standardize(rows, { features: REGIME_FEATURES, mean: [1, 2, 3], scale: [1, 1, 1] })[0]).toEqual([0, 0, 0]);
  });
});

describe('driftScore', () => {
  it('is the mean of the last window steps, or null with fewer', () => {
    const steps = Array.from({ length: 20 }, (_, i) => i);
    expect(driftScore(steps, 10)).toBeCloseTo(14.5, 12);
    expect(driftScore(steps.slice(0, 5), 10)).toBeNull();
    expect(driftScore(steps, 0)).toBeNull();
  });
});
