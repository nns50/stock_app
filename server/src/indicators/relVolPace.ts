// ---------------------------------------------------------------------------
// Relative-volume PACE (2026-08-25) — relative volume that means the same thing
// at 10:00 as it does at 15:30.
//
// The problem with raw relVolume: it is today's CUMULATIVE volume divided by
// the 20-day average FULL-DAY volume, so it climbs mechanically through the
// session no matter how the stock is trading. A fixed floor on it is therefore
// wrong at every hour but one. Measured on the live book at 10:47 ET, across
// 261 scored symbols:
//
//     median 0.10 · p90 0.19 · p95 0.23 · p99 0.43 · max 2.30
//     symbols at or above 1.0: ONE
//
// minRelVol was 1.0. At 19.7% of the session elapsed, that demanded roughly 5x
// normal pace, and 270 of 271 symbols failed it — the loop found 3 candidates
// in 33 minutes and took no trades. The same 1.0 in the last hour would let
// virtually everything through, because by then a completely ordinary stock has
// done most of a normal day's volume.
//
// The fix is to divide by how far a NORMAL stock has got by now. The obvious
// implementation is a hard-coded intraday volume curve (the well-known U
// shape), but that bakes in an assumption this app cannot check and that drifts
// with market structure. There is a better estimator already in hand: the
// screener scores the whole universe every tick, so the MEDIAN relVolume across
// that universe IS the fraction of a normal day's volume elapsed. By definition
// half the market is above it and half below.
//
// Dividing by that median gives a pace multiple — "this stock is trading at
// 2.4x the pace of the median stock right now" — which is
//   - time-of-day neutral: the denominator rises through the day exactly as the
//     numerator does, so a 1.5x threshold means the same thing all session;
//   - market-condition neutral: on a quiet day EVERY relVolume is depressed,
//     and dividing by the median cancels it, instead of a fixed floor silently
//     becoming stricter;
//   - free: no extra fetch, no stored curve to maintain, no per-symbol intraday
//     history (which the provider rate-limits hard enough already — 47 of 559
//     symbols go unscored per tick as it is).
//
// The cost, stated plainly: this measures a stock against TODAY'S market rather
// than against its own history, so on a day when the whole market is unusually
// active the bar rises with it. That is a feature for finding relative movers
// and a limitation if you specifically want absolute unusual volume — for which
// the raw minRelVol filter is still there and still applies.
// ---------------------------------------------------------------------------

/** Below this many usable samples the median is too noisy to divide by, and
 *  the filter fails OPEN rather than silently rejecting the whole universe off
 *  a handful of readings. A screen tick normally scores 500+. */
export const MIN_PACE_SAMPLES = 20;

/** Median of the finite, positive values in `xs`. Null when there are too few
 *  to be meaningful — never a guessed denominator. */
export function relVolMedian(xs: (number | null | undefined)[]): number | null {
  const usable = xs
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (usable.length < MIN_PACE_SAMPLES) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 0 ? (usable[mid - 1] + usable[mid]) / 2 : usable[mid];
}

/**
 * How this symbol's relative volume compares with the median stock's right now.
 * 1.0 = trading at exactly the market's current pace; 2.0 = twice it.
 *
 * Null when it cannot be measured — no relVolume for the symbol, or too few
 * samples for a median. Callers treat null as "no opinion" and let the symbol
 * through, the same "never reject on a guess" discipline the rest of the
 * screener follows.
 */
export function relVolPace(relVolume: number | null | undefined, median: number | null): number | null {
  if (median === null || !(median > 0)) return null;
  if (typeof relVolume !== 'number' || !Number.isFinite(relVolume) || relVolume < 0) return null;
  return Math.round((relVolume / median) * 100) / 100;
}
