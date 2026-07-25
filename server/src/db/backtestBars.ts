import { db } from './index';
import { Candle, Timeframe } from '../providers/types';

// ---------------------------------------------------------------------------
// Local cache of historical bars for the backtest harness (docs/AUTOTRADING_SPEC.md
// — Phase 5). A walk-forward run re-queries the same symbol/period repeatedly;
// this avoids re-fetching from Polygon/Massive every time.
// ---------------------------------------------------------------------------

interface BarRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function mapRow(r: BarRow): Candle {
  return { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
}

/** Cached bars for symbol+timeframe within [fromMs, toMs] inclusive, ascending. */
export function getCachedBars(symbol: string, timeframe: Timeframe, fromMs: number, toMs: number): Candle[] {
  const rows = db
    .prepare(
      `SELECT time, open, high, low, close, volume FROM backtest_bars
       WHERE symbol = ? AND timeframe = ? AND time >= ? AND time <= ?
       ORDER BY time ASC`,
    )
    .all(symbol.toUpperCase(), timeframe, fromMs, toMs) as BarRow[];
  return rows.map(mapRow);
}

/** Upsert bars into the cache — idempotent, safe to call with overlapping ranges. */
export function saveBars(symbol: string, timeframe: Timeframe, bars: Candle[]): void {
  if (!bars.length) return;
  const sym = symbol.toUpperCase();
  const insert = db.prepare(
    `INSERT INTO backtest_bars (symbol, timeframe, time, open, high, low, close, volume)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume`,
  );
  const tx = db.transaction((items: Candle[]) => {
    for (const bar of items) insert.run(sym, timeframe, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume);
  });
  tx(bars);
}

/** Earliest/latest cached bar time for symbol+timeframe, or null if nothing cached. */
export function cachedRange(symbol: string, timeframe: Timeframe): { min: number; max: number } | null {
  const row = db
    .prepare('SELECT MIN(time) AS min, MAX(time) AS max FROM backtest_bars WHERE symbol = ? AND timeframe = ?')
    .get(symbol.toUpperCase(), timeframe) as { min: number | null; max: number | null };
  return row.min !== null && row.max !== null ? { min: row.min, max: row.max } : null;
}

/** True if a PRIOR fetch already covered [from, to] (YYYY-MM-DD) for
 *  symbol+timeframe — i.e. some logged fetch's own range fully contains this
 *  one. String comparison is safe here: YYYY-MM-DD sorts lexicographically =
 *  chronologically. */
export function isRangeFetched(symbol: string, timeframe: Timeframe, from: string, to: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM backtest_fetch_log
       WHERE symbol = ? AND timeframe = ? AND from_date <= ? AND to_date >= ? LIMIT 1`,
    )
    .get(symbol.toUpperCase(), timeframe, from, to);
  return !!row;
}

/** Record that [from, to] was fetched, so a later request for the same (or a
 *  narrower) range can skip re-fetching. */
export function logFetchedRange(symbol: string, timeframe: Timeframe, from: string, to: string): void {
  db.prepare(
    'INSERT INTO backtest_fetch_log (symbol, timeframe, from_date, to_date, fetched_at) VALUES (?,?,?,?,?)',
  ).run(symbol.toUpperCase(), timeframe, from, to, Date.now());
}
