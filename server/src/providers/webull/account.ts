import { config } from '../../config';
import { WebullClient } from './client';
import { normalizeRegion } from './hosts';

// Config-bound Webull access + a small read-only probe used to validate live
// credentials and surface real response shapes (so the data mappers are built
// from confirmed payloads, not guesses). All read-only.

export function webullConfigured(): boolean {
  return !!(config.webull.appKey && config.webull.appSecret);
}

export function webullStatus(): { configured: boolean; region: string } {
  return { configured: webullConfigured(), region: normalizeRegion(config.webull.region) };
}

function client(): WebullClient {
  return WebullClient.fromEnv({
    appKey: config.webull.appKey,
    appSecret: config.webull.appSecret,
    region: config.webull.region,
    apiHost: config.webull.apiHost,
    quotesHost: config.webull.quotesHost,
  });
}

export type ProbeKind = 'account-list' | 'snapshot';

export interface ProbeResult {
  ok: boolean;
  /** The exact URL called — handy for diagnosing host/path issues (e.g. 404s). */
  url?: string;
  status?: number;
  code?: string;
  data?: unknown;
  error?: string;
}

/** Run one whitelisted read-only call and return the raw payload + URL (or a clean error). */
export async function webullProbe(kind: ProbeKind, symbol = 'AAPL'): Promise<ProbeResult> {
  if (!webullConfigured()) {
    return { ok: false, error: 'Webull is not configured — set WEBULL_APP_KEY and WEBULL_APP_SECRET.' };
  }
  try {
    const r =
      kind === 'snapshot'
        ? await client().call('GET', '/openapi/market-data/stock/snapshot', {
            query: { symbols: symbol.toUpperCase(), category: 'US_STOCK' },
            surface: 'market',
          })
        : await client().call('GET', '/openapi/account/list', { surface: 'trade' });
    if (r.ok) return { ok: true, url: r.url, status: r.status, data: r.data };
    const j = r.data as { code?: string; msg?: string; message?: string } | null;
    return {
      ok: false,
      url: r.url,
      status: r.status,
      code: j?.code,
      error: j?.msg || j?.message || `Webull request failed (${r.status})`,
      data: r.data,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'request failed' };
  }
}
