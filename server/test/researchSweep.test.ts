import { describe, it, expect } from 'vitest';
import {
  buildExperiments,
  completeFilters,
  completeWeights,
  EXPERIMENT_NAMES,
  rankResults,
  SweepBase,
  SweepResult,
} from '../src/services/autotrading/researchSweep';
import { defaultScreenerConfig } from '../src/indicators/screener';

const base: SweepBase = {
  symbols: ['AAPL', 'MSFT'],
  from: '2025-01-01',
  to: '2026-01-01',
  splitDate: '2025-09-01',
  riskProfile: 'MODERATE',
  startingEquity: 100_000,
  maxConcurrentPositions: 3,
};

describe('buildExperiments — the shallow-merge trap', () => {
  it('every variant carries a COMPLETE weights object (a partial would silently zero the rest)', () => {
    const allKeys = Object.keys(defaultScreenerConfig().weights).sort();
    for (const v of buildExperiments(base, EXPERIMENT_NAMES)) {
      const weights = (v.body.screenerConfig as { weights: Record<string, number> }).weights;
      expect(Object.keys(weights).sort(), `${v.experiment}/${v.label}`).toEqual(allKeys);
    }
  });

  it("every variant's filters carry the autotrade minRelVol 1.5 base, not the manual screener's unset default", () => {
    for (const v of buildExperiments(base, EXPERIMENT_NAMES)) {
      const filters = (v.body.screenerConfig as { filters: Record<string, unknown> }).filters;
      expect(filters.minRelVol, `${v.experiment}/${v.label}`).toBe(1.5);
    }
  });

  it('completeWeights/completeFilters apply overrides without dropping siblings', () => {
    const w = completeWeights({ relativeStrength: 20 });
    expect(w.relativeStrength).toBe(20);
    expect(w.momentum).toBe(defaultScreenerConfig().weights.momentum);
    const f = completeFilters({ minScore: 60 });
    expect(f.minScore).toBe(60);
    expect(f.minAvgVolume).toBe(defaultScreenerConfig().filters.minAvgVolume);
  });
});

describe('buildExperiments — one axis per experiment', () => {
  it('minscore varies ONLY filters.minScore across its variants', () => {
    const variants = buildExperiments(base, ['minscore']);
    expect(variants.map((v) => (v.body.screenerConfig as { filters: { minScore?: number } }).filters.minScore)).toEqual(
      [0, 40, 60, 75], // 0 = the gate off — the engine treats 0 and unset identically
    );
    // Everything else identical variant-to-variant.
    for (const v of variants) {
      expect(v.body.decisionConfig).toEqual({ stopAtrMultiple: 1.5, targetRMultiple: 2 });
      expect(v.body.directionMode).toBeUndefined();
    }
  });

  it('exits keeps the baseline as the shipped bracket and arms trailing only on the runner variants', () => {
    const variants = buildExperiments(base, ['exits']);
    const byLabel = new Map(variants.map((v) => [v.label, v.body]));
    expect(byLabel.get('bracket-2R (baseline)')).toMatchObject({
      decisionConfig: { stopAtrMultiple: 1.5, targetRMultiple: 2 },
    });
    expect(byLabel.get('bracket-2R (baseline)')!.trailStartRMultiple).toBeUndefined();
    expect(byLabel.get('runner: BE@1R, trail 1.5R')).toMatchObject({
      decisionConfig: { stopAtrMultiple: 1.5, targetRMultiple: 6 },
      breakevenTriggerRMultiple: 1,
      trailStartRMultiple: 1,
      trailStopRMultiple: 1.5,
    });
  });

  it('direction toggles directionMode alone', () => {
    const variants = buildExperiments(base, ['direction']);
    expect(variants.map((v) => v.body.directionMode)).toEqual(['long', 'both']);
  });

  it('selecting a subset builds only that subset', () => {
    const variants = buildExperiments(base, ['direction']);
    expect(new Set(variants.map((v) => v.experiment))).toEqual(new Set(['direction']));
  });
});

describe('rankResults', () => {
  const row = (label: string, expectancy: number | null, reliable: boolean, error?: string): SweepResult => ({
    experiment: 'x',
    label,
    inSample: null,
    outOfSample:
      expectancy === null
        ? null
        : {
            stats: {
              totalTrades: 30,
              winRate: 50,
              expectancy,
              profitFactor: 1.2,
              returnPct: 1,
              maxDrawdown: 100,
              avgR: 0.1,
            },
            significance: { sampleSize: 30, ciLow: null, ciHigh: null, pValue: null, reliable },
          },
    error,
  });

  it('sorts reliable OOS samples first, then by OOS expectancy, with errors last', () => {
    const ranked = rankResults([
      row('err', null, false, 'boom'),
      row('thin-high', 99, false),
      row('reliable-low', 5, true),
      row('reliable-high', 20, true),
    ]);
    expect(ranked.map((r) => r.label)).toEqual(['reliable-high', 'reliable-low', 'thin-high', 'err']);
  });
});
