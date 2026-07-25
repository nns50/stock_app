import { analyzeStrategy, netPremium, LegAction, OptionType, StrategyLeg } from './optionStrategy';

// ---------------------------------------------------------------------------
// "Should I roll this option, and to what?" — compares the position you hold
// today against a candidate replacement (same side, same quantity — a roll
// keeps your directional bet, it doesn't change it), reusing the existing
// multi-leg strategy analyzer for both the roll's own net cost (as a 2-leg
// close+open transaction) and each leg's own standalone outlook (breakeven,
// max profit/loss, probability of profit, expected value). Decision-support
// only: it never places the roll.
// ---------------------------------------------------------------------------

export interface RollLegInput {
  optionType: OptionType;
  strike: number;
  /** Days to expiration for this leg. */
  dte: number;
  /** Current per-share premium (a live mark, or your own estimate). */
  premium: number;
  /** Optional — otherwise solved from the premium, same as StrategyLeg.iv. */
  iv?: number;
}

export interface RollInput {
  /** How the CURRENT leg is held — a roll keeps this same directional bias
   *  for the new leg (you're not flipping long/short mid-roll). */
  side: 'long' | 'short';
  quantity: number;
  underlyingPrice: number;
  riskFreeRate?: number;
  current: RollLegInput;
  target: RollLegInput;
}

export interface RollLegOutlook {
  breakevens: number[];
  maxProfit: number | null;
  maxLoss: number | null;
  probabilityOfProfit: number | null;
  expectedValue: number | null;
  delta: number;
}

export interface RollAnalysis {
  /** $ to execute the roll as one transaction (close current + open target) —
   *  negative = net debit paid, positive = net credit received, same sign
   *  convention as optionStrategy's own netPremium. */
  netCost: number;
  current: RollLegOutlook;
  target: RollLegOutlook;
  /** target's nearest breakeven to its own strike minus current's — positive
   *  means the new position needs a bigger favorable move to break even.
   *  Null if either leg has no breakeven in the modeled range. */
  breakevenShift: number | null;
  probabilityOfProfitShift: number | null;
  expectedValueShift: number | null;
}

function legOutlook(input: RollInput, leg: RollLegInput): { outlook: RollLegOutlook; strategyLeg: StrategyLeg } {
  const action: LegAction = input.side === 'long' ? 'buy' : 'sell';
  const strategyLeg: StrategyLeg = {
    type: leg.optionType,
    action,
    strike: leg.strike,
    quantity: input.quantity,
    premium: leg.premium,
    iv: leg.iv,
  };
  const analysis = analyzeStrategy({
    underlyingPrice: input.underlyingPrice,
    dte: leg.dte,
    riskFreeRate: input.riskFreeRate,
    legs: [strategyLeg],
  });
  return {
    strategyLeg,
    outlook: {
      breakevens: analysis.breakevens,
      maxProfit: analysis.maxProfit,
      maxLoss: analysis.maxLoss,
      probabilityOfProfit: analysis.probabilityOfProfit,
      expectedValue: analysis.expectedValue,
      delta: analysis.greeks.delta,
    },
  };
}

function nearestBreakeven(breakevens: number[], strike: number): number | null {
  if (!breakevens.length) return null;
  return breakevens.reduce((a, b) => (Math.abs(b - strike) < Math.abs(a - strike) ? b : a));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export function analyzeRoll(input: RollInput): RollAnalysis {
  // Closing reverses however the current leg is held; opening the target
  // keeps the same directional bias — modeled as one 2-leg transaction so
  // netPremium() gives the roll's own net cash flow in one call.
  const closeAction: LegAction = input.side === 'long' ? 'sell' : 'buy';
  const openAction: LegAction = input.side === 'long' ? 'buy' : 'sell';
  const closeLeg: StrategyLeg = {
    type: input.current.optionType,
    action: closeAction,
    strike: input.current.strike,
    quantity: input.quantity,
    premium: input.current.premium,
  };
  const openLeg: StrategyLeg = {
    type: input.target.optionType,
    action: openAction,
    strike: input.target.strike,
    quantity: input.quantity,
    premium: input.target.premium,
  };

  const { outlook: current } = legOutlook(input, input.current);
  const { outlook: target } = legOutlook(input, input.target);

  const currentBe = nearestBreakeven(current.breakevens, input.current.strike);
  const targetBe = nearestBreakeven(target.breakevens, input.target.strike);

  return {
    netCost: round2(netPremium([closeLeg, openLeg])),
    current,
    target,
    breakevenShift: currentBe != null && targetBe != null ? round2(targetBe - currentBe) : null,
    probabilityOfProfitShift:
      current.probabilityOfProfit != null && target.probabilityOfProfit != null
        ? round4(target.probabilityOfProfit - current.probabilityOfProfit)
        : null,
    expectedValueShift:
      current.expectedValue != null && target.expectedValue != null
        ? round2(target.expectedValue - current.expectedValue)
        : null,
  };
}
