import { describe, it, expect } from 'vitest';
import { analyzeStrategy, netPremium, StrategyLeg } from '../src/options/optionStrategy';

describe('netPremium', () => {
  it('is a debit (negative) for longs and a credit (positive) for shorts', () => {
    expect(netPremium([{ type: 'call', action: 'buy', strike: 100, quantity: 1, premium: 5 }])).toBe(-500);
    expect(netPremium([{ type: 'put', action: 'sell', strike: 100, quantity: 1, premium: 3 }])).toBe(300);
  });
});

describe('analyzeStrategy — long call', () => {
  const a = analyzeStrategy({
    underlyingPrice: 100,
    dte: 30,
    legs: [{ type: 'call', action: 'buy', strike: 100, quantity: 1, premium: 5, iv: 0.3 }],
  });

  it('caps loss at the premium, has unbounded profit, and breaks even at strike+premium', () => {
    expect(a.maxLoss).toBeCloseTo(-500, 0);
    expect(a.unboundedProfit).toBe(true);
    expect(a.maxProfit).toBeNull();
    expect(a.breakevens[0]).toBeGreaterThan(104);
    expect(a.breakevens[0]).toBeLessThan(106);
    expect(a.greeks.delta).toBeGreaterThan(0);
    expect(a.greeks.theta).toBeLessThan(0); // long option decays
  });
});

describe('analyzeStrategy — vertical call (debit) spread', () => {
  const legs: StrategyLeg[] = [
    { type: 'call', action: 'buy', strike: 100, quantity: 1, premium: 5, iv: 0.3 },
    { type: 'call', action: 'sell', strike: 110, quantity: 1, premium: 2, iv: 0.3 },
  ];
  const a = analyzeStrategy({ underlyingPrice: 100, dte: 30, ivForPop: 0.3, legs });

  it('is bounded both ways with the right max profit/loss and breakeven', () => {
    expect(a.netPremium).toBeCloseTo(-300, 0); // $3 debit
    expect(a.maxLoss).toBeCloseTo(-300, 0);
    expect(a.maxProfit).toBeCloseTo(700, 0); // (10 - 3) * 100
    expect(a.unboundedProfit).toBe(false);
    expect(a.unboundedLoss).toBe(false);
    expect(a.breakevens[0]).toBeCloseTo(103, 0);
  });

  it('produces a probability of profit in (0,1)', () => {
    expect(a.probabilityOfProfit).not.toBeNull();
    expect(a.probabilityOfProfit as number).toBeGreaterThan(0);
    expect(a.probabilityOfProfit as number).toBeLessThan(1);
  });

  it('returns a payoff curve for charting', () => {
    expect(a.payoff.length).toBeGreaterThan(50);
    expect(a.payoff[0]).toHaveProperty('price');
    expect(a.payoff[0]).toHaveProperty('pnl');
  });
});
