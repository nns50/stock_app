import { atr } from '../../indicators/indicators';
import { getProvider } from '../../providers';
import { isUsEquityMarketOpen } from '../trading/marketHours';

// ---------------------------------------------------------------------------
// Guards specific to the autonomous execution loop (docs/AUTOTRADING_SPEC.md
// — "RISK MANAGEMENT": "No new entries in the first/last N minutes of the
// trading session" and "Volatility filter"). Distinct from
// services/trading/marketHours.ts, which is deliberately warn-only for the
// human-confirmed live pipeline (a person can see the warning and decide
// anyway) — an unattended loop has no one to override it, so these are hard
// blocks.
// ---------------------------------------------------------------------------

const OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET
const CLOSE_MINUTES = 16 * 60; // 16:00 ET

function etMinutesSinceMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24; // some platforms render midnight as "24"
  return hour * 60 + Number(get('minute'));
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Hard block outside regular trading hours, and within `bufferMinutes` of the
 * open or close — the opening auction and closing imbalance both distort
 * prices in ways a signal generated off a stale/thin quote shouldn't be
 * trusted to react to. Same heuristic caveat as isUsEquityMarketOpen (no
 * holiday calendar) — acceptable here since the loop just skips a cycle
 * rather than acting on bad information; it tries again next cycle.
 */
export function checkSessionWindow(bufferMinutes: number, now: Date = new Date()): GuardResult {
  if (!isUsEquityMarketOpen(now)) return { ok: false, reason: 'Market is closed' };
  const minutes = etMinutesSinceMidnight(now);
  if (minutes < OPEN_MINUTES + bufferMinutes) {
    return { ok: false, reason: `Within ${bufferMinutes}m of the session open` };
  }
  if (minutes > CLOSE_MINUTES - bufferMinutes) {
    return { ok: false, reason: `Within ${bufferMinutes}m of the session close` };
  }
  return { ok: true };
}

export interface VolatilityFilterConfig {
  /** Skip a candidate whose own ATR% exceeds this. */
  maxTickerAtrPct: number;
  /** Skip ALL new entries this cycle if the broad-market proxy's ATR% exceeds this. */
  maxMarketAtrPct: number;
  /** No VIX feed exists in this app — a liquid index ETF's own ATR% stands in
   *  as a broad-market volatility proxy, using whatever MARKET_DATA_PROVIDER
   *  is already configured (no new data source needed). */
  marketProxySymbol: string;
}

export function defaultVolatilityFilterConfig(): VolatilityFilterConfig {
  return { maxTickerAtrPct: 15, maxMarketAtrPct: 5, marketProxySymbol: 'SPY' };
}

/**
 * Pure — no I/O. `marketAtrPct` is computed ONCE per loop cycle (see
 * getMarketAtrPct below), not re-fetched per candidate.
 */
export function checkVolatility(
  candidateAtrPct: number | null,
  marketAtrPct: number | null,
  cfg: VolatilityFilterConfig,
): GuardResult {
  if (candidateAtrPct === null) return { ok: false, reason: 'Ticker ATR unavailable' };
  if (candidateAtrPct > cfg.maxTickerAtrPct) {
    return { ok: false, reason: `Ticker ATR ${candidateAtrPct.toFixed(1)}% exceeds max ${cfg.maxTickerAtrPct}%` };
  }
  if (marketAtrPct !== null && marketAtrPct > cfg.maxMarketAtrPct) {
    return {
      ok: false,
      reason: `${cfg.marketProxySymbol} ATR ${marketAtrPct.toFixed(1)}% exceeds max ${cfg.maxMarketAtrPct}%`,
    };
  }
  return { ok: true };
}

/**
 * The market-proxy's own ATR%, as of its most recent daily bar. Null if the
 * fetch/computation fails — treated as "unknown," not "elevated": a
 * market-data blip on the proxy symbol shouldn't itself halt every entry for
 * the cycle; the per-ticker ATR check still applies regardless.
 */
export async function getMarketAtrPct(proxySymbol: string): Promise<number | null> {
  try {
    const candles = await getProvider().getCandles(proxySymbol, 'daily', { limit: 30 });
    const atrVal = atr(candles, 14);
    const lastClose = candles[candles.length - 1]?.close;
    return atrVal !== null && lastClose ? (atrVal / lastClose) * 100 : null;
  } catch {
    return null;
  }
}
