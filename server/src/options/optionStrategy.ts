import { bsGreeks, impliedVol, normCdf } from './blackScholes';

// ---------------------------------------------------------------------------
// Multi-leg option strategy analytics (pure). Given a set of legs at a current
// underlying price, computes net premium, expiration payoff curve, breakevens,
// max profit/loss (with unbounded detection), combined Greeks, and an estimated
// probability of profit from a lognormal model of the underlying at expiry.
// Decision-support only.
// ---------------------------------------------------------------------------

export type OptionType = 'call' | 'put';
export type LegAction = 'buy' | 'sell';

export interface StrategyLeg {
  type: OptionType;
  action: LegAction;
  strike: number;
  quantity: number; // contracts (>0)
  premium: number; // per-share premium
  iv?: number; // optional; otherwise solved from premium
}

export interface StrategyInput {
  underlyingPrice: number;
  dte: number; // days to expiration
  riskFreeRate?: number;
  ivForPop?: number; // vol used for probability-of-profit (decimal)
  legs: StrategyLeg[];
}

export interface StrategyGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface StrategyAnalysis {
  netPremium: number; // dollars; negative = debit paid, positive = credit received
  maxProfit: number | null; // null = unbounded
  maxLoss: number | null; // null = unbounded
  unboundedProfit: boolean;
  unboundedLoss: boolean;
  breakevens: number[];
  greeks: StrategyGreeks;
  payoff: { price: number; pnl: number }[];
  probabilityOfProfit: number | null; // 0..1
}

const MULTIPLIER = 100;

function intrinsic(type: OptionType, S: number, K: number): number {
  return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
}

/** Per-share P&L of a leg at expiration price S (premium and action included). */
function legPayoffPerShare(leg: StrategyLeg, S: number): number {
  const val = intrinsic(leg.type, S, leg.strike);
  const perShare = leg.action === 'buy' ? val - leg.premium : leg.premium - val;
  return perShare * leg.quantity;
}

function strategyPnl(legs: StrategyLeg[], S: number): number {
  return legs.reduce((sum, leg) => sum + legPayoffPerShare(leg, S), 0) * MULTIPLIER;
}

export function netPremium(legs: StrategyLeg[]): number {
  return (
    legs.reduce((sum, leg) => sum + (leg.action === 'buy' ? -leg.premium : leg.premium) * leg.quantity, 0) * MULTIPLIER
  );
}

function combinedGreeks(input: StrategyInput): StrategyGreeks {
  const r = input.riskFreeRate ?? 0.04;
  const T = Math.max(input.dte, 0) / 365;
  const S = input.underlyingPrice;
  const acc: StrategyGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of input.legs) {
    const sigma =
      leg.iv ?? impliedVol({ type: leg.type, marketPrice: leg.premium, S, K: leg.strike, T, r }) ?? input.ivForPop;
    if (!sigma || T <= 0) continue;
    const g = bsGreeks({ type: leg.type, S, K: leg.strike, T, r, sigma });
    const sign = (leg.action === 'buy' ? 1 : -1) * leg.quantity;
    acc.delta += g.delta * sign;
    acc.gamma += g.gamma * sign;
    acc.theta += g.theta * sign;
    acc.vega += g.vega * sign;
  }
  return {
    delta: round4(acc.delta),
    gamma: round4(acc.gamma),
    theta: round4(acc.theta),
    vega: round4(acc.vega),
  };
}

/** Probability the underlying expires in a profitable region (lognormal model). */
function probabilityOfProfit(input: StrategyInput, grid: { price: number; pnl: number }[]): number | null {
  const r = input.riskFreeRate ?? 0.04;
  const T = Math.max(input.dte, 0) / 365;
  const S = input.underlyingPrice;
  // Pick a vol: explicit, else average of solved leg IVs.
  let sigma = input.ivForPop;
  if (!sigma) {
    const ivs = input.legs
      .map((leg) => leg.iv ?? impliedVol({ type: leg.type, marketPrice: leg.premium, S, K: leg.strike, T, r }))
      .filter((v): v is number => typeof v === 'number' && v > 0);
    if (ivs.length) sigma = ivs.reduce((a, b) => a + b, 0) / ivs.length;
  }
  if (!sigma || T <= 0 || S <= 0) return null;

  const mu = Math.log(S) + (r - 0.5 * sigma * sigma) * T;
  const s = sigma * Math.sqrt(T);
  const lnCdf = (x: number) => (x <= 0 ? 0 : normCdf((Math.log(x) - mu) / s));

  let prob = 0;
  for (let i = 0; i < grid.length - 1; i++) {
    const midPnl = (grid[i].pnl + grid[i + 1].pnl) / 2;
    if (midPnl > 0) prob += lnCdf(grid[i + 1].price) - lnCdf(grid[i].price);
  }
  return Math.max(0, Math.min(1, round4(prob)));
}

export function analyzeStrategy(input: StrategyInput): StrategyAnalysis {
  const legs = input.legs;
  const strikes = legs.map((l) => l.strike);
  const hi = Math.max(input.underlyingPrice * 2, Math.max(...strikes) * 1.5, input.underlyingPrice + 1);
  const N = 121;
  const payoff: { price: number; pnl: number }[] = [];
  for (let i = 0; i < N; i++) {
    const price = (hi * i) / (N - 1);
    payoff.push({ price: round2(price), pnl: round2(strategyPnl(legs, price)) });
  }

  // Max/min over the modeled range.
  let maxP = -Infinity;
  let minP = Infinity;
  for (const pt of payoff) {
    if (pt.pnl > maxP) maxP = pt.pnl;
    if (pt.pnl < minP) minP = pt.pnl;
  }
  // Unbounded detection from the slope at the upper boundary (price → ∞).
  const slopeHi = payoff[N - 1].pnl - payoff[N - 2].pnl;
  const unboundedProfit = slopeHi > 0.01;
  const unboundedLoss = slopeHi < -0.01;

  // Breakevens: zero crossings of the payoff, linearly interpolated.
  const breakevens: number[] = [];
  for (let i = 0; i < payoff.length - 1; i++) {
    const a = payoff[i];
    const b = payoff[i + 1];
    if ((a.pnl <= 0 && b.pnl > 0) || (a.pnl >= 0 && b.pnl < 0)) {
      const t = a.pnl / (a.pnl - b.pnl);
      breakevens.push(round2(a.price + t * (b.price - a.price)));
    }
  }

  return {
    netPremium: round2(netPremium(legs)),
    maxProfit: unboundedProfit ? null : round2(maxP),
    maxLoss: unboundedLoss ? null : round2(minP),
    unboundedProfit,
    unboundedLoss,
    breakevens,
    greeks: combinedGreeks(input),
    payoff,
    probabilityOfProfit: probabilityOfProfit(input, payoff),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
