import { describe, it, expect } from 'vitest';
import { analyzeRoll, RollInput } from '../src/options/optionRoll';

describe('analyzeRoll — long call, up and out', () => {
  const input: RollInput = {
    side: 'long',
    quantity: 1,
    underlyingPrice: 100,
    current: { optionType: 'call', strike: 100, dte: 10, premium: 3, iv: 0.3 },
    target: { optionType: 'call', strike: 105, dte: 40, premium: 4, iv: 0.3 },
  };
  const a = analyzeRoll(input);

  it('nets a debit when the new leg costs more than closing the old one pays', () => {
    // Sell to close +$300, buy to open -$400 -> net -$100 (debit).
    expect(a.netCost).toBeCloseTo(-100, 0);
  });

  it("caps each leg's max loss at its own premium paid", () => {
    expect(a.current.maxLoss).toBeCloseTo(-300, 0);
    expect(a.target.maxLoss).toBeCloseTo(-400, 0);
  });

  it('shifts the breakeven up by roughly the strike move plus the extra premium', () => {
    // current breakeven ~103, target breakeven ~109 -> shift ~+6
    expect(a.breakevenShift as number).toBeGreaterThan(4);
    expect(a.breakevenShift as number).toBeLessThan(8);
  });

  it('produces finite probability-of-profit and expected-value shifts', () => {
    expect(a.probabilityOfProfitShift).not.toBeNull();
    expect(a.expectedValueShift).not.toBeNull();
    expect(Number.isFinite(a.probabilityOfProfitShift)).toBe(true);
    expect(Number.isFinite(a.expectedValueShift)).toBe(true);
  });
});

describe('analyzeRoll — short put, down and out to avoid assignment', () => {
  const input: RollInput = {
    side: 'short',
    quantity: 2,
    underlyingPrice: 50,
    current: { optionType: 'put', strike: 50, dte: 5, premium: 1.5, iv: 0.35 },
    target: { optionType: 'put', strike: 45, dte: 35, premium: 1.2, iv: 0.35 },
  };
  const a = analyzeRoll(input);

  it('scales the net cost by quantity and flips sign for a short position', () => {
    // Buy to close -$300 (2 * 1.5 * 100), sell to open +$240 (2 * 1.2 * 100) -> net -$60.
    expect(a.netCost).toBeCloseTo(-60, 0);
  });

  it("caps each leg's max profit at the premium received", () => {
    expect(a.current.maxProfit).toBeCloseTo(300, 0); // 2 * 1.5 * 100
    expect(a.target.maxProfit).toBeCloseTo(240, 0); // 2 * 1.2 * 100
  });
});

describe('analyzeRoll — quantity of 1 without an explicit iv', () => {
  it('still resolves probability/expected-value by solving IV from the premium', () => {
    const a = analyzeRoll({
      side: 'long',
      quantity: 1,
      underlyingPrice: 100,
      current: { optionType: 'call', strike: 100, dte: 20, premium: 3 },
      target: { optionType: 'call', strike: 100, dte: 45, premium: 4.5 },
    });
    expect(a.current.probabilityOfProfit).not.toBeNull();
    expect(a.target.probabilityOfProfit).not.toBeNull();
  });
});

describe('analyzeRoll — unresolvable IV on both legs', () => {
  it('leaves probability/expected-value null rather than guessing, and their shifts null too', () => {
    // A zero premium has no intrinsic-vs-market gap to solve an IV from, and
    // no iv/ivForPop is supplied either.
    const a = analyzeRoll({
      side: 'long',
      quantity: 1,
      underlyingPrice: 100,
      current: { optionType: 'call', strike: 100, dte: 20, premium: 0 },
      target: { optionType: 'call', strike: 105, dte: 45, premium: 0 },
    });
    expect(a.current.probabilityOfProfit).toBeNull();
    expect(a.target.probabilityOfProfit).toBeNull();
    expect(a.current.expectedValue).toBeNull();
    expect(a.target.expectedValue).toBeNull();
    expect(a.probabilityOfProfitShift).toBeNull();
    expect(a.expectedValueShift).toBeNull();
    // netCost and breakevens are plain arithmetic/payoff-curve results, so
    // they still resolve even with no usable IV.
    expect(a.netCost).toBe(0);
    expect(a.breakevenShift).not.toBeNull();
  });
});
