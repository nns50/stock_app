import dotenv from 'dotenv';
import path from 'path';
import { SERVER_ROOT, resolveFromRoot, ensureDir } from './util/paths';

// Load server/.env (if present). Defaults below let the app boot with the mock
// provider and zero configuration. `quiet` silences dotenv v17's startup banner.
dotenv.config({ path: path.join(SERVER_ROOT, '.env'), quiet: true });

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value || '').toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const databasePath = resolveFromRoot(process.env.DATABASE_PATH || './data/stock_app.db');
ensureDir(path.dirname(databasePath));

export type ProviderName = 'tradier' | 'yahoo' | 'mock';

export const config = {
  port: num(process.env.PORT, 3001),
  /** Selected market-data provider. Falls back to the keyless mock provider. */
  provider: (process.env.MARKET_DATA_PROVIDER || 'mock').toLowerCase() as ProviderName,
  tradier: {
    token: process.env.TRADIER_API_TOKEN || '',
    baseUrl: (process.env.TRADIER_BASE_URL || 'https://sandbox.tradier.com/v1').replace(/\/$/, ''),
  },
  databasePath,
  quoteCacheTtlMs: num(process.env.QUOTE_CACHE_TTL_MS, 15000),
  candleCacheTtlMs: num(process.env.CANDLE_CACHE_TTL_MS, 60000),
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:5173']),
  /** Annualized risk-free rate used by the Black–Scholes helper. */
  riskFreeRate: num(process.env.RISK_FREE_RATE, 0.04),
  /** When set, the built frontend is served from this directory (production). */
  publicDir: process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : '',
  /**
   * Outbound alert notifications (for the background poller). Each configured
   * webhook is a destination an alert fans out to, so Slack + Discord (+ a
   * generic/ntfy webhook) can all fire at once. URLs are secrets — keep them in
   * server/.env, never commit them.
   */
  notifications: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    // Generic webhook (ntfy / Zapier / custom). Format adapts the JSON body.
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    webhookFormat: oneOf(process.env.ALERT_WEBHOOK_FORMAT, ['json', 'slack', 'discord'] as const, 'json'),
  },
  /**
   * Single-password app lock. Set APP_PASSWORD (a server secret) to require a
   * login before any `/api/*` data is served — for exposing the app on a public
   * URL. Empty = auth disabled (local dev / tests behave as before). The session
   * cookie is marked Secure in production (HTTPS); override for plain-http access
   * (e.g. behind `fly proxy`) with AUTH_SECURE_COOKIE=false.
   */
  auth: {
    password: process.env.APP_PASSWORD || '',
    secureCookie: process.env.AUTH_SECURE_COOKIE
      ? process.env.AUTH_SECURE_COOKIE !== 'false'
      : process.env.NODE_ENV === 'production',
    /** Recovery switch: bypass the TOTP second factor (login = password only). */
    mfaDisabled: ['1', 'true', 'yes'].includes((process.env.DISABLE_MFA || '').toLowerCase()),
  },
  /**
   * Webull OpenAPI credentials (App Key / Secret from developer.webull.com),
   * server-side only. Used by the Webull provider/account integration when
   * configured; region selects the api/quotes hosts (us | hk | jp).
   */
  webull: {
    appKey: process.env.WEBULL_APP_KEY || '',
    appSecret: process.env.WEBULL_APP_SECRET || '',
    region: (process.env.WEBULL_REGION || 'us').toLowerCase(),
    /** Host overrides (the bundled SDK's defaults can be stale per region). */
    apiHost: process.env.WEBULL_API_HOST || '',
    quotesHost: process.env.WEBULL_QUOTES_HOST || '',
    /** Verified access token — only needed when 2FA is enabled on the account. */
    accessToken: process.env.WEBULL_ACCESS_TOKEN || '',
  },
};

export type AppConfig = typeof config;
