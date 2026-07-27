import { config } from '../../config';
import { Candle, Timeframe } from '../../providers/types';

// ---------------------------------------------------------------------------
// Polygon.io (rebranded Massive.com, same account/API) historical aggregates
// client, for the backtest + walk-forward harness ONLY (docs/AUTOTRADING_SPEC.md
// — Phase 5). Never used for live screening or quotes — see config.polygon.
//
// https://api.polygon.io/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
// `adjusted=true` — split/dividend-adjusted, so a backtest doesn't see fake
// gaps around corporate actions. Auth via `Authorization: Bearer <key>`.
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.polygon.io';
/** Hard cap on paginated pages (50 × the 50,000-row limit = 2.5M bars) — far
 *  beyond any realistic single-symbol pull; a backstop against a runaway loop
 *  if `next_url` ever misbehaves, not a real limit in practice. */
const MAX_PAGES = 50;

export class PolygonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PolygonError';
  }
}

interface PolygonBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Unix ms epoch, start of the bar. */
  t: number;
}

interface PolygonAggsResponse {
  results?: PolygonBar[];
  next_url?: string;
  status?: string;
  error?: string;
  message?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Max 429 retries per page — at the free tier's 5 req/min, a long multi-page
 *  fetch WILL hit the limiter repeatedly; failing the whole backtest on the
 *  first 429 made any sizable options-contract fetch effectively impossible. */
const MAX_RATE_LIMIT_RETRIES = 8;
const DEFAULT_RATE_LIMIT_WAIT_S = 15;

/**
 * GET one Polygon JSON page with Bearer auth, retrying HTTP 429 with a
 * backoff that honors Retry-After when present. Throws PolygonError on any
 * other non-ok response (or when the retries run out). Shared by the bar and
 * option-contract clients so both survive rate-limited multi-page fetches.
 */
export async function fetchPolygonPage<T extends { error?: string; message?: string }>(
  url: string,
  apiKey: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const waitS = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : DEFAULT_RATE_LIMIT_WAIT_S;
      await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
      continue;
    }
    const body = (await res.json()) as T;
    if (!res.ok) {
      throw new PolygonError(body.error || body.message || `Polygon request failed (${res.status})`, res.status);
    }
    return body;
  }
}

function mapBar(b: PolygonBar, timeframe: Timeframe): Candle {
  // Polygon stamps a daily/weekly aggregate's `t` at midnight EASTERN — 04:00
  // or 05:00 UTC depending on DST — while the backtest engines iterate
  // calendar days at midnight UTC and match bars to days by EXACT equality
  // (backtest.ts's `candles[idx].time !== dayMs` guard). Un-normalized, a real
  // Polygon daily bar therefore never matches its own trading day and the
  // whole simulation silently no-ops: zero trades, zero errors. Floor
  // day-level timeframes to UTC midnight of the same calendar date (midnight
  // ET is always later than midnight UTC, so the date is unchanged); intraday
  // bars keep their real timestamps.
  const time = timeframe === 'daily' || timeframe === 'weekly' ? b.t - (b.t % DAY_MS) : b.t;
  return { time, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
}

function timespanFor(timeframe: Timeframe): { multiplier: number; timespan: string } {
  switch (timeframe) {
    case '1min':
      return { multiplier: 1, timespan: 'minute' };
    case '5min':
      return { multiplier: 5, timespan: 'minute' };
    case '15min':
      return { multiplier: 15, timespan: 'minute' };
    case 'daily':
      return { multiplier: 1, timespan: 'day' };
    case 'weekly':
      return { multiplier: 1, timespan: 'week' };
  }
}

/**
 * Fetch historical aggregate bars for `symbol` between `from`/`to`
 * (YYYY-MM-DD, inclusive), paginating via `next_url` until exhausted.
 * Throws PolygonError if POLYGON_API_KEY is unset or the request fails.
 */
export async function fetchPolygonBars(
  symbol: string,
  timeframe: Timeframe,
  from: string,
  to: string,
): Promise<Candle[]> {
  const apiKey = config.polygon.apiKey;
  if (!apiKey) {
    throw new PolygonError('POLYGON_API_KEY is not set — required for the backtest harness (see docs/DEPLOY.md).');
  }

  const { multiplier, timespan } = timespanFor(timeframe);
  let url: string | undefined =
    `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/${multiplier}/${timespan}/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000`;

  const bars: Candle[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    // Explicitly annotated — inferring it would circle through `url`'s own
    // control-flow narrowing (TS7022), since `url` is reassigned from `body`.
    const body: PolygonAggsResponse = await fetchPolygonPage<PolygonAggsResponse>(url, apiKey);
    for (const bar of body.results ?? []) bars.push(mapBar(bar, timeframe));
    url = body.next_url || undefined;
  }
  return bars;
}
