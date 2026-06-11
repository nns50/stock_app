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
