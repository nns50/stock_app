import { db } from './index';
import type { ShortShadowReport } from '../services/autotrading/shortShadowRecordData';

// ---------------------------------------------------------------------------
// The last short shadow record, persisted (2026-09-19).
//
// The record replays every declined short on provider bars — one fetch per
// live-eligible symbol-day — so it is computed once per session, after the
// close, by the loop (shortShadowRecordData.ts), and the gated-switch engine
// reads the stored fact. Same arrangement as edge_leak_scans, for the same
// reason: the reader polls or ticks far more often than the number can be
// recomputed. One row: "what did the last replay say" is the only question the
// `shorts` switch asks, and the whole report travels with it so a reader can
// open the trades behind the three numbers.
// ---------------------------------------------------------------------------

export interface ShortShadowRecordRow {
  /** The session the record was computed after. */
  etDate: string;
  report: ShortShadowReport;
  createdAt: number;
}

interface Row {
  et_date: string;
  report: string;
  created_at: number;
}

export function saveShortShadowRecord(etDate: string, report: ShortShadowReport, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO short_shadow_records (id, et_date, report, created_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       et_date = excluded.et_date, report = excluded.report, created_at = excluded.created_at`,
  ).run(etDate, JSON.stringify(report), now);
}

/** Null when no record has been computed yet, or when the stored JSON cannot
 *  be parsed — a corrupt row reads as "no record yet" rather than throwing on
 *  the after-close tick or the dashboard poll. */
export function getLastShortShadowRecord(): ShortShadowRecordRow | null {
  const row = db.prepare('SELECT * FROM short_shadow_records WHERE id = 1').get() as Row | undefined;
  if (!row) return null;
  let report: ShortShadowReport;
  try {
    report = JSON.parse(row.report) as ShortShadowReport;
  } catch {
    return null;
  }
  return { etDate: row.et_date, report, createdAt: row.created_at };
}
