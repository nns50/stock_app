import { defaultScreenerConfig, IndicatorWeights, ScreenerFilters } from '../../indicators/screener';

// ---------------------------------------------------------------------------
// Pure experiment-building and result-ranking for the scripted research sweep
// (scripts/researchSweep.ts — `npm run research`). No I/O here so every
// request body the script sends can be unit-tested.
//
// Why this exists: the walk-forward backtest routes accept far more than the
// UI exposes (full screener weights/filters, stop/target multiples, the whole
// trailing/breakeven/partial toolkit), but there is no server-side sweep — a
// systematic comparison means scripting one POST per variant. Two rules of
// that road are encoded here rather than left to memory:
//
//   1. The engines merge `screenerConfig` SHALLOWLY over the autotrade
//      defaults (backtest.ts uses `{ ...defaults, ...cfg.screenerConfig }`,
//      not the deep-merging resolveAutotradeScreenerConfig) — a partial
//      `weights` object silently zeroes every weight it omits. So every
//      variant built here carries COMPLETE weights and filters objects.
//   2. Sweeps invite data dredging. The built-in experiments are a small,
//      PRE-REGISTERED set, each varying exactly one axis against the same
//      baseline, judged on the OUT-OF-SAMPLE window only — see
//      docs/STRATEGY_PLAYBOOK.md's "Is a backtested edge real, or noise?".
// ---------------------------------------------------------------------------

export interface SweepBase {
  symbols: string[];
  from: string;
  to: string;
  splitDate: string;
  riskProfile: 'MODERATE' | 'AGGRESSIVE';
  startingEquity: number;
  maxConcurrentPositions: number;
}

/** The two walk-forward engines a variant can target. Same response envelope
 *  ({inSample/outOfSample: {report, stats, significance}, excludedSymbols,
 *  errors}), so the script's handling is endpoint-agnostic. */
export const EQUITY_WALK_FORWARD_PATH = '/api/autotrade/backtest/walk-forward';
export const OPTIONS_WALK_FORWARD_PATH = '/api/autotrade/backtest-options/walk-forward';

export interface SweepVariant {
  experiment: string;
  label: string;
  /** API path to POST `body` to — equity or options walk-forward. */
  endpoint: string;
  /** A COMPLETE walk-forward request body — post as-is. */
  body: Record<string, unknown>;
}

/** A complete weight set: the engine defaults with `overrides` applied. Every
 *  key present, always — see rule 1 in the header comment. */
export function completeWeights(overrides: Partial<IndicatorWeights> = {}): IndicatorWeights {
  return { ...defaultScreenerConfig().weights, ...overrides };
}

/** A complete filter set: the engine defaults plus the autotrade loop's own
 *  minRelVol 1.5 override (screen.ts's defaultAutotradeScreenerConfig — the
 *  backtest engines start from that same base), with `overrides` applied. */
export function completeFilters(overrides: Partial<ScreenerFilters> = {}): ScreenerFilters {
  return { ...defaultScreenerConfig().filters, minRelVol: 1.5, ...overrides };
}

function baseBody(base: SweepBase): Record<string, unknown> {
  return {
    symbols: base.symbols,
    from: base.from,
    to: base.to,
    splitDate: base.splitDate,
    riskProfile: base.riskProfile,
    startingEquity: base.startingEquity,
    maxConcurrentPositions: base.maxConcurrentPositions,
    screenerConfig: { weights: completeWeights(), filters: completeFilters() },
    decisionConfig: { stopAtrMultiple: 1.5, targetRMultiple: 2 },
  };
}

/** Base body for the OPTIONS walk-forward — same underlying screen (complete
 *  weights/filters, same shallow-merge trap) but no equity decisionConfig:
 *  the options engine's own contract-selection and time-exit defaults are the
 *  shipped behavior under test. */
function optionsBaseBody(base: SweepBase): Record<string, unknown> {
  return {
    symbols: base.symbols,
    from: base.from,
    to: base.to,
    splitDate: base.splitDate,
    riskProfile: base.riskProfile,
    startingEquity: base.startingEquity,
    maxConcurrentPositions: base.maxConcurrentPositions,
    screenerConfig: { weights: completeWeights(), filters: completeFilters() },
  };
}

/** The DEFAULT experiment set — every variant here hits the EQUITY walk-forward,
 *  whose data cost is daily bars only (cheap, and cached after run #1). */
export const EXPERIMENT_NAMES = ['exits', 'minscore', 'direction', 'weights'] as const;
/** OPT-IN experiments, excluded from the default run because they hit the
 *  OPTIONS walk-forward: the first run fetches option CONTRACT references and
 *  per-contract price bars from Polygon — far heavier than equity daily bars,
 *  and painful on a rate-limited key with a wide symbol list. Run explicitly
 *  via `--experiments ivrv` / `--experiments optexits`, ideally over a handful
 *  of liquid names (they share one cache, so the second is cheap after the
 *  first). */
export const OPTIN_EXPERIMENT_NAMES = ['ivrv', 'optexits'] as const;
export const ALL_EXPERIMENT_NAMES = [...EXPERIMENT_NAMES, ...OPTIN_EXPERIMENT_NAMES] as const;
export type ExperimentName = (typeof ALL_EXPERIMENT_NAMES)[number];

/**
 * The pre-registered experiment sets. Each varies ONE axis; everything else
 * stays at the loop's shipped defaults so a difference in the OOS window is
 * attributable to the axis, not an interaction.
 *
 * - `exits`: the review's central geometry question. The live book hit its 2R
 *   target zero times in twelve decisive trades, and the momentum literature
 *   says the payoff is the uncapped right tail — so the bracket baseline runs
 *   against a wider fixed target and two breakeven+trailing "runner" shapes
 *   (target 6R stands in for "effectively uncapped": the trail, not the
 *   target, is meant to end those trades).
 * - `minscore`: the conviction gate at off/40/60/75 (60 = the B-grade cut).
 * - `direction`: long-only vs per-symbol both-ways scoring.
 * - `weights`: default vs a relative-strength tilt (cross-sectional momentum
 *   is the best-evidenced component and ships at weight 0) vs a trend/RS
 *   shape that also drops the "more ATR is better" volatility component.
 * - `ivrv` (opt-in, options engine): the IV/RV cheapness-gate ladder — long
 *   premium pays the variance risk premium whenever implied outruns realized
 *   vol (the Goyal–Saretto direction), so the gate should earn its trade-count
 *   cut. Off / 1.5 / 1.2 / 1.0 / 0.8.
 * - `optexits` (opt-in, options engine): exit geometry for the options book —
 *   the same central question the equity `exits` set answered (there, the
 *   trail beat the fixed target on both splits). The shipped options baseline
 *   exits on TIME only, and both the live journal and the first ivrv ladder
 *   show that shape bleeding; this varies ONE axis — the %-of-premium exit
 *   rules — from no-rules through a hard stop, a stop+take-profit bracket,
 *   and a breakeven+trailing runner.
 */
export function buildExperiments(base: SweepBase, which: readonly ExperimentName[]): SweepVariant[] {
  const variants: SweepVariant[] = [];
  const add = (
    experiment: string,
    label: string,
    patch: (b: Record<string, unknown>) => void,
    opts: { endpoint?: string; body?: Record<string, unknown> } = {},
  ) => {
    const body = opts.body ?? baseBody(base);
    patch(body);
    variants.push({ experiment, label, endpoint: opts.endpoint ?? EQUITY_WALK_FORWARD_PATH, body });
  };

  if (which.includes('exits')) {
    add('exits', 'bracket-2R (baseline)', () => {});
    add('exits', 'bracket-3R', (b) => {
      b.decisionConfig = { stopAtrMultiple: 1.5, targetRMultiple: 3 };
    });
    add('exits', 'runner: BE@1R, trail 1.5R', (b) => {
      b.decisionConfig = { stopAtrMultiple: 1.5, targetRMultiple: 6 };
      b.breakevenTriggerRMultiple = 1;
      b.trailStartRMultiple = 1;
      b.trailStopRMultiple = 1.5;
    });
    add('exits', 'runner: BE@1R, trail 1R', (b) => {
      b.decisionConfig = { stopAtrMultiple: 1.5, targetRMultiple: 6 };
      b.breakevenTriggerRMultiple = 1;
      b.trailStartRMultiple = 1;
      b.trailStopRMultiple = 1;
    });
  }

  if (which.includes('minscore')) {
    for (const minScore of [0, 40, 60, 75]) {
      add('minscore', `minScore ${minScore}`, (b) => {
        b.screenerConfig = { weights: completeWeights(), filters: completeFilters({ minScore }) };
      });
    }
  }

  if (which.includes('direction')) {
    add('direction', 'long-only (baseline)', (b) => {
      b.directionMode = 'long';
    });
    add('direction', 'both directions', (b) => {
      b.directionMode = 'both';
    });
  }

  if (which.includes('weights')) {
    add('weights', 'default weights (baseline)', () => {});
    add('weights', 'relative-strength tilt', (b) => {
      b.screenerConfig = {
        weights: completeWeights({
          momentum: 25,
          relativeVolume: 20,
          rsi: 10,
          volatility: 0,
          gap: 5,
          trend: 20,
          relativeStrength: 20,
        }),
        filters: completeFilters(),
      };
    });
    add('weights', 'trend+RS, no raw-ATR reward', (b) => {
      b.screenerConfig = {
        weights: completeWeights({
          momentum: 30,
          relativeVolume: 25,
          rsi: 0,
          volatility: 0,
          gap: 5,
          trend: 25,
          relativeStrength: 15,
        }),
        filters: completeFilters(),
      };
    });
  }

  // OPT-IN (see OPTIN_EXPERIMENT_NAMES): the IV/RV cheapness-gate ladder, on
  // the OPTIONS walk-forward. One axis — optionsDecisionConfig.maxIvRvRatio —
  // from off through progressively stricter "implied must be no richer than
  // realized" cuts. 1.0 is the natural boundary (implied == realized); 1.5/1.2
  // are tolerance bands above it and 0.8 demands premium strictly BELOW
  // realized. Expect trade count to fall as the ratio tightens — the question
  // the OOS column answers is whether expectancy rises enough to justify it.
  if (which.includes('ivrv')) {
    add('ivrv', 'gate off (baseline)', () => {}, {
      endpoint: OPTIONS_WALK_FORWARD_PATH,
      body: optionsBaseBody(base),
    });
    for (const ratio of [1.5, 1.2, 1.0, 0.8]) {
      add(
        'ivrv',
        `maxIvRvRatio ${ratio}`,
        (b) => {
          b.optionsDecisionConfig = { maxIvRvRatio: ratio };
        },
        { endpoint: OPTIONS_WALK_FORWARD_PATH, body: optionsBaseBody(base) },
      );
    }
  }

  // OPT-IN (see OPTIN_EXPERIMENT_NAMES): exit shapes for the options book, in
  // %-of-premium terms (net debit for a spread — a long option has no
  // ATR-based stop distance to measure R against). 50% stop / 100% take-profit
  // are the manual exit-rules defaults, not new numbers; the runner mirrors
  // the equity winner's shape: cut losers, protect breakeven once up 50%,
  // then trail 50 points behind the best gain with NO fixed cap.
  if (which.includes('optexits')) {
    const addOpt = (label: string, patch: (b: Record<string, unknown>) => void) =>
      add('optexits', label, patch, { endpoint: OPTIONS_WALK_FORWARD_PATH, body: optionsBaseBody(base) });
    addOpt('time-exit only (baseline)', () => {});
    addOpt('stop 50%', (b) => {
      b.optionsStopLossPct = 50;
    });
    addOpt('stop 50% + TP 100%', (b) => {
      b.optionsStopLossPct = 50;
      b.optionsTakeProfitPct = 100;
    });
    addOpt('runner: stop 50, BE@50, trail 50', (b) => {
      b.optionsStopLossPct = 50;
      b.optionsBreakevenTriggerPct = 50;
      b.optionsTrailStartPct = 50;
      b.optionsTrailStopPct = 50;
    });
  }

  return variants;
}

// --- Result ranking ---------------------------------------------------------

export interface SweepWindow {
  stats: {
    totalTrades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number | null;
    returnPct: number;
    maxDrawdown: number;
    avgR: number | null;
  };
  significance?: {
    sampleSize: number;
    ciLow: number | null;
    ciHigh: number | null;
    pValue: number | null;
    reliable: boolean;
  } | null;
}

/** Per-run data problems the walk-forward response reports at its top level
 *  (loadBacktestHistory's own per-symbol fetch errors and the real-estate
 *  pre-filter's exclusions). The sweep script used to drop these on the
 *  floor, which made a data problem indistinguishable from "no setup ever
 *  qualified" — a zero-trades sweep printed nothing but zeros. */
export interface SweepDataIssues {
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

export interface SweepResult {
  experiment: string;
  label: string;
  outOfSample: SweepWindow | null;
  inSample: SweepWindow | null;
  dataIssues?: SweepDataIssues;
  error?: string;
}

/** Order results for reading: errors last, then reliable OOS samples before
 *  unreliable ones, then by OOS expectancy descending. Judging on the OOS
 *  window only is the point of the walk-forward split — the in-sample column
 *  is context, never the verdict. */
export function rankResults(results: SweepResult[]): SweepResult[] {
  return [...results].sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? 1 : -1;
    const ra = a.outOfSample?.significance?.reliable ? 1 : 0;
    const rb = b.outOfSample?.significance?.reliable ? 1 : 0;
    if (ra !== rb) return rb - ra;
    const ea = a.outOfSample?.stats.expectancy ?? Number.NEGATIVE_INFINITY;
    const eb = b.outOfSample?.stats.expectancy ?? Number.NEGATIVE_INFINITY;
    return eb - ea;
  });
}

/** One console-ready line describing a result's data issues, or null when
 *  there are none — the script prints it right under the variant's own line
 *  (deduped, since every variant of one sweep usually shares the same set). */
export function formatDataIssues(issues: SweepDataIssues | undefined): string | null {
  if (!issues) return null;
  const parts: string[] = [];
  if (issues.errors.length) {
    parts.push(`fetch errors: ${issues.errors.map((e) => `${e.symbol} (${e.message})`).join('; ')}`);
  }
  if (issues.excludedSymbols.length) {
    parts.push(`excluded: ${issues.excludedSymbols.map((e) => `${e.symbol} (${e.reason})`).join('; ')}`);
  }
  return parts.length ? parts.join(' | ') : null;
}

/** True when every variant that got a response simulated ZERO trades in BOTH
 *  windows — the signature of the engine never seeing a tradable bar at all
 *  (a data problem), as opposed to setups failing to qualify (which varies
 *  by variant and window). The script prints a pointed warning on this. */
export function allZeroTrades(results: SweepResult[]): boolean {
  const answered = results.filter((r) => !r.error && (r.outOfSample || r.inSample));
  return (
    answered.length > 0 &&
    answered.every((r) => (r.outOfSample?.stats.totalTrades ?? 0) === 0 && (r.inSample?.stats.totalTrades ?? 0) === 0)
  );
}

const fmt = (v: number | null | undefined, digits = 2): string => (v == null ? '—' : v.toFixed(digits));

/** One aligned text row per result, OOS-first — for the script's console table. */
export function formatResultRow(r: SweepResult): string {
  if (r.error) return `  ${r.label.padEnd(28)} ERROR: ${r.error}`;
  const o = r.outOfSample;
  if (!o) return `  ${r.label.padEnd(28)} (no out-of-sample window)`;
  const sig = o.significance;
  const rel = sig?.reliable ? 'reliable' : `n=${sig?.sampleSize ?? 0} (thin)`;
  return (
    `  ${r.label.padEnd(28)} OOS exp $${fmt(o.stats.expectancy).padStart(8)}/trade  ` +
    `trades ${String(o.stats.totalTrades).padStart(3)}  win% ${fmt(o.stats.winRate, 1).padStart(5)}  ` +
    `avgR ${fmt(o.stats.avgR).padStart(6)}  ret% ${fmt(o.stats.returnPct).padStart(7)}  ` +
    `maxDD $${fmt(o.stats.maxDrawdown).padStart(8)}  ` +
    `CI [${fmt(sig?.ciLow)}, ${fmt(sig?.ciHigh)}]  p ${fmt(sig?.pValue, 3)}  ${rel}`
  );
}
