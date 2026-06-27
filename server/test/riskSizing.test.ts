import { describe, it, expect } from 'vitest';
import { computeRiskSizing, computeSpreadSizing } from '../src/services/riskSizing';

describe('computeRiskSizing', () => {
  it('sizes a long stock so a full stop-out equals the risk budget', () => {
    const r = computeRiskSizing({
      accountSize: 10_000,
      riskPct: 1, // $100 risk
      entryPrice: 50,
      stopPrice: 48, // $2 stop distance
      assetType: 'stock',
      targetRMultiple: 2,
    });
    expect(r.maxRiskDollars).toBe(100);
    expect(r.stopDistance).toBe(2);
    expect(r.riskPerUnit).toBe(2);
    expect(r.suggestedQuantity).toBe(50);
    expect(r.positionCost).toBe(2500);
    expect(r.positionPctOfAccount).toBe(25);
    expect(r.riskOfPosition).toBe(100);
    expect(r.targetPrice).toBe(54); // entry + 2R * stop
    expect(r.targetProfit).toBe(200); // (54-50)*50
    expect(r.warnings).toHaveLength(0);
  });

  it('applies the 100x multiplier for options', () => {
    const r = computeRiskSizing({
      accountSize: 10_000,
      riskPct: 2, // $200
      entryPrice: 5,
      stopPrice: 3, // $2 stop -> $200/contract
      assetType: 'option',
    });
    expect(r.riskPerUnit).toBe(200);
    expect(r.suggestedQuantity).toBe(1);
    expect(r.positionCost).toBe(500);
    expect(r.riskOfPosition).toBe(200);
  });

  it('handles short positions and R-target direction', () => {
    const r = computeRiskSizing({
      accountSize: 10_000,
      riskPct: 1,
      entryPrice: 50,
      stopPrice: 52,
      assetType: 'stock',
      side: 'short',
      targetRMultiple: 2,
    });
    expect(r.suggestedQuantity).toBe(50);
    expect(r.targetPrice).toBe(46); // entry - 2R * stop
    expect(r.warnings).toHaveLength(0);
  });

  it('warns when the stop is on the wrong side', () => {
    const r = computeRiskSizing({
      accountSize: 10_000,
      riskPct: 1,
      entryPrice: 50,
      stopPrice: 51,
      assetType: 'stock',
      side: 'long',
    });
    expect(r.warnings.join(' ')).toContain('long');
  });

  it('warns when the risk budget is too small for one unit', () => {
    const r = computeRiskSizing({ accountSize: 100, riskPct: 1, entryPrice: 50, stopPrice: 48, assetType: 'stock' });
    expect(r.suggestedQuantity).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/too small/i);
  });
});

describe('computeSpreadSizing (defined-risk verticals)', () => {
  it('sizes a debit spread by its net debit (max loss = debit × 100)', () => {
    const r = computeSpreadSizing({
      accountSize: 10_000,
      riskPct: 5, // $500 budget
      width: 5,
      netPremium: 2, // $2 debit → $200 max loss / spread
      direction: 'debit',
    });
    expect(r.maxRiskDollars).toBe(500);
    expect(r.maxLossPerSpread).toBe(200);
    expect(r.maxProfitPerSpread).toBe(300); // (5 - 2) × 100
    expect(r.suggestedContracts).toBe(2); // floor(500 / 200)
    expect(r.totalMaxLoss).toBe(400);
    expect(r.totalMaxProfit).toBe(600);
    expect(r.positionPctOfAccount).toBe(4); // 400 / 10,000
    expect(r.rewardRiskRatio).toBe(1.5); // 300 / 200
    expect(r.warnings).toHaveLength(0);
  });

  it('sizes a credit spread by width − net credit', () => {
    const r = computeSpreadSizing({
      accountSize: 35_000,
      riskPct: 1, // $350 budget
      width: 5,
      netPremium: 1.5, // credit → max loss (5 - 1.5) × 100 = $350
      direction: 'credit',
    });
    expect(r.maxLossPerSpread).toBe(350);
    expect(r.maxProfitPerSpread).toBe(150);
    expect(r.suggestedContracts).toBe(1);
    expect(r.totalMaxLoss).toBe(350);
    expect(r.rewardRiskRatio).toBe(0.43); // 150 / 350
    expect(r.warnings).toHaveLength(0);
  });

  it('warns when the budget is too small for even one spread', () => {
    const r = computeSpreadSizing({ accountSize: 1_000, riskPct: 1, width: 5, netPremium: 2, direction: 'debit' });
    expect(r.suggestedContracts).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/too small/i);
  });

  it('flags a net credit that exceeds the width (impossible inputs)', () => {
    const r = computeSpreadSizing({ accountSize: 10_000, riskPct: 5, width: 5, netPremium: 6, direction: 'credit' });
    expect(r.warnings.join(' ')).toMatch(/exceed its width/i);
    expect(r.suggestedContracts).toBe(0); // width − credit ≤ 0 → no sizable max loss
  });
});
