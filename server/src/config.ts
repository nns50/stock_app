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
   * Outbound alert notifications (for the background poller). The webhook URL is
   * a secret — keep it in server/.env, never commit it. Format adapts the JSON
   * body to the target service.
   */
  notifications: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    webhookFormat: oneOf(process.env.ALERT_WEBHOOK_FORMAT, ['json', 'slack', 'discord'] as const, 'json'),
  },
};

export type AppConfig = typeof config;
