// ---------------------------------------------------------------------------
// Position-size / risk calculator (pure). Given account size + risk-per-trade,
// an entry and a stop, returns the suggested quantity so a full stop-out loses
// no more than the configured risk, plus an R-multiple target. Decision-support
// only — not advice.
// ---------------------------------------------------------------------------

export interface RiskSizingInput {
  accountSize: number;
  /** Percent of the account to risk on this trade, e.g. 1 = 1%. */
  riskPct: number;
  entryPrice: number;
  stopPrice: number;
  assetType: 'stock' | 'option';
  side?: 'long' | 'short';
  /** Contract multiplier; defaults to 100 for options, 1 for stock. */
  multiplier?: number;
  /** Optional reward target as a multiple of risk (R), e.g. 2 = 2R. */
  targetRMultiple?: number;
}

export interface RiskSizingResult {
  maxRiskDollars: number;
  stopDistance: number; // per share/contract, in price terms
  riskPerUnit: number; // per share/contract incl. multiplier
  suggestedQuantity: number; // floored to a whole unit
  positionCost: number; // entry notional of the sized position
  positionPctOfAccount: number;
  /** Actual dollar risk of the sized (floored) position — ≤ maxRiskDollars. */
  riskOfPosition: number;
  targetPrice: number | null;
  targetProfit: number | null;
  rewardRiskRatio: number | null;
  warnings: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Defined-risk vertical spread sizing (pure). A spread has no price stop — its
// loss is structural and capped, so we size by MAX LOSS per spread instead of a
// stop distance:
//   debit  spread → max loss = net debit            ; max profit = width − net debit
//   credit spread → max loss = width − net credit   ; max profit = net credit
// (each × the 100× multiplier × contracts). The capital tied up equals the max
// loss in both cases (the debit you pay, or the collateral a credit holds).
// Decision-support only — not advice.
// ---------------------------------------------------------------------------

export interface SpreadSizingInput {
  accountSize: number;
  /** Percent of the account to risk on this trade, e.g. 1 = 1%. */
  riskPct: number;
  /** Spread width = |strike difference| between the two legs (per share). */
  width: number;
  /** Net premium per spread, per share: the debit you PAY or the credit you RECEIVE. */
  netPremium: number;
  /** 'debit' (you pay net, e.g. a long vertical) or 'credit' (you receive net). */
  direction: 'debit' | 'credit';
  /** Contract multiplier; defaults to 100. */
  multiplier?: number;
}

export interface SpreadSizingResult {
  maxRiskDollars: number; // risk budget ($)
  maxLossPerSpread: number; // $ per 1 spread (incl. multiplier) — also the capital tied up
  maxProfitPerSpread: number; // $ per 1 spread
  suggestedContracts: number; // floored to whole spreads
  totalMaxLoss: number; // sized position's max loss ($) ≤ budget
  totalMaxProfit: number; // sized position's max profit ($)
  positionPctOfAccount: number; // totalMaxLoss as % of account
  rewardRiskRatio: number | null; // max profit / max loss
  warnings: string[];
}

export function computeSpreadSizing(input: SpreadSizingInput): SpreadSizingResult {
  const multiplier = input.multiplier ?? 100;
  const warnings: string[] = [];
  const maxRiskDollars = (input.accountSize * input.riskPct) / 100;

  if (input.width <= 0) warnings.push('Spread width must be greater than zero.');
  // Net is a magnitude; the direction toggle says whether it's paid or received.
  const net = Math.abs(input.netPremium);
  if (input.netPremium < 0) {
    warnings.push('Enter net premium as a positive number; use the debit/credit toggle for its sign.');
  }
  if (input.width > 0 && net >= input.width) {
    warnings.push(
      input.direction === 'credit'
        ? "A credit spread's net credit can't exceed its width — check your inputs."
        : 'A net debit ≥ the width leaves no profit — check your inputs.',
    );
  }

  const lossPerShare = input.direction === 'debit' ? net : input.width - net;
  const profitPerShare = input.direction === 'debit' ? input.width - net : net;
  const maxLossPerSpread = Math.max(0, lossPerShare) * multiplier;
  const maxProfitPerSpread = Math.max(0, profitPerShare) * multiplier;

  let suggestedContracts = 0;
  if (maxLossPerSpread > 0 && maxRiskDollars > 0) {
    suggestedContracts = Math.floor(maxRiskDollars / maxLossPerSpread);
  }
  if (maxLossPerSpread <= 0) warnings.push('Max loss per spread is zero or negative — nothing to size.');
  else if (suggestedContracts === 0) warnings.push('Risk budget is too small for even one spread.');

  const totalMaxLoss = maxLossPerSpread * suggestedContracts;
  const totalMaxProfit = maxProfitPerSpread * suggestedContracts;
  const positionPctOfAccount = input.accountSize ? (totalMaxLoss / input.accountSize) * 100 : 0;
  const rewardRiskRatio = maxLossPerSpread > 0 ? maxProfitPerSpread / maxLossPerSpread : null;

  return {
    maxRiskDollars: round2(maxRiskDollars),
    maxLossPerSpread: round2(maxLossPerSpread),
    maxProfitPerSpread: round2(maxProfitPerSpread),
    suggestedContracts,
    totalMaxLoss: round2(totalMaxLoss),
    totalMaxProfit: round2(totalMaxProfit),
    positionPctOfAccount: round2(positionPctOfAccount),
    rewardRiskRatio: rewardRiskRatio === null ? null : round2(rewardRiskRatio),
    warnings,
  };
}

export function computeRiskSizing(input: RiskSizingInput): RiskSizingResult {
  const side = input.side ?? 'long';
  const multiplier = input.multiplier ?? (input.assetType === 'option' ? 100 : 1);
  const warnings: string[] = [];

  const maxRiskDollars = (input.accountSize * input.riskPct) / 100;
  const stopDistance = Math.abs(input.entryPrice - input.stopPrice);
  const riskPerUnit = stopDistance * multiplier;

  // Sanity checks on stop placement relative to direction.
  if (side === 'long' && input.stopPrice >= input.entryPrice) {
    warnings.push('For a long, the stop should be below the entry.');
  }
  if (side === 'short' && input.stopPrice <= input.entryPrice) {
    warnings.push('For a short, the stop should be above the entry.');
  }

  let suggestedQuantity = 0;
  if (riskPerUnit > 0 && maxRiskDollars > 0) {
    suggestedQuantity = Math.floor(maxRiskDollars / riskPerUnit);
  }
  if (riskPerUnit === 0) warnings.push('Entry and stop are equal — risk per unit is zero.');
  if (suggestedQuantity === 0 && riskPerUnit > 0) {
    warnings.push('Risk budget is too small for even one unit at this stop distance.');
  }

  const positionCost = input.entryPrice * suggestedQuantity * multiplier;
  const positionPctOfAccount = input.accountSize ? (positionCost / input.accountSize) * 100 : 0;
  if (positionCost > input.accountSize) {
    warnings.push('Position cost exceeds account size (would require margin/leverage).');
  }
  const riskOfPosition = riskPerUnit * suggestedQuantity;

  let targetPrice: number | null = null;
  let targetProfit: number | null = null;
  let rewardRiskRatio: number | null = null;
  if (input.targetRMultiple !== undefined && stopDistance > 0) {
    const dir = side === 'long' ? 1 : -1;
    targetPrice = input.entryPrice + dir * input.targetRMultiple * stopDistance;
    targetProfit = (targetPrice - input.entryPrice) * suggestedQuantity * multiplier * dir;
    rewardRiskRatio = input.targetRMultiple;
  }

  return {
    maxRiskDollars: round2(maxRiskDollars),
    stopDistance: round2(stopDistance),
    riskPerUnit: round2(riskPerUnit),
    suggestedQuantity,
    positionCost: round2(positionCost),
    positionPctOfAccount: round2(positionPctOfAccount),
    riskOfPosition: round2(riskOfPosition),
    targetPrice: targetPrice === null ? null : round2(targetPrice),
    targetProfit: targetProfit === null ? null : round2(targetProfit),
    rewardRiskRatio,
    warnings,
  };
}
