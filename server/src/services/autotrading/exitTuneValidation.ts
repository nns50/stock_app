// ---------------------------------------------------------------------------
// Does the exit tuner's RULE make money? (2026-09-09, task #58b)
//
// excursionTune.ts holds two rules that have never been checked against a
// realized outcome:
//
//     target:  0.8 x mean winner MFE
//     stop:    stopAtrMultiple x (winners' heat p90 x 1.1)
//
// Both are honest-looking descriptions of what winners did. Neither has ever
// been asked the only question that matters — would trading them have earned
// more than the geometry they replace. liveMinSignalScore was fitted that way
// in PR #44 (the bottom two thirds of the score distribution had lost $247, so
// the floor moved to where the money was); targetRMultiple was tested that way
// in task #32 (no candidate beat 2.0 outside noise). The exit tuner never was,
// and on this book its own answer is "go to the clamp on BOTH parameters" —
// stop 1.5 -> 0.50, target 2.0 -> 1.00-1.15 — which is a different strategy
// reached in five 0.25 steps, each of which looks unremarkable alone.
//
// So this module fits the rule on one slice of trades and replays the OTHER
// slice under what it produced, against the geometry actually traded. It is
// the exitReplay.ts path walk, not an MFE model: see that file's header for
// why a peak-minus-distance model reported every tightening as an improvement
// and was discarded.
//
// ---------------------------------------------------------------------------
// THE UNITS, because two arms of this comparison are denominated differently.
//
// 1R is the trade's initial risk in DOLLARS: |entry − initialStop| x qty x
// multiplier. A candidate that tightens stopAtrMultiple moves the stop closer,
// which makes 1R a smaller PRICE distance — and the sizer answers by buying
// more shares, because riskPerTradePct x equity is what it holds fixed. So a
// candidate arm's R and the current arm's R are the same number of DOLLARS,
// and their mean R can be compared directly. That is the only reason this
// comparison is meaningful, and it is why the replay is run with a SCALED STOP
// PRICE rather than by rescaling the results afterwards.
//
// What that assumption ignores, all of which FLATTERS the tighter candidate:
//   - a tighter stop needs proportionally more shares, which can run into the
//     per-order dollar cap or plain buying power. Unmodelled: the replay
//     assumes the size is attainable.
//   - levelPlan.ts can override the ATR stop on some trades, so scaling by
//     candidate/current stopAtrMultiple is exact only where the ATR stop is
//     what was actually placed.
//   - intrabar order is unknowable; replayExit resolves it adversely, which
//     charges a tighter stop for dips rather than crediting it with highs.
// A candidate that fails to win HERE is therefore failing on generous terms.
// ---------------------------------------------------------------------------

import { Candle } from '../../providers/types';
import { TradeExcursion, aggregateExcursions } from '../excursion';
import {
  ExitRules,
  ReplayComparison,
  ReplayResult,
  ReplayVerdict,
  aggregateReplay,
  replayExit,
  replayVerdict,
} from '../exitReplay';
import { ExcursionTuneBounds, computeExcursionTune } from './excursionTune';
import { DEFAULT_OOS_FRACTION, SignificanceStats, computeSignificanceStats } from './significance';

/** The two multiples the exit tuner owns. */
export interface ExitGeometry {
  stopAtrMultiple: number;
  targetRMultiple: number;
}

/** The exit rules the tuner does NOT own. They are R multiples in the config
 *  and stay numerically identical across arms — which is what the live path
 *  would do, since R is defined by whatever stop is actually placed. */
export interface CarriedExitRules {
  breakevenTriggerR: number;
  trailStartR: number;
  trailStopR: number;
}

/** One trade, with the bars to replay it on and the excursion row that is the
 *  tuner's own input. Both come from the SAME bars at the call site, so the
 *  fit and the replay can never be measuring different things. */
export interface ValidationTrade {
  positionId: number;
  symbol: string;
  /** ET day. The chronological split key — a walk-forward split on anything
   *  else is not walk-forward. */
  entryDate: string;
  side: 'long' | 'short';
  entryPrice: number;
  /** The FROZEN initial stop (the ratchet mutates the live one). */
  initialStopPrice: number;
  bars: Candle[];
  excursion: TradeExcursion;
}

/** What the rule produced from a training slice. */
export interface FittedGeometry {
  geometry: ExitGeometry;
  /** Winning trades the rule actually fitted on, after its own filters. */
  winners: number;
  /** How many times the bounded step was applied before the rule stopped
   *  moving. 1 for a single run; more for the fixed point. */
  runs: number;
  /** False when the rule ran out of iterations still moving — the geometry
   *  below is then a waypoint, not a resting place. */
  converged: boolean;
  warnings: string[];
}

export interface ValidationArm {
  geometry: ExitGeometry;
  replay: ReplayComparison;
}

export interface ValidationComparison {
  trades: number;
  current: ValidationArm;
  candidate: ValidationArm;
  /** candidate mean R − current mean R, over the SAME trades. Positive means
   *  the rule's geometry earned more per dollar of risk. */
  meanDiffR: number | null;
  /** Sign-flip permutation test over the PAIRED per-trade differences: under
   *  "the geometry change did nothing", each pair's difference was as likely to
   *  have come out the other way. `expectancy` here is meanDiffR. */
  significance: SignificanceStats;
  verdict: ValidationVerdict;
}

/** Deliberately explicit. The rest of this codebase renders no pass/fail on
 *  edge questions (significance.ts says so at length) — but #58b is a
 *  precondition on a switch that moves real stops, so it needs an answer, and
 *  an answer stated in one place is easier to argue with than four numbers a
 *  reader has to combine themselves. `inside_noise` is the expected outcome on
 *  a sample this size and is NOT permission to enable the tuner.
 *
 *  `insufficient` covers both "no paired trades at all" and "too few to call" —
 *  read `significance.sampleSize` for which. A directional verdict requires a
 *  RELIABLE sample (significance.ts's own 20-trade floor) on top of a CI that
 *  excludes zero, the same pair of conditions checkOosEdgeConfirmation uses:
 *  a bootstrap CI over three trades is three numbers wearing a confidence
 *  interval, and it excludes zero almost every time. */
/** The replay's own verdict rule (exitReplay.ts's replayVerdict) — one
 *  derivation for every paired replay, so this validation and the route's
 *  candidate comparison cannot disagree about what "better" means. */
export type ValidationVerdict = ReplayVerdict;

/** A geometry the rule produced, and what it earned. */
export interface FittedArm {
  fit: FittedGeometry;
  comparison: ValidationComparison;
}

/** A window's span, for reading a result back later. */
export interface TradeSpan {
  trades: number;
  from: string | null;
  to: string | null;
}

export interface ExitTuneValidation {
  current: ExitGeometry;
  carried: CarriedExitRules;
  /** Fit on the older slice, measured on the newer one. The honest read. */
  holdout: {
    train: TradeSpan;
    test: TradeSpan;
    /** One bounded run of the rule — what a single day's tune would do. */
    oneStep: FittedArm;
    /** Where repeated runs come to rest — what the tuner would eventually
     *  trade. #47 is about this one, not the step. */
    fixedPoint: FittedArm;
  };
  /** Fit AND measured on everything. Optimistic by construction — the geometry
   *  has already seen every trade it is scored on — and reported only because
   *  at this sample size the holdout slice is thin enough that omitting it
   *  would leave the reader with one noisy number instead of two. */
  inSample: {
    oneStep: FittedArm;
    fixedPoint: FittedArm;
  };
  coverage: {
    /** Trades handed in. */
    supplied: number;
    /** Dropped because one arm or the other could not be replayed at all —
     *  dropped from BOTH, since an unpaired trade would compare a geometry
     *  against a population the other never saw. */
    unpaired: number;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** How many times a rule may be re-applied before we call it non-converging.
 *  The observed walk to both clamps took five 0.25 steps; 40 is far past any
 *  path a 0.25 step can take between the clamps (0.5..4 and 1..6), so hitting
 *  it means the rule is oscillating, not still travelling. */
const MAX_FIXED_POINT_RUNS = 40;

/** Apply the tuner's rule once to a set of excursion rows. */
export function fitOnce(rows: TradeExcursion[], current: ExitGeometry, bounds: ExcursionTuneBounds): FittedGeometry {
  const r = computeExcursionTune(aggregateExcursions(rows), current, bounds);
  return {
    geometry: {
      stopAtrMultiple: r.patch.stopAtrMultiple ?? current.stopAtrMultiple,
      targetRMultiple: r.patch.targetRMultiple ?? current.targetRMultiple,
    },
    winners: r.diagnostics.winners,
    runs: 1,
    converged: true,
    warnings: r.warnings,
  };
}

/**
 * Where the rule COMES TO REST, applying it over and over to the same evidence.
 *
 * This is not a claim about what a refitting tuner would do — every run in
 * production sees a different sample. It is the stationary case: what the rule
 * converges to if the trades keep looking like the ones already recorded. That
 * is the case worth pricing, because it is what actually happened. Each daily
 * run is bounded to maxStep, so no single run ever looks like a strategy
 * change; the strategy change is the sum of them, and only the fixed point
 * shows it.
 */
export function fitToFixedPoint(
  rows: TradeExcursion[],
  current: ExitGeometry,
  bounds: ExcursionTuneBounds,
): FittedGeometry {
  let geometry = current;
  let winners = 0;
  let warnings: string[] = [];
  for (let run = 1; run <= MAX_FIXED_POINT_RUNS; run++) {
    const step = fitOnce(rows, geometry, bounds);
    winners = step.winners;
    warnings = step.warnings;
    const moved =
      step.geometry.stopAtrMultiple !== geometry.stopAtrMultiple ||
      step.geometry.targetRMultiple !== geometry.targetRMultiple;
    geometry = step.geometry;
    if (!moved) return { geometry, winners, runs: run, converged: true, warnings };
  }
  return { geometry, winners, runs: MAX_FIXED_POINT_RUNS, converged: false, warnings };
}

/**
 * Replay one trade under a candidate geometry.
 *
 * The candidate's stop is placed by scaling the trade's ACTUAL initial stop
 * distance by candidate/current stopAtrMultiple — both are `multiple x ATR`
 * off the same entry, so their ratio is the ratio of distances without needing
 * the ATR itself. Feeding that scaled stop into replayExit makes every R it
 * returns the candidate's own R, which (see the header) is the same number of
 * dollars as the current arm's.
 *
 * Null when the trade cannot be replayed — no bars, or a zero-width risk.
 */
export function replayUnderGeometry(
  trade: ValidationTrade,
  current: ExitGeometry,
  candidate: ExitGeometry,
  carried: CarriedExitRules,
): ReplayResult | null {
  if (!(current.stopAtrMultiple > 0) || !(candidate.stopAtrMultiple > 0)) return null;
  const ratio = candidate.stopAtrMultiple / current.stopAtrMultiple;
  const sign = trade.side === 'long' ? 1 : -1;
  const actualDistance = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const stopPrice = trade.entryPrice - sign * actualDistance * ratio;
  const rules: ExitRules = { ...carried, targetR: candidate.targetRMultiple };
  return replayExit({ side: trade.side, entryPrice: trade.entryPrice, initialStopPrice: stopPrice }, trade.bars, rules);
}

function compare(
  trades: ValidationTrade[],
  current: ExitGeometry,
  candidate: ExitGeometry,
  carried: CarriedExitRules,
  opts: { rng?: () => number; resamples?: number },
): { comparison: ValidationComparison; unpaired: number } {
  const currentResults: ReplayResult[] = [];
  const candidateResults: ReplayResult[] = [];
  const diffs: number[] = [];
  let unpaired = 0;
  for (const t of trades) {
    const a = replayUnderGeometry(t, current, current, carried);
    const b = replayUnderGeometry(t, current, candidate, carried);
    // PAIRED or not at all. A trade one arm can replay and the other cannot
    // would put the two geometries against different populations, which is the
    // mistake the exit-replay route's `actual` field exists to avoid.
    if (!a || !b) {
      unpaired++;
      continue;
    }
    currentResults.push(a);
    candidateResults.push(b);
    diffs.push(b.exitR - a.exitR);
  }

  const geometriesEqual =
    candidate.stopAtrMultiple === current.stopAtrMultiple && candidate.targetRMultiple === current.targetRMultiple;
  const significance = computeSignificanceStats(
    diffs.map((d) => ({ pnl: d })),
    opts,
  );
  const meanDiffR = diffs.length ? round2(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null;

  const verdict = replayVerdict(significance, geometriesEqual);

  return {
    comparison: {
      trades: diffs.length,
      current: { geometry: current, replay: aggregateReplay(currentResults) },
      candidate: { geometry: candidate, replay: aggregateReplay(candidateResults) },
      meanDiffR,
      significance,
      verdict,
    },
    unpaired,
  };
}

export interface ValidateOptions {
  /** Fraction of the chronological list held out as the TEST slice (most
   *  recent trades). Defaults to the codebase's existing walk-forward split. */
  oosFraction?: number;
  rng?: () => number;
  resamples?: number;
}

/**
 * Fit the exit tuner's rules and price what they produced.
 *
 * `bounds` is the live tuner's own (minTrades / maxStep / sampleSince), so the
 * thing under test is the rule as configured, not an idealised version of it.
 */
export function validateExitTuneRules(
  trades: ValidationTrade[],
  current: ExitGeometry,
  carried: CarriedExitRules,
  bounds: ExcursionTuneBounds,
  opts: ValidateOptions = {},
): ExitTuneValidation {
  const ordered = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const fraction = opts.oosFraction ?? DEFAULT_OOS_FRACTION;
  const testCount = Math.floor(ordered.length * fraction);
  const train = ordered.slice(0, ordered.length - testCount);
  const test = ordered.slice(ordered.length - testCount);
  const span = (xs: ValidationTrade[]) => ({
    trades: xs.length,
    from: xs.length ? ((xs[0] as ValidationTrade).entryDate as string) : null,
    to: xs.length ? ((xs[xs.length - 1] as ValidationTrade).entryDate as string) : null,
  });

  const rowsOf = (xs: ValidationTrade[]) => xs.map((t) => t.excursion);
  const holdoutOneStep = fitOnce(rowsOf(train), current, bounds);
  const holdoutFixed = fitToFixedPoint(rowsOf(train), current, bounds);
  const allOneStep = fitOnce(rowsOf(ordered), current, bounds);
  const allFixed = fitToFixedPoint(rowsOf(ordered), current, bounds);

  const h1 = compare(test, current, holdoutOneStep.geometry, carried, opts);
  const h2 = compare(test, current, holdoutFixed.geometry, carried, opts);
  const a1 = compare(ordered, current, allOneStep.geometry, carried, opts);
  const a2 = compare(ordered, current, allFixed.geometry, carried, opts);

  return {
    current,
    carried,
    holdout: {
      train: span(train),
      test: span(test),
      oneStep: { fit: holdoutOneStep, comparison: h1.comparison },
      fixedPoint: { fit: holdoutFixed, comparison: h2.comparison },
    },
    inSample: {
      oneStep: { fit: allOneStep, comparison: a1.comparison },
      fixedPoint: { fit: allFixed, comparison: a2.comparison },
    },
    coverage: { supplied: trades.length, unpaired: Math.max(h1.unpaired, h2.unpaired, a1.unpaired, a2.unpaired) },
  };
}
