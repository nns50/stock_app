import { getProvider } from '../providers';
import { sma, atr } from '../indicators/indicators';
import { listUniverseSymbols } from '../db/universe';
import { mapPool } from '../util/async';

// ---------------------------------------------------------------------------
// "What kind of market am I trading into today?" — a single read-only regime
// gauge for the Today dashboard, folding four independent, explainable signals
// into one Risk-on / Neutral / Risk-off label:
//
//   • trend200   — the proxy (SPY) vs its own 200-day average (primary trend)
//   • trend50    — the proxy vs its 50-day average (intermediate trend)
//   • breadth    — % of the universe trading above its own 50-day average
//   • volatility — the proxy's ATR% (reuses the exact getMarketAtrPct read the
//                  autotrade vol guardrail already uses)
//
// v1 is DISPLAY-ONLY: nothing here gates entries or resizes anything — it's
// context for the human, mirroring the "explainable, never a fake 0" posture
// of the rest of the app. A signal whose inputs can't be fetched is reported
// `unknown` and simply left out of the score, never counted as neutral-in-favor
// of any regime.
// ---------------------------------------------------------------------------

export type RegimeSignal = 'risk-on' | 'neutral' | 'risk-off' | 'unknown';
export type RegimeLabel = 'risk-on' | 'neutral' | 'risk-off';

export interface RegimeComponent {
  key: 'trend200' | 'trend50' | 'breadth' | 'volatility';
  label: string;
  signal: RegimeSignal;
  /** Human-readable one-liner behind the signal. */
  detail: string;
  /** The raw number the signal was derived from (null when unresolved). */
  value: number | null;
}

export interface MarketRegime {
  proxySymbol: string;
  label: RegimeLabel;
  /** Sum of component signals (+1 risk-on, −1 risk-off, 0 otherwise). */
  score: number;
  /** How many components resolved (were not `unknown`) — the score's basis. */
  resolvedComponents: number;
  components: RegimeComponent[];
  /** % of sampled universe names above their own 50-day average, or null. */
  breadthPct: number | null;
  /** How many universe names actually resolved for the breadth read. */
  breadthSampleSize: number;
  marketAtrPct: number | null;
  asOf: number;
}

/** ±this% around a moving average reads as "neutral", not a trend either way. */
const TREND_BAND_PCT = 1;
/** Breadth above this % is risk-on; below (100−this) is risk-off. */
const BREADTH_ON_PCT = 55;
const BREADTH_OFF_PCT = 45;
/** Proxy ATR% below this is calm (risk-on lean); above VOL_STRESS_PCT is
 *  stressed (risk-off lean). */
const VOL_CALM_PCT = 2;
const VOL_STRESS_PCT = 4;

/** Cap on universe names fetched for the breadth read — bounds provider
 *  fan-out. The sample is reported (breadthSampleSize) so partial coverage is
 *  never mistaken for the whole universe. */
export const MAX_BREADTH_SYMBOLS = 120;
const BREADTH_FETCH_CONCURRENCY = 8;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — regime shifts on the daily bar, not intraday

function signalPoints(signal: RegimeSignal): number {
  return signal === 'risk-on' ? 1 : signal === 'risk-off' ? -1 : 0;
}

/** Trend of price vs a moving average, as a signed % gap. */
function trendSignal(pctVsMa: number | null): RegimeSignal {
  if (pctVsMa === null) return 'unknown';
  if (pctVsMa > TREND_BAND_PCT) return 'risk-on';
  if (pctVsMa < -TREND_BAND_PCT) return 'risk-off';
  return 'neutral';
}

function breadthSignal(pct: number | null): RegimeSignal {
  if (pct === null) return 'unknown';
  if (pct >= BREADTH_ON_PCT) return 'risk-on';
  if (pct <= BREADTH_OFF_PCT) return 'risk-off';
  return 'neutral';
}

function volatilitySignal(atrPct: number | null): RegimeSignal {
  if (atrPct === null) return 'unknown';
  if (atrPct < VOL_CALM_PCT) return 'risk-on';
  if (atrPct > VOL_STRESS_PCT) return 'risk-off';
  return 'neutral';
}

function pctGap(value: number | null, ref: number | null): number | null {
  if (value === null || ref === null || ref === 0) return null;
  return ((value - ref) / ref) * 100;
}

export interface RegimeInputs {
  proxySymbol: string;
  proxyClose: number | null;
  proxySma50: number | null;
  proxySma200: number | null;
  marketAtrPct: number | null;
  breadthPct: number | null;
  breadthSampleSize: number;
  asOf: number;
}

/** Pure classifier: folds already-fetched raw numbers into the regime read.
 *  Split out from the fetching so the scoring is trivially testable. */
export function classifyRegime(inputs: RegimeInputs): MarketRegime {
  const trend200Pct = pctGap(inputs.proxyClose, inputs.proxySma200);
  const trend50Pct = pctGap(inputs.proxyClose, inputs.proxySma50);

  const components: RegimeComponent[] = [
    {
      key: 'trend200',
      label: 'Primary trend (200-day)',
      signal: trendSignal(trend200Pct),
      value: trend200Pct,
      detail:
        trend200Pct === null
          ? `${inputs.proxySymbol} vs its 200-day average — not enough history`
          : `${inputs.proxySymbol} is ${Math.abs(trend200Pct).toFixed(1)}% ${trend200Pct >= 0 ? 'above' : 'below'} its 200-day average`,
    },
    {
      key: 'trend50',
      label: 'Intermediate trend (50-day)',
      signal: trendSignal(trend50Pct),
      value: trend50Pct,
      detail:
        trend50Pct === null
          ? `${inputs.proxySymbol} vs its 50-day average — not enough history`
          : `${inputs.proxySymbol} is ${Math.abs(trend50Pct).toFixed(1)}% ${trend50Pct >= 0 ? 'above' : 'below'} its 50-day average`,
    },
    {
      key: 'breadth',
      label: 'Breadth (% above 50-day)',
      signal: breadthSignal(inputs.breadthPct),
      value: inputs.breadthPct,
      detail:
        inputs.breadthPct === null
          ? 'No universe history available for a breadth read'
          : `${inputs.breadthPct.toFixed(0)}% of ${inputs.breadthSampleSize} names are above their own 50-day average`,
    },
    {
      key: 'volatility',
      label: 'Volatility (proxy ATR%)',
      signal: volatilitySignal(inputs.marketAtrPct),
      value: inputs.marketAtrPct,
      detail:
        inputs.marketAtrPct === null
          ? `${inputs.proxySymbol} ATR% — unavailable`
          : `${inputs.proxySymbol} ATR is ${inputs.marketAtrPct.toFixed(1)}% of price`,
    },
  ];

  const score = components.reduce((sum, c) => sum + signalPoints(c.signal), 0);
  const resolvedComponents = components.filter((c) => c.signal !== 'unknown').length;
  const label: RegimeLabel = score >= 2 ? 'risk-on' : score <= -2 ? 'risk-off' : 'neutral';

  return {
    proxySymbol: inputs.proxySymbol,
    label,
    score,
    resolvedComponents,
    components,
    breadthPct: inputs.breadthPct,
    breadthSampleSize: inputs.breadthSampleSize,
    marketAtrPct: inputs.marketAtrPct,
    asOf: inputs.asOf,
  };
}

/** % of the sampled universe trading above its own 50-day average. Best-effort
 *  per symbol: a name whose candles can't be fetched (or lacks 50 bars) is
 *  simply excluded from both numerator and denominator, never counted. Returns
 *  { pct: null, sampleSize: 0 } when nothing resolved. */
async function computeBreadth(): Promise<{ pct: number | null; sampleSize: number }> {
  const symbols = listUniverseSymbols().slice(0, MAX_BREADTH_SYMBOLS);
  if (symbols.length === 0) return { pct: null, sampleSize: 0 };

  const provider = getProvider();
  const flags = await mapPool(symbols, BREADTH_FETCH_CONCURRENCY, async (symbol) => {
    try {
      const candles = await provider.getCandles(symbol, 'daily', { limit: 60 });
      const closes = candles.map((c) => c.close);
      const ma = sma(closes, 50);
      const last = closes[closes.length - 1];
      if (ma === null || last === undefined) return null;
      return last > ma;
    } catch {
      return null;
    }
  });

  const resolved = flags.filter((f): f is boolean => f !== null);
  if (resolved.length === 0) return { pct: null, sampleSize: 0 };
  const above = resolved.filter(Boolean).length;
  return { pct: (above / resolved.length) * 100, sampleSize: resolved.length };
}

let cache: { value: MarketRegime; expiresAt: number } | null = null;

/** Async orchestrator: fetches the proxy's daily history + a universe breadth
 *  read, then classifies. Cached in-memory for an hour — the regime turns on
 *  the daily bar, and the breadth read is a bounded-but-real provider fan-out
 *  we don't want to repeat on every dashboard load. */
export async function computeMarketRegime(opts?: { proxySymbol?: string; force?: boolean }): Promise<MarketRegime> {
  const proxySymbol = (opts?.proxySymbol ?? 'SPY').toUpperCase();
  const now = Date.now();
  if (!opts?.force && cache && cache.expiresAt > now && cache.value.proxySymbol === proxySymbol) {
    return cache.value;
  }

  const provider = getProvider();
  let proxyClose: number | null = null;
  let proxySma50: number | null = null;
  let proxySma200: number | null = null;
  let marketAtrPct: number | null = null;
  try {
    const candles = await provider.getCandles(proxySymbol, 'daily', { limit: 210 });
    const closes = candles.map((c) => c.close);
    proxyClose = closes[closes.length - 1] ?? null;
    proxySma50 = sma(closes, 50);
    proxySma200 = sma(closes, 200);
    const atrVal = atr(candles, 14);
    marketAtrPct = atrVal !== null && proxyClose ? (atrVal / proxyClose) * 100 : null;
  } catch {
    /* leave proxy reads null — their components report `unknown` */
  }

  const breadth = await computeBreadth();

  const regime = classifyRegime({
    proxySymbol,
    proxyClose,
    proxySma50,
    proxySma200,
    marketAtrPct,
    breadthPct: breadth.pct,
    breadthSampleSize: breadth.sampleSize,
    asOf: now,
  });

  cache = { value: regime, expiresAt: now + CACHE_TTL_MS };
  return regime;
}

/** Test hook — drop the in-memory cache. */
export function _resetMarketRegimeCache(): void {
  cache = null;
}
