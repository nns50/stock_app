import { describe, it, expect } from 'vitest';
import {
  entryDriftPct,
  orderRiskAmount,
  riskBasisPrice,
  riskCappedQuantity,
  riskInflationFactor,
} from '../src/services/autotrading/entryRisk';

// The weight of these behaviours is asserted at the CONSUMER — see
// autotradeLiveExecute.test.ts's "the entry is sized against the price it will
// pay", which drives them through a real placement. What is left here is the
// arithmetic those cases cannot pin down: the degenerate inputs that must
// return "no opinion" rather than zero, and the sign convention.
describe('orderRiskAmount', () => {
  it('is the distance to the stop times the size', () => {
    expect(orderRiskAmount(104, 95, 50)).toBeCloseTo(450, 6);
    expect(orderRiskAmount(95, 104, 50)).toBeCloseTo(450, 6); // a short, same distance
  });

  it('is zero for anything it cannot price, rather than NaN', () => {
    expect(orderRiskAmount(0, 95, 50)).toBe(0);
    expect(orderRiskAmount(104, 0, 50)).toBe(0);
    expect(orderRiskAmount(104, 95, 0)).toBe(0);
  });
});

describe('riskCappedQuantity', () => {
  it('floors to whole shares inside the budget', () => {
    expect(riskCappedQuantity(104, 95, 500)).toBe(55); // 500 / 9 = 55.55
  });

  it('returns "no opinion" — not zero — when it cannot answer', () => {
    // The distinction is load-bearing: the caller takes the MINIMUM of this
    // and the risk-checked size, so a 0 here would silently refuse every
    // entry, while undefined leaves the size exactly as it was.
    expect(riskCappedQuantity(100, 100, 500)).toBeUndefined(); // zero-width stop
    expect(riskCappedQuantity(104, 95, 0)).toBeUndefined();
    expect(riskCappedQuantity(0, 95, 500)).toBeUndefined();
  });
});

describe('entryDriftPct', () => {
  it('signs adverse as positive on BOTH sides', () => {
    // A buy paying up and a short selling down are the same event. Unsigned,
    // a book doing both would average to nothing and read as calm.
    expect(entryDriftPct(100, 104, 'buy')).toBeCloseTo(4, 6);
    expect(entryDriftPct(100, 96, 'sell')).toBeCloseTo(4, 6);
    expect(entryDriftPct(100, 96, 'buy')).toBeCloseTo(-4, 6);
    expect(entryDriftPct(100, 104, 'sell')).toBeCloseTo(-4, 6);
  });

  it('is null when either price is unusable', () => {
    expect(entryDriftPct(0, 104, 'buy')).toBeNull();
    expect(entryDriftPct(100, 0, 'buy')).toBeNull();
  });
});

describe('riskBasisPrice', () => {
  it('is the quote, not the limit', () => {
    // Stated as a test because the two are interchangeable to the eye and are
    // not to the account: notional is reserved at the limit, risk is realized
    // at the fill, and the fill lands at the quote.
    expect(riskBasisPrice(104)).toBe(104);
  });
});

describe('riskInflationFactor', () => {
  it('reads the SWKS row: a 2.5% plan that filled 3.64% from its stop', () => {
    expect(riskInflationFactor({ fillPrice: 91.23, stopPrice: 87.91, plannedStopDistancePct: 2.5 })).toBeCloseTo(
      1.456,
      3,
    );
  });

  it('is 1 when the fill landed where the sizer assumed', () => {
    expect(riskInflationFactor({ fillPrice: 100, stopPrice: 97.5, plannedStopDistancePct: 2.5 })).toBeCloseTo(1, 6);
  });

  it('is null for a row that cannot answer, never a guessed 1', () => {
    expect(riskInflationFactor({ fillPrice: 100, stopPrice: 97.5, plannedStopDistancePct: null })).toBeNull();
    expect(riskInflationFactor({ fillPrice: 100, stopPrice: 100, plannedStopDistancePct: 2.5 })).toBeNull();
    expect(riskInflationFactor({ fillPrice: 0, stopPrice: 97.5, plannedStopDistancePct: 2.5 })).toBeNull();
  });
});
