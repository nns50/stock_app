import { describe, it, expect } from 'vitest';
import type { DailyTargetStatus } from '../src/services/autotrading/dailyTarget';
import {
  FINISH_LINE_MIN_FACTOR,
  computeFinishLineFactor,
  finishLineScoreGate,
} from '../src/services/autotrading/finishLine';
import { NEUTRAL, preFinishLineFactors, preFinishLineRiskPct } from '../src/services/autotrading/effectiveRisk';

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

// ---------------------------------------------------------------------------
// The basis this function is handed (2026-09-05).
//
// computeFinishLineFactor's answer is ONE of six multipliers in the sizing
// product, beside step-down, the regime cut, the equity-curve cut and the two
// edge multipliers. It was handed the raw cfg.riskPerTradePct, so whenever any
// of those was below 1 it reasoned about a payoff LARGER than the trade would
// produce: it fired when it should not have, and cut deeper when it did --
// then its own factor multiplied with the cut it had ignored.
//
// One direction only: under-sizing near the goal, precisely after a couple of
// losses. That works against the whole point of having a daily target.
// ---------------------------------------------------------------------------
describe('the finish-line trim reasons about the risk the trade will really take', () => {
  // The live config the defect was found under: 1.25% risk, 2R target, a 50%
  // step-down after 2 consecutive losses, on the real account equity.
  const EQUITY = 5_161;
  const stepDownFactors = (consecutiveLosses: number) =>
    preFinishLineFactors({
      consecutiveLosses,
      stepDownAfterLosses: 2,
      stepDownSizeCutPct: 50,
      marketAtrPct: null,
      regimeAtrThresholdPct: 3,
      regimeSizeCutPct: 0,
      equityCurveDerisk: NEUTRAL,
      expectancy: NEUTRAL,
      method: NEUTRAL,
    });
  const trimAt = (consecutiveLosses: number, currentEquityUsd: number) =>
    computeFinishLineFactor({
      enabled: true,
      dailyTarget: {
        ...tracking(0),
        baselineEquityUsd: EQUITY,
        targetEquityUsd: EQUITY + 160, // a $160 gap when current === EQUITY
        currentEquityUsd,
      },
      equity: EQUITY,
      riskPerTradePct: preFinishLineRiskPct(1.25, stepDownFactors(consecutiveLosses)),
      rewardMultiple: 2,
    });

  it('stays INACTIVE when a step-down already put the real payoff below the gap', () => {
    // Full size: risk $64.51, a 2R win pays $129.03 -- under the $80 gap it
    // would trim. Step-down halves it to a $64.51 payoff, which no longer
    // reaches $80, so there is nothing to trim: the trade cannot overshoot.
    // This is the case that was wrong. On the raw 1.25% it trimmed to 0.62,
    // taking the entry down to a ~$40 win against an $80 gap.
    const gapIs80 = EQUITY + 80;
    const withStepDown = trimAt(2, gapIs80);
    expect(withStepDown.factor).toBe(1);
    expect(withStepDown.detail).toMatch(/still to the bank line/);

    // Same day, no losing streak: full size WOULD overshoot, so it trims.
    const noStepDown = trimAt(0, gapIs80);
    expect(noStepDown.factor).toBeLessThan(1);
  });

  it('quotes the payoff it actually compared against', () => {
    // The detail line is what the operator reads to understand a trimmed
    // entry; it must not name a full-size win the trade was never going to
    // take. $64.51 risk halved -> $32.26, a 2R win of $64.51.
    const d = trimAt(2, EQUITY + 40).detail;
    expect(d).toContain('$64.51');
    expect(d).not.toContain('$129.03');
  });

  it('still trims when the cut trade would overshoot a smaller gap', () => {
    // Cuts elsewhere must not disable the trim outright -- only rebase it.
    // Step-down payoff $64.51 against a $20 gap still overshoots.
    const r = trimAt(2, EQUITY + 140); // target - current = 20
    expect(r.factor).toBeLessThan(1);
    expect(r.factor).toBeGreaterThanOrEqual(FINISH_LINE_MIN_FACTOR);
  });

  it('never lets the rebase size a trade UP', () => {
    // preFinishLineRiskPct only ever shrinks the basis, and the function's own
    // ceiling is 1, so no combination of cuts can produce a factor above 1.
    for (const losses of [0, 2, 9]) {
      for (const equityNow of [EQUITY, EQUITY + 40, EQUITY + 80, EQUITY + 159]) {
        expect(trimAt(losses, equityNow).factor).toBeLessThanOrEqual(1);
      }
    }
  });
});
