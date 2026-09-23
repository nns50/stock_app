import { describe, expect, it } from 'vitest';
import {
  EMPTY_BREADTH,
  MIN_BREADTH_SAMPLE,
  breadthOf,
  claimDirectionChange,
  directionRefuses,
  readMarketDirection,
  tapeAlignment,
  type MarketBreadth,
} from '../src/services/autotrading/marketDirection';

// The market-direction reading (2026-09-23). On 2026-09-23 SPY sat 0.3-0.5%
// under its prior close while ~73% of the universe was red, and all four live
// longs bought into it lost. The reading must call that day red, must not call
// a day red on breadth alone or on the index alone, and must refuse nothing it
// cannot see.

/** A breadth of `n` names with the given red and green shares. */
function breadth(redPct: number, greenPct: number, n = 500): MarketBreadth {
  const red = Math.round((redPct / 100) * n);
  const green = Math.round((greenPct / 100) * n);
  return { red, green, flat: n - red - green, sample: n };
}

const read = (indexChangePct: number | null, b: MarketBreadth, indexPct = 0.2, breadthPct = 65) =>
  readMarketDirection({ indexSymbol: 'SPY', indexChangePct, breadth: b, indexPct, breadthPct });

describe('breadthOf', () => {
  it('counts names below, above and at their prior close, and leaves an unmeasured name out', () => {
    expect(breadthOf([-1.2, -0.01, 0, 0.5, null, undefined, Number.NaN])).toEqual({
      red: 2,
      green: 1,
      flat: 1,
      sample: 4,
    });
  });
});

describe('readMarketDirection', () => {
  it('reads 2026-09-23 as a broad red market: SPY −0.35%, 73% of names red', () => {
    const r = read(-0.35, breadth(73, 27));
    expect(r.direction).toBe('red');
    expect(r).toMatchObject({ indexChangePct: -0.35, redPct: 73, greenPct: 27, sample: 500 });
    expect(r.detail).toBe('Broad red market (SPY -0.35%, 73% of 500 names red, 27% green)');
  });

  it('reads the mirror as a broad green market', () => {
    expect(read(0.9, breadth(30, 70)).direction).toBe('green');
  });

  it('needs BOTH legs: a red breadth under a green index is mixed, and so is a red index over green breadth', () => {
    // 2026-08-27: SPY +0.5% while most names were red.
    expect(read(0.5, breadth(72, 27)).direction).toBe('mixed');
    // 2026-08-24 10:00: SPY −0.30% while 70% of names were green.
    expect(read(-0.3, breadth(30, 70)).direction).toBe('mixed');
  });

  it('holds both bars inclusive, and judges the raw values rather than the rounded ones shown', () => {
    expect(read(-0.2, breadth(65, 35)).direction).toBe('red');
    // 324 of 500 is 64.8% — shown as 64.8, below the bar.
    expect(read(-0.5, { red: 324, green: 176, flat: 0, sample: 500 }).direction).toBe('mixed');
    // −0.196% rounds to −0.20 for display and must still miss a 0.2% bar.
    const r = read(-0.196, breadth(80, 20));
    expect(r.indexChangePct).toBe(-0.2);
    expect(r.direction).toBe('mixed');
  });

  it('at an index bar of 0, the index only has to be red at all — never flat', () => {
    expect(read(-0.01, breadth(70, 30), 0).direction).toBe('red');
    expect(read(0, breadth(70, 30), 0).direction).toBe('mixed');
  });

  it('is unknown when there is no index move, or too few names to read breadth from', () => {
    const noIndex = read(null, breadth(80, 20));
    expect(noIndex.direction).toBe('unknown');
    expect(noIndex.detail).toContain('no SPY move');
    const thin = read(-1, breadth(90, 10, MIN_BREADTH_SAMPLE - 1));
    expect(thin.direction).toBe('unknown');
    expect(thin.redPct).toBeNull();
    expect(thin.detail).toContain(`only ${MIN_BREADTH_SAMPLE - 1} names measured`);
    expect(read(-1, EMPTY_BREADTH).direction).toBe('unknown');
  });

  it('carries the thresholds it was judged against', () => {
    expect(read(-1, breadth(90, 10), 0.4, 70)).toMatchObject({ indexPct: 0.4, breadthPct: 70 });
  });
});

describe('directionRefuses', () => {
  const red = read(-0.4, breadth(75, 25));
  const green = read(0.4, breadth(25, 75));
  const mixed = read(0.4, breadth(50, 50));
  const unknown = read(null, breadth(75, 25));

  it('refuses a long on a red day and a short on a green one, and nothing else', () => {
    expect(directionRefuses(red, 'long')).toBe(true);
    expect(directionRefuses(red, 'short')).toBe(false);
    expect(directionRefuses(green, 'short')).toBe(true);
    expect(directionRefuses(green, 'long')).toBe(false);
  });

  it('refuses nothing on a mixed or unknown market, or with no reading at all', () => {
    for (const lean of ['long', 'short'] as const) {
      expect(directionRefuses(mixed, lean)).toBe(false);
      expect(directionRefuses(unknown, lean)).toBe(false);
      expect(directionRefuses(null, lean)).toBe(false);
    }
  });
});

describe('tapeAlignment — the leak scan’s dimension', () => {
  it('places an entry with, against or beside the tape', () => {
    expect(tapeAlignment('red', 'long')).toBe('against');
    expect(tapeAlignment('red', 'short')).toBe('with');
    expect(tapeAlignment('green', 'long')).toBe('with');
    expect(tapeAlignment('green', 'short')).toBe('against');
    expect(tapeAlignment('mixed', 'long')).toBe('mixed');
  });

  it('places nothing without a reading', () => {
    expect(tapeAlignment('unknown', 'long')).toBeNull();
    expect(tapeAlignment(null, 'short')).toBeNull();
  });
});

describe('claimDirectionChange — one journal row per change', () => {
  it('claims the first reading of the day and each flip, not a repeat', () => {
    expect(claimDirectionChange('2026-09-23', 'red')).toBe(true);
    expect(claimDirectionChange('2026-09-23', 'red')).toBe(false);
    expect(claimDirectionChange('2026-09-23', 'mixed')).toBe(true);
    expect(claimDirectionChange('2026-09-23', 'red')).toBe(true);
    // A new day starts over, even in the same direction.
    expect(claimDirectionChange('2026-09-24', 'red')).toBe(true);
  });
});
