import { config } from '../../config';
import { fetchPolygonPage, PolygonError } from './polygonClient';

// ---------------------------------------------------------------------------
// Polygon.io options CONTRACT REFERENCE data (which contracts — strike,
// expiration, type — existed for an underlying), for the options backtest
// harness ONLY (docs/AUTOTRADING_SPEC.md — Phase 11). A sibling to
// polygonClient.ts, not a modification of it: that file's fetchPolygonBars()
// is reused UNCHANGED for options PRICE history (Polygon's Aggregates
// endpoint is ticker-format-agnostic — an OCC-style options ticker works
// exactly like a stock symbol; see optionsHistoricalData.ts). This file is
// only for the genuinely new piece: discovering which contracts existed at
// all, which the Aggregates endpoint (built for an already-known ticker)
// can't answer.
//
// https://api.polygon.io/v3/reference/options/contracts
// ?underlying_ticker=X&expiration_date.gte=Y&expiration_date.lte=Z&limit=1000
// Same auth/pagination/error shape as polygonClient.ts's fetchPolygonBars.
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.polygon.io';
/** Same rationale as polygonClient.ts's MAX_PAGES — a backstop, not a real
 *  limit (1000/page is already generous for one underlying's contracts). */
const MAX_PAGES = 50;

export type OptionContractType = 'call' | 'put';

export interface OptionContractRef {
  /** Polygon's own contract ticker (e.g. "O:AAPL240315C00100000") — what
   *  fetchPolygonBars() is called with to get this contract's price history. */
  ticker: string;
  underlying: string;
  contractType: OptionContractType;
  strike: number;
  /** YYYY-MM-DD. */
  expiration: string;
}

interface PolygonContract {
  ticker: string;
  underlying_ticker: string;
  contract_type: string;
  strike_price: number;
  expiration_date: string;
}

interface PolygonContractsResponse {
  results?: PolygonContract[];
  next_url?: string;
  status?: string;
  error?: string;
  message?: string;
}

function mapContract(c: PolygonContract): OptionContractRef | null {
  // contract_type is documented as always 'call' | 'put' for standard listed
  // options; skip (don't throw) anything else rather than let one odd
  // instrument (e.g. a non-standard adjusted contract) fail the whole batch.
  if (c.contract_type !== 'call' && c.contract_type !== 'put') return null;
  return {
    ticker: c.ticker,
    underlying: c.underlying_ticker.toUpperCase(),
    contractType: c.contract_type,
    strike: c.strike_price,
    expiration: c.expiration_date,
  };
}

/**
 * Every option contract listed for `underlying` with an expiration date in
 * [fromExpiration, toExpiration] (YYYY-MM-DD, inclusive), paginating via
 * `next_url` until exhausted. Throws PolygonError if POLYGON_API_KEY is unset
 * or the request fails — same convention as fetchPolygonBars.
 *
 * Two passes, `expired=true` then `expired=false`, merged by ticker: Polygon's
 * contracts endpoint filters on `expired` and DEFAULTS to active-only, so a
 * single default-parameter query over a historical backtest window returns
 * none of the contracts that have already expired — which is nearly all of
 * them. That default made every options backtest over a historical window
 * silently simulate zero trades (no contract ever inside a simulated day's
 * DTE window; "no contracts" is not an error). The active pass still matters
 * for windows extending past today.
 */
export async function fetchPolygonOptionContracts(
  underlying: string,
  fromExpiration: string,
  toExpiration: string,
): Promise<OptionContractRef[]> {
  const apiKey = config.polygon.apiKey;
  if (!apiKey) {
    throw new PolygonError(
      'POLYGON_API_KEY is not set — required for the options backtest harness (see docs/DEPLOY.md).',
    );
  }

  const byTicker = new Map<string, OptionContractRef>();
  for (const expired of [true, false]) {
    let url: string | undefined =
      `${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(underlying.toUpperCase())}` +
      `&expiration_date.gte=${fromExpiration}&expiration_date.lte=${toExpiration}&expired=${expired}&limit=1000`;

    for (let page = 0; url && page < MAX_PAGES; page++) {
      // Explicitly annotated — same TS7022 inference-cycle avoidance as
      // fetchPolygonBars' own call site.
      const body: PolygonContractsResponse = await fetchPolygonPage<PolygonContractsResponse>(url, apiKey);
      for (const c of body.results ?? []) {
        const mapped = mapContract(c);
        if (mapped) byTicker.set(mapped.ticker, mapped);
      }
      url = body.next_url || undefined;
    }
  }
  return Array.from(byTicker.values());
}
