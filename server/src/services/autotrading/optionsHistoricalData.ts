import { fetchPolygonOptionContracts, OptionContractRef } from './polygonOptionsClient';
import {
  getCachedContracts,
  isExpirationRangeFetched,
  logFetchedExpirationRange,
  saveContracts,
} from '../../db/backtestOptionContracts';

// ---------------------------------------------------------------------------
// Historical option CONTRACT reference data for the backtest harness: served
// from the local cache when it already covers the requested expiration
// range, else fetched from Polygon and cached (docs/AUTOTRADING_SPEC.md,
// Phase 11) — same cache-or-fetch shape as historicalData.ts's
// getHistoricalBars, just keyed by expiration-date range instead of a
// trading-day range. A contract's own PRICE history, once its ticker is
// known, is fetched via historicalData.ts's getHistoricalBars() UNCHANGED
// (an options ticker works there exactly like a stock symbol) — this file
// only covers "which contracts existed," not their prices.
// ---------------------------------------------------------------------------

/**
 * Every option contract for `underlying` with expiration in
 * [fromExpiration, toExpiration] (YYYY-MM-DD, inclusive). Fetches from
 * Polygon only when no prior fetch already covered this range.
 */
export async function getHistoricalOptionContracts(
  underlying: string,
  fromExpiration: string,
  toExpiration: string,
): Promise<OptionContractRef[]> {
  if (!isExpirationRangeFetched(underlying, fromExpiration, toExpiration)) {
    const fresh = await fetchPolygonOptionContracts(underlying, fromExpiration, toExpiration);
    saveContracts(underlying, fresh);
    logFetchedExpirationRange(underlying, fromExpiration, toExpiration);
  }

  return getCachedContracts(underlying, fromExpiration, toExpiration);
}
