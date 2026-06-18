import { Candle } from '../providers/types';
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
