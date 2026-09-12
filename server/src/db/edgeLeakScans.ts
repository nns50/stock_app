import { db } from './index';
import { etToday } from '../util/marketDate';
import type { EdgeLeakScanResult } from '../services/autotrading/edgeLeakScan';

// ---------------------------------------------------------------------------
// The last edge-leak scan, persisted (2026-09-12).
//
// The scan is on-demand — a route and the daily routine — because a per-bucket
// bootstrap over both books is real CPU and the dashboard is polled every few
// seconds. So the dashboard reads the LAST scan rather than running one, the
// same arrangement the daily-target sweep already uses. One row: "what did the
// most recent scan find" is the only question the card asks, and the full
// result travels with it so a reader can open the whole catalog without
// re-running the scan over a book that has since moved.
// ---------------------------------------------------------------------------

export interface EdgeLeakScanRecord {
  etDate: string;
  leaks: number;
  watches: number;
  findings: number;
  result: EdgeLeakScanResult;
  createdAt: number;
}

interface Row {
  et_date: string;
  leaks: number;
  watches: number;
  findings: number;
  result: string;
  created_at: number;
}

export function saveEdgeLeakScan(result: EdgeLeakScanResult): void {
  db.prepare(
    `INSERT INTO edge_leak_scans (id, et_date, leaks, watches, findings, result, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       et_date = excluded.et_date, leaks = excluded.leaks, watches = excluded.watches,
       findings = excluded.findings, result = excluded.result, created_at = excluded.created_at`,
  ).run(
    etToday(result.asOf),
    result.leaks.length,
    result.watches.length,
    result.findings.length,
    JSON.stringify(result),
    result.asOf,
  );
}

/** Null when no scan has ever run, or when the stored JSON cannot be parsed —
 *  a corrupt row reads as "no scan yet" rather than throwing on the dashboard
 *  poll path, which is the one place a stored blob must never be able to take
 *  the whole page down. */
export function getLastEdgeLeakScan(): EdgeLeakScanRecord | null {
  const row = db.prepare('SELECT * FROM edge_leak_scans WHERE id = 1').get() as Row | undefined;
  if (!row) return null;
  let result: EdgeLeakScanResult;
  try {
    result = JSON.parse(row.result) as EdgeLeakScanResult;
  } catch {
    return null;
  }
  return {
    etDate: row.et_date,
    leaks: row.leaks,
    watches: row.watches,
    findings: row.findings,
    result,
    createdAt: row.created_at,
  };
}
