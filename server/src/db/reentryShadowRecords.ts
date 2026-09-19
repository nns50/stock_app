import { db } from './index';
import type { ReentryShadowReport } from '../services/autotrading/reentryShadowRecordData';

// ---------------------------------------------------------------------------
// The last re-entry cooldown shadow record, persisted (2026-09-19).
//
// The record replays every symbol-day the live re-entry cooldown refused at
// four gaps after the exit — one bar fetch per symbol-day — so it is computed
// once per session, after the close, by the loop (reentryShadowRecordData.ts),
// and the leak scan's cooldown finding reads the stored fact. Same arrangement
// as short_shadow_records, for the same reason: the reader runs far more often
// than the number can be recomputed. One row: "what did the last replay say"
// is the only question the finding asks, and the whole report travels with it
// so a reader can open the trades behind each gap's numbers.
// ---------------------------------------------------------------------------

export interface ReentryShadowRecordRow {
  /** The session the record was computed after. */
  etDate: string;
  report: ReentryShadowReport;
  createdAt: number;
}

interface Row {
  et_date: string;
  report: string;
  created_at: number;
}

export function saveReentryShadowRecord(etDate: string, report: ReentryShadowReport, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO reentry_shadow_records (id, et_date, report, created_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       et_date = excluded.et_date, report = excluded.report, created_at = excluded.created_at`,
  ).run(etDate, JSON.stringify(report), now);
}

/** Null when no record has been computed yet, or when the stored JSON cannot
 *  be parsed — a corrupt row reads as "no record yet" rather than throwing on
 *  the after-close tick or the scan. */
export function getLastReentryShadowRecord(): ReentryShadowRecordRow | null {
  const row = db.prepare('SELECT * FROM reentry_shadow_records WHERE id = 1').get() as Row | undefined;
  if (!row) return null;
  let report: ReentryShadowReport;
  try {
    report = JSON.parse(row.report) as ReentryShadowReport;
  } catch {
    return null;
  }
  return { etDate: row.et_date, report, createdAt: row.created_at };
}
