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
// ---------------------------------------------------------------------------

import { Candle } from '../providers/types';

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
}

export type ReplayExitReason = 'stop' | 'breakeven' | 'trail' | 'target' | 'time_exit';

export interface ReplayResult {
  /** R booked under these rules. */
  exitR: number;
  reason: ReplayExitReason;
  /** Bars elapsed before the exit — 0 means it closed in its first bar. */
  barsHeld: number;
  /** Best R reached before the exit. Equals the trade's MFE when nothing fired
   *  early, and is LESS when a rule cut the trade short — the difference is
   *  what the rule cost. */
  bestR: number;
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

  for (const [i, bar] of bars.entries()) {
    // ---- adverse side first, always. See the header: every intrabar
    // ambiguity is resolved against the trade, so a tighter stop is charged
    // for the dips it would have been hit by rather than credited with the
    // highs it would have missed.
    const stopPrice = priceAtR(input, stopR);
    if (stopHit(adverseOf(bar), stopPrice)) {
      const reason: ReplayExitReason = !trailing && stopR <= -1 ? 'stop' : trailing ? 'trail' : 'breakeven';
      return { exitR: stopR, reason, barsHeld: i, bestR };
    }

    // ---- then the favourable side.
    if (targetPrice !== null && targetHit(favourableOf(bar), targetPrice)) {
      return { exitR: rules.targetR, reason: 'target', barsHeld: i, bestR: Math.max(bestR, rules.targetR) };
    }

    const barBestR = rAtPrice(input, favourableOf(bar));
    if (barBestR > bestR) bestR = barBestR;

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
  return { exitR: round2(rAtPrice(input, last.close)), reason: 'time_exit', barsHeld: bars.length - 1, bestR };
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
}

export function aggregateReplay(results: ReplayResult[]): ReplayComparison {
  const reasons: Record<ReplayExitReason, number> = {
    stop: 0,
    breakeven: 0,
    trail: 0,
    target: 0,
    time_exit: 0,
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
  };
}
