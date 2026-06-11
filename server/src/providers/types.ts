// ---------------------------------------------------------------------------
// Provider-agnostic domain types. Every concrete provider maps its raw API
// response into these shapes so the rest of the app never depends on a vendor.
// ---------------------------------------------------------------------------

export type Timeframe = '1min' | '5min' | '15min' | 'daily' | 'weekly';

export interface Quote {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  /** Average daily volume — used for relative-volume in the screener. */
  avgVolume?: number;
  /** ms epoch of the quote. */
  timestamp: number;
}

export interface Candle {
  /** ms epoch of the bar's start. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  /** Implied volatility as a decimal (e.g. 0.42 = 42%). */
  iv?: number;
  /** True when the Greeks were computed locally (Black–Scholes) rather than
   *  supplied by the provider. Surfaced in the UI for transparency. */
  computed?: boolean;
}

export interface OptionContract {
  /** Provider option symbol (e.g. OCC code). */
  symbol: string;
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  /** Expiration date, YYYY-MM-DD. */
  expiration: string;
  bid?: number;
  ask?: number;
  last?: number;
  /** Mid price ((bid+ask)/2) when both sides are present. */
  mark?: number;
  volume?: number;
  openInterest?: number;
  greeks?: OptionGreeks;
}

export interface OptionsChain {
  underlying: string;
  expiration: string;
  underlyingPrice?: number;
  calls: OptionContract[];
  puts: OptionContract[];
}

export interface Fundamentals {
  symbol: string;
  name?: string;
  description?: string;
  marketCap?: number;
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  high52?: number;
  low52?: number;
  averageVolume?: number;
  sector?: string;
  industry?: string;
}

export interface CandleQuery {
  start?: string; // YYYY-MM-DD
  end?: string; // YYYY-MM-DD
  limit?: number; // max bars to return (most recent)
}
