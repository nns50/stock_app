import { Candle, OptionsChain } from '../providers/types';

// ---------------------------------------------------------------------------
// IV rank / IV percentile for an underlying.
//
//   IV Rank       = (currentIV - minIV) / (maxIV - minIV) * 100
//   IV Percentile = % of observations at or below currentIV
//
// Preferred source is accumulated ATM-IV history (populated whenever a chain is
// viewed). Until enough real history exists, we fall back to the underlying's
// realized-volatility range as a labeled proxy (method = 'hv-estimate').
// ---------------------------------------------------------------------------

const MIN_SAMPLES = 15;

export type IvMethod = 'history' | 'hv-estimate' | 'insufficient';

export interface IvContext {
  atmIv: number | null;
  ivRank: number | null; // 0..100
  ivPercentile: number | null; // 0..100
  method: IvMethod;
  samples: number;
  min: number | null;
  max: number | null;
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

/** ATM implied vol = mean of the call & put IV at the strike nearest spot. */
export function atmIvOfChain(chain: OptionsChain): number | undefined {
  const u = chain.underlyingPrice;
  if (!u) return undefined;
  const nearest = (arr: OptionsChain['calls']) =>
    arr
      .filter((c) => typeof c.greeks?.iv === 'number')
      .reduce<OptionsChain['calls'][number] | undefined>(
        (best, c) => (!best || Math.abs(c.strike - u) < Math.abs(best.strike - u) ? c : best),
        undefined,
      );
  const ivs = [nearest(chain.calls)?.greeks?.iv, nearest(chain.puts)?.greeks?.iv].filter(
    (x): x is number => typeof x === 'number',
  );
  if (!ivs.length) return undefined;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/** Rolling annualized realized volatility of log returns. */
export function realizedVolSeries(candles: Candle[], window = 20): number[] {
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const out: number[] = [];
  for (let i = window; i <= rets.length; i++) {
    const slice = rets.slice(i - window, i);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    out.push(Math.sqrt(variance) * Math.sqrt(252));
  }
  return out;
}

function rankFrom(current: number, samples: number[]): { rank: number; pct: number; min: number; max: number } {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const rank = max > min ? ((current - min) / (max - min)) * 100 : 50;
  const pct = (samples.filter((v) => v <= current).length / samples.length) * 100;
  return { rank: clamp(rank), pct: clamp(pct), min, max };
}

export function computeIvContext(
  currentAtmIv: number | undefined,
  history: number[],
  candles: Candle[] = [],
): IvContext {
  if (currentAtmIv === undefined) {
    return {
      atmIv: null,
      ivRank: null,
      ivPercentile: null,
      method: 'insufficient',
      samples: history.length,
      min: null,
      max: null,
    };
  }
  if (history.length >= MIN_SAMPLES) {
    const { rank, pct, min, max } = rankFrom(currentAtmIv, history);
    return {
      atmIv: currentAtmIv,
      ivRank: rank,
      ivPercentile: pct,
      method: 'history',
      samples: history.length,
      min,
      max,
    };
  }
  const hv = realizedVolSeries(candles);
  if (hv.length >= MIN_SAMPLES) {
    const { rank, pct, min, max } = rankFrom(currentAtmIv, hv);
    return {
      atmIv: currentAtmIv,
      ivRank: rank,
      ivPercentile: pct,
      method: 'hv-estimate',
      samples: hv.length,
      min,
      max,
    };
  }
  return {
    atmIv: currentAtmIv,
    ivRank: null,
    ivPercentile: null,
    method: 'insufficient',
    samples: history.length,
    min: null,
    max: null,
  };
}
