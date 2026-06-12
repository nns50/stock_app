import { describe, it, expect } from 'vitest';
import { computeRiskSizing } from '../src/services/riskSizing';

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
