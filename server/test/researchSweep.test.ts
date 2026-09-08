import { describe, it, expect } from 'vitest';
import {
  ALL_EXPERIMENT_NAMES,
  allZeroTrades,
  buildExperiments,
  buildOverlayFloorStage,
  completeFilters,
  completeWeights,
  EQUITY_WALK_FORWARD_PATH,
  EXPERIMENT_NAMES,
  formatDataIssues,
  formatOverlaySelection,
  ML_REGIME_GRID,
  OPTIONS_WALK_FORWARD_PATH,
  OverlayCell,
  overlayCellLabel,
  rankResults,
  selectOverlayCell,
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
    for (const v of buildExperiments(base, ALL_EXPERIMENT_NAMES)) {
      const weights = (v.body.screenerConfig as { weights: Record<string, number> }).weights;
      expect(Object.keys(weights).sort(), `${v.experiment}/${v.label}`).toEqual(allKeys);
    }
  });

  it("every variant's filters carry the autotrade minRelVol 1.5 base, not the manual screener's unset default", () => {
    for (const v of buildExperiments(base, ALL_EXPERIMENT_NAMES)) {
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

  it('the DEFAULT experiment set excludes the opt-in ivrv (options data cost), and stays equity-endpoint only', () => {
    const variants = buildExperiments(base, EXPERIMENT_NAMES);
    expect(variants.some((v) => v.experiment === 'ivrv')).toBe(false);
    for (const v of variants) expect(v.endpoint, `${v.experiment}/${v.label}`).toBe(EQUITY_WALK_FORWARD_PATH);
  });

  it('rshorizon adds RS weight 15 on top of the default mix and varies ONLY the lookback', () => {
    const variants = buildExperiments(base, ['rshorizon']);
    const cfgOf = (v: (typeof variants)[number]) =>
      v.body.screenerConfig as { weights: Record<string, number>; relativeStrengthLookbackDays?: number };
    expect(variants.map((v) => cfgOf(v).weights.relativeStrength)).toEqual([0, 15, 15, 15]);
    expect(variants.map((v) => cfgOf(v).relativeStrengthLookbackDays)).toEqual([undefined, 20, 63, 126]);
    for (const v of variants) {
      // Every other component keeps the shipped mix — the axis is the RS
      // horizon, not a reweighting.
      expect(cfgOf(v).weights.momentum, v.label).toBe(defaultScreenerConfig().weights.momentum);
      expect(cfgOf(v).weights.trend, v.label).toBe(defaultScreenerConfig().weights.trend);
      expect(v.body.decisionConfig).toEqual({ stopAtrMultiple: 1.5, targetRMultiple: 2 });
      expect(v.body.endpoint).toBeUndefined();
      expect(v.endpoint).toBe(EQUITY_WALK_FORWARD_PATH);
    }
  });

  it('optexits targets the OPTIONS walk-forward and varies ONLY the %-of-premium exit fields', () => {
    const variants = buildExperiments(base, ['optexits']);
    expect(variants.map((v) => v.endpoint)).toEqual(Array(4).fill(OPTIONS_WALK_FORWARD_PATH));
    const exitFields = (b: Record<string, unknown>) => ({
      stop: b.optionsStopLossPct,
      tp: b.optionsTakeProfitPct,
      be: b.optionsBreakevenTriggerPct,
      trailStart: b.optionsTrailStartPct,
      trailStop: b.optionsTrailStopPct,
    });
    expect(variants.map((v) => exitFields(v.body))).toEqual([
      { stop: undefined, tp: undefined, be: undefined, trailStart: undefined, trailStop: undefined },
      { stop: 50, tp: undefined, be: undefined, trailStart: undefined, trailStop: undefined },
      { stop: 50, tp: 100, be: undefined, trailStart: undefined, trailStop: undefined },
      { stop: 50, tp: undefined, be: 50, trailStart: 50, trailStop: 50 },
    ]);
    for (const v of variants) {
      expect(v.body.optionsDecisionConfig, `${v.label}`).toBeUndefined(); // no IV/RV gate — one axis at a time
      expect(v.body.decisionConfig, `${v.label}`).toBeUndefined();
    }
  });

  it('ivrv targets the OPTIONS walk-forward and varies ONLY optionsDecisionConfig.maxIvRvRatio', () => {
    const variants = buildExperiments(base, ['ivrv']);
    expect(variants.map((v) => v.endpoint)).toEqual(Array(5).fill(OPTIONS_WALK_FORWARD_PATH));
    expect(
      variants.map((v) => (v.body.optionsDecisionConfig as { maxIvRvRatio?: number } | undefined)?.maxIvRvRatio),
    ).toEqual([undefined, 1.5, 1.2, 1.0, 0.8]);
    for (const v of variants) {
      // No equity bracket geometry on an options-engine body — the options
      // engine's own shipped defaults are the thing under test.
      expect(v.body.decisionConfig, `${v.experiment}/${v.label}`).toBeUndefined();
      expect(v.body.directionMode).toBeUndefined();
    }
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

describe('data-issue surfacing', () => {
  const windowWith = (totalTrades: number): SweepResult['outOfSample'] => ({
    stats: { totalTrades, winRate: 0, expectancy: 0, profitFactor: null, returnPct: 0, maxDrawdown: 0, avgR: null },
    significance: null,
  });
  const result = (oosTrades: number, isTrades: number, error?: string): SweepResult => ({
    experiment: 'x',
    label: 'v',
    outOfSample: error ? null : windowWith(oosTrades),
    inSample: error ? null : windowWith(isTrades),
    error,
  });

  it('formatDataIssues renders fetch errors and exclusions, and null when clean', () => {
    expect(formatDataIssues(undefined)).toBeNull();
    expect(formatDataIssues({ excludedSymbols: [], errors: [] })).toBeNull();
    expect(
      formatDataIssues({
        excludedSymbols: [{ symbol: 'SPG', reason: 'real estate' }],
        errors: [{ symbol: 'AAPL', message: 'POLYGON_API_KEY is not set' }],
      }),
    ).toBe('fetch errors: AAPL (POLYGON_API_KEY is not set) | excluded: SPG (real estate)');
  });

  it('allZeroTrades is true only when every answered variant has zero trades in BOTH windows', () => {
    expect(allZeroTrades([result(0, 0), result(0, 0)])).toBe(true);
    expect(allZeroTrades([result(0, 0), result(0, 3)])).toBe(false); // in-sample trades count too
    expect(allZeroTrades([result(0, 0), result(1, 0)])).toBe(false);
    expect(allZeroTrades([result(0, 0, 'HTTP 500')])).toBe(false); // errors alone are not a zero-trades verdict
    expect(allZeroTrades([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ML regime overlay grid (2026-09-08) — two stages, and the rule that
// picks the cell, written before the run and pinned here so the choice is
// reproducible from the results file.
// ---------------------------------------------------------------------------
describe('the ML regime overlay grid', () => {
  it('stage 1 is the 15-cell cut × tighten grid; 0/0 is the baseline with the overlay OFF, byte-identical to every other baseline', () => {
    const variants = buildExperiments(base, ['mlregime']);
    expect(variants).toHaveLength(15);
    expect(new Set(variants.map((v) => v.cell!.cut))).toEqual(new Set([0, 25, 35, 50, 100]));
    expect(new Set(variants.map((v) => v.cell!.tighten))).toEqual(new Set([0, 15, 30]));
    for (const v of variants) {
      expect(v.cell!.floor).toBe(0);
      expect(v.endpoint).toBe(EQUITY_WALK_FORWARD_PATH);
      expect(v.experiment).toBe('mlregime');
    }
    const baseline = variants.find((v) => v.cell!.cut === 0 && v.cell!.tighten === 0)!;
    expect(baseline.label).toBe('cut 0 / tighten 0 (baseline)');
    const exitsBaseline = buildExperiments(base, ['exits'])[0].body;
    expect(baseline.body).toEqual({
      ...exitsBaseline,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 0,
      mlRegimeTargetTightenPct: 0,
      mlRegimeHighVolMinSignalScore: 0,
    });
    const cell = variants.find((v) => v.cell!.cut === 35 && v.cell!.tighten === 15)!;
    expect(cell.body).toMatchObject({
      mlRegimeEnabled: true,
      mlRegimeSizeCutPct: 35,
      mlRegimeTargetTightenPct: 15,
      mlRegimeHighVolMinSignalScore: 0,
    });
    expect(cell.label).toBe('cut 35 / tighten 15');
    expect(variants.find((v) => v.cell!.cut === 100 && v.cell!.tighten === 0)!.label).toBe(
      'cut 100 / tighten 0 (skip High Vol)',
    );
  });

  it('is opt-in — never in the default set — and stays on the equity endpoint', () => {
    expect(buildExperiments(base, EXPERIMENT_NAMES).some((v) => v.experiment === 'mlregime')).toBe(false);
    expect(ALL_EXPERIMENT_NAMES).toContain('mlregime');
  });

  it('stage 2 varies ONLY the High-Vol conviction bar at the chosen cell, floor 0 first as its baseline', () => {
    const ladder = buildOverlayFloorStage(base, { cut: 35, tighten: 15 });
    expect(ladder.map((v) => v.cell)).toEqual([
      { cut: 35, tighten: 15, floor: 0 },
      { cut: 35, tighten: 15, floor: 72 },
      { cut: 35, tighten: 15, floor: 76 },
    ]);
    expect(ladder.map((v) => v.body.mlRegimeHighVolMinSignalScore)).toEqual([...ML_REGIME_GRID.floors]);
    for (const v of ladder) {
      expect(v.experiment).toBe('mlregime-floor');
      expect(v.body).toMatchObject({ mlRegimeEnabled: true, mlRegimeSizeCutPct: 35, mlRegimeTargetTightenPct: 15 });
      expect(v.endpoint).toBe(EQUITY_WALK_FORWARD_PATH);
    }
    expect(ladder[2].label).toBe('cut 35 / tighten 15 / floor 76');
  });

  describe('selectOverlayCell — the rule, written before the run', () => {
    const B: OverlayCell = { cut: 0, tighten: 0, floor: 0 };
    const res = (cell: OverlayCell, returnPct: number, maxDrawdown: number, regimeDayTrades = 10): SweepResult => ({
      experiment: 'mlregime',
      label: overlayCellLabel(cell),
      cell,
      inSample: null,
      outOfSample: {
        stats: { totalTrades: 40, winRate: 50, expectancy: 10, profitFactor: 1.5, returnPct, maxDrawdown, avgR: 0.2 },
        significance: null,
        report: { regimeDayTrades },
      },
    });
    const EQUITY = 100_000; // maxDrawdown $5,000 = 5% of it

    it('picks the highest OOS return ÷ max drawdown among cells keeping ≥ 75% of the baseline return', () => {
      const sel = selectOverlayCell(
        [
          res(B, 10, 5_000), // ratio 2
          res({ cut: 25, tighten: 0, floor: 0 }, 9, 3_000), // ratio 3, keeps 90% → eligible
          res({ cut: 50, tighten: 30, floor: 0 }, 6, 1_000), // ratio 6, but keeps 60% → out
          res({ cut: 35, tighten: 15, floor: 0 }, 8, 4_000), // ratio 2 — does not BEAT the baseline
        ],
        EQUITY,
        { baseline: B },
      );
      expect(sel.chosen).toEqual({ cut: 25, tighten: 0, floor: 0 });
      expect(sel.rows.find((r) => r.cell.cut === 50)!.eligible).toBe(false);
      expect(sel.rows.find((r) => r.cell.cut === 50)!.note).toMatch(/keeps < 75%/);
      expect(sel.rows.find((r) => r.cell.cut === 35)!.note).toMatch(/does not beat/);
      expect(sel.reason).toMatch(/cut 25 \/ tighten 0: OOS return 9\.00% over a 3\.00% max drawdown \(ratio 3\.00\)/);
    });

    it('ties go to the smaller cut, then the smaller tighten, then the lower floor', () => {
      const sel = selectOverlayCell(
        [
          res(B, 10, 5_000),
          res({ cut: 50, tighten: 0, floor: 0 }, 9, 3_000),
          res({ cut: 25, tighten: 15, floor: 0 }, 9, 3_000),
          res({ cut: 25, tighten: 0, floor: 0 }, 9, 3_000),
        ],
        EQUITY,
        { baseline: B },
      );
      expect(sel.chosen).toEqual({ cut: 25, tighten: 0, floor: 0 });
      expect(sel.reason).toMatch(/ties break toward the smaller cut/);
    });

    it('keeps the overlay OFF when no cell beats the baseline on the ratio', () => {
      const sel = selectOverlayCell(
        [
          res(B, 10, 5_000),
          res({ cut: 35, tighten: 30, floor: 0 }, 9, 5_000),
          res({ cut: 100, tighten: 0, floor: 0 }, 2, 500),
        ],
        EQUITY,
        { baseline: B },
      );
      expect(sel.chosen).toBeNull();
      expect(sel.reason).toMatch(/the overlay stays OFF/);
    });

    it('a non-positive baseline return makes the 75% clause vacuous — a cell must simply not be worse', () => {
      const sel = selectOverlayCell(
        [
          res(B, -2, 4_000), // ratio −0.5
          res({ cut: 35, tighten: 0, floor: 0 }, -1, 4_000), // −0.25 — better, eligible
          res({ cut: 50, tighten: 0, floor: 0 }, -3, 2_000), // worse than the baseline return → out
        ],
        EQUITY,
        { baseline: B },
      );
      expect(sel.chosen).toEqual({ cut: 35, tighten: 0, floor: 0 });
      expect(sel.rows.find((r) => r.cell.cut === 50)!.note).toBe('worse than the baseline return');
    });

    it('a zero-drawdown positive return ranks above everything without producing NaN', () => {
      const sel = selectOverlayCell(
        [
          res(B, 10, 5_000),
          res({ cut: 25, tighten: 0, floor: 0 }, 8, 0),
          res({ cut: 35, tighten: 0, floor: 0 }, 9, 100),
        ],
        EQUITY,
        { baseline: B },
      );
      expect(sel.chosen).toEqual({ cut: 25, tighten: 0, floor: 0 });
      expect(formatOverlaySelection('t', sel)).toMatch(/ratio\s+∞/);
    });

    it('needs the baseline row, and ignores errored or unanswered cells', () => {
      const none = selectOverlayCell([res({ cut: 25, tighten: 0, floor: 0 }, 9, 3_000)], EQUITY, { baseline: B });
      expect(none.chosen).toBeNull();
      expect(none.reason).toMatch(/no baseline row/);
      const errored: SweepResult = {
        ...res({ cut: 25, tighten: 0, floor: 0 }, 99, 1),
        outOfSample: null,
        error: 'HTTP 500',
      };
      expect(selectOverlayCell([res(B, 10, 5_000), errored], EQUITY, { baseline: B }).rows).toHaveLength(1);
    });

    it('stage 2 judges the floors against the chosen cell itself as the baseline', () => {
      const C = { cut: 35, tighten: 15, floor: 0 };
      const sel = selectOverlayCell(
        [res(C, 10, 5_000), res({ ...C, floor: 72 }, 9, 3_000), res({ ...C, floor: 76 }, 7, 2_000)],
        EQUITY,
        { baseline: C },
      );
      expect(sel.chosen).toEqual({ ...C, floor: 72 });
    });

    it('prints the grid with the regime-day fill share and the verdict', () => {
      const text = formatOverlaySelection(
        'stage 1',
        selectOverlayCell([res(B, 10, 5_000, 0), res({ cut: 25, tighten: 0, floor: 0 }, 9, 3_000, 12)], EQUITY, {
          baseline: B,
        }),
      );
      expect(text).toMatch(/cut 0 \/ tighten 0 \(baseline\)/);
      expect(text).toMatch(/regime-day fills\s+12\/40/);
      expect(text).toMatch(/→ chosen: cut 25 \/ tighten 0/);
    });
  });
});
