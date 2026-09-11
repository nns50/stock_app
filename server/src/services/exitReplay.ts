// ---------------------------------------------------------------------------
// Exit-rule path replay (2026-09-09) — walk a trade's 5-minute bars IN ORDER
// against a candidate exit geometry, and report where it would actually have
// been closed.
//
// WHY THIS EXISTS. services/excursion.ts collapses a trade's bars to their max
// and min: it answers "how far did this run" and cannot answer "would a tighter
// stop have survived the dip that came first". Reasoning about exit rules from
// MFE alone is not merely imprecise, it is BIASED, and always in the same
// direction. Modelling a trail as "exit at peak − D" can never be punished for
// tightening D, because a peak-and-distance model has no dip in it. Run over
// the live book on 2026-09-09 that model reported every trail distance from
// 0.5R down to 0.1R as monotonically better — 0.032R -> 0.315R mean — which is
// the signature of a question the data cannot answer, not a finding.
//
// The thing it was being used to judge is not hypothetical. THREE live
// thresholds are set at 0.5R:
//
//     trailStartRMultiple    0.5   reached by only 17 of 48 intraday trades
//     trailStopRMultiple     0.5   the stop's distance behind the peak
//     stagnationExitMinR     0.5   below this for 90 min and the slot recycles
//
// while this book's MEDIAN trade peaks at 0.34R and its median winner at 0.58R.
// A trail sitting 0.5R behind the peak of a 0.58R move sits at breakeven, which
// is exactly what IOT (peak 1.04R, booked 0.25R) and TSLA (peak 0.64R, booked
// 0.05R) did. Those numbers are arithmetic and need no simulation; choosing
// what to REPLACE them with does, and that is this module.
//
// INTRABAR ORDER IS UNKNOWABLE AND IS RESOLVED ADVERSELY. Within one 5-minute
// bar we know the high and the low but not which came first. Every ambiguous
// bar is resolved AGAINST the trade: if both the stop and the target sit inside
// one bar's range, the stop fills. That is the assumption that makes a tighter
// stop look worse rather than better, which is the whole point — a replay whose
// assumptions all flatter the change under test is the peak-minus-distance
// model again, wearing more code.
//
// THE SCALE-OUT AND THE STAGNATION TIMER (2026-09-11). The four rules above are
// not the live book's whole exit policy. Since 2026-09-08 the live scale-out
// (scaleOut.ts) has banked partialExitPct of a position at partialExitRMultiple
// — 67% at 0.25R in production — and the stagnation exit (stagnationExit.ts)
// scratches a trade held stagnationExitMinutes below stagnationExitMinR; the
// spec's own count has the clock closing 12 of 22 winners. A replay blind to
// both is not replaying the current policy, and cannot score the one change
// the profitability review put first: bank the book's half-R peaks. Both are
// optional rules here so every earlier caller replays byte-for-byte; the route
// defaults them from the live config. The scale-out fills on the favourable
// side AFTER the adverse check (a bar holding both the stop and the level
// fills the stop, as everywhere in this file) and BEFORE the target (the
// level sits below it, so the target takes only the remainder); the timer is
// read at a bar's close, which is the bar's tick. Not modelled: the
// scarcity gate on the stagnation exit, and the cancel/replace mechanics of a
// live scale-out — this scores the shape, not the plumbing.
// ---------------------------------------------------------------------------

import { Candle } from '../providers/types';
import { computeSignificanceStats, SignificanceStats } from './autotrading/significance';

/** Candidate exit geometry, all in R (multiples of the trade's INITIAL risk —
 *  |entry − initialStop| × qty × multiplier). R, not price and not ATR: the
 *  live config's stopAtrMultiple sets where the initial stop goes, and once it
 *  is placed that distance IS 1R by construction. */
export interface ExitRules {
  /** Move the stop to entry once price reaches this. 0 disables. */
  breakevenTriggerR: number;
  /** Begin trailing once price reaches this. 0 disables trailing entirely. */
  trailStartR: number;
  /** Once trailing, hold the stop this far below the best price seen. */
  trailStopR: number;
  /** Take profit here. 0 disables. */
  targetR: number;
  /** The live scale-out (scaleOut.ts): book `scaleOutFraction` of the position
   *  the first time price reaches this R, and keep the remainder running under
   *  every other rule. 0 or absent = no scale-out, and the four-field rules
   *  every earlier caller passes replay exactly as before. */
  scaleOutR?: number;
  /** 0–1: the share booked at scaleOutR (the config's partialExitPct / 100). */
  scaleOutFraction?: number;
  /** The stagnation exit (stagnationExit.ts): once the trade has been held this
   *  many minutes and a bar closes below `stagnationMinR`, the remainder is
   *  scratched at that close. 0 or absent = no timer. Minutes are bar-time
   *  minutes since the first bar — session minutes, for the same-session trades
   *  this replays. The scarcity gate is not modelled. */
  stagnationMinutes?: number;
  stagnationMinR?: number;
}

export type ReplayExitReason = 'stop' | 'breakeven' | 'trail' | 'target' | 'time_exit' | 'stagnation';

export interface ReplayResult {
  /** R booked under these rules — the position-weighted blend of the scale-out
   *  (when it fired) and the remainder's exit; the remainder's R alone when
   *  nothing scaled out. */
  exitR: number;
  /** How the REMAINDER ended — the whole position when nothing scaled out. */
  reason: ReplayExitReason;
  /** Bars elapsed before the exit — 0 means it closed in its first bar. */
  barsHeld: number;
  /** Best R reached before the exit. Equals the trade's MFE when nothing fired
   *  early, and is LESS when a rule cut the trade short — the difference is
   *  what the rule cost. */
  bestR: number;
  /** True when the scale-out fired before the remainder's exit. */
  scaledOut: boolean;
  /** The scale-out's share of exitR: fraction × scaleOutR; 0 when it did not fire. */
  bankedR: number;
}

export interface ReplayInput {
  side: 'long' | 'short';
  entryPrice: number;
  /** The FROZEN initial stop. The ratchet mutates a position's stopPrice, so a
   *  live value here would make 1R shrink toward zero on any trade that reached
   *  breakeven and inflate every R this module returns — the same denominator
   *  bug excursion.ts and autoTune.ts each had to be corrected for. */
  initialStopPrice: number;
}

/** Price at `r` R from entry, in the favourable direction for negative-free
 *  arithmetic on both sides. r may be negative (adverse). */
function priceAtR(input: ReplayInput, r: number): number {
  const sign = input.side === 'long' ? 1 : -1;
  const oneR = Math.abs(input.entryPrice - input.initialStopPrice);
  return input.entryPrice + sign * r * oneR;
}

/** How many R this price sits from entry, favourably. */
function rAtPrice(input: ReplayInput, price: number): number {
  const sign = input.side === 'long' ? 1 : -1;
  const oneR = Math.abs(input.entryPrice - input.initialStopPrice);
  if (!(oneR > 0)) return 0;
  return ((price - input.entryPrice) * sign) / oneR;
}

/**
 * Replay one trade's bars against one exit geometry.
 *
 * Returns null when the trade cannot be replayed at all — no bars, or a zero-
 * width initial risk (entry == stop), which would make every R infinite. Null
 * rather than 0: a trade that could not be measured must never average in as
 * one that broke even.
 */
export function replayExit(input: ReplayInput, bars: Candle[], rules: ExitRules): ReplayResult | null {
  if (!bars.length) return null;
  const oneR = Math.abs(input.entryPrice - input.initialStopPrice);
  if (!(oneR > 0)) return null;

  const long = input.side === 'long';
  // Adverse extreme of a bar for this side, and favourable extreme.
  const adverseOf = (c: Candle) => (long ? c.low : c.high);
  const favourableOf = (c: Candle) => (long ? c.high : c.low);
  // Has `price` reached or passed `stop` in the adverse direction?
  const stopHit = (price: number, stop: number) => (long ? price <= stop : price >= stop);
  const targetHit = (price: number, target: number) => (long ? price >= target : price <= target);

  let stopR = -1; // the initial stop is exactly 1R adverse, by construction
  let bestR = 0;
  let trailing = false;
  const targetPrice = rules.targetR > 0 ? priceAtR(input, rules.targetR) : null;
  const scaleOutR = rules.scaleOutR ?? 0;
  const fraction = scaleOutR > 0 ? Math.min(1, Math.max(0, rules.scaleOutFraction ?? 0)) : 0;
  const scaleOutPrice = scaleOutR > 0 && fraction > 0 ? priceAtR(input, scaleOutR) : null;
  const stagnationMinutes = rules.stagnationMinutes ?? 0;
  const stagnationMinR = rules.stagnationMinR ?? 0;
  const firstBarTime = (bars[0] as Candle).time;
  let scaledOut = false;
  let bankedR = 0;
  // The blend is applied only once the scale-out fired, so a rule set without
  // one returns the remainder's R untouched — the earlier callers' numbers.
  const finish = (remainderR: number, reason: ReplayExitReason, barsHeld: number, best: number): ReplayResult => ({
    exitR: scaledOut ? round2(bankedR + (1 - fraction) * remainderR) : remainderR,
    reason,
    barsHeld,
    bestR: best,
    scaledOut,
    bankedR: scaledOut ? round2(bankedR) : 0,
  });

  for (const [i, bar] of bars.entries()) {
    // ---- adverse side first, always. See the header: every intrabar
    // ambiguity is resolved against the trade, so a tighter stop is charged
    // for the dips it would have been hit by rather than credited with the
    // highs it would have missed.
    const stopPrice = priceAtR(input, stopR);
    if (stopHit(adverseOf(bar), stopPrice)) {
      const reason: ReplayExitReason = !trailing && stopR <= -1 ? 'stop' : trailing ? 'trail' : 'breakeven';
      return finish(stopR, reason, i, bestR);
    }

    // ---- then the favourable side: the scale-out level sits below the
    // target, so when both are inside one bar the scale-out fills first and
    // the target takes only the remainder.
    const favourable = favourableOf(bar);
    if (scaleOutPrice !== null && !scaledOut && targetHit(favourable, scaleOutPrice)) {
      scaledOut = true;
      bankedR = fraction * scaleOutR;
    }
    if (targetPrice !== null && targetHit(favourable, targetPrice)) {
      return finish(rules.targetR, 'target', i, Math.max(bestR, rules.targetR));
    }

    const barBestR = rAtPrice(input, favourable);
    if (barBestR > bestR) bestR = barBestR;

    // ---- the stagnation timer, read at the close: the live rule is evaluated
    // at a tick's price, and the close is the bar's tick. Held long enough and
    // still below the bar's R, the remainder is scratched here.
    if (stagnationMinutes > 0 && (bar.time - firstBarTime) / 60_000 >= stagnationMinutes) {
      const progress = rAtPrice(input, bar.close);
      if (progress < stagnationMinR) return finish(round2(progress), 'stagnation', i, bestR);
    }

    // ---- ratchet the stop for the NEXT bar. Never loosens: a stop that could
    // move back down would give back protection already earned, which no live
    // path does and no replay should model.
    if (rules.trailStartR > 0 && bestR >= rules.trailStartR) trailing = true;
    // Both rules apply, and the stop takes the BEST of them — never `else if`.
    // A single 5-minute bar can cross the breakeven trigger and the trail start
    // together, and an else-if lets the arming trail skip breakeven entirely:
    // with a trail wider than the progress made (best 0.6R, trail 1.5R) the
    // stop computes to -0.9R and the trade gives back protection it had already
    // earned. Found by the ratchet test, not by reading this back.
    let next = stopR;
    if (rules.breakevenTriggerR > 0 && bestR >= rules.breakevenTriggerR) next = Math.max(next, 0);
    if (trailing) next = Math.max(next, bestR - rules.trailStopR);
    stopR = next;
  }

  // Ran out of bars still open — the live book's time exit / end-of-day
  // flatten. Booked at the last close, which is the honest price for "we were
  // still in it when the session ended".
  const last = bars[bars.length - 1] as Candle;
  return finish(round2(rAtPrice(input, last.close)), 'time_exit', bars.length - 1, bestR);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ReplayComparison {
  trades: number;
  meanR: number | null;
  medianR: number | null;
  /** How each rule set ended its trades — the shape of the change, which a mean
   *  hides. A geometry that lifts the mean by converting time exits into stops
   *  is a different bet from one that converts them into targets. */
  reasons: Record<ReplayExitReason, number>;
  /** Trades whose scale-out fired — how often the level was even reached. */
  scaleOuts: number;
}

export function aggregateReplay(results: ReplayResult[]): ReplayComparison {
  const reasons: Record<ReplayExitReason, number> = {
    stop: 0,
    breakeven: 0,
    trail: 0,
    target: 0,
    time_exit: 0,
    stagnation: 0,
  };
  for (const r of results) reasons[r.reason] += 1;
  const rs = results.map((r) => r.exitR).sort((a, b) => a - b);
  return {
    trades: results.length,
    meanR: rs.length ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    medianR: rs.length
      ? round2(
          rs.length % 2
            ? (rs[(rs.length - 1) / 2] as number)
            : ((rs[rs.length / 2 - 1] as number) + (rs[rs.length / 2] as number)) / 2,
        )
      : null,
    reasons,
    scaleOuts: results.filter((r) => r.scaledOut).length,
  };
}

// ---------------------------------------------------------------------------
// Two rule sets over the SAME trades (2026-09-11). Paired or not at all: a
// trade one arm can replay and the other cannot would put the two shapes
// against different populations, the mistake the route's `actual` field exists
// to avoid. The verdict rule is shared with the exit-tune validation so the two
// readers of a paired replay cannot disagree about what "better" means.
// ---------------------------------------------------------------------------

export type ReplayVerdict = 'better' | 'worse' | 'inside_noise' | 'no_change' | 'insufficient';

/** The one verdict rule: unchanged rules are `no_change`; an unreliable sample
 *  (significance.ts's own 20-trade floor) is `insufficient`; then the paired
 *  difference's 95% interval decides — above zero `better`, below `worse`,
 *  straddling it `inside_noise`. */
export function replayVerdict(significance: SignificanceStats, unchanged: boolean): ReplayVerdict {
  if (unchanged) return 'no_change';
  if (!significance.reliable) return 'insufficient';
  if (significance.ciLow !== null && significance.ciLow > 0) return 'better';
  if (significance.ciHigh !== null && significance.ciHigh < 0) return 'worse';
  return 'inside_noise';
}

export interface ReplayTrade {
  input: ReplayInput;
  bars: Candle[];
}

export interface ExitRulesComparison {
  /** Paired trades — replayed under BOTH rule sets. */
  trades: number;
  unpaired: number;
  current: { rules: ExitRules; replay: ReplayComparison };
  candidate: { rules: ExitRules; replay: ReplayComparison };
  /** candidate mean R − current mean R over the same trades. */
  meanDiffR: number | null;
  /** Sign-flip permutation test over the paired per-trade differences. */
  significance: SignificanceStats;
  verdict: ReplayVerdict;
}

function normalizedRules(r: ExitRules): Required<ExitRules> {
  return {
    breakevenTriggerR: r.breakevenTriggerR,
    trailStartR: r.trailStartR,
    trailStopR: r.trailStopR,
    targetR: r.targetR,
    scaleOutR: r.scaleOutR ?? 0,
    scaleOutFraction: r.scaleOutR ? (r.scaleOutFraction ?? 0) : 0,
    stagnationMinutes: r.stagnationMinutes ?? 0,
    stagnationMinR: r.stagnationMinutes ? (r.stagnationMinR ?? 0) : 0,
  };
}

export function rulesEqual(a: ExitRules, b: ExitRules): boolean {
  const x = normalizedRules(a);
  const y = normalizedRules(b);
  return (Object.keys(x) as (keyof typeof x)[]).every((k) => x[k] === y[k]);
}

export function compareExitRules(
  trades: ReplayTrade[],
  current: ExitRules,
  candidate: ExitRules,
  opts: { rng?: () => number; resamples?: number } = {},
): ExitRulesComparison {
  const currentResults: ReplayResult[] = [];
  const candidateResults: ReplayResult[] = [];
  const diffs: number[] = [];
  let unpaired = 0;
  for (const t of trades) {
    const a = replayExit(t.input, t.bars, current);
    const b = replayExit(t.input, t.bars, candidate);
    if (!a || !b) {
      unpaired++;
      continue;
    }
    currentResults.push(a);
    candidateResults.push(b);
    diffs.push(b.exitR - a.exitR);
  }
  const significance = computeSignificanceStats(
    diffs.map((d) => ({ pnl: d })),
    opts,
  );
  return {
    trades: diffs.length,
    unpaired,
    current: { rules: current, replay: aggregateReplay(currentResults) },
    candidate: { rules: candidate, replay: aggregateReplay(candidateResults) },
    meanDiffR: diffs.length ? round2(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
    significance,
    verdict: replayVerdict(significance, rulesEqual(current, candidate)),
  };
}
