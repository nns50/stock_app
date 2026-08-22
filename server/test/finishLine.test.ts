import { describe, it, expect } from 'vitest';
import type { DailyTargetStatus } from '../src/services/autotrading/dailyTarget';
import {
  FINISH_LINE_MIN_FACTOR,
  computeFinishLineFactor,
  finishLineScoreGate,
} from '../src/services/autotrading/finishLine';

// A day tracking a 3% goal off a $10,000 baseline: banks at $10,300.
const tracking = (currentEquityUsd: number, over: Partial<DailyTargetStatus> = {}): DailyTargetStatus => ({
  active: true,
  targetPct: 3,
  baselineEquityUsd: 10_000,
  targetEquityUsd: 10_300,
  currentEquityUsd,
  gainPct: ((currentEquityUsd - 10_000) / 10_000) * 100,
  reached: false,
  reachedAt: null,
  giveBackArmed: false,
  giveBackHalted: false,
  giveBackArmPct: 2,
  giveBackFloorPct: 1,
  giveBackHaltedAt: null,
  entriesHalted: false,
  ...over,
});

const inactive: DailyTargetStatus = {
  active: false,
  reached: false,
  giveBackArmed: false,
  giveBackHalted: false,
  entriesHalted: false,
};

describe('computeFinishLineFactor', () => {
  // Full-size risk $200 (2% of $10k), 2R target => a full winner pays ~$400.
  const base = { enabled: true, equity: 10_000, riskPerTradePct: 2, rewardMultiple: 2 };

  it('is 1 when disabled or the goal is unmeasurable', () => {
    expect(computeFinishLineFactor({ ...base, enabled: false, dailyTarget: tracking(10_200) }).factor).toBe(1);
    expect(computeFinishLineFactor({ ...base, dailyTarget: inactive }).factor).toBe(1);
  });

  it('is 1 while the gap still needs at least a full-size winner — NEVER sizes up behind the target', () => {
    // $500 to the line > $400 full win: full size, no trim, no press.
    const r = computeFinishLineFactor({ ...base, dailyTarget: tracking(9_800) });
    expect(r.factor).toBe(1);
    expect(r.detail).toMatch(/inactive/);
  });

  it('trims the closing trade to just what banks the day', () => {
    // +2% day: $100 to the line vs a $400 full win => quarter... exactly 0.25.
    expect(computeFinishLineFactor({ ...base, dailyTarget: tracking(10_200) }).factor).toBe(0.25);
    // +1% day: $200 gap / $400 full win => half size.
    expect(computeFinishLineFactor({ ...base, dailyTarget: tracking(10_100) }).factor).toBe(0.5);
  });

  it('floors at quarter size so the closing trade stays viable — no dead zone under the line', () => {
    // +2.9% day: $10 gap / $400 => 0.03 raw, floored.
    const r = computeFinishLineFactor({ ...base, dailyTarget: tracking(10_290) });
    expect(r.factor).toBe(FINISH_LINE_MIN_FACTOR);
  });

  it('is 1 at/past the line — the bank halt owns that state, not a trim', () => {
    expect(computeFinishLineFactor({ ...base, dailyTarget: tracking(10_300) }).factor).toBe(1);
  });

  it('degrades to 1 on a nonsense payoff rather than dividing by zero', () => {
    expect(computeFinishLineFactor({ ...base, rewardMultiple: 0, dailyTarget: tracking(10_200) }).factor).toBe(1);
  });
});

describe('finishLineScoreGate', () => {
  const cfg = { finishLineMinSignalScore: 70 };

  it('never gates while off (0), unarmed, or untracked', () => {
    expect(
      finishLineScoreGate(10, tracking(10_250, { giveBackArmed: true }), { finishLineMinSignalScore: 0 }).skip,
    ).toBe(false);
    expect(finishLineScoreGate(10, tracking(10_150), cfg).skip).toBe(false); // not armed
    expect(finishLineScoreGate(10, inactive, cfg).skip).toBe(false);
  });

  it('once ARMED, entries below the bar are skipped and entries at/above pass', () => {
    const armed = tracking(10_250, { giveBackArmed: true });
    expect(finishLineScoreGate(69, armed, cfg)).toMatchObject({ skip: true });
    expect(finishLineScoreGate(70, armed, cfg)).toMatchObject({ skip: false });
  });
});
