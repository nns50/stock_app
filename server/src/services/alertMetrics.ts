import { Candle, OptionsChain } from '../providers/types';
import { rsi, sma } from '../indicators/indicators';

// Candle-derived metrics for the alert engine: RSI, the 20/50 moving-average
// spread (a level-based proxy for an MA cross — > 0 is bullish alignment), and
// distance from the 52-week high / low as a %. Pure and testable; the route
// fetches the candles and a current price, this turns them into numbers.

export interface CandleMetrics {
  rsi: number | null;
  /** (MA20 − MA50) / MA50 × 100. > 0 short above long. */
  maSpreadPct: number | null;
  /** (price − 52w high) / 52w high × 100. ≤ 0; 0 means at the high. */
  pctFromHigh52: number | null;
  /** (price − 52w low) / 52w low × 100. ≥ 0; 0 means at the low. */
  pctFromLow52: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Per-contract metrics an option alert can trigger on, pulled from a chain. */
export interface OptionContractMetrics {
  mark: number | null;
  bid: number | null;
  ask: number | null;
  /** Absolute delta (|Δ|), 0..1. */
  delta: number | null;
  /** Implied volatility in percent (e.g. 42 for 42%). */
  iv: number | null;
  /** Underlying price from the chain (for `price`-kind option alerts). */
  underlyingPrice: number | null;
}

const EMPTY_OPTION: OptionContractMetrics = {
  mark: null,
  bid: null,
  ask: null,
  delta: null,
  iv: null,
  underlyingPrice: null,
};

/**
 * Locate a contract (by type + strike) in a chain and read the metrics an option
 * alert cares about. Pure — the route fetches the chain. Delta is returned as an
 * absolute value and IV as a percent, matching how the entry/exit engines and
 * the UI express them.
 */
export function optionContractMetrics(
  chain: OptionsChain,
  optionType: 'call' | 'put',
  strike: number,
): OptionContractMetrics {
  const pool = optionType === 'put' ? chain.puts : chain.calls;
  const c = pool.find((x) => Math.abs(x.strike - strike) < 1e-6);
  const underlyingPrice = chain.underlyingPrice ?? null;
  if (!c) return { ...EMPTY_OPTION, underlyingPrice };
  const mark = c.mark ?? (c.bid !== undefined && c.ask !== undefined ? (c.bid + c.ask) / 2 : (c.last ?? null));
  const delta = c.greeks?.delta;
  const iv = c.greeks?.iv;
  return {
    mark: mark ?? null,
    bid: c.bid ?? null,
    ask: c.ask ?? null,
    delta: delta === undefined ? null : Math.abs(delta),
    iv: iv === undefined ? null : iv * 100,
    underlyingPrice,
  };
}

export function computeCandleMetrics(candles: Candle[], price: number | null): CandleMetrics {
  if (candles.length === 0) return { rsi: null, maSpreadPct: null, pctFromHigh52: null, pctFromLow52: null };
  const closes = candles.map((c) => c.close);
  const px = price ?? closes[closes.length - 1] ?? null;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const window = candles.slice(-252); // ~52 weeks of daily bars
  const high52 = Math.max(...window.map((c) => c.high));
  const low52 = Math.min(...window.map((c) => c.low));
  return {
    rsi: rsi(closes, 14),
    maSpreadPct: ma20 !== null && ma50 !== null && ma50 !== 0 ? round2(((ma20 - ma50) / ma50) * 100) : null,
    pctFromHigh52: px !== null && high52 > 0 ? round2(((px - high52) / high52) * 100) : null,
    pctFromLow52: px !== null && low52 > 0 ? round2(((px - low52) / low52) * 100) : null,
  };
}
