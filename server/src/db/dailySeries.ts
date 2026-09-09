import { db } from './index';

// ---------------------------------------------------------------------------
// Daily closes of the two FRED series the market-regime model reads (SP500,
// VIXCLS) — services/mlRegime.ts's cache, so a day's reading costs one FRED
// fetch and a FRED outage falls back to the rows already here rather than to
// nothing. FRED rows ONLY: a provider-fallback reading (^GSPC/^VIX candles) is
// marked in the reading and never written here, because the model was trained
// on FRED's numbers and a mixed table would silently feed it a different
// series (docs/MARKET_REGIME_MODEL.md, "Data").
// ---------------------------------------------------------------------------

export interface DailySeriesPoint {
  date: string;
  value: number;
}

interface Row {
  date: string;
  value: number;
}

/** Insert-or-replace a batch of closes for one series (last write wins). */
export function upsertDailySeries(
  seriesId: string,
  points: readonly DailySeriesPoint[],
  now: number = Date.now(),
): void {
  const stmt = db.prepare(
    `INSERT INTO daily_series (series_id, date, value, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_id, date) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
  );
  const tx = db.transaction((rows: readonly DailySeriesPoint[]) => {
    for (const p of rows) stmt.run(seriesId, p.date, p.value, now);
  });
  tx(points);
}

/** Every stored close of a series, oldest first, optionally from `since`
 *  (YYYY-MM-DD, inclusive) and/or through `until` (inclusive). */
export function getDailySeries(seriesId: string, opts: { since?: string; until?: string } = {}): DailySeriesPoint[] {
  const clauses = ['series_id = ?'];
  const params: unknown[] = [seriesId];
  if (opts.since) {
    clauses.push('date >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    clauses.push('date <= ?');
    params.push(opts.until);
  }
  const rows = db
    .prepare(`SELECT date, value FROM daily_series WHERE ${clauses.join(' AND ')} ORDER BY date ASC`)
    .all(...params) as Row[];
  return rows.map((r) => ({ date: r.date, value: r.value }));
}

/** The newest stored date of a series, or null when nothing is stored. */
export function latestDailySeriesDate(seriesId: string): string | null {
  const row = db.prepare('SELECT MAX(date) AS date FROM daily_series WHERE series_id = ?').get(seriesId) as
    { date: string | null } | undefined;
  return row?.date ?? null;
}
