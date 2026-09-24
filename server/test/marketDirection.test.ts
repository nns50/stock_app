import { describe, expect, it } from 'vitest';
import {
  DIRECTION_DATA_GAP_HOLD_MS,
  EMPTY_BREADTH,
  LATEST_DIRECTION_MAX_AGE_MS,
  MIN_BREADTH_SAMPLE,
  breadthOf,
  claimDirectionChange,
  directionRefuses,
  liveShortPermitted,
  holdMarketDirection,
  latestMarketDirection,
  readMarketDirection,
  readMarketDirectionForTick,
  resetMarketDirectionState,
  tapeAlignment,
  type HeldDirection,
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

// 2026-09-24, the tape plan's PR 8: ONE predicate for every live short (the
// entry, a scale-in, a second lot).
describe('liveShortPermitted', () => {
  const on = { liveAllowNakedShort: true, liveShortsRedTapeOnly: true };
  const tape = (direction: 'red' | 'green' | 'mixed' | 'unknown') => ({ direction });

  it('refuses every short while the switch is off, whatever the tape', () => {
    for (const reading of [tape('red'), tape('mixed'), null]) {
      expect(liveShortPermitted({ ...on, liveAllowNakedShort: false }, reading)).toEqual({
        permitted: false,
        cause: 'shorts_off',
        reason: 'liveAllowNakedShort is off',
      });
    }
  });

  it('admits a short on a red tape only, while held to one', () => {
    expect(liveShortPermitted(on, tape('red'))).toEqual({ permitted: true });
    // "Not green" is not the rule: a mixed tape is exactly what it keeps out.
    for (const [reading, word] of [
      [tape('mixed'), 'mixed'],
      [tape('green'), 'green'],
      [tape('unknown'), 'unknown'],
      [null, 'unread'],
    ] as const) {
      expect(liveShortPermitted(on, reading)).toEqual({
        permitted: false,
        cause: 'red_tape_only',
        reason: `red-tape only: the tape is ${word}`,
      });
    }
  });

  it('admits a short on any tape with the red-tape rule off', () => {
    for (const reading of [tape('red'), tape('mixed'), tape('green'), null]) {
      expect(liveShortPermitted({ ...on, liveShortsRedTapeOnly: false }, reading)).toEqual({ permitted: true });
    }
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

  it('claims a hold starting and ending as changes too, so the journal shows when the bar stopped being met', () => {
    expect(claimDirectionChange('2026-09-24', 'red')).toBe(true);
    expect(claimDirectionChange('2026-09-24', 'red', 'hysteresis')).toBe(true);
    expect(claimDirectionChange('2026-09-24', 'red', 'hysteresis')).toBe(false);
    expect(claimDirectionChange('2026-09-24', 'red', 'data_gap')).toBe(true);
    expect(claimDirectionChange('2026-09-24', 'red')).toBe(true);
  });
});

// THE HOLD (2026-09-24). Replayed over 22 sessions, the 0.2% / 65% bar changed
// label 7.4 times a session and 4.5 of those were undone within 10 minutes: a
// tape sitting near the bar crosses it back and forth, and each dip to mixed in
// the middle of a red day lets that tick's longs through.
describe('holdMarketDirection — the exit band and the data-gap hold', () => {
  const DAY = '2026-09-24';
  const T0 = Date.UTC(2026, 8, 24, 14, 0, 0);
  const MIN = 60_000;
  const step = (
    indexChangePct: number | null,
    b: MarketBreadth,
    prev: HeldDirection | null,
    now: number,
    day = DAY,
    band = { exitIndexPct: 0.1, exitBreadthPct: 60 },
  ) =>
    holdMarketDirection(
      { indexSymbol: 'SPY', indexChangePct, breadth: b, indexPct: 0.2, breadthPct: 65, ...band },
      prev,
      now,
      day,
    );

  it('enters on the full bar and stays inside the exit band, saying it is held', () => {
    const entered = step(-0.35, breadth(73, 27), null, T0);
    expect(entered.reading.direction).toBe('red');
    expect(entered.reading.heldBy).toBeUndefined();
    expect(entered.held).toEqual({ direction: 'red', day: DAY, confirmedAt: T0 });

    // SPY −0.15% and 62% red: under the 0.2 / 65 bar, inside the 0.1 / 60 band.
    const held = step(-0.15, breadth(62, 38), entered.held, T0 + 2 * MIN);
    expect(held.reading).toMatchObject({
      direction: 'red',
      rawDirection: 'mixed',
      heldBy: 'hysteresis',
      exitIndexPct: 0.1,
      exitBreadthPct: 60,
      indexChangePct: -0.15,
      redPct: 62,
    });
    expect(held.reading.detail).toMatch(/^Broad red market, held \(SPY -0\.15%, 62% of 500 names red/);
    // A readable tape inside the band confirms the direction again.
    expect(held.held).toEqual({ direction: 'red', day: DAY, confirmedAt: T0 + 2 * MIN });
    expect(directionRefuses(held.reading, 'long')).toBe(true);
  });

  it('lets go when EITHER leg leaves the band, and the index must stay on the day’s side of zero', () => {
    const prev: HeldDirection = { direction: 'red', day: DAY, confirmedAt: T0 };
    // Breadth leg out: 59% red.
    expect(step(-0.3, breadth(59, 41), prev, T0 + MIN)).toMatchObject({ reading: { direction: 'mixed' }, held: null });
    // Index leg out: SPY −0.05%.
    expect(step(-0.05, breadth(70, 30), prev, T0 + MIN).reading.direction).toBe('mixed');
    // Exactly on the band holds (inclusive, like the bar)...
    expect(step(-0.1, breadth(60, 40), prev, T0 + MIN).reading.heldBy).toBe('hysteresis');
    // ...but a band of 0 still needs SPY red at all, never flat.
    const zeroBand = { exitIndexPct: 0, exitBreadthPct: 60 };
    expect(step(-0.01, breadth(70, 30), prev, T0 + MIN, DAY, zeroBand).reading.direction).toBe('red');
    expect(step(0, breadth(70, 30), prev, T0 + MIN, DAY, zeroBand).reading.direction).toBe('mixed');
  });

  it('holds green the same way, mirrored', () => {
    const entered = step(0.4, breadth(25, 75), null, T0);
    expect(entered.reading.direction).toBe('green');
    const held = step(0.12, breadth(38, 61), entered.held, T0 + MIN);
    expect(held.reading).toMatchObject({ direction: 'green', heldBy: 'hysteresis' });
    expect(directionRefuses(held.reading, 'short')).toBe(true);
    expect(step(0.12, breadth(45, 55), entered.held, T0 + MIN).reading.direction).toBe('mixed');
  });

  it('never applies a band stricter than the bar, and says which band applied', () => {
    const r = step(-0.35, breadth(73, 27), null, T0, DAY, { exitIndexPct: 0.3, exitBreadthPct: 70 });
    expect(r.reading).toMatchObject({ exitIndexPct: 0.2, exitBreadthPct: 65 });
  });

  it('holds through a tick it cannot see, for DIRECTION_DATA_GAP_HOLD_MS after the last confirmation, and no longer', () => {
    const entered = step(-0.35, breadth(73, 27), null, T0);
    // The screen mostly failed: 40 names measured.
    const blind = step(-0.35, breadth(73, 27, 40), entered.held, T0 + 2 * MIN);
    expect(blind.reading).toMatchObject({ direction: 'red', rawDirection: 'unknown', heldBy: 'data_gap' });
    expect(blind.reading.detail).toContain('held through a data gap (Market direction unknown: only 40 names measured');
    // A gap never extends itself: the confirmation stays where it was.
    expect(blind.held).toEqual(entered.held);
    // No index move at all, still inside the hold.
    const blinder = step(null, breadth(73, 27), blind.held, T0 + DIRECTION_DATA_GAP_HOLD_MS);
    expect(blinder.reading.heldBy).toBe('data_gap');
    // One millisecond past the hold: unknown, which refuses nothing.
    const lapsed = step(null, breadth(73, 27), blinder.held, T0 + DIRECTION_DATA_GAP_HOLD_MS + 1);
    expect(lapsed).toMatchObject({ reading: { direction: 'unknown' }, held: null });
    expect(lapsed.reading.heldBy).toBeUndefined();
  });

  it('counts a hysteresis hold as a confirmation for the data-gap hold', () => {
    const entered = step(-0.35, breadth(73, 27), null, T0);
    const banded = step(-0.15, breadth(62, 38), entered.held, T0 + 4 * MIN);
    const blind = step(null, breadth(62, 38), banded.held, T0 + 8 * MIN);
    expect(blind.reading).toMatchObject({ direction: 'red', heldBy: 'data_gap' });
  });

  it('never carries a hold into another ET day', () => {
    const yesterday: HeldDirection = { direction: 'red', day: '2026-09-23', confirmedAt: T0 - MIN };
    expect(step(-0.15, breadth(62, 38), yesterday, T0).reading.direction).toBe('mixed');
    expect(step(null, breadth(62, 38), yesterday, T0).reading.direction).toBe('unknown');
  });

  it('flips straight from a held green to red when red meets the bar', () => {
    const prev: HeldDirection = { direction: 'green', day: DAY, confirmedAt: T0 };
    const r = step(-0.35, breadth(73, 27), prev, T0 + MIN);
    expect(r.reading.direction).toBe('red');
    expect(r.held?.direction).toBe('red');
  });

  it('turns a tape flickering around the bar into one label change instead of three', () => {
    // A red morning easing off: the bar alone reads red, mixed, mixed, red,
    // mixed, mixed. The band holds red until the tape really lets go.
    const tape: [number, number][] = [
      [-0.35, 73],
      [-0.19, 66],
      [-0.3, 64],
      [-0.25, 67],
      [-0.15, 61],
      [-0.05, 58],
    ];
    let held: HeldDirection | null = null;
    const labels: string[] = [];
    const raw: string[] = [];
    tape.forEach(([spy, red], i) => {
      const r = step(spy, breadth(red, 100 - red), held, T0 + i * 2 * MIN);
      held = r.held;
      labels.push(r.reading.direction);
      raw.push(r.reading.rawDirection ?? r.reading.direction);
    });
    expect(raw).toEqual(['red', 'mixed', 'mixed', 'red', 'mixed', 'mixed']);
    expect(labels).toEqual(['red', 'red', 'red', 'red', 'red', 'mixed']);
  });
});

describe('the loop’s held reading — readMarketDirectionForTick and latestMarketDirection', () => {
  const DAY = '2026-09-24';
  const T0 = Date.UTC(2026, 8, 24, 14, 0, 0);
  const input = (indexChangePct: number, red: number) => ({
    indexSymbol: 'SPY',
    indexChangePct,
    breadth: breadth(red, 100 - red),
    indexPct: 0.2,
    breadthPct: 65,
    exitIndexPct: 0.1,
    exitBreadthPct: 60,
  });

  it('carries the hold from one tick to the next', () => {
    expect(readMarketDirectionForTick(input(-0.35, 73), T0, DAY).direction).toBe('red');
    expect(readMarketDirectionForTick(input(-0.15, 62), T0 + 130_000, DAY)).toMatchObject({
      direction: 'red',
      heldBy: 'hysteresis',
    });
    resetMarketDirectionState();
    // With the hold forgotten, the same tape is only mixed.
    expect(readMarketDirectionForTick(input(-0.15, 62), T0 + 260_000, DAY).direction).toBe('mixed');
  });

  it('hands the add-on gates the last reading with its age, until it is too old to stand for now', () => {
    expect(latestMarketDirection(T0)).toBeNull();
    readMarketDirectionForTick(input(-0.35, 73), T0, DAY);
    expect(latestMarketDirection(T0 + 130_000)).toMatchObject({ reading: { direction: 'red' }, ageMs: 130_000 });
    expect(latestMarketDirection(T0 + LATEST_DIRECTION_MAX_AGE_MS)).not.toBeNull();
    expect(latestMarketDirection(T0 + LATEST_DIRECTION_MAX_AGE_MS + 1)).toBeNull();
  });
});
