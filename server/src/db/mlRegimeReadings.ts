import { db } from './index';
import type { MlRegime } from '../services/regimeModel';
import type { MlRegimeProbabilities } from '../services/mlRegime';

// ---------------------------------------------------------------------------
// One persisted market-regime reading per ET day (services/mlRegime.ts). The
// regime column holds the LABEL ('high_vol_bearish' | 'low_vol_bullish' |
// 'sideways' | 'unknown'), never a state index — a retrain can renumber the
// states, and the sticky switch that reads yesterday's regime from here must
// survive that. The full reading (probabilities, source, staleness, drift…)
// is kept as JSON beside it for the gauge and the journal.
//
// The sticky rule's "previous regime" is the newest KNOWN row before today
// (getPreviousKnownMlRegime): a day the model could not read (no data, stale,
// switched off) neither resets the regime nor counts as one.
// ---------------------------------------------------------------------------

/** What one side of a parity check said: the label, the data date and the
 *  three probabilities. The SERVER side also carries the sticky-switch inputs
 *  (`previous`, `threshold`) the Python side must be given to reproduce it. */
export interface MlRegimeParityVector {
  regime: MlRegime;
  asOf: string | null;
  probabilities: MlRegimeProbabilities | null;
}

/** The parity verdict stored on a reading (2026-09-10, enabling rule 3):
 *  what `regime:predict` submitted, what this row held WHEN it was compared,
 *  and how far apart they were. The readiness computation re-derives
 *  agreement from `server` against the row's CURRENT reading, so a verdict
 *  on a since-refreshed reading reads as unchecked rather than as agreed. */
export interface MlRegimeParityDetail {
  checkedAt: number;
  submitted: MlRegimeParityVector & { probabilities: MlRegimeProbabilities };
  server: MlRegimeParityVector & { previous: MlRegime | null; threshold: number | null };
  maxAbsDiff: number | null;
  reasons: string[];
}

export interface MlRegimeReadingRow<T = unknown> {
  etDate: string;
  regime: MlRegime;
  /** The last data date the reading was computed from, or null. */
  asOf: string | null;
  reading: T;
  modelVersion: string | null;
  /** Rule 3's verdict for this day, or null when no check has been recorded. */
  parityAgrees: boolean | null;
  parityDetail: MlRegimeParityDetail | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  et_date: string;
  regime: string;
  as_of: string | null;
  reading: string;
  model_version: string | null;
  parity_agrees: number | null;
  parity_detail: string | null;
  created_at: number;
  updated_at: number;
}

function parseParityDetail(text: string | null): MlRegimeParityDetail | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as MlRegimeParityDetail;
  } catch {
    return null;
  }
}

function fromRow<T>(r: Row): MlRegimeReadingRow<T> | null {
  try {
    return {
      etDate: r.et_date,
      regime: r.regime as MlRegime,
      asOf: r.as_of,
      reading: JSON.parse(r.reading) as T,
      modelVersion: r.model_version,
      parityAgrees: r.parity_agrees == null ? null : r.parity_agrees === 1,
      parityDetail: parseParityDetail(r.parity_detail),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  } catch {
    return null;
  }
}

/** Insert or overwrite the reading for an ET day (a mid-morning refresh
 *  replaces the pre-open one; `createdAt` keeps the first write's time). The
 *  parity columns are deliberately NOT in the update list: the verdict stays
 *  with the row, and the readiness computation decides whether it still
 *  describes the reading now stored there. */
export function saveMlRegimeReading<T>(
  input: { etDate: string; regime: MlRegime; asOf: string | null; reading: T; modelVersion: string | null },
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO ml_regime_readings (et_date, regime, as_of, reading, model_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(et_date) DO UPDATE SET regime = excluded.regime, as_of = excluded.as_of,
       reading = excluded.reading, model_version = excluded.model_version, updated_at = excluded.updated_at`,
  ).run(input.etDate, input.regime, input.asOf, JSON.stringify(input.reading), input.modelVersion, now, now);
}

/** Store rule 3's verdict on an existing reading; false when no reading exists
 *  for that day (nothing to compare against — the caller reports it). */
export function recordMlRegimeParity(
  etDate: string,
  verdict: { agrees: boolean; detail: MlRegimeParityDetail },
): boolean {
  const result = db
    .prepare('UPDATE ml_regime_readings SET parity_agrees = ?, parity_detail = ? WHERE et_date = ?')
    .run(verdict.agrees ? 1 : 0, JSON.stringify(verdict.detail), etDate);
  return result.changes > 0;
}

export function getMlRegimeReading<T = unknown>(etDate: string): MlRegimeReadingRow<T> | null {
  const row = db.prepare('SELECT * FROM ml_regime_readings WHERE et_date = ?').get(etDate) as Row | undefined;
  return row ? fromRow<T>(row) : null;
}

/** The newest reading on or before `etDate` (defaults to any). */
export function getLatestMlRegimeReading<T = unknown>(etDate?: string): MlRegimeReadingRow<T> | null {
  const row = (
    etDate
      ? db.prepare('SELECT * FROM ml_regime_readings WHERE et_date <= ? ORDER BY et_date DESC LIMIT 1').get(etDate)
      : db.prepare('SELECT * FROM ml_regime_readings ORDER BY et_date DESC LIMIT 1').get()
  ) as Row | undefined;
  return row ? fromRow<T>(row) : null;
}

/** The newest KNOWN regime strictly before `etDate` — the sticky switch's
 *  "previous"; null when no known reading exists before that day. */
export function getPreviousKnownMlRegime(beforeEtDate: string): MlRegime | null {
  const row = db
    .prepare(
      `SELECT regime FROM ml_regime_readings WHERE et_date < ? AND regime != 'unknown'
       ORDER BY et_date DESC LIMIT 1`,
    )
    .get(beforeEtDate) as { regime: string } | undefined;
  return row ? (row.regime as MlRegime) : null;
}

/** Readings from `since` through `until` (both inclusive, either optional),
 *  oldest first — the window the enabling rules are counted over
 *  (services/mlRegimeReadiness.ts). */
export function listMlRegimeReadings<T = unknown>(
  opts: { since?: string; until?: string; limit?: number } = {},
): MlRegimeReadingRow<T>[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.since) {
    where.push('et_date >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    where.push('et_date <= ?');
    params.push(opts.until);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM ml_regime_readings${clause} ORDER BY et_date ASC LIMIT ?`)
    .all(...params, opts.limit ?? 1000) as Row[];
  return rows.map((r) => fromRow<T>(r)).filter((r): r is MlRegimeReadingRow<T> => r !== null);
}
