import { db } from './index';
import type { MlRegime } from '../services/regimeModel';

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

export interface MlRegimeReadingRow<T = unknown> {
  etDate: string;
  regime: MlRegime;
  /** The last data date the reading was computed from, or null. */
  asOf: string | null;
  reading: T;
  modelVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  et_date: string;
  regime: string;
  as_of: string | null;
  reading: string;
  model_version: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow<T>(r: Row): MlRegimeReadingRow<T> | null {
  try {
    return {
      etDate: r.et_date,
      regime: r.regime as MlRegime,
      asOf: r.as_of,
      reading: JSON.parse(r.reading) as T,
      modelVersion: r.model_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  } catch {
    return null;
  }
}

/** Insert or overwrite the reading for an ET day (a mid-morning refresh
 *  replaces the pre-open one; `createdAt` keeps the first write's time). */
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

/** Readings from `since` (inclusive) onward, oldest first — the transition
 *  count the enabling rule reads. */
export function listMlRegimeReadings<T = unknown>(
  opts: { since?: string; limit?: number } = {},
): MlRegimeReadingRow<T>[] {
  const rows = (
    opts.since
      ? db
          .prepare('SELECT * FROM ml_regime_readings WHERE et_date >= ? ORDER BY et_date ASC LIMIT ?')
          .all(opts.since, opts.limit ?? 1000)
      : db.prepare('SELECT * FROM ml_regime_readings ORDER BY et_date ASC LIMIT ?').all(opts.limit ?? 1000)
  ) as Row[];
  return rows.map((r) => fromRow<T>(r)).filter((r): r is MlRegimeReadingRow<T> => r !== null);
}
