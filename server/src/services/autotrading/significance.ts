// ---------------------------------------------------------------------------
// Statistical-significance check for a backtest's trade list
// (docs/AUTOTRADING_SPEC.md, phase 5 follow-up) — bootstrap resampling for a
// confidence interval on expectancy, plus a sign-flip permutation test for a
// p-value against the "no real edge" null. Meant to run over a walk-forward
// run's OUT-OF-SAMPLE trades specifically: a config's in-sample performance
// is already selected to look good, so testing IT for significance mostly
// measures how well you overfit, not whether the edge is real (routes/
// autotrade.ts computes this for both windows anyway, since it's the same
// cheap function call either way — but the framing above is why the existing
// UI already labels out-of-sample "the number that matters").
//
// The harness still renders no pass/fail verdict (docs/AUTOTRADING_SPEC.md's
// own stated philosophy for this whole feature) — these numbers are
// additional evidence a human weighs, not a gate the system enforces itself.
// autoTuneEfficacy.ts takes the identical stance on a related question
// ("did a past config change actually help") for the same reason: telling a
// genuine edge apart from an unrelated regime shift, or from noise, is
// genuinely hard, and a human reviewing the numbers should stay in the loop.
//
// Mirrors riskOfRuin.ts's own Monte Carlo conventions: an injectable rng
// (defaults to Math.random, swapped for a seeded PRNG in tests) and a private
// sort-then-index percentile() copy — small-helper duplication instead of a
// shared stats module is this codebase's deliberate convention (see e.g.
// autoTuneEfficacy.ts's own comment making the same point about a different
// helper).
// ---------------------------------------------------------------------------

/** Same floor pnl.ts's kellySuggestion() uses for its own "reliable" flag —
 *  below this, both the CI and the p-value are themselves too noisy to lean
 *  on hard. */
export const MIN_RELIABLE_TRADES = 20;

/** Bootstrap/permutation draw count. 2000 is a standard default for a
 *  percentile bootstrap CI (Efron & Tibshirani) — enough for the 2.5th/97.5th
 *  percentiles to stop moving much between runs, cheap enough (a couple
 *  million simple ops even at a few hundred trades) to run synchronously in
 *  a request handler. */
export const DEFAULT_RESAMPLES = 2000;

export interface SignificanceStats {
  sampleSize: number;
  /** Mean pnl per trade — the same figure as BacktestStats.expectancy,
   *  computed independently here so this file has no import dependency on
   *  backtest.ts (kept a pure, engine-agnostic function, same reasoning as
   *  computeBacktestStats's own structural-subset parameter type). */
  expectancy: number | null;
  /** 95% bootstrap percentile CI on expectancy — the spread of means you'd
   *  plausibly see if this same underlying trade-generating process played
   *  out again. Null only when there are no trades to resample at all. */
  ciLow: number | null;
  ciHigh: number | null;
  /** Two-sided sign-flip permutation p-value: the fraction of random sign
   *  reassignments (the null hypothesis of "no true directional edge," i.e.
   *  each trade's realized pnl was just as likely to have gone the other
   *  way) that produce a mean at least as extreme as the one actually
   *  observed. Lower means the observed expectancy is less consistent with
   *  pure noise — conventionally, under 0.05 is "unlikely to be noise," but
   *  this function renders no such verdict itself. */
  pValue: number | null;
  /** How many bootstrap/permutation draws were actually used. */
  resamples: number;
  /** sampleSize >= MIN_RELIABLE_TRADES. A thin trade list can still produce a
   *  narrow-looking CI or a small p-value by chance — this flags that rather
   *  than silently presenting it with the same confidence as a deep sample. */
  reliable: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 4 decimal places — a p-value's own scale (0.001 vs 0.04 vs 0.4) is the
 *  point; round2 would collapse anything under 0.01 to 0.00, which reads as
 *  "impossible" rather than "quite unlikely." */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Value at the given percentile (0..100) of an already-SORTED sample. */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Bootstrap CI + permutation p-value on a trade list's expectancy (mean
 * pnl/trade). Parameter is a structural subset — `{ pnl: number }[]` — the
 * same idiom computeBacktestStats() uses, so this works unmodified across
 * equity trades, options trades, or a combined-engine's concatenated
 * `[...equityTrades, ...optionsTrades]`, with no per-engine duplication.
 *
 * Returns all-null stats (not a thrown error or a fabricated 0) when there
 * are no trades to resample — matching computeBacktestStats's own
 * empty-list convention (avgR/bestR/worstR are null there too).
 */
export function computeSignificanceStats(
  trades: { pnl: number }[],
  opts: { rng?: () => number; resamples?: number } = {},
): SignificanceStats {
  const rng = opts.rng ?? Math.random;
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const n = trades.length;
  if (n === 0) {
    return { sampleSize: 0, expectancy: null, ciLow: null, ciHigh: null, pValue: null, resamples: 0, reliable: false };
  }

  const pnls = trades.map((t) => t.pnl);
  const expectancy = mean(pnls);

  // Bootstrap CI: resample WITH replacement, recompute the mean each draw.
  const bootMeans: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += pnls[Math.floor(rng() * n)];
    bootMeans[i] = sum / n;
  }
  bootMeans.sort((a, b) => a - b);

  // Sign-flip permutation p-value: under the null of no true directional
  // edge, each trade's realized pnl was just as likely to have been its own
  // negation (symmetric around zero) — repeatedly flip signs at random and
  // see how often the resulting mean is at least as extreme (in absolute
  // value, two-sided) as the one actually observed.
  let asExtreme = 0;
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += rng() < 0.5 ? pnls[j] : -pnls[j];
    if (Math.abs(sum / n) >= Math.abs(expectancy)) asExtreme++;
  }
  // +1/+1 smoothing (Davison & Hinkley, 1997) — a finite number of resamples
  // can never itself justify a probability of exactly zero.
  const pValue = (asExtreme + 1) / (resamples + 1);

  return {
    sampleSize: n,
    expectancy: round2(expectancy),
    ciLow: round2(percentile(bootMeans, 2.5)),
    ciHigh: round2(percentile(bootMeans, 97.5)),
    pValue: round4(pValue),
    resamples,
    reliable: n >= MIN_RELIABLE_TRADES,
  };
}

/** Fraction of the chronological trade list treated as OUT-OF-SAMPLE (the most
 *  recent trades) for the auto-tune walk-forward guard (2026-07-24). Half is a
 *  balanced split — recent enough to catch a decayed edge, deep enough to be
 *  worth a significance read. */
export const DEFAULT_OOS_FRACTION = 0.5;

export interface OosConfirmation {
  /** True only when the out-of-sample slice is a RELIABLE sample AND its
   *  expectancy CI excludes zero on the positive side — i.e. the edge still
   *  looks real on the trades the tune hasn't already been fit to. */
  confirmed: boolean;
  oosSampleSize: number;
  /** Expectancy in R MULTIPLES, not dollars — see the note on
   *  checkOosEdgeConfirmation. Renamed from `oosExpectancy` on 2026-09-06 with
   *  the unit change, deliberately: journal rows written before and after carry
   *  different quantities under the same name otherwise, and a $5.54 sitting
   *  next to a 0.051 in the same field is exactly the kind of silent unit
   *  mismatch CLAUDE.md's "two places deriving the same quantity" rule is about. */
  oosExpectancyR: number | null;
  oosCiLowR: number | null;
  reliable: boolean;
  /** Plain-English one-liner for journaling. */
  reason: string;
}

/**
 * JUDGED IN R MULTIPLES, NOT DOLLARS (2026-09-06).
 *
 * This guard reads the loop's own closed trades, and `riskPerTradePct` moved
 * 2.14 -> 1.97 -> 1.25 across that same window (and 2.14 -> 0 -> 2.14 before
 * it). So a dollar result mixes bets of very different size, and the spread it
 * measures is partly the SIZING history rather than the edge. Dividing each
 * trade by the risk it actually took removes that.
 *
 * Measured on the 43-trade out-of-sample window as it stood:
 *
 *   dollars   expectancy +$1.51   stdev $38.34   CI  -$8.85 … +$13.75
 *             -> needs ~2,473 out-of-sample trades to confirm at this edge
 *   R         expectancy +0.051R  stdev 0.617    CI  -0.119 … +0.234
 *             -> needs ~566
 *
 * A 4.4x improvement, and it still refuses today — which is the point. This is
 * a correction to WHAT is measured, not a loosening of the bar: +0.051R +/-
 * 0.18R is not a demonstrated edge, and the guard is right to say so. What it
 * fixes is that in dollars the bar was unreachable in any realistic number of
 * trades, which made the risk ratchet permanently one-way (see task #47: seven
 * risk adjustments, all decreases, and all 22 increases blocked).
 *
 * Trades with no usable initial stop have no R and are DROPPED by the caller
 * rather than counted as zero. That shrinks the window, which can only make
 * this refuse — the safe direction for a gate that guards a risk increase.
 *
 * Walk-forward guard for the auto-tune risk-% INCREASE (docs/AUTOTRADING_SPEC.md
 * — VALIDATION GATE, applied live). Given all decisive closed trades in
 * chronological order (oldest → newest), split off the most recent
 * `oosFraction` as an out-of-sample window and ask whether the edge still holds
 * THERE — because the in-sample edge the Kelly suggestion is fit to is already
 * selected to look good. Confirmed only when that OOS window is a reliable
 * sample and its bootstrap expectancy CI sits entirely above zero. A thin OOS
 * window is treated as "not confirmed" (conservative — no evidence is not
 * positive evidence), never as a pass.
 *
 * Pure: reuses computeSignificanceStats, no I/O, deterministic under a seeded
 * rng. Only ever used to GATE an increase — decreases never call it.
 */
export function checkOosEdgeConfirmation(
  chronoTrades: { rMultiple: number }[],
  opts: { rng?: () => number; resamples?: number; oosFraction?: number } = {},
): OosConfirmation {
  const frac = opts.oosFraction ?? DEFAULT_OOS_FRACTION;
  const n = chronoTrades.length;
  const oosCount = n === 0 ? 0 : Math.min(n, Math.max(1, Math.floor(n * frac)));
  const oos = chronoTrades.slice(n - oosCount);
  // The statistic is unit-agnostic — it bootstraps a mean over whatever numbers
  // it is handed — so the `pnl` field here carries an R MULTIPLE. Measured
  // 2026-09-06, that substitution is worth roughly 4.4x: the same 43 trades need
  // ~2,473 out-of-sample observations to confirm in dollars and ~566 in R.
  const stats = computeSignificanceStats(
    oos.map((t) => ({ pnl: t.rMultiple })),
    { rng: opts.rng, resamples: opts.resamples },
  );
  const confirmed = stats.reliable && stats.ciLow !== null && stats.ciLow > 0;
  const reason = confirmed
    ? `out-of-sample edge holds: ${stats.sampleSize} recent trades, expectancy ${stats.expectancy}R ` +
      `(95% CI ${stats.ciLow}…${stats.ciHigh}, entirely positive)`
    : !stats.reliable
      ? `out-of-sample window too thin to confirm (${stats.sampleSize} recent trades with a usable ` +
        `initial stop, needs ${MIN_RELIABLE_TRADES})`
      : `out-of-sample edge not confirmed: expectancy ${stats.expectancy}R, 95% CI ${stats.ciLow}…${stats.ciHigh} ` +
        `includes zero or below`;
  return {
    confirmed,
    oosSampleSize: stats.sampleSize,
    oosExpectancyR: stats.expectancy,
    oosCiLowR: stats.ciLow,
    reliable: stats.reliable,
    reason,
  };
}
