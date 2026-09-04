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

export interface EntryExtensionInput {
  side: 'long' | 'short';
  price: number;
  vwap: number | null;
  range: SessionRange | null;
}

export interface EntryExtension {
  /** Percent above VWAP for a long, below it for a short. Null when unmeasured. */
  vwapExtPct: number | null;
  /** 0 = at the session low, 100 = at the session high. Flipped for a short. Null when unmeasured. */
  pctOfRange: number | null;
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

  let pctOfRange: number | null = null;
  if (range && range.high > range.low) {
    const raw = ((price - range.low) / (range.high - range.low)) * 100;
    pctOfRange = Math.round((side === 'long' ? raw : 100 - raw) * 10) / 10;
  }

  const reasons: string[] = [];
  if (pctOfRange !== null && pctOfRange > REFERENCE_MAX_PCT_OF_RANGE) {
    reasons.push(`entered at ${pctOfRange}% of the session range (reference max ${REFERENCE_MAX_PCT_OF_RANGE}%)`);
  }
  if (vwapExtPct !== null && vwapExtPct > REFERENCE_MAX_VWAP_EXT_PCT) {
    reasons.push(`entered ${vwapExtPct}% beyond VWAP (reference max ${REFERENCE_MAX_VWAP_EXT_PCT}%)`);
  }
  return { vwapExtPct, pctOfRange, wouldBlock: reasons.length > 0, reasons };
}
