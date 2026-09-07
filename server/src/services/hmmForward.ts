// ---------------------------------------------------------------------------
// The market-regime HMM's forward filter — a TypeScript port of
// ml/regime/infer.py, held to it by server/data/regimeModel.fixture.json.
//
// Pure and DB-free: numbers in, numbers out. The model itself (state means,
// precision matrices, the transition matrix) is trained offline in Python —
// the runtime image has no Python — and exported with everything precomputed,
// so nothing here inverts a matrix or fits anything. Two implementations of
// one algorithm drift apart silently; the parity test
// (server/test/regimeModelParity.test.ts) compares every intermediate of this
// file against the Python reference on a window of real FRED rows, so a change
// to either side that is not made to both fails loudly.
//
// The scaled forward algorithm, in log space:
//
//   logAlpha[k] = ln π[k] + logB[0][k];  c0 = logsumexp(logAlpha)
//   post[0]     = exp(logAlpha − c0);     logL = c0
//   for t ≥ 1:  logPred[j] = logsumexp_i( ln post[t−1][i] + ln A[i][j] )
//               logAlpha[j] = logPred[j] + logB[t][j]
//               ct = logsumexp(logAlpha);  post[t] = exp(logAlpha − ct);  logL += ct
//   predictedNext = post[T−1] × A
//
// Σct equals hmmlearn's score() on the same window; each ct is
// ln p(x_t | x_1..t−1), and the mean of the last ten is the drift statistic the
// reading compares with the training set's 5th percentile (a retrain signal —
// see services/regimeModel.ts for what the artifact carries).
// ---------------------------------------------------------------------------

/** One daily close of a FRED series. `date` is YYYY-MM-DD. */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** The three daily features, in the ONE order the model was trained on. */
export const REGIME_FEATURES = ['ret', 'logVix', 'logRv20'] as const;
export type RegimeFeature = (typeof REGIME_FEATURES)[number];

/** Rolling window of `logRv20` — 20 daily returns, sample std (ddof 1), then ln. */
export const RV_WINDOW = 20;

export interface FeatureRow {
  date: string;
  /** ln(close_t / close_{t−1}) on the S&P 500's own rows. */
  ret: number;
  /** ln(VIX close). */
  logVix: number;
  /** ln of the sample std of the last 20 `ret` (not annualized) — vol is
   *  log-normal-ish, and on the raw scale a crash stretches the high-vol
   *  state until an ordinary bear-market grind no longer fits it. */
  logRv20: number;
}

/** ln Σ exp(v_i), stable for large values and tolerant of −Infinity. */
export function logsumexp(values: readonly number[]): number {
  let top = -Infinity;
  for (const v of values) if (v > top) top = v;
  if (!Number.isFinite(top)) return top; // all −Infinity (or an Infinity/NaN, which propagates)
  let sum = 0;
  for (const v of values) sum += Math.exp(v - top);
  return top + Math.log(sum);
}

/**
 * ln N(x; μ, Σ) with Σ⁻¹ and ln|Σ| precomputed by the trainer:
 *   −0.5 · (d·ln 2π + ln|Σ| + (x−μ)ᵀ P (x−μ)).
 */
export function logGaussianDensity(
  x: readonly number[],
  mean: readonly number[],
  precision: readonly (readonly number[])[],
  logDet: number,
): number {
  const d = x.length;
  const diff = new Array<number>(d);
  for (let i = 0; i < d; i += 1) diff[i] = x[i] - mean[i];
  let maha = 0;
  for (let i = 0; i < d; i += 1) {
    let row = 0;
    for (let j = 0; j < d; j += 1) row += precision[i][j] * diff[j];
    maha += diff[i] * row;
  }
  return -0.5 * (d * Math.log(2 * Math.PI) + logDet + maha);
}

/** Sort ascending by date and keep the LAST value of a duplicated date — the
 *  same de-duplication ml/regime/data.py applies to a FRED body. */
function normalizeSeries(points: readonly SeriesPoint[]): SeriesPoint[] {
  const byDate = new Map<string, number>();
  for (const p of points) byDate.set(p.date, p.value);
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

function sampleStd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (n - 1));
}

/**
 * The feature frame, exactly as ml/regime/features.py builds it: log returns
 * and the rolling std on the S&P 500 series ALONE (a VIX holiday never punches
 * a hole in a return), ln on the VIX series alone, then an inner join on date
 * and the rows with any non-finite feature dropped — which removes the first
 * 20 S&P 500 rows (no rolling std yet), any row with a non-positive close, and
 * a window of identical closes (ln 0).
 */
export function buildFeatures(sp500: readonly SeriesPoint[], vix: readonly SeriesPoint[]): FeatureRow[] {
  const sp = normalizeSeries(sp500);
  const logVixByDate = new Map<string, number>();
  for (const p of normalizeSeries(vix)) logVixByDate.set(p.date, Math.log(p.value));
  const logClose = sp.map((p) => Math.log(p.value));
  const ret = new Array<number>(sp.length).fill(NaN);
  for (let i = 1; i < sp.length; i += 1) ret[i] = logClose[i] - logClose[i - 1];
  const out: FeatureRow[] = [];
  for (let i = RV_WINDOW; i < sp.length; i += 1) {
    const window = ret.slice(i - RV_WINDOW + 1, i + 1);
    // pandas' rolling std is NaN whenever the window holds a NaN.
    const logRv20 = window.every((v) => Number.isFinite(v)) ? Math.log(sampleStd(window)) : NaN;
    const logVix = logVixByDate.get(sp[i].date);
    if (logVix === undefined) continue;
    const row = { date: sp[i].date, ret: ret[i], logVix, logRv20 };
    if (!Number.isFinite(row.ret) || !Number.isFinite(row.logVix) || !Number.isFinite(row.logRv20)) continue;
    out.push(row);
  }
  return out;
}

export interface StandardizeSpec {
  /** Column order of the standardized matrix — the model's `features`. */
  features: readonly RegimeFeature[];
  mean: readonly number[];
  scale: readonly number[];
}

/** z = (x − mean) / scale, columns in `spec.features` order. */
export function standardize(rows: readonly FeatureRow[], spec: StandardizeSpec): number[][] {
  return rows.map((row) => spec.features.map((name, j) => (row[name] - spec.mean[j]) / spec.scale[j]));
}

export interface HmmState {
  mean: readonly number[];
  precision: readonly (readonly number[])[];
  logDet: number;
}

export interface HmmParams {
  startprob: readonly number[];
  transmat: readonly (readonly number[])[];
  /** In state-index order. */
  states: readonly HmmState[];
}

export interface ForwardFilterResult {
  /** T × K filtered posteriors P(state_t | x_1..t). Each row sums to 1. */
  posteriors: number[][];
  /** Σ stepLogLik — equals hmmlearn's score() on the same window. */
  logLikelihood: number;
  /** ln p(x_t | x_1..t−1) per step. */
  stepLogLik: number[];
}

export function forwardFilter(params: HmmParams, standardized: readonly (readonly number[])[]): ForwardFilterResult {
  const T = standardized.length;
  const K = params.states.length;
  if (T === 0) throw new Error('forwardFilter needs at least one observation');
  const logB = standardized.map((x) => params.states.map((s) => logGaussianDensity(x, s.mean, s.precision, s.logDet)));
  const logA = params.transmat.map((row) => row.map((a) => Math.log(a)));
  const posteriors: number[][] = [];
  const stepLogLik: number[] = [];
  let logAlpha = params.startprob.map((p, k) => Math.log(p) + logB[0][k]);
  let c = logsumexp(logAlpha);
  posteriors.push(logAlpha.map((v) => Math.exp(v - c)));
  stepLogLik.push(c);
  for (let t = 1; t < T; t += 1) {
    const logPrev = posteriors[t - 1].map((p) => Math.log(p));
    logAlpha = new Array<number>(K);
    for (let j = 0; j < K; j += 1) {
      const terms = new Array<number>(K);
      for (let i = 0; i < K; i += 1) terms[i] = logPrev[i] + logA[i][j];
      logAlpha[j] = logsumexp(terms) + logB[t][j];
    }
    c = logsumexp(logAlpha);
    posteriors.push(logAlpha.map((v) => Math.exp(v - c)));
    stepLogLik.push(c);
  }
  let logLikelihood = 0;
  for (const v of stepLogLik) logLikelihood += v;
  return { posteriors, logLikelihood, stepLogLik };
}

/** posterior × A — the one-step-ahead state distribution. */
export function predictedNext(posterior: readonly number[], transmat: readonly (readonly number[])[]): number[] {
  const K = posterior.length;
  const out = new Array<number>(K).fill(0);
  for (let j = 0; j < K; j += 1) for (let i = 0; i < K; i += 1) out[j] += posterior[i] * transmat[i][j];
  return out;
}

/** Mean of the last `window` per-step log-likelihoods; null with fewer steps. */
export function driftScore(stepLogLik: readonly number[], window: number): number | null {
  if (window <= 0 || stepLogLik.length < window) return null;
  let sum = 0;
  for (let i = stepLogLik.length - window; i < stepLogLik.length; i += 1) sum += stepLogLik[i];
  return sum / window;
}
