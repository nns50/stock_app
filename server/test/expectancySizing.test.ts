import { describe, it, expect } from 'vitest';
import { computeGradeExpectancyMultipliers } from '../src/services/autotrading/expectancySizing';

const CFG = { enabled: true, minTrades: 2, minMultiplier: 0.5, maxMultiplier: 1.5 };

describe('computeGradeExpectancyMultipliers', () => {
  it('returns an empty map when disabled', () => {
    const trades = [
      { grade: 'A', realizedR: 1 },
      { grade: 'A', realizedR: 1 },
    ];
    expect(computeGradeExpectancyMultipliers(trades, { ...CFG, enabled: false })).toEqual({});
  });

  it('sizes a positive-edge grade up and a bleeding grade down (multiplier = 1 + avgR)', () => {
    const trades = [
      { grade: 'A', realizedR: 0.3 },
      { grade: 'A', realizedR: 0.3 },
      { grade: 'B', realizedR: -0.2 },
      { grade: 'B', realizedR: -0.2 },
    ];
    expect(computeGradeExpectancyMultipliers(trades, CFG)).toEqual({ A: 1.3, B: 0.8 });
  });

  it('clamps to the configured bounds', () => {
    const trades = [
      { grade: 'A', realizedR: 2 }, // 1 + 2 = 3 → clamped to max 1.5
      { grade: 'A', realizedR: 2 },
      { grade: 'C', realizedR: -2 }, // 1 − 2 = −1 → clamped to min 0.5
      { grade: 'C', realizedR: -2 },
    ];
    expect(computeGradeExpectancyMultipliers(trades, CFG)).toEqual({ A: 1.5, C: 0.5 });
  });

  it('omits a grade below the min-trades sample floor (caller reads it as neutral)', () => {
    const trades = [
      { grade: 'A', realizedR: 0.5 }, // only 1 A trade, need 2
      { grade: 'B', realizedR: 0.1 },
      { grade: 'B', realizedR: 0.1 },
    ];
    const out = computeGradeExpectancyMultipliers(trades, CFG);
    expect(out.A).toBeUndefined();
    expect(out.B).toBe(1.1);
  });

  it('ignores trades with no grade', () => {
    const trades = [
      { grade: null, realizedR: 5 },
      { grade: null, realizedR: 5 },
      { grade: 'A', realizedR: 0.2 },
      { grade: 'A', realizedR: 0.2 },
    ];
    expect(computeGradeExpectancyMultipliers(trades, CFG)).toEqual({ A: 1.2 });
  });
});
