import { config } from '../../config';
import { WebullClient } from './client';
import { normalizeRegion } from './hosts';

// Config-bound Webull access + a small read-only probe used to validate live
// credentials and surface real response shapes (so the data mappers are built
// from confirmed payloads, not guesses). All read-only.

export function webullConfigured(): boolean {
  return !!(config.webull.appKey && config.webull.appSecret);
}

export function webullStatus(): { configured: boolean; region: string; hasAccessToken: boolean } {
  return {
    configured: webullConfigured(),
    region: normalizeRegion(config.webull.region),
    hasAccessToken: !!config.webull.accessToken,
  };
}

/** Build a config-bound Webull client (shared by the probe and positions sync). */
export function webullClient(): WebullClient {
  return WebullClient.fromEnv({
    appKey: config.webull.appKey,
    appSecret: config.webull.appSecret,
    region: config.webull.region,
    apiHost: config.webull.apiHost,
    quotesHost: config.webull.quotesHost,
    accessToken: config.webull.accessToken,
  });
}

export type ProbeKind =
  | 'account-list'
  | 'snapshot'
  | 'bars'
  | 'movers'
  | 'depth'
  | 'option-snapshot'
  | 'positions'
  | 'balance'
  | 'open-orders'
  | 'order-history'
  | 'subscriptions';

export interface ProbeResult {
  ok: boolean;
  /** The exact URL called — handy for diagnosing host/path issues (e.g. 404s). */
  url?: string;
  status?: number;
  code?: string;
  data?: unknown;
  error?: string;
}

function probeCall(kind: ProbeKind, opts: { symbol?: string; accountId?: string }) {
  const c = webullClient();
  switch (kind) {
    case 'snapshot':
      return c.call('GET', '/openapi/market-data/stock/snapshot', {
        query: { symbols: (opts.symbol || 'AAPL').toUpperCase(), category: 'US_STOCK' },
        surface: 'market',
      });
    case 'bars':
      // A few 1-minute candles — just enough to confirm the bar field shape
      // (timestamps, OHLCV) before the candle mapper is written against it.
      return c.call('GET', '/openapi/market-data/stock/bars', {
        query: { symbol: (opts.symbol || 'AAPL').toUpperCase(), category: 'US_STOCK', timespan: 'M1', count: '5' },
        surface: 'market',
      });
    case 'movers':
      // Top daily gainers — confirms the screener/gainers-losers row shape
      // before the Market Movers feature is built against it.
      return c.call('GET', '/openapi/market-data/screener/gainers-losers', {
        query: {
          rank_type: 'DAY_1',
          category: 'US_STOCK',
          sort_by: 'CHANGE_RATIO',
          direction: 'DESC',
          page_size: '10',
        },
        surface: 'market',
      });
    case 'depth':
      // Bid/ask ladder — confirms the depth shape before the L2 panel. depth=1
      // (top of book) is all an LV1 quote plan allows; LV2 supports up to 50.
      return c.call('GET', '/openapi/market-data/stock/quotes', {
        query: { symbol: (opts.symbol || 'AAPL').toUpperCase(), category: 'US_STOCK', depth: '1' },
        surface: 'market',
      });
    case 'option-snapshot':
      // Real option quote (bid/ask/OI/volume) — needs a full OCC symbol in the
      // Symbol field (e.g. AAPL260522C00300000). Confirms the overlay shape.
      return c.call('GET', '/openapi/market-data/option/snapshot', {
        query: { symbols: (opts.symbol || '').toUpperCase(), category: 'US_OPTION' },
        surface: 'market',
      });
    case 'positions':
      return c.call('GET', '/openapi/assets/positions', { query: { account_id: opts.accountId! }, surface: 'trade' });
    case 'balance':
      return c.call('GET', '/openapi/assets/balance', {
        query: { account_id: opts.accountId!, total_asset_currency: 'USD' },
        surface: 'trade',
      });
    case 'open-orders':
      // READ-ONLY (GET). Confirms the live order-object shape from your real
      // open orders before any place/cancel path is built — places nothing.
      // Path confirmed from the Trading API Reference (/openapi/trade/order/*).
      return c.call('GET', '/openapi/trade/order/open', { query: { account_id: opts.accountId! }, surface: 'trade' });
    case 'order-history':
      // READ-ONLY (GET). Same as open-orders but over historical orders (useful
      // when there are no open orders right now). Places nothing.
      return c.call('GET', '/openapi/trade/order/history', {
        query: { account_id: opts.accountId! },
        surface: 'trade',
      });
    case 'subscriptions':
      // What market-data/quote subscriptions does Webull's OpenAPI actually see
      // for this app? The authoritative check for "I subscribed but still get a
      // 401" — an OpenAPI quote entitlement won't show here if only the mobile
      // app / desktop (QT) plan was purchased, or if it hasn't activated yet.
      return c.call('GET', '/app/subscriptions/list', { surface: 'trade' });
    default:
      return c.call('GET', '/openapi/account/list', { surface: 'trade' });
  }
}

/** Run one whitelisted read-only call and return the raw payload + URL (or a clean error). */
export async function webullProbe(
  kind: ProbeKind,
  opts: { symbol?: string; accountId?: string } = {},
): Promise<ProbeResult> {
  if (!webullConfigured()) {
    return { ok: false, error: 'Webull is not configured — set WEBULL_APP_KEY and WEBULL_APP_SECRET.' };
  }
  if (
    (kind === 'positions' || kind === 'balance' || kind === 'open-orders' || kind === 'order-history') &&
    !opts.accountId
  ) {
    return { ok: false, error: 'Pick an account — copy an account_id from the Account list result.' };
  }
  try {
    const r = await probeCall(kind, opts);
    if (r.ok) return { ok: true, url: r.url, status: r.status, data: r.data };
    const j = r.data as { code?: string; error_code?: string; msg?: string; message?: string } | null;
    return {
      ok: false,
      url: r.url,
      status: r.status,
      code: j?.code || j?.error_code,
      error: j?.msg || j?.message || `Webull request failed (${r.status})`,
      data: r.data,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'request failed' };
  }
}
