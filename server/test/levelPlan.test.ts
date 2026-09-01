import { describe, it, expect } from 'vitest';
import { planAroundLevels, LevelPlanConfig } from '../src/services/autotrading/levelPlan';
import type { PriceLevel } from '../src/indicators/levels';

const level = (price: number, over: Partial<PriceLevel> = {}): PriceLevel => ({
  price,
  halfWidth: 0,
  touches: 3,
  barsSinceTouch: 10,
  from: 'highs',
  strength: 0.8,
  isExtreme: false,
  ...over,
});

const cfg: LevelPlanConfig = {
  enabled: true,
  minStrength: 0.35,
  bufferPct: 0.15,
  maxStopWidenPct: 60,
  minRewardR: 1,
  // Off in the shared fixture so the pre-2026-09-01 describes below keep
  // testing exactly what they were written to test; the reach/breakout
  // describes opt in explicitly.
  targetReachAtrMultiple: 0,
  breakoutRelVolPace: 0,
};

// A long: entry 100, ATR stop 95 (risk 5), 2R target 110.
const long = { side: 'long' as const, entry: 100, stop: 95, target: 110 };

describe('planAroundLevels — off / nothing to do', () => {
  it('returns the ATR plan untouched when disabled', () => {
    const p = planAroundLevels({ ...long, levels: [level(105)], cfg: { ...cfg, enabled: false } });
    expect(p).toMatchObject({ stop: 95, target: 110, veto: false, stopAdjusted: false, targetAdjusted: false });
  });

  it('returns it untouched when there is no confirmed structure', () => {
    const p = planAroundLevels({ ...long, levels: [], cfg });
    expect(p).toMatchObject({ stop: 95, target: 110, veto: false });
    expect(p.detail).toMatch(/no confirmed structure/);
  });

  it('leaves an ATR plan that already clears the structure alone', () => {
    // Resistance far above the 110 target, support far below the 95 stop.
    const p = planAroundLevels({ ...long, levels: [level(130), level(80, { from: 'lows' })], cfg });
    expect(p).toMatchObject({ stop: 95, target: 110, stopAdjusted: false, targetAdjusted: false, veto: false });
  });

  it('ignores levels below the strength floor — a lone stale touch is not a wall', () => {
    const p = planAroundLevels({ ...long, levels: [level(103, { strength: 0.1, touches: 1 })], cfg });
    expect(p.targetAdjusted).toBe(false);
  });
});

describe('planAroundLevels — stop placement', () => {
  it('widens the stop to sit BEYOND support it would otherwise be taken out above', () => {
    // Support 93, ATR stop 95: the stop sits ABOVE the level, so a routine dip
    // toward support takes the trade out before the level even gets tested.
    const p = planAroundLevels({ ...long, levels: [level(93, { from: 'lows' })], cfg });
    expect(p.stopAdjusted).toBe(true);
    expect(p.stop).toBeCloseTo(93 - 100 * 0.0015, 2); // support minus the buffer
    expect(p.stop).toBeLessThan(93);
  });

  it('never TIGHTENS the stop toward a level — a stop already under support is correctly placed', () => {
    // Support 96, stop 95: the stop already sits just BELOW the level, which is
    // exactly where it belongs. Pulling it up to 95.85 would risk less but sit
    // inside the zone — never done.
    const p = planAroundLevels({ ...long, levels: [level(96, { from: 'lows' })], cfg });
    expect(p.stop).toBe(95);
    expect(p.stopAdjusted).toBe(false);
  });

  it('refuses to widen past the cap — a far level cannot turn a scalp into a swing', () => {
    // Support at 80 would mean a 20-wide stop vs the 5 the ATR asked for (300%).
    const p = planAroundLevels({ ...long, levels: [level(80, { from: 'lows' })], cfg });
    expect(p.stop).toBe(95);
    expect(p.stopAdjusted).toBe(false);
  });

  it('mirrors correctly for a short — the stop clears resistance ABOVE', () => {
    const short = { side: 'short' as const, entry: 100, stop: 105, target: 90 };
    // Stop 105 sits BELOW resistance 107 — a rally to the level stops the
    // short out before the level can reject price.
    const p = planAroundLevels({ ...short, levels: [level(107)], cfg });
    expect(p.stopAdjusted).toBe(true);
    expect(p.stop).toBeGreaterThan(107);
  });
});

describe('planAroundLevels — target capping', () => {
  it('caps a target set THROUGH a wall to just short of it', () => {
    // The real VALE shape: 2R target beyond a resistance that has held twice.
    const p = planAroundLevels({ ...long, levels: [level(106, { touches: 2 })], cfg });
    expect(p.targetAdjusted).toBe(true);
    expect(p.target).toBeLessThan(106);
    expect(p.target).toBeCloseTo(106 - 100 * 0.0015, 2);
    expect(p.detail).toMatch(/capped/);
  });

  it('leaves a target that stops short of the wall alone', () => {
    const p = planAroundLevels({ ...long, levels: [level(115)], cfg });
    expect(p.target).toBe(110);
    expect(p.targetAdjusted).toBe(false);
  });

  it('reports the reachable reward in R, not the imaginary one', () => {
    const p = planAroundLevels({ ...long, levels: [level(108)], cfg });
    // ~107.85 reachable on a $5 risk = ~1.57R, not the nominal 2R.
    expect(p.rewardR).toBeCloseTo(1.57, 1);
  });
});

describe('planAroundLevels — the veto', () => {
  it('rejects a setup whose wall is too close to pay for the risk', () => {
    // Resistance at 103: ~2.85 of headroom on a $5 risk = 0.57R.
    const p = planAroundLevels({ ...long, levels: [level(103)], cfg });
    expect(p.veto).toBe(true);
    expect(p.rewardR).toBeLessThan(1);
    expect(p.detail).toMatch(/REJECTED/);
  });

  it('does not reject when there is enough room to be worth taking', () => {
    const p = planAroundLevels({ ...long, levels: [level(108)], cfg });
    expect(p.veto).toBe(false);
  });

  it('rejects a wall sitting essentially ON the entry — the buffer leaves no room at all', () => {
    // Resistance 100.10 against a 100 entry: a buffer short of it is BELOW the
    // entry, i.e. there is no reachable target on this side at all.
    const p = planAroundLevels({ ...long, levels: [level(100.1)], cfg });
    expect(p.veto).toBe(true);
  });

  it('minRewardR 0 disables the veto — cap targets, but never refuse a trade', () => {
    const p = planAroundLevels({ ...long, levels: [level(103)], cfg: { ...cfg, minRewardR: 0 } });
    expect(p.veto).toBe(false);
    expect(p.targetAdjusted).toBe(true); // still capped
  });

  it('measures reward against the WIDENED stop, not the original', () => {
    // Support at 96 widens the stop (risk grows), resistance at 108 caps the
    // target — the reward must be computed on the risk actually being taken.
    const p = planAroundLevels({
      ...long,
      levels: [level(93, { from: 'lows' }), level(108)],
      cfg,
    });
    expect(p.stopAdjusted).toBe(true);
    const risk = 100 - p.stop;
    expect(p.rewardR).toBeCloseTo((p.target - 100) / risk, 1);
  });
});

// The number that was missing (2026-08-31). `rewardR` records what a trade is
// worth AFTER the adjustment; on its own it cannot say what the adjustment
// COST, because a 2R signal taken at 1.5R and a 1.5R signal taken whole write
// the identical row. Real SLB entry that day: signal 2R, stop widened to clear
// support 56.75, booked at 1.5R — and every one of 285 adjusted plans that
// session came out under 2.0R with nothing recording that they started higher.
describe('planAroundLevels — intendedRewardR (what the signal asked for)', () => {
  it('records the signal\u2019s own R, measured on the PRE-widening risk', () => {
    // Support at 93 widens the stop; the target has no wall and stays at 110.
    const p = planAroundLevels({ ...long, levels: [level(93, { from: 'lows' })], cfg });
    expect(p.stopAdjusted).toBe(true);
    expect(p.targetAdjusted).toBe(false);
    // Asked for 2R off the 95 stop (risk 5, target 110).
    expect(p.intendedRewardR).toBe(2);
    // Got less, off the widened stop — the whole point of keeping both.
    expect(p.rewardR).toBeLessThan(2);
    expect(p.rewardR).toBeGreaterThan(0);
  });

  it('reproduces the SLB degradation the operator asked about', () => {
    // Entry 58.38, ATR stop 56.92 (the 2.5% cap), 2R target 61.30, support
    // 56.75 -> stop widened to 56.51. Booked at ~1.5R against an asked-for 2R.
    const slb = { side: 'long' as const, entry: 58.38, stop: 56.92, target: 61.3 };
    const p = planAroundLevels({
      ...slb,
      levels: [level(56.75, { from: 'lows' })],
      cfg: { ...cfg, bufferPct: 0.4 },
    });
    expect(p.stopAdjusted).toBe(true);
    expect(p.intendedRewardR).toBe(2);
    expect(p.rewardR).toBeLessThan(1.6);
    expect(p.rewardR).toBeGreaterThan(1.4);
  });

  it('is EQUAL to rewardR when nothing moved — no phantom degradation', () => {
    // A plan the structure already clears must not read as though it lost
    // something, or every untouched trade pollutes the distribution.
    const p = planAroundLevels({ ...long, levels: [level(130), level(80, { from: 'lows' })], cfg });
    expect(p.stopAdjusted).toBe(false);
    expect(p.targetAdjusted).toBe(false);
    expect(p.intendedRewardR).toBe(p.rewardR);
  });

  it('still reports the ask on a VETOED setup — that population matters most', () => {
    // A veto is a trade structure refused. Knowing it was a 2R ask that fell
    // under the floor is the evidence for whether the floor is set right.
    const p = planAroundLevels({ ...long, levels: [level(103)], cfg });
    expect(p.veto).toBe(true);
    expect(p.intendedRewardR).toBe(2);
    expect(p.rewardR).toBeLessThan(cfg.minRewardR);
  });

  it('is null on the genuinely inactive paths, matching rewardR rather than guessing', () => {
    // Feature off, and no usable stop to measure against. NOT "no levels":
    // since 2026-09-01 an empty chart still gets a real plan, because the
    // reach cap does not depend on structure (see the reachability describe).
    for (const p of [
      planAroundLevels({ ...long, levels: [level(105)], cfg: { ...cfg, enabled: false } }),
      planAroundLevels({ ...long, stop: 100, levels: [level(105)], cfg }),
    ]) {
      expect(p.intendedRewardR).toBeNull();
      expect(p.rewardR).toBeNull();
    }
  });

  it('still measures a chart with NO structure — the reach cap needs no levels', () => {
    const p = planAroundLevels({ ...long, levels: [], cfg });
    expect(p.intendedRewardR).toBe(2);
    expect(p.rewardR).toBe(2); // nothing bound it, but it was measured
    expect(p.detail).toMatch(/no confirmed structure/);
  });

  it('does not divide by a zero risk', () => {
    const p = planAroundLevels({ ...long, stop: 100, levels: [level(105)], cfg });
    expect(p.intendedRewardR).toBeNull();
  });
});

// A 2R target off a 1.5x-ATR stop asks for a 3x ATR move, and where the flat
// 2.5% stop cap binds (16 of 22 real entries) it asks for ~4.7% of price no
// matter what the name does in a day. Measured over those entries the median
// target sat at 1.06x the stock's ENTIRE daily range. Reward:risk cannot see
// this — R says nothing about whether the underlying can travel the distance.
describe('planAroundLevels — target reachability (ATR)', () => {
  // entry 100, stop 95 (risk 5), 2R target 110 = a 10% move.
  const reachCfg = { ...cfg, targetReachAtrMultiple: 1 };

  it('cuts a target the name cannot travel in a session', () => {
    // ATR 3 => 1x ATR reach is 103, well short of the 110 ask.
    const p = planAroundLevels({ ...long, levels: [], cfg: reachCfg, atr: 3 });
    // No levels at all, so this is the reach cap acting entirely on its own —
    // the case the level engine could never have covered.
    expect(p.target).toBe(103);
    expect(p.reachCapped).toBe(true);
    expect(p.rewardR).toBeCloseTo(0.6, 5);
    expect(p.detail).toMatch(/as far as this name travels/);
  });

  it('leaves a target the name CAN travel completely alone', () => {
    // A high-ATR name: 1x ATR is 115, beyond the 110 ask, so nothing binds.
    const p = planAroundLevels({ ...long, levels: [], cfg: reachCfg, atr: 15 });
    expect(p.target).toBe(110);
    expect(p.reachCapped).toBe(false);
    expect(p.rewardR).toBe(2);
  });

  it('mirrors for a short', () => {
    const short = { side: 'short' as const, entry: 100, stop: 105, target: 90 };
    const p = planAroundLevels({ ...short, levels: [], cfg: reachCfg, atr: 3 });
    expect(p.target).toBe(97);
    expect(p.reachCapped).toBe(true);
  });

  it('imposes NO cap when ATR is unusable — never guesses a distance', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN]) {
      const p = planAroundLevels({ ...long, levels: [], cfg: reachCfg, atr: bad });
      expect(p.target).toBe(110);
      expect(p.reachCapped).toBe(false);
    }
  });

  it('is off when the multiple is 0, exactly as before it existed', () => {
    expect(planAroundLevels({ ...long, levels: [], cfg, atr: 3 }).target).toBe(110);
  });

  it('takes the NEARER of reach and wall, and names which one bound it', () => {
    // Wall at 108 (cap ~107.8) vs reach at 103 — reach is nearer.
    const near = planAroundLevels({ ...long, levels: [level(108)], cfg: reachCfg, atr: 3 });
    expect(near.target).toBe(103);
    expect(near.reachCapped).toBe(true);
    expect(near.detail).toMatch(/as far as this name travels/);

    // Same wall, a name with room to run: now the WALL is the binding one, and
    // reachCapped must NOT claim the credit.
    const far = planAroundLevels({ ...long, levels: [level(108)], cfg: reachCfg, atr: 15 });
    expect(far.target).toBeLessThan(108);
    expect(far.reachCapped).toBe(false);
    expect(far.detail).toMatch(/short of resistance/);
  });
});

// Without this the reach cap would quietly kill the strategy's best setup: a
// breakout trades AT its 52-week high, so the wall is always inches overhead,
// leaving a fraction of an R and a veto every time.
describe('planAroundLevels — breakout allowance', () => {
  const bCfg = { ...cfg, targetReachAtrMultiple: 1, breakoutRelVolPace: 2 };

  it('prices THROUGH the wall when volume says the move is real', () => {
    const p = planAroundLevels({ ...long, levels: [level(103)], cfg: bCfg, atr: 15, relVolPace: 3 });
    expect(p.breakoutAllowed).toBe(true);
    expect(p.target).toBeGreaterThan(103); // through the level, not short of it
    expect(p.veto).toBe(false); // and therefore takeable
  });

  it('still refuses the same setup on ordinary volume', () => {
    const p = planAroundLevels({ ...long, levels: [level(103)], cfg: bCfg, atr: 15, relVolPace: 1.2 });
    expect(p.breakoutAllowed).toBe(false);
    expect(p.target).toBeLessThan(103);
    expect(p.veto).toBe(true); // too little room to pay — the DE shape
  });

  it('treats an ABSENT pace as no evidence, never as permission', () => {
    // The permissive reading has to be earned by a number.
    for (const pace of [undefined, null]) {
      const p = planAroundLevels({ ...long, levels: [level(103)], cfg: bCfg, atr: 15, relVolPace: pace });
      expect(p.breakoutAllowed).toBe(false);
    }
  });

  it('never lets a breakout escape the reach cap — conviction is not teleportation', () => {
    // 5x pace, but the name only travels 3 a day: the target is still 103.
    const p = planAroundLevels({ ...long, levels: [level(101)], cfg: bCfg, atr: 3, relVolPace: 5 });
    expect(p.breakoutAllowed).toBe(true);
    expect(p.target).toBe(103); // the reach cap, not the wall and not the 110 ask
    expect(p.reachCapped).toBe(true);
  });

  it('is off when the threshold is 0 — no pace ever counts as a breakout', () => {
    const p = planAroundLevels({
      ...long,
      levels: [level(103)],
      cfg: { ...bCfg, breakoutRelVolPace: 0 },
      atr: 15,
      relVolPace: 99,
    });
    expect(p.breakoutAllowed).toBe(false);
  });
});
