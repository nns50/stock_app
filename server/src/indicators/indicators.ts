// ---------------------------------------------------------------------------
// Pure technical-indicator functions. No I/O, no provider coupling — just math
// over arrays of closes / candles. Series variants return values aligned to the
// input length (null during the warmup period) for charting overlays; scalar
// helpers return the latest value.
// ---------------------------------------------------------------------------

export interface Bar {
  high: number;
  low: number;
  close: number;
  open?: number;
}

/** Simple moving average series (null until `period` samples are available). */
export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average series, seeded with the SMA of the first window. */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      sum += values[i];
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's RSI series. */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** True range for a bar given the previous close. */
export function trueRange(bar: Bar, prevClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** Wilder's ATR series. */
export function atrSeries(bars: Bar[], period = 14): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  const tr: number[] = new Array(n).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < n; i++) tr[i] = trueRange(bars[i], bars[i - 1].close);

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Latest non-null value of a series, or null. */
export function latest(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

// --- Scalar / derived helpers ----------------------------------------------

export function sma(values: number[], period: number): number | null {
  return latest(smaSeries(values, period));
}

export function ema(values: number[], period: number): number | null {
  return latest(emaSeries(values, period));
}

export function rsi(closes: number[], period = 14): number | null {
  return latest(rsiSeries(closes, period));
}

export function atr(bars: Bar[], period = 14): number | null {
  return latest(atrSeries(bars, period));
}

export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export function relativeVolume(currentVolume: number, averageVolume: number): number | null {
  if (!averageVolume) return null;
  return currentVolume / averageVolume;
}

export function gapPercent(open: number, prevClose: number): number | null {
  if (!prevClose) return null;
  return ((open - prevClose) / prevClose) * 100;
}

/** Distance of price from a moving average, in percent. */
export function distanceFromMa(price: number, ma: number | null): number | null {
  if (ma === null || !ma) return null;
  return ((price - ma) / ma) * 100;
}

/** Mean of the last `n` values (or all if fewer). */
export function meanOfLast(values: number[], n: number): number | null {
  if (!values.length) return null;
  const slice = values.slice(Math.max(0, values.length - n));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Simple period-over-period % returns between consecutive closes (as
 *  decimals, e.g. 0.02 = 2%). Length is closes.length - 1. Skips a step where
 *  the prior close is zero (can't divide). */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

/** Pearson correlation coefficient between two numeric series. Uses the
 *  shorter series' length (aligning from the end, not by date) — fine for two
 *  US-equity return series over the same calendar window, which is the only
 *  use case today. Null if either series has fewer than 2 points, or either
 *  has zero variance (a correlation is undefined against a flat series). */
export function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ax = a.slice(a.length - n);
  const bx = b.slice(b.length - n);
  const meanA = ax.reduce((s, v) => s + v, 0) / n;
  const meanB = bx.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}
