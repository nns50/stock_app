import { etToday } from '../util/marketDate';
// ---------------------------------------------------------------------------
// Black–Scholes(–Merton) pricing + Greeks, used when a provider doesn't supply
// Greeks, and to price the mock provider's synthetic chains.
//
// Unit conventions (trader-friendly, documented for transparency):
//   - delta : per $1 move in the underlying        (calls 0..1, puts -1..0)
//   - gamma : delta change per $1 move
//   - vega  : price change per +1% (0.01) change in implied vol
//   - theta : price change per CALENDAR DAY (negative for long options)
//   - rho   : price change per +1% (0.01) change in the risk-free rate
//   - iv / sigma : annualized volatility as a decimal (0.40 = 40%)
//   - T     : time to expiration in YEARS
// ---------------------------------------------------------------------------

export type OptionType = 'call' | 'put';

export interface BsInputs {
  type: OptionType;
  S: number; // underlying price
  K: number; // strike
  T: number; // years to expiration
  r: number; // annualized risk-free rate (decimal)
  sigma: number; // annualized volatility (decimal)
  q?: number; // continuous dividend yield (decimal)
}

export interface BsGreeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number; // per 1% vol
  theta: number; // per day
  rho: number; // per 1% rate
}

const SQRT2PI = Math.sqrt(2 * Math.PI);

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function d1d2(S: number, K: number, T: number, r: number, sigma: number, q: number): [number, number] {
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return [d1, d2];
}

/** Option price. Handles the T<=0 (intrinsic) and sigma<=0 edge cases. */
export function bsPrice(inputs: BsInputs): number {
  const { type, S, K, T, r, sigma, q = 0 } = inputs;
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    return intrinsic;
  }
  const [d1, d2] = d1d2(S, K, T, r, sigma, q);
  const df = Math.exp(-r * T);
  const dq = Math.exp(-q * T);
  if (type === 'call') {
    return S * dq * normCdf(d1) - K * df * normCdf(d2);
  }
  return K * df * normCdf(-d2) - S * dq * normCdf(-d1);
}

/** Full set of Greeks (and price) in the units documented at the top. */
export function bsGreeks(inputs: BsInputs): BsGreeks {
  const { type, S, K, T, r, sigma, q = 0 } = inputs;
  const price = bsPrice(inputs);

  if (T <= 0 || sigma <= 0) {
    // At/after expiry the option is pure intrinsic; delta is a step function.
    const itm = type === 'call' ? S > K : S < K;
    const delta = itm ? (type === 'call' ? 1 : -1) : 0;
    return { price, delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }

  const [d1, d2] = d1d2(S, K, T, r, sigma, q);
  const df = Math.exp(-r * T);
  const dq = Math.exp(-q * T);
  const pdf = normPdf(d1);
  const sqrtT = Math.sqrt(T);

  const gamma = (dq * pdf) / (S * sigma * sqrtT);
  const vegaPerWhole = S * dq * pdf * sqrtT; // per 1.00 vol
  const vega = vegaPerWhole / 100; // per 1% vol

  let delta: number;
  let thetaPerYear: number;
  let rhoPerWhole: number;
  if (type === 'call') {
    delta = dq * normCdf(d1);
    thetaPerYear = -(S * dq * pdf * sigma) / (2 * sqrtT) - r * K * df * normCdf(d2) + q * S * dq * normCdf(d1);
    rhoPerWhole = K * T * df * normCdf(d2);
  } else {
    delta = -dq * normCdf(-d1);
    thetaPerYear = -(S * dq * pdf * sigma) / (2 * sqrtT) + r * K * df * normCdf(-d2) - q * S * dq * normCdf(-d1);
    rhoPerWhole = -K * T * df * normCdf(-d2);
  }

  return {
    price,
    delta,
    gamma,
    vega,
    theta: thetaPerYear / 365, // per calendar day
    rho: rhoPerWhole / 100, // per 1% rate
  };
}

/**
 * Implied volatility from a market price, via Newton–Raphson with a bisection
 * fallback. Returns undefined if the price is below intrinsic or no root is
 * found (e.g. stale/locked markets).
 */
export function impliedVol(params: {
  type: OptionType;
  marketPrice: number;
  S: number;
  K: number;
  T: number;
  r: number;
  q?: number;
}): number | undefined {
  const { type, marketPrice, S, K, T, r, q = 0 } = params;
  if (T <= 0 || marketPrice <= 0) return undefined;

  const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice < intrinsic - 1e-6) return undefined;

  // Newton–Raphson
  let sigma = 0.5;
  for (let i = 0; i < 50; i++) {
    const g = bsGreeks({ type, S, K, T, r, sigma, q });
    const diff = g.price - marketPrice;
    if (Math.abs(diff) < 1e-6) return sigma;
    const vegaPerWhole = g.vega * 100;
    if (vegaPerWhole < 1e-8) break; // vega too small to iterate reliably
    sigma -= diff / vegaPerWhole;
    if (sigma <= 0 || sigma > 10 || !Number.isFinite(sigma)) break;
  }

  // Bisection fallback on [1e-4, 5]
  let lo = 1e-4;
  let hi = 5;
  let priceLo = bsPrice({ type, S, K, T, r, sigma: lo, q }) - marketPrice;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pm = bsPrice({ type, S, K, T, r, sigma: mid, q }) - marketPrice;
    if (Math.abs(pm) < 1e-6) return mid;
    if (priceLo * pm < 0) {
      hi = mid;
    } else {
      lo = mid;
      priceLo = pm;
    }
  }
  return undefined;
}

/** Years from now until end of the given expiration date (YYYY-MM-DD). */
export function yearsToExpiration(expiration: string, from: Date = new Date()): number {
  const expiry = new Date(`${expiration}T20:00:00Z`).getTime(); // ~US market close
  const years = (expiry - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
  return Math.max(0, years);
}

/**
 * Days from now until the given expiration date, FRACTIONAL — 2.27 at Wednesday
 * lunchtime for a Friday expiry.
 *
 * This is time-to-expiry for PRICING and for decay-sensitive exit rules, where a
 * fraction of a day genuinely matters. It is the WRONG function for a
 * configured min/max-DTE WINDOW: a user setting "max 2 days to expiration"
 * means two CALENDAR days, and on a Wednesday every Friday contract in the
 * market scores 2.27 and is rejected. Use calendarDaysToExpiration() for any
 * comparison against a whole-days config value.
 */
export function daysToExpiration(expiration: string, from: Date = new Date()): number {
  const expiry = new Date(`${expiration}T20:00:00Z`).getTime();
  return Math.max(0, (expiry - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * WHOLE calendar days from the US-market day containing `from` to `expiration`
 * — Wednesday to Friday is 2, and same-day expiry is 0, at any hour.
 *
 * The unit every DTE *window* is configured in (2026-09-02). optionsMinDte /
 * optionsMaxDte and entryRules' min/max DTE both compared the FRACTIONAL
 * daysToExpiration() above against these whole-day settings, so a 0-2 window
 * admitted a Friday contract only from Thursday onward: measured on the live
 * book on a Wednesday, 214 of 218 candidates were skipped for "No expiration
 * within the configured DTE window [0, 2] days" while DE, TXN and the rest all
 * listed a 2026-09-04 expiry. entryRules made the contradiction visible on its
 * own rule line, which rendered the failure as "2d <= 2d" because the DETAIL
 * string already rounded to whole days while the comparison did not.
 *
 * Anchored to the ET calendar day rather than the server's, so the answer does
 * not change with deployment timezone, and floored at 0 like its sibling: an
 * expiration already past is 0 days out, never negative.
 */
export function calendarDaysToExpiration(expiration: string, from: Date = new Date()): number {
  return calendarDaysBetween(etToday(from.getTime()), expiration);
}

/**
 * Whole days between two YYYY-MM-DD market dates, floored at 0.
 *
 * The shared definition behind calendarDaysToExpiration(). Callers that already
 * HOLD a market date — the options backtest walks bar by bar and knows its
 * as-of date as a string — use this directly rather than converting to a Date
 * and back, which would misread a date-only midnight-UTC value as the previous
 * ET day and shift every DTE by one.
 */
export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
  const toMs = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)));
}
