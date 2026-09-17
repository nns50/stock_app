/**
 * Linear-interpolated percentile of an UNSORTED sample, `p` in 0..100. An
 * empty sample reads 0 (the callers treat "nothing to measure" separately,
 * before asking); a single value is its own every percentile.
 *
 * One definition (2026-09-17). It lived privately in excursionTune.ts, where
 * it sizes a stop from winners' heat; the excursion report now surfaces the
 * same quantiles for both books, and two copies of a percentile are how a
 * report and the tuner that reads it come to disagree by a rank.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0] as number;
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (xs[lo] as number) * (1 - frac) + (xs[hi] as number) * frac;
}
