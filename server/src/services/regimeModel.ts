import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DATA_DIR } from '../util/paths';
import { HmmParams, REGIME_FEATURES } from './hmmForward';

// ---------------------------------------------------------------------------
// The shipped market-regime model — server/data/regimeModel.json — and the
// out-of-sample regime history the backtest reads, server/data/regimeHistory.json.
//
// Both are produced offline by the Python package under ml/ (see
// docs/MARKET_REGIME_MODEL.md) and copied into the image with the rest of
// server/data, exactly like sp500.json. Loaded once, validated with zod, and
// NEVER thrown from: a missing or corrupt artifact makes every reading
// `unknown` (the overlay fails open) with one console warning, rather than
// taking the loop down. The zod schema checks what the Python exporter
// promises — three distinct labels, stochastic rows, symmetric precisions —
// so a hand-edited file cannot half-load.
// ---------------------------------------------------------------------------

export const ML_REGIMES = ['high_vol_bearish', 'low_vol_bullish', 'sideways'] as const;
export type MlRegimeLabel = (typeof ML_REGIMES)[number];
/** `unknown` = no model, no data, stale data, or the overlay switched off. */
export type MlRegime = MlRegimeLabel | 'unknown';

/** The labels in the operator's words. "Bearish" is the state's fitted mean
 *  drift over the training window — not a forecast of direction. */
export const ML_REGIME_LABELS: Record<MlRegime, string> = {
  high_vol_bearish: 'High Volatility/Bearish',
  low_vol_bullish: 'Low Volatility/Bullish',
  sideways: 'Sideways',
  unknown: 'Unknown',
};

export function isMlRegimeLabel(value: unknown): value is MlRegimeLabel {
  return typeof value === 'string' && (ML_REGIMES as readonly string[]).includes(value);
}

const vector3 = z.array(z.number()).length(3);
const matrix3 = z.array(vector3).length(3);

const regimeStateSchema = z.object({
  index: z.number().int().min(0).max(2),
  label: z.enum(ML_REGIMES),
  mean: vector3,
  precision: matrix3,
  logDet: z.number(),
  rawMean: z.object({ ret: z.number(), logVix: z.number(), logRv20: z.number() }),
  expectedDwellSessions: z.number(),
});

export const regimeModelSchema = z
  .object({
    version: z.string().min(1),
    modelType: z.literal('GaussianHMM'),
    nStates: z.literal(3),
    covarianceType: z.literal('full'),
    features: z.array(z.enum(REGIME_FEATURES)).length(3),
    scaler: z.object({ mean: vector3, scale: z.array(z.number().positive()).length(3) }),
    startprob: z.array(z.number().min(0)).length(3),
    transmat: z.array(z.array(z.number().min(0)).length(3)).length(3),
    stationary: vector3.optional(),
    states: z.array(regimeStateSchema).length(3),
    inferenceWindow: z.number().int().positive(),
    switchThresholdDefault: z.number().min(0).max(1),
    training: z.object({
      trainingStart: z.string(),
      trainedThrough: z.string(),
      retrainBy: z.string(),
      nObs: z.number().int().positive(),
      seed: z.number().int(),
      converged: z.boolean(),
      logLikelihood: z.number(),
      dataSha256: z.string(),
      hmmlearnVersion: z.string(),
      sklearnVersion: z.string(),
      numpyVersion: z.string(),
      pythonVersion: z.string(),
      trainedAt: z.string(),
    }),
    drift: z.object({ window: z.number().int().positive(), p5: z.number(), median: z.number() }),
  })
  .superRefine((m, ctx) => {
    const sums = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
    if (Math.abs(sums(m.startprob) - 1) > 1e-6) ctx.addIssue({ code: 'custom', message: 'startprob must sum to 1' });
    m.transmat.forEach((row, i) => {
      if (Math.abs(sums(row) - 1) > 1e-6) ctx.addIssue({ code: 'custom', message: `transmat row ${i} must sum to 1` });
    });
    if (new Set(m.features).size !== 3) ctx.addIssue({ code: 'custom', message: 'features must be distinct' });
    if (m.states.some((s, k) => s.index !== k))
      ctx.addIssue({ code: 'custom', message: 'states must be in index order 0..2' });
    if (new Set(m.states.map((s) => s.label)).size !== 3) {
      ctx.addIssue({ code: 'custom', message: 'the three states must carry three distinct labels' });
    }
    for (const s of m.states) {
      for (let i = 0; i < 3; i += 1) {
        for (let j = i + 1; j < 3; j += 1) {
          if (Math.abs(s.precision[i][j] - s.precision[j][i]) > 1e-8) {
            ctx.addIssue({ code: 'custom', message: `state ${s.index} precision is not symmetric` });
            return;
          }
        }
      }
    }
  });

export type RegimeModel = z.infer<typeof regimeModelSchema>;

export const REGIME_MODEL_FILE = path.join(DATA_DIR, 'regimeModel.json');
export const REGIME_FIXTURE_FILE = path.join(DATA_DIR, 'regimeModel.fixture.json');
export const REGIME_HISTORY_FILE = path.join(DATA_DIR, 'regimeHistory.json');

/** Parse one artifact file. Null (never a throw) when it is absent or invalid;
 *  the reason goes to `console.warn` once per call — callers memoize. */
export function loadRegimeModelFrom(file: string): RegimeModel | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    console.warn(`[regimeModel] no model at ${file} — ML regime readings will be unknown`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[regimeModel] ${file} is not JSON (${(e as Error).message}) — ML regime readings will be unknown`);
    return null;
  }
  const result = regimeModelSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    console.warn(
      `[regimeModel] ${file} failed validation at ${first?.path.join('.') || '(root)'}: ${first?.message} — ML regime readings will be unknown`,
    );
    return null;
  }
  return result.data;
}

let modelCache: { model: RegimeModel | null } | null = null;

/** The shipped model, loaded and validated once per process. */
export function loadRegimeModel(): RegimeModel | null {
  if (!modelCache) modelCache = { model: loadRegimeModelFrom(REGIME_MODEL_FILE) };
  return modelCache.model;
}

/** Tests only: forget the memoized model (and history) so a test can point at
 *  another file or a corrupted one. */
export function resetRegimeModelCache(): void {
  modelCache = null;
  historyCache = null;
}

/** The forward filter's view of the model: state parameters in index order. */
export function hmmParamsOf(model: RegimeModel): HmmParams {
  return {
    startprob: model.startprob,
    transmat: model.transmat,
    states: model.states.map((s) => ({ mean: s.mean, precision: s.precision, logDet: s.logDet })),
  };
}

/** Which label state `k` carries. */
export function labelOfState(model: RegimeModel, k: number): MlRegimeLabel {
  return model.states[k].label;
}

// --- the out-of-sample history (backtest only) ------------------------------

export interface RegimeHistoryDay {
  /** The sticky-path regime the runtime would have read with data through this date. */
  regime: MlRegimeLabel;
  /** The argmax posterior's label, before the sticky rule. */
  argmax: MlRegimeLabel;
  /** Filtered posterior by label. */
  p: Record<MlRegimeLabel, number>;
  held: boolean;
  switched: boolean;
  drift: boolean;
  driftScore: number | null;
  /** The refit (YYYY-MM-DD) whose model classified this date. */
  refit: string;
}

export interface RegimeHistory {
  version: string;
  method: string;
  from: string;
  to: string;
  /** Keyed by DATA date — the backtest shifts one session for publication. */
  days: Record<string, RegimeHistoryDay>;
}

const historyDaySchema = z.object({
  regime: z.enum(ML_REGIMES),
  argmax: z.enum(ML_REGIMES),
  p: z.object({ high_vol_bearish: z.number(), low_vol_bullish: z.number(), sideways: z.number() }),
  held: z.boolean(),
  switched: z.boolean(),
  drift: z.boolean(),
  driftScore: z.number().nullable(),
  refit: z.string(),
});

const regimeHistorySchema = z.object({
  version: z.string().min(1),
  method: z.string(),
  from: z.string(),
  to: z.string(),
  days: z.record(z.string(), historyDaySchema),
});

let historyCache: { history: RegimeHistory | null } | null = null;

export function loadRegimeHistoryFrom(file: string): RegimeHistory | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[regimeModel] no regime history at ${file} (${(e as Error).message})`);
    return null;
  }
  const result = regimeHistorySchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    console.warn(`[regimeModel] ${file} failed validation at ${first?.path.join('.') || '(root)'}: ${first?.message}`);
    return null;
  }
  return result.data;
}

/** The walk-forward history, loaded once; null when absent or invalid. */
export function loadRegimeHistory(): RegimeHistory | null {
  if (!historyCache) historyCache = { history: loadRegimeHistoryFrom(REGIME_HISTORY_FILE) };
  return historyCache.history;
}
