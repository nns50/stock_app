import { Candle, Timeframe } from '../../providers/types';
import { fetchPolygonBars } from './polygonClient';
import { getCachedBars, isRangeFetched, logFetchedRange, saveBars } from '../../db/backtestBars';

// ---------------------------------------------------------------------------
// Historical bars for the backtest harness: served from the local cache when
// it already fully covers the requested range, else fetched from Polygon and
// cached. Decoupled from the app's live MarketDataProvider — this is a
// separate concern (see docs/AUTOTRADING_SPEC.md's "Fit with the current
// codebase" section on backtest data being intentionally decoupled from live
// scanning).
// ---------------------------------------------------------------------------

function startOfDayMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00Z`);
}

function endOfDayMs(dateStr: string): number {
  return Date.parse(`${dateStr}T23:59:59.999Z`);
}

/**
 * Historical bars for `symbol`/`timeframe` over [from, to] (YYYY-MM-DD,
 * inclusive). Fetches from Polygon only when no prior fetch already covered
 * this range (tracked explicitly in backtest_fetch_log — the data's own
 * min/max bar time can't be used for this check, since trading data has gaps
 * around weekends/holidays that never align exactly with a requested
 * calendar boundary).
 */
export async function getHistoricalBars(
  symbol: string,
  timeframe: Timeframe,
  from: string,
  to: string,
): Promise<Candle[]> {
  if (!isRangeFetched(symbol, timeframe, from, to)) {
    const fresh = await fetchPolygonBars(symbol, timeframe, from, to);
    saveBars(symbol, timeframe, fresh);
    logFetchedRange(symbol, timeframe, from, to);
  }

  return getCachedBars(symbol, timeframe, startOfDayMs(from), endOfDayMs(to));
}
