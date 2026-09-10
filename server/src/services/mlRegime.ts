import { config } from '../config';
import { getProvider, getProviderStatus } from '../providers';
import { getAutotradeConfig } from '../db/autotradeConfig';
import { listAutotradeEvents, logAutotradeEvent } from '../db/autotradeEvents';
import { getDailySeries, latestDailySeriesDate, upsertDailySeries } from '../db/dailySeries';
import { getMlRegimeReading, getPreviousKnownMlRegime, saveMlRegimeReading } from '../db/mlRegimeReadings';
import { etToday } from '../util/marketDate';
import { previousTradingSession, sessionDatesEndingAt } from './trading/marketCalendar';
import { FRED_SP500, FRED_VIX, fetchFredSeries } from './fredSeries';
import {
  FeatureRow,
  SeriesPoint,
  buildFeatures,
  driftScore,
  forwardFilter,
  predictedNext,
  standardize,
} from './hmmForward';
import {
  ML_REGIME_LABELS,
  MlRegime,
  MlRegimeLabel,
  RegimeModel,
  hmmParamsOf,
  isMlRegimeLabel,
  loadRegimeModel,
} from './regimeModel';

// ---------------------------------------------------------------------------
// The market-regime READING: what regime is the tape in today, according to
// the shipped HMM (docs/MARKET_REGIME_MODEL.md)? One reading per ET day,
// persisted (db/mlRegimeReadings.ts) so a restart or a retrain cannot flap the
// sticky switch, computed from the same FRED series the model was trained on
// (db/dailySeries.ts caches them), and journaled once per day.
//
// Fail-OPEN, visibly. No model, no data, a stale data date, the source
// switched off — every one reads `unknown` with a `reason`, and `unknown` is
// what every consumer treats as "no overlay" (nothing is cut, tightened or
// gated on a guess). DRIFT is the one exception: the reading keeps its label
// and raises `drift` as a retrain signal — the first evaluation showed a
// drift-as-unknown rule would have switched the overlay off on 92% of the
// COVID-crash sessions, the one episode it exists for.
//
// FRED publishes the S&P 500 close the next business morning and the VIX close
// often a day later, so a day's first fetch (the first tick after midnight
// ET) rarely has yesterday. The service refetches at most hourly until both
// series carry the previous session's close, re-classifying each time (the
// sticky switch keeps that from flapping), and then holds for the day.
// ---------------------------------------------------------------------------

export type MlRegimeSource = 'fred' | 'provider' | 'cache' | 'override' | 'off' | 'none';
export type MlRegimeReason = 'no_model' | 'source_off' | 'no_data' | 'stale' | 'synthetic_provider' | 'fetch_failed';

export interface MlRegimeProbabilities {
  high_vol_bearish: number;
  low_vol_bullish: number;
  sideways: number;
}

export interface MlRegimeReading {
  /** The regime the app acts on — `unknown` whenever the reading is unusable. */
  regime: MlRegime;
  /** `regime` in the operator's words. */
  label: string;
  /** The argmax posterior's label before the sticky rule (and under staleness,
   *  what the model WOULD read) — `unknown` when nothing was computed. */
  candidate: MlRegime;
  probabilities: MlRegimeProbabilities | null;
  /** posterior × A — the one-step-ahead state distribution. */
  predictedNext: MlRegimeProbabilities | null;
  /** The last data date the reading was computed from (both series present). */
  asOf: string | null;
  /** The ET day the reading is for. */
  etDate: string;
  /** The last row's features in natural units (vix = exp(logVix), rv20 = exp(logRv20)). */
  features: { ret: number; vix: number; rv20: number } | null;
  source: MlRegimeSource;
  /** `asOf` older than the third most recent session — the overlay is inert. */
  stale: boolean;
  /** Trailing likelihood below the training 5th percentile: a retrain signal. */
  drift: boolean;
  driftScore: number | null;
  driftP5: number | null;
  modelVersion: string | null;
  /** The sticky rule changed the regime today (relative to the previous known day). */
  switched: boolean;
  /** The argmax differed from the previous regime but did not clear the threshold. */
  heldBelowThreshold: boolean;
  threshold: number;
  /** The previous KNOWN regime the sticky rule read (null on the first day). */
  previous: MlRegime | null;
  /** Feature rows the filter ran over. */
  rows: number;
  logLikelihood: number | null;
  reason?: MlRegimeReason;
  /** Epoch ms this reading was computed. */
  computedAt: number;
}

/** The compact mirror the loop persists on its tick summary. */
export interface MlRegimeTickSummary {
  regime: MlRegime;
  label: string;
  source: MlRegimeSource;
  asOf: string | null;
  stale: boolean;
  drift: boolean;
  /** The acted-on regime's posterior (null when nothing was computed). */
  probability: number | null;
}

/**
 * The regime a consumer may ACT on: the reading's regime when it is known and
 * fresh, else null — never a guess. The one derivation the loop, both risk-check
 * previews and every executor share (effectiveRisk.ts's regimeTriggers takes
 * its output), so "stale reads as no overlay" cannot be true in one place and
 * false in another. Drift does not zero it: the label stands and the drift flag
 * is a retrain signal (see the header).
 */
export function actionableRegime(r: MlRegimeReading | null | undefined): MlRegime | null {
  return r && !r.stale && r.regime !== 'unknown' ? r.regime : null;
}

export function summarizeMlRegime(r: MlRegimeReading): MlRegimeTickSummary {
  const acted = r.regime !== 'unknown' ? r.regime : r.candidate;
  const probability = r.probabilities && acted !== 'unknown' ? r.probabilities[acted] : null;
  return {
    regime: r.regime,
    label: r.label,
    source: r.source,
    asOf: r.asOf,
    stale: r.stale,
    drift: r.drift,
    probability,
  };
}

/** Calendar days of closes fetched so 250 feature rows are certain (mirrors ml/regime/infer.py). */
export const LOOKBACK_CALENDAR_DAYS = 500;
/** Fewer feature rows than this and the filter has not settled from its prior. */
export const MIN_INFERENCE_ROWS = 60;
/** `asOf` older than this many most-recent sessions reads stale. */
export const STALE_AFTER_SESSIONS = 3;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const PROVIDER_FALLBACK = { sp500: '^GSPC', vix: '^VIX', limit: 400 } as const;

export const ML_REGIME_READ_ACTION = 'ml_regime_read';
export const ML_REGIME_CHANGED_ACTION = 'ml_regime_changed';
export const ML_REGIME_DRIFT_ACTION = 'ml_regime_drift';
export const ML_REGIME_FETCH_FAILED_ACTION = 'ml_regime_fetch_failed';
export const ML_REGIME_OVERRIDE_ACTION = 'ml_regime_override';
/** Rule 3 of the enabling rules (2026-09-10): a recorded comparison of the
 *  Python `regime:predict` with the persisted reading for one day
 *  (services/mlRegimeReadiness.ts). */
export const ML_REGIME_PARITY_ACTION = 'ml_regime_parity';

// --- pure ------------------------------------------------------------------

/** Stale when the last data date is older than the third most recent session:
 *  Tue 09-08 with data through Thu 09-03 (a Labor-Day week) is fresh; Wed 09-09
 *  with the same data is stale. */
export function isReadingStale(asOf: string | null, today: string): boolean {
  if (!asOf) return true;
  const window = sessionDatesEndingAt(today, STALE_AFTER_SESSIONS);
  return window.length > 0 && asOf < window[0];
}

/** The sticky rule: no previous (or an unknown one) accepts the argmax; the same
 *  regime holds; a different argmax switches only at or above `threshold`. */
export function stickySwitch(
  previous: MlRegime | null,
  posterior: readonly number[],
  labels: readonly MlRegimeLabel[],
  threshold: number,
): { regime: MlRegimeLabel; candidate: MlRegimeLabel; switched: boolean; heldBelowThreshold: boolean } {
  let best = 0;
  for (let k = 1; k < posterior.length; k += 1) if (posterior[k] > posterior[best]) best = k;
  const candidate = labels[best];
  if (previous === null || previous === 'unknown' || !labels.includes(previous)) {
    return { regime: candidate, candidate, switched: false, heldBelowThreshold: false };
  }
  if (candidate === previous) return { regime: previous, candidate, switched: false, heldBelowThreshold: false };
  if (posterior[best] >= threshold) return { regime: candidate, candidate, switched: true, heldBelowThreshold: false };
  return { regime: previous, candidate, switched: false, heldBelowThreshold: true };
}

export interface Classification {
  regime: MlRegimeLabel;
  candidate: MlRegimeLabel;
  probabilities: MlRegimeProbabilities;
  predictedNext: MlRegimeProbabilities;
  switched: boolean;
  heldBelowThreshold: boolean;
  drift: boolean;
  driftScore: number | null;
  logLikelihood: number;
  rows: number;
  asOf: string;
  features: { ret: number; vix: number; rv20: number };
}

function byLabel(model: RegimeModel, vector: readonly number[]): MlRegimeProbabilities {
  const out: MlRegimeProbabilities = { high_vol_bearish: 0, low_vol_bullish: 0, sideways: 0 };
  model.states.forEach((s, k) => {
    out[s.label] = vector[k];
  });
  return out;
}

/** Classify the last row of `rows` exactly as ml/regime/infer.py's classify():
 *  the last `inferenceWindow` rows, standardized, filtered from the prior,
 *  sticky-switched from `previous`. Null with too few rows. */
export function classifyFromFeatures(
  model: RegimeModel,
  rows: readonly FeatureRow[],
  previous: MlRegime | null,
  threshold: number,
): Classification | null {
  if (rows.length < MIN_INFERENCE_ROWS) return null;
  const window = rows.slice(-model.inferenceWindow);
  const z = standardize(window, { features: model.features, mean: model.scaler.mean, scale: model.scaler.scale });
  const { posteriors, logLikelihood, stepLogLik } = forwardFilter(hmmParamsOf(model), z);
  const last = posteriors[posteriors.length - 1];
  const labels = model.states.map((s) => s.label);
  const sticky = stickySwitch(previous, last, labels, threshold);
  const score = driftScore(stepLogLik, model.drift.window);
  const lastRow = window[window.length - 1];
  return {
    ...sticky,
    probabilities: byLabel(model, last),
    predictedNext: byLabel(model, predictedNext(last, model.transmat)),
    drift: score !== null && score < model.drift.p5,
    driftScore: score,
    logLikelihood,
    rows: window.length,
    asOf: lastRow.date,
    features: { ret: lastRow.ret, vix: Math.exp(lastRow.logVix), rv20: Math.exp(lastRow.logRv20) },
  };
}

// --- the reading -------------------------------------------------------------

export interface GetMarketRegimeOptions {
  now?: number;
  /** Refetch and re-classify even if today's reading is cached. */
  force?: boolean;
  /** Tests: override the configured source / dev override / model. */
  source?: 'fred' | 'provider' | 'off';
  devOverride?: string;
  model?: RegimeModel | null;
  fetchImpl?: typeof fetch;
  /** Tests: the sticky switch's threshold; defaults to the auto-trade config's
   *  mlRegimeSwitchThreshold (0.6, the artifact's own default). */
  threshold?: number;
}

let cache: { etDate: string; reading: MlRegimeReading } | null = null;
let lastFetchAt = 0;

/** Tests only. */
export function resetMlRegimeCache(): void {
  cache = null;
  lastFetchAt = 0;
}

function unknownReading(
  etDate: string,
  reason: MlRegimeReason,
  source: MlRegimeSource,
  now: number,
  model: RegimeModel | null,
): MlRegimeReading {
  return {
    regime: 'unknown',
    label: ML_REGIME_LABELS.unknown,
    candidate: 'unknown',
    probabilities: null,
    predictedNext: null,
    asOf: null,
    etDate,
    features: null,
    source,
    stale: reason === 'stale',
    drift: false,
    driftScore: null,
    driftP5: model?.drift.p5 ?? null,
    modelVersion: model?.version ?? null,
    switched: false,
    heldBelowThreshold: false,
    threshold: model?.switchThresholdDefault ?? 0,
    previous: null,
    rows: 0,
    logLikelihood: null,
    reason,
    computedAt: now,
  };
}

function journaledToday(action: string, today: string, key?: string): boolean {
  return listAutotradeEvents({ stage: 'config', actions: [action], limit: 30 }).some((e) => {
    if (!e.detail) return false;
    try {
      const d = JSON.parse(e.detail) as { date?: string; key?: string };
      return d.date === today && (key === undefined || d.key === key);
    } catch {
      return false;
    }
  });
}

/** One journal row per (action, ET day, optional key) — `detail.date` is the
 *  day it is about, which for a back-filled parity check is not today. */
export function journalOncePerDay(action: string, today: string, detail: Record<string, unknown>, key?: string): void {
  if (journaledToday(action, today, key)) return;
  logAutotradeEvent({
    stage: 'config',
    action,
    detail: { date: today, ...(key === undefined ? {} : { key }), ...detail },
  });
}

function seriesComplete(today: string): boolean {
  const needed = previousTradingSession(today);
  const sp = latestDailySeriesDate(FRED_SP500);
  const vix = latestDailySeriesDate(FRED_VIX);
  return sp !== null && vix !== null && sp >= needed && vix >= needed;
}

function shiftDays(etDate: string, n: number): string {
  const [y, m, d] = etDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function candlesToSeries(candles: readonly { time: number; close: number }[]): SeriesPoint[] {
  // Daily candles are stamped at the session's open (13:30 UTC for a US
  // session), so the UTC date is the ET date.
  return candles.map((c) => ({ date: new Date(c.time).toISOString().slice(0, 10), value: c.close }));
}

async function providerSeries(): Promise<{ sp500: SeriesPoint[]; vix: SeriesPoint[] } | 'synthetic'> {
  if (getProviderStatus().synthetic) return 'synthetic';
  const provider = getProvider();
  const [sp500, vix] = await Promise.all([
    provider.getCandles(PROVIDER_FALLBACK.sp500, 'daily', { limit: PROVIDER_FALLBACK.limit }),
    provider.getCandles(PROVIDER_FALLBACK.vix, 'daily', { limit: PROVIDER_FALLBACK.limit }),
  ]);
  return { sp500: candlesToSeries(sp500), vix: candlesToSeries(vix) };
}

interface SeriesResult {
  sp500: SeriesPoint[];
  vix: SeriesPoint[];
  source: MlRegimeSource;
  reason?: MlRegimeReason;
}

/** FRED (persisted) → the cached rows → the provider (never persisted). */
async function loadSeries(
  today: string,
  source: 'fred' | 'provider',
  now: number,
  fetchImpl: typeof fetch | undefined,
): Promise<SeriesResult> {
  const cosd = shiftDays(today, -LOOKBACK_CALENDAR_DAYS);
  if (source === 'fred') {
    try {
      const [sp500, vix] = await Promise.all([
        fetchFredSeries(FRED_SP500, cosd, { fetchImpl }),
        fetchFredSeries(FRED_VIX, cosd, { fetchImpl }),
      ]);
      upsertDailySeries(FRED_SP500, sp500, now);
      upsertDailySeries(FRED_VIX, vix, now);
      return { sp500, vix, source: 'fred' };
    } catch (err) {
      journalOncePerDay(ML_REGIME_FETCH_FAILED_ACTION, today, {
        error: err instanceof Error ? err.message : String(err),
        note: 'falling back to the cached FRED rows, then to the provider',
      });
    }
    const cachedSp = getDailySeries(FRED_SP500, { since: cosd });
    const cachedVix = getDailySeries(FRED_VIX, { since: cosd });
    const cachedAsOf = cachedSp.length && cachedVix.length ? minDate(cachedSp, cachedVix) : null;
    if (cachedAsOf !== null && !isReadingStale(cachedAsOf, today)) {
      return { sp500: cachedSp, vix: cachedVix, source: 'cache' };
    }
    const fallback = await providerSeries().catch(() => null);
    if (fallback === 'synthetic') {
      return {
        sp500: cachedSp,
        vix: cachedVix,
        source: cachedAsOf === null ? 'none' : 'cache',
        reason: 'synthetic_provider',
      };
    }
    if (fallback) return { ...fallback, source: 'provider' };
    return { sp500: cachedSp, vix: cachedVix, source: cachedAsOf === null ? 'none' : 'cache', reason: 'fetch_failed' };
  }
  const fallback = await providerSeries();
  if (fallback === 'synthetic') return { sp500: [], vix: [], source: 'none', reason: 'synthetic_provider' };
  return { ...fallback, source: 'provider' };
}

function minDate(a: readonly SeriesPoint[], b: readonly SeriesPoint[]): string {
  const la = a[a.length - 1].date;
  const lb = b[b.length - 1].date;
  return la < lb ? la : lb;
}

/**
 * Today's regime reading. Cached per ET day; refetches at most hourly while
 * either series still lacks the previous session's close; `force` refetches
 * now. Never throws — every failure is an `unknown` reading with a reason.
 */
export async function getMarketRegime(opts: GetMarketRegimeOptions = {}): Promise<MlRegimeReading> {
  const now = opts.now ?? Date.now();
  const today = etToday(now);
  const source = opts.source ?? config.mlRegime.source;
  const devOverride = opts.devOverride ?? config.mlRegime.devOverride;
  const model = opts.model === undefined ? loadRegimeModel() : opts.model;

  if (source === 'off') return unknownReading(today, 'source_off', 'off', now, model);

  if (devOverride && isMlRegimeLabel(devOverride)) {
    const reading: MlRegimeReading = {
      ...unknownReading(today, 'no_data', 'override', now, model),
      regime: devOverride,
      label: ML_REGIME_LABELS[devOverride],
      candidate: devOverride,
      asOf: today,
      stale: false,
      reason: undefined,
    };
    delete reading.reason;
    persistAndJournal(reading, today, now);
    return reading;
  }

  if (!model) return unknownReading(today, 'no_model', 'none', now, null);

  if (!opts.force) {
    if (cache?.etDate === today && (seriesComplete(today) || now - lastFetchAt < REFRESH_INTERVAL_MS)) {
      return cache.reading;
    }
    if (!cache && seriesComplete(today)) {
      const persisted = getMlRegimeReading<MlRegimeReading>(today);
      if (persisted && persisted.modelVersion === model.version) {
        cache = { etDate: today, reading: persisted.reading };
        return persisted.reading;
      }
    }
  }

  lastFetchAt = now;
  let series: SeriesResult;
  try {
    series = await loadSeries(today, source, now, opts.fetchImpl);
  } catch (err) {
    journalOncePerDay(ML_REGIME_FETCH_FAILED_ACTION, today, {
      error: err instanceof Error ? err.message : String(err),
    });
    series = { sp500: [], vix: [], source: 'none', reason: 'fetch_failed' };
  }

  const rows = buildFeatures(series.sp500, series.vix);
  const previous = getPreviousKnownMlRegime(today);
  // The switch threshold is a config field (mlRegimeSwitchThreshold), read on
  // every classification whether or not the overlay is on: it shapes the
  // reading itself, which is displayed and stamped regardless.
  const threshold = opts.threshold ?? getAutotradeConfig().mlRegimeSwitchThreshold;
  const classification = classifyFromFeatures(model, rows, previous, threshold);
  let reading: MlRegimeReading;
  if (!classification) {
    reading = { ...unknownReading(today, series.reason ?? 'no_data', series.source, now, model), previous };
  } else {
    const stale = isReadingStale(classification.asOf, today);
    const regime: MlRegime = stale ? 'unknown' : classification.regime;
    reading = {
      regime,
      label: ML_REGIME_LABELS[regime],
      candidate: classification.candidate,
      probabilities: classification.probabilities,
      predictedNext: classification.predictedNext,
      asOf: classification.asOf,
      etDate: today,
      features: classification.features,
      source: series.source,
      stale,
      drift: classification.drift,
      driftScore: classification.driftScore,
      driftP5: model.drift.p5,
      modelVersion: model.version,
      switched: !stale && classification.switched,
      heldBelowThreshold: classification.heldBelowThreshold,
      threshold,
      previous,
      rows: classification.rows,
      logLikelihood: classification.logLikelihood,
      computedAt: now,
      ...(stale ? { reason: 'stale' as const } : series.reason ? { reason: series.reason } : {}),
    };
  }
  persistAndJournal(reading, today, now);
  cache = { etDate: today, reading };
  return reading;
}

function persistAndJournal(reading: MlRegimeReading, today: string, now: number): void {
  saveMlRegimeReading(
    { etDate: today, regime: reading.regime, asOf: reading.asOf, reading, modelVersion: reading.modelVersion },
    now,
  );
  if (reading.source === 'override') {
    journalOncePerDay(ML_REGIME_OVERRIDE_ACTION, today, {
      regime: reading.regime,
      note: 'ML_REGIME_DEV_OVERRIDE is set — not a model reading',
    });
    return;
  }
  if (reading.regime !== 'unknown') {
    journalOncePerDay(ML_REGIME_READ_ACTION, today, {
      regime: reading.regime,
      label: reading.label,
      probabilities: reading.probabilities,
      asOf: reading.asOf,
      source: reading.source,
      drift: reading.drift,
      previous: reading.previous,
    });
  }
  if (reading.switched && reading.regime !== 'unknown') {
    journalOncePerDay(
      ML_REGIME_CHANGED_ACTION,
      today,
      { from: reading.previous, to: reading.regime, probabilities: reading.probabilities, asOf: reading.asOf },
      reading.regime,
    );
  }
  if (reading.drift) {
    journalOncePerDay(ML_REGIME_DRIFT_ACTION, today, {
      driftScore: reading.driftScore,
      driftP5: reading.driftP5,
      regime: reading.regime,
      note: 'trailing likelihood below the training 5th percentile — the model no longer describes the tape; retrain (docs/MARKET_REGIME_MODEL.md)',
    });
  }
}

/** Today's reading if one exists (cache, then the persisted row) — never fetches. */
export function peekMarketRegime(now: number = Date.now()): MlRegimeReading | null {
  const today = etToday(now);
  if (cache?.etDate === today) return cache.reading;
  const persisted = getMlRegimeReading<MlRegimeReading>(today);
  return persisted?.reading ?? null;
}
