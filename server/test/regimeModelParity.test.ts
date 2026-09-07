import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ML_REGIMES,
  REGIME_FIXTURE_FILE,
  REGIME_MODEL_FILE,
  hmmParamsOf,
  loadRegimeHistory,
  loadRegimeModel,
  loadRegimeModelFrom,
  resetRegimeModelCache,
} from '../src/services/regimeModel';
import { buildFeatures, driftScore, forwardFilter, predictedNext, standardize } from '../src/services/hmmForward';

// ---------------------------------------------------------------------------
// Two implementations of one algorithm, held together by a fixture of REAL
// FRED rows that ml/regime/train.py wrote alongside the model — every
// intermediate the Python reference computed, which hmmlearn itself confirmed
// on the same window (score() and predict_proba()[-1]). If this file fails
// after a retrain, one side changed without the other.
// ---------------------------------------------------------------------------

interface Fixture {
  modelVersion: string;
  window: number;
  sp500: { date: string; value: number }[];
  vix: { date: string; value: number }[];
  features: { date: string; ret: number; logVix: number; logRv20: number }[];
  standardized: number[][];
  filteredPosteriors: number[][];
  stepLogLik: number[];
  logLikelihood: number;
  hmmlearnScore: number;
  hmmlearnPredictProbaLast: number[];
  predictedNext: number[];
  driftScore: number;
  labels: string[];
}

const fixture = JSON.parse(fs.readFileSync(REGIME_FIXTURE_FILE, 'utf8')) as Fixture;
const model = loadRegimeModel();
if (!model) throw new Error(`the shipped model at ${REGIME_MODEL_FILE} did not load`);

describe('the shipped model', () => {
  it('names three distinct regimes in index order', () => {
    expect(model.states.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(new Set(model.states.map((s) => s.label)).size).toBe(3);
    for (const s of model.states) expect(ML_REGIMES).toContain(s.label);
    expect(fixture.labels).toEqual(model.states.map((s) => s.label));
  });

  it('is the version the fixture was built from', () => {
    expect(fixture.modelVersion).toBe(model.version);
    expect(fixture.features).toHaveLength(fixture.window);
  });

  it('carries the drift line and a retrain date', () => {
    expect(model.drift.p5).toBeLessThan(model.drift.median);
    expect(model.training.retrainBy > model.training.trainedThrough).toBe(true);
  });
});

describe('feature parity', () => {
  const rows = buildFeatures(fixture.sp500, fixture.vix);

  it('rebuilds every fixture feature row from the raw closes', () => {
    expect(rows.map((r) => r.date)).toEqual(fixture.features.map((f) => f.date));
    rows.forEach((row, i) => {
      expect(row.ret).toBeCloseTo(fixture.features[i].ret, 9);
      expect(row.logVix).toBeCloseTo(fixture.features[i].logVix, 9);
      expect(row.logRv20).toBeCloseTo(fixture.features[i].logRv20, 9);
    });
  });

  it('standardizes to the same matrix, in the model feature order', () => {
    const z = standardize(rows, { features: model.features, mean: model.scaler.mean, scale: model.scaler.scale });
    z.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(fixture.standardized[i][j], 9)));
  });
});

describe('filter parity', () => {
  const rows = buildFeatures(fixture.sp500, fixture.vix);
  const z = standardize(rows, { features: model.features, mean: model.scaler.mean, scale: model.scaler.scale });
  const result = forwardFilter(hmmParamsOf(model), z);

  it('reproduces every filtered posterior cell', () => {
    result.posteriors.forEach((row, t) =>
      row.forEach((p, k) => expect(p).toBeCloseTo(fixture.filteredPosteriors[t][k], 9)),
    );
  });

  it('reproduces the per-step and total log-likelihood, which equal hmmlearn score()', () => {
    result.stepLogLik.forEach((c, t) => expect(c).toBeCloseTo(fixture.stepLogLik[t], 9));
    expect(result.logLikelihood).toBeCloseTo(fixture.logLikelihood, 6);
    expect(result.logLikelihood).toBeCloseTo(fixture.hmmlearnScore, 6);
  });

  it('ends on hmmlearn predict_proba()[-1] — the one filtered row of a smoothed pass', () => {
    const last = result.posteriors[result.posteriors.length - 1];
    last.forEach((p, k) => expect(p).toBeCloseTo(fixture.hmmlearnPredictProbaLast[k], 6));
  });

  it('predicts the next state distribution and the drift score', () => {
    const last = result.posteriors[result.posteriors.length - 1];
    predictedNext(last, model.transmat).forEach((p, k) => expect(p).toBeCloseTo(fixture.predictedNext[k], 9));
    expect(driftScore(result.stepLogLik, model.drift.window)).toBeCloseTo(fixture.driftScore, 9);
  });
});

describe('loading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-model-'));
  afterEach(() => {
    vi.restoreAllMocks();
    resetRegimeModelCache();
  });

  it('is null with one warning for a missing file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadRegimeModelFrom(path.join(dir, 'missing.json'))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is null for a file that is not JSON', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{ not json');
    expect(loadRegimeModelFrom(file)).toBeNull();
  });

  it('is null for a model whose transition rows do not sum to one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = JSON.parse(fs.readFileSync(REGIME_MODEL_FILE, 'utf8')) as { transmat: number[][] };
    broken.transmat[0][0] += 0.01;
    const file = path.join(dir, 'unstochastic.json');
    fs.writeFileSync(file, JSON.stringify(broken));
    expect(loadRegimeModelFrom(file)).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/row 0 must sum to 1/);
  });

  it('is null for a model with two states sharing a label', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = JSON.parse(fs.readFileSync(REGIME_MODEL_FILE, 'utf8')) as { states: { label: string }[] };
    broken.states[1].label = broken.states[0].label;
    const file = path.join(dir, 'duplicate-label.json');
    fs.writeFileSync(file, JSON.stringify(broken));
    expect(loadRegimeModelFrom(file)).toBeNull();
  });

  it('memoizes the shipped model', () => {
    resetRegimeModelCache();
    expect(loadRegimeModel()).toBe(loadRegimeModel());
  });
});

describe('the walk-forward history', () => {
  const history = loadRegimeHistory();
  if (!history) throw new Error('regimeHistory.json did not load');

  it('is keyed by data date with valid readings that sum to one', () => {
    expect(history.from <= history.to).toBe(true);
    const days = Object.entries(history.days);
    expect(days.length).toBeGreaterThan(1000);
    for (const [date, day] of days) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ML_REGIMES).toContain(day.regime);
      expect(day.p.high_vol_bearish + day.p.low_vol_bullish + day.p.sideways).toBeCloseTo(1, 5);
    }
  });

  it('spends the COVID crash and most of the 2022 bear market in High Vol', () => {
    const share = (from: string, to: string) => {
      const rows = Object.entries(history.days).filter(([d]) => d >= from && d <= to);
      return rows.filter(([, day]) => day.regime === 'high_vol_bearish').length / rows.length;
    };
    expect(share('2020-02-24', '2020-04-30')).toBeGreaterThanOrEqual(0.5);
    expect(share('2022-01-03', '2022-10-12')).toBeGreaterThanOrEqual(0.5);
  });
});
