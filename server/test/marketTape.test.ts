import { describe, it, expect } from 'vitest';
import {
  TAPE_LEGS,
  TapeLegInputs,
  breadthMomentum30,
  breadthNetOf,
  claimTapeJournal,
  indexLegsOf,
  meanOfPresent,
  pctFrom,
  recordBreadthNet,
  scoreMarketTape,
  tapeDetailLine,
  TAPE_JOURNAL_HEARTBEAT_MS,
} from '../src/services/autotrading/marketTape';

// The ring and the journal claim are process state; test/setupProcessState.ts
// resets both before every test.

const NONE: TapeLegInputs = {
  indexVsPrevClose: null,
  breadthNet: null,
  indexVsOpen: null,
  indexVsVwap: null,
  indexSlope30: null,
  breadthMomentum30: null,
};

// A broad red morning like 2026-09-23's: SPY and QQQ a little under their
// prior close and further under their open and VWAP, still falling, and 73%
// of the universe red, more of it than half an hour earlier.
const RED_MORNING: TapeLegInputs = {
  indexVsPrevClose: -0.45,
  breadthNet: -0.46,
  indexVsOpen: -0.6,
  indexVsVwap: -0.3,
  indexSlope30: -0.2,
  breadthMomentum30: -0.1,
};

const mirror = (x: TapeLegInputs): TapeLegInputs =>
  Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v === null ? null : -v])) as TapeLegInputs;

describe('scoreMarketTape — the weighted legs', () => {
  it('scores a broad red morning deep red, and its mirror as deep green', () => {
    const red = scoreMarketTape('red', RED_MORNING);
    // 25x(-0.45/1.17) + 25x(-1, breadth past its scale) + 15x(-0.6/0.77)
    // + 15x(-0.3/0.39) + 10x(-0.2/0.23) + 10x(-0.1/0.11) = -75.6.
    expect(red.score).toBe(-76);
    expect(red.coverage).toBe(100);
    expect(scoreMarketTape('green', mirror(RED_MORNING)).score).toBe(76);
    // The breadth leg is past its scale, and clamps at -1 rather than
    // outweighing the others.
    expect(red.components.find((c) => c.leg === 'breadthNet')).toMatchObject({ value: -0.46, sub: -1 });
  });

  it('is null exactly when the direction is unknown, and says how much it measured', () => {
    const unknown = scoreMarketTape('unknown', RED_MORNING);
    expect(unknown.score).toBeNull();
    expect(unknown.coverage).toBe(100);
    // A known label with every leg present still scores; one with none cannot.
    expect(scoreMarketTape('mixed', NONE)).toMatchObject({ score: null, coverage: 0 });
  });

  it('renormalizes over the legs present, and reports the coverage', () => {
    // Only the label's own two legs, both at their scale: -100 over 50% of
    // the weight, not -50 over all of it.
    const two = scoreMarketTape('red', { ...NONE, indexVsPrevClose: -1.17, breadthNet: -0.42 });
    expect(two).toMatchObject({ score: -100, coverage: 50 });
    // Without the VWAP leg (15 of 100): the other five renormalize over 85,
    // -64.09 / 85 = -75.4. Over all 100 it would read -64.
    const noVwap = scoreMarketTape('red', { ...RED_MORNING, indexVsVwap: null });
    expect(noVwap.coverage).toBe(85);
    expect(noVwap.score).toBe(-75);
    expect(noVwap.components.find((c) => c.leg === 'indexVsVwap')).toMatchObject({ value: null, sub: null });
  });

  it('clamps every leg at its scale, so no one leg can carry the score past +/-100', () => {
    const extreme = scoreMarketTape('red', {
      indexVsPrevClose: -9,
      breadthNet: -1,
      indexVsOpen: -9,
      indexVsVwap: -9,
      indexSlope30: -9,
      breadthMomentum30: -1,
    });
    expect(extreme.score).toBe(-100);
    expect(extreme.components.every((c) => c.sub === -1)).toBe(true);
  });

  it('reads a flat tape as 0, not -0', () => {
    const flat = scoreMarketTape('mixed', {
      indexVsPrevClose: 0,
      breadthNet: 0,
      indexVsOpen: 0,
      indexVsVwap: 0,
      indexSlope30: 0,
      breadthMomentum30: 0,
    });
    expect(Object.is(flat.score, 0)).toBe(true);
  });

  it('weights sum to 100 and every scale is positive (the frozen table)', () => {
    expect(TAPE_LEGS.reduce((s, l) => s + l.weight, 0)).toBe(100);
    expect(TAPE_LEGS.every((l) => l.scale > 0)).toBe(true);
  });
});

describe('the index legs — SPY and QQQ averaged over whichever answered', () => {
  it('averages each leg over the indexes that answered', () => {
    const legs = indexLegsOf([
      { symbol: 'SPY', vsPrevClose: -0.4, last: 99, open: 100, vwap: 99.5, closeThirtyMinAgo: 99.2 },
      { symbol: 'QQQ', vsPrevClose: -0.8, last: 198, open: 200, vwap: null, closeThirtyMinAgo: null },
    ]);
    expect(legs.indexVsPrevClose).toBeCloseTo(-0.6, 10);
    expect(legs.indexVsOpen).toBeCloseTo((-1 + -1) / 2, 10);
    // QQQ has no VWAP and no 30-minute reference: SPY's alone.
    expect(legs.indexVsVwap).toBeCloseTo(((99 - 99.5) / 99.5) * 100, 10);
    expect(legs.indexSlope30).toBeCloseTo(((99 - 99.2) / 99.2) * 100, 10);
  });

  it('is null for a leg neither index could measure', () => {
    const legs = indexLegsOf([
      { symbol: 'SPY', vsPrevClose: null, last: null, open: 100, vwap: 100, closeThirtyMinAgo: 100 },
    ]);
    expect(legs).toEqual({ indexVsPrevClose: null, indexVsOpen: null, indexVsVwap: null, indexSlope30: null });
  });

  it('pctFrom and meanOfPresent refuse what they cannot measure', () => {
    expect(pctFrom(101, 100)).toBeCloseTo(1, 10);
    expect(pctFrom(null, 100)).toBeNull();
    expect(pctFrom(101, 0)).toBeNull();
    expect(pctFrom(Number.NaN, 100)).toBeNull();
    expect(meanOfPresent([null, 2, 4, Number.NaN])).toBe(3);
    expect(meanOfPresent([null])).toBeNull();
  });

  it('breadth is a net share, and no reading under the direction reading’s sample floor', () => {
    expect(breadthNetOf({ red: 365, green: 135, flat: 0, sample: 500 })).toBeCloseTo(-0.46, 10);
    expect(breadthNetOf({ red: 60, green: 30, flat: 9, sample: 99 })).toBeNull();
  });
});

describe('breadth momentum — the ring of this session’s breadth', () => {
  const T0 = Date.parse('2026-09-28T14:00:00Z'); // 10:00 ET
  const min = (m: number) => T0 + m * 60_000;
  const DAY = '2026-09-28';

  it('is null until the ring reaches back 25 minutes, then reads the change from ~30 minutes ago', () => {
    for (let m = 0; m <= 20; m += 2) recordBreadthNet(DAY, min(m), -0.2 - m / 100);
    // At 24 minutes the oldest sample is 24 minutes old: no reference yet.
    expect(breadthMomentum30(DAY, min(24), -0.5)).toBeNull();
    // At 26: the 0-minute sample (-0.2) is 26 minutes old, inside the
    // tolerance of the 30-minute mark, and the closest to it.
    expect(breadthMomentum30(DAY, min(26), -0.5)).toBeCloseTo(-0.3, 10);
    // At 36 the closest to the mark (6 minutes) is the 6-minute one (-0.26).
    expect(breadthMomentum30(DAY, min(36), -0.5)).toBeCloseTo(-0.24, 10);
  });

  it('after a gap it is null, never a change measured over an hour', () => {
    recordBreadthNet(DAY, min(0), -0.2);
    recordBreadthNet(DAY, min(60), -0.5);
    expect(breadthMomentum30(DAY, min(62), -0.5)).toBeNull();
  });

  it('starts empty on a new ET day, and keeps no null', () => {
    recordBreadthNet(DAY, min(0), -0.2);
    expect(breadthMomentum30('2026-09-29', min(30), -0.5)).toBeNull();
    recordBreadthNet('2026-09-29', min(30), null);
    recordBreadthNet('2026-09-29', min(31), -0.4);
    // The day's ring holds only the 31-minute sample; the null left nothing.
    expect(breadthMomentum30('2026-09-29', min(60), -0.5)).toBeCloseTo(-0.1, 10);
    // And a null current value has no momentum.
    expect(breadthMomentum30('2026-09-29', min(61), null)).toBeNull();
  });
});

describe('claimTapeJournal — a row on a change, a move of 5, or every 10 minutes', () => {
  const at = (m: number) => Date.parse('2026-09-28T14:00:00Z') + m * 60_000;
  const DAY = '2026-09-28';

  it('journals the first reading, then only what moved', () => {
    expect(claimTapeJournal(DAY, 'mixed', -10, at(0))).toBe(true);
    expect(claimTapeJournal(DAY, 'mixed', -12, at(2))).toBe(false);
    // A drift of 4 from the last ROW is not enough; 5 is, even in two steps.
    expect(claimTapeJournal(DAY, 'mixed', -14, at(4))).toBe(false);
    expect(claimTapeJournal(DAY, 'mixed', -15, at(6))).toBe(true);
    // A change of label, even at the same score.
    expect(claimTapeJournal(DAY, 'red', -15, at(7))).toBe(true);
    // A score going null (the direction unknown), and coming back.
    expect(claimTapeJournal(DAY, 'unknown', null, at(8))).toBe(true);
    expect(claimTapeJournal(DAY, 'unknown', null, at(9))).toBe(false);
    expect(claimTapeJournal(DAY, 'red', -15, at(9))).toBe(true);
  });

  it('writes a heartbeat after 10 quiet minutes, and a first row on a new day', () => {
    expect(claimTapeJournal(DAY, 'mixed', 3, at(0))).toBe(true);
    expect(claimTapeJournal(DAY, 'mixed', 3, at(0) + TAPE_JOURNAL_HEARTBEAT_MS - 1)).toBe(false);
    expect(claimTapeJournal(DAY, 'mixed', 3, at(0) + TAPE_JOURNAL_HEARTBEAT_MS)).toBe(true);
    expect(claimTapeJournal('2026-09-29', 'mixed', 3, at(11))).toBe(true);
  });
});

describe('tapeDetailLine — the Last cycle line', () => {
  const label = { indexSymbol: 'SPY', indexChangePct: -0.45, redPct: 73, greenPct: 27 };

  it('reads the score, the index, the dominant side and where breadth is heading', () => {
    expect(tapeDetailLine(scoreMarketTape('red', RED_MORNING), label)).toBe(
      'Tape -76 · SPY -0.45% · 73% red · breadth falling',
    );
    const green = tapeDetailLine(scoreMarketTape('green', mirror(RED_MORNING)), {
      indexSymbol: 'SPY',
      indexChangePct: 0.45,
      redPct: 27,
      greenPct: 73,
    });
    expect(green).toBe('Tape +76 · SPY +0.45% · 73% green · breadth rising');
  });

  it('says what it could not measure', () => {
    const partial = scoreMarketTape('red', { ...NONE, indexVsPrevClose: -0.45, breadthNet: -0.46 });
    // (25 x -0.385 + 25 x -1) / 50 = -69.
    expect(tapeDetailLine(partial, label)).toBe('Tape -69 · SPY -0.45% · 73% red · 50% of legs');
    expect(tapeDetailLine(scoreMarketTape('unknown', RED_MORNING), label)).toBe(
      'Tape unscored: the market direction is unknown this tick',
    );
  });
});
