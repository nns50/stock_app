// ---------------------------------------------------------------------------
// Entry extension — how far into today's move are we buying? (2026-09-04)
//
// OBSERVER ONLY. Nothing here blocks an entry; it measures and journals, in the
// same evidence-before-action pattern vwap.ts set out. The filter it describes
// is NOT wired to the entry decision, and the numbers below say why it should
// not be yet.
//
// WHAT PROMPTED IT. The book's read was that entries land at the top of the
// day and then spend the session playing catch-up. Measured against 5-minute
// candles for each closed intraday trade's entry day, the literal version is
// NOT true: entries sit at mean 60.2 / median 65.9 percent of the range formed
// up to that moment, only 2 of 18 landed in the top 5%, every trade had room
// above it, and the median trade still had 53% of the day's eventual range
// ahead of it.
//
// What IS true is weaker but real, and it is what this measures:
//
//   entered in the lower 60% of the range   n=9   avg realR +0.183  avg mfeR 0.794
//   entered in the upper 40% of the range   n=9   avg realR -0.066  avg mfeR 0.317
//   corr(position in range, mfeR) = -0.501
//
// The same effect appears independently against VWAP — 68% of entries are above
// it, and those average mfeR 0.32 against 0.75 for entries at or below. Both
// splits survive leave-one-out with 0/18 sign flips on both metrics, and both
// stay positive with the single big winner (BIAF) dropped entirely.
//
// WHY IT IS NOT A FILTER YET. Two reasons, both of which the shadow journal is
// meant to settle:
//
//   1. n=18 over four sessions. That is a direction, not a season.
//   2. Position-in-range is confounded with time of day — 8 of the 10
//      near-VWAP entries were before 10:00, when VWAP has barely diverged from
//      price. "Enter cheap" and "enter early" cannot be separated at this
//      sample size, and they imply different fixes.
//
// A neighbouring correlation was checked and REJECTED, recorded here so it is
// not rediscovered and believed: day range looked like the strongest predictor
// of realised R (corr +0.588, and >8%-range names averaged +0.300R), which
// would argue for an ATR floor. Under leave-one-out that gap is +0.004 with
// 9/18 sign flips — one trade was carrying all of it. No range floor on this
// evidence.
//
// WHAT IS JOURNALED, and why it is the raw numbers rather than a verdict: the
// thresholds below are a reference point, not a decision. Recording
// vwapExtPct and pctOfRange themselves means the cut can be re-chosen from the
// journal later without a deploy, and without this session's guess at 60/0.4
// silently becoming the answer.
//
// NOTE FOR WHEN THIS DOES GATE: the live path computes session context AFTER
// the broker placement, deliberately, so measurement can never delay or fail a
// real order. A blocking version has to move ahead of placement.
//
// THE RATIO IS NOW WELL-FORMED BY CONSTRUCTION (2026-09-14). It was not, and
// the journal said so out loud: five of the first 43 live rows put the entry
// price OUTSIDE the range it was divided by — FCX 130.0%, FTFT 114.8%, SMCI
// 110.9%, BWIN 105.9%, and CHYM at -1.6%, below its own session low. The cause
// is the disease entryRisk.ts was written for, one dimension over: the
// numerator was `signal.entry`, the price the SCREEN saw, and the denominator
// a range built from 5-minute bars behind a 5-minute cache and fetched AFTER
// the placement. Two different moments, divided by each other.
//
// Two changes, and the second is the one that cannot regress:
//
//   1. The caller passes the price the order was really priced at, not the
//      screener's (liveExecute.ts passes riskBasisPrice of the placement
//      quote; execute.ts passes the paper fill).
//   2. `rangeIncluding` extends the range with that price before the division.
//      A price that just printed in this session IS part of the session's
//      range; a range that does not contain it is simply behind. So
//      0 <= pctOfRange <= 100 holds for every input, and "at a new high of
//      day" reads 100 with `extendedRange: 'above'` beside it rather than an
//      impossible 130.
//
// What is NOT fixed, and is journaled instead of pretended away: the bars can
// be up to one bar plus one cache TTL behind, so a high printed after the last
// completed bar but above our own quote is still invisible. That residual
// biases a reading DOWN (the range looks smaller than it was), where the old
// defect was two-sided and unbounded. `extendedRange` counts how often the
// quote was outside the bars at all, which is the measurable proxy for it.
//
// Error size matters for the buckets, not just the outliers: FCX's entry sat
// 30 percentage points of range beyond its high. Bucket edges at 50/70/85 do
// not survive noise of that size, which is why the first bucket read was
// non-monotonic and why no gate could be cut from it.
// ---------------------------------------------------------------------------

import { Candle } from '../../providers/types';
import { etToday } from '../../util/marketDate';

/** Regular-session bounds, minutes since ET midnight (9:30–16:00). */
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

const etMinutesFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function etMinutes(ms: number): number {
  const parts = etMinutesFmt.formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

export interface SessionRange {
  high: number;
  low: number;
}

/**
 * High and low of today's REGULAR session so far, from 5-minute bars.
 *
 * Same session filter as computeSessionVwap, for the same reason: pre- and
 * after-market prints trade thin, and letting one set the day's high would
 * put every regular-session entry artificially low in the range.
 *
 * Null when today has no usable bars — an unmeasured entry, never an invented
 * one.
 */
export function computeSessionRange(candles: Candle[], now: number): SessionRange | null {
  const today = etToday(now);
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (etToday(c.time) !== today) continue;
    const m = etMinutes(c.time);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

/** Reference cut points. NOT tuned — the shadow journal exists to replace them. */
export const REFERENCE_MAX_PCT_OF_RANGE = 60;
export const REFERENCE_MAX_VWAP_EXT_PCT = 0.4;

/**
 * The session range widened to contain `price`.
 *
 * The range comes from completed 5-minute bars; `price` is a quote taken now.
 * When the quote sits outside the bars, the bars are behind — the session's
 * true high is at least this print — so the honest range is the wider one.
 * Doing this BEFORE the division is what makes 0..100 a property of the
 * function rather than a hope about its inputs.
 *
 * Null range in, null range out: widening nothing is still nothing.
 */
export function rangeIncluding(range: SessionRange | null, price: number): SessionRange | null {
  if (!range) return null;
  if (!(price > 0)) return range;
  return { high: Math.max(range.high, price), low: Math.min(range.low, price) };
}

/** Which side of the bar-derived range the measured price fell outside, if either. */
export type RangeExtension = 'above' | 'below' | null;

/** Whether `price` sat outside the bar-derived `range` — i.e. the bars were behind. */
export function rangeExtendedBy(range: SessionRange | null, price: number): RangeExtension {
  if (!range || !(price > 0)) return null;
  if (price > range.high) return 'above';
  if (price < range.low) return 'below';
  return null;
}

export interface EntryExtensionInput {
  side: 'long' | 'short';
  /** The price the trade was really priced at — the placement quote on the
   *  live path, the fill on the paper path. NOT `signal.entry`: that is the
   *  screen's price, minutes and a broker round-trip older than the range it
   *  would be divided by (see the header). */
  price: number;
  vwap: number | null;
  range: SessionRange | null;
}

export interface EntryExtension {
  /** Percent above VWAP for a long, below it for a short. Null when unmeasured. */
  vwapExtPct: number | null;
  /** 0 = at the session low, 100 = at the session high. Flipped for a short. Null when unmeasured. */
  pctOfRange: number | null;
  /** Which side of the bar-derived range the price fell outside, before the
   *  range was widened to include it. Null when it sat inside, or when there
   *  was no range. A running count of these is how stale the bars are. */
  extendedRange: RangeExtension;
  /** What the reference thresholds WOULD have done. Never acted on here. */
  wouldBlock: boolean;
  reasons: string[];
}

/**
 * How extended this entry is, measured two independent ways.
 *
 * Both are oriented so HIGHER always means "more extended in the direction we
 * are trading" — a short entered near the session LOW is as extended as a long
 * entered near the high, and the two must not cancel out when the journal is
 * aggregated across sides.
 *
 * A degenerate range (high === low, a symbol that has not moved) yields a null
 * pctOfRange rather than a divide-by-zero or an arbitrary 100: it is genuinely
 * unmeasurable, which is different from "at the high".
 */
export function evaluateEntryExtension(input: EntryExtensionInput): EntryExtension {
  const { side, price, vwap, range } = input;

  let vwapExtPct: number | null = null;
  if (vwap !== null && vwap > 0) {
    const raw = ((price - vwap) / vwap) * 100;
    vwapExtPct = Math.round((side === 'long' ? raw : -raw) * 1000) / 1000;
  }

  const extendedRange = rangeExtendedBy(range, price);
  const measured = rangeIncluding(range, price);
  let pctOfRange: number | null = null;
  if (measured && measured.high > measured.low) {
    const raw = ((price - measured.low) / (measured.high - measured.low)) * 100;
    pctOfRange = Math.round((side === 'long' ? raw : 100 - raw) * 10) / 10;
  }

  const reasons: string[] = [];
  if (pctOfRange !== null && pctOfRange > REFERENCE_MAX_PCT_OF_RANGE) {
    reasons.push(`entered at ${pctOfRange}% of the session range (reference max ${REFERENCE_MAX_PCT_OF_RANGE}%)`);
  }
  if (vwapExtPct !== null && vwapExtPct > REFERENCE_MAX_VWAP_EXT_PCT) {
    reasons.push(`entered ${vwapExtPct}% beyond VWAP (reference max ${REFERENCE_MAX_VWAP_EXT_PCT}%)`);
  }
  return { vwapExtPct, pctOfRange, extendedRange, wouldBlock: reasons.length > 0, reasons };
}
