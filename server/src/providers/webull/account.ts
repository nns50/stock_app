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
  });
}

export type ProbeKind = 'account-list' | 'snapshot';

export interface ProbeResult {
  ok: boolean;
  status?: number;
  code?: string;
  data?: unknown;
  error?: string;
}

/** Run one whitelisted read-only call and return the raw payload (or a clean error). */
export async function webullProbe(kind: ProbeKind, symbol = 'AAPL'): Promise<ProbeResult> {
  if (!webullConfigured()) {
    return { ok: false, error: 'Webull is not configured — set WEBULL_APP_KEY and WEBULL_APP_SECRET.' };
  }
  const c = client();
  try {
    const data =
      kind === 'snapshot'
        ? await c.get('/market-data/snapshot', { symbols: symbol.toUpperCase(), category: 'US_STOCK' }, 'market')
        : await c.get('/openapi/account/list', {}, 'trade');
    return { ok: true, data };
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    return { ok: false, status: err.status, code: err.code, error: err.message ?? 'request failed' };
  }
}
