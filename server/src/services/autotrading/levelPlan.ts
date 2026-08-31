import { PriceLevel, surroundingLevels } from '../../indicators/levels';

// ---------------------------------------------------------------------------
// Level-aware stop and target placement (2026-08-24) — the half of support/
// resistance that changes what the loop actually does. indicators/levels.ts
// finds the structure; this decides what to do about it.
//
// The problem, in the operator's words: "blindly setting an R exit makes no
// sense if it will never reach that point." Confirmed on the same day's own
// trades — VALE was given a 16.27 target with resistance at 15.38 (it topped
// at 15.22 and never even reached the wall), and GRMN a 317.84 target set
// 3.56 ABOVE a level at 314.28. Both were 2R off an ATR stop, computed with no
// idea a ceiling was in the way.
//
// THREE decisions, in the order they matter:
//
// 1. STOP — clear the structure, never rest inside it. For a long, a stop
//    sitting above (or within) the nearest support is the worst place on the
//    chart: it is exactly where a routine dip to a level buyers defend takes
//    you out before the trade works. So the stop WIDENS to sit a buffer beyond
//    support; it is never tightened toward it. Widening costs nothing in
//    dollars — risk-based sizing simply buys fewer shares for the same risk
//    budget — but it is capped at maxStopWidenPct of the original distance so
//    a far-flung level can't quietly turn a scalp into a swing.
//
// 2. TARGET — never priced through a wall. A target beyond the nearest
//    opposing level is capped to a buffer short of it. This makes the target
//    smaller, which is the point: a reachable 1.2R beats an imaginary 2R, and
//    it also makes the reward:risk arithmetic honest for the first time.
//
// 3. VETO — the decision that only becomes possible once 1 and 2 exist. If
//    the capped target leaves less than minRewardR of headroom, the setup is
//    not worth its risk and the signal is rejected outright. Without this the
//    loop happily enters a trade whose ceiling is 0.6R overhead and books a
//    2R target it cannot reach; the veto is what turns "know about the wall"
//    into "don't take the trade".
//
// Every path degrades to the ATR plan it was handed: disabled, no levels, no
// qualifying level in the way, or an unusable number, and the caller's own
// stop/target come back untouched. Never invents a level, never moves an exit
// on a guess. Pure — the caller supplies the levels and the ATR plan.
// ---------------------------------------------------------------------------

export interface LevelPlanConfig {
  enabled: boolean;
  /** Ignore levels weaker than this (0..1) — a lone stale touch is not a wall. */
  minStrength: number;
  /** Clearance beyond a level, as a % of price, for both stop and target. */
  bufferPct: number;
  /** Cap on stop widening, as a % of the original stop distance. */
  maxStopWidenPct: number;
  /** Reject the setup when the reachable target is worth less than this in R.
   *  0 disables the veto (cap targets, but never refuse a trade). */
  minRewardR: number;
}

export interface LevelPlan {
  stop: number;
  target: number;
  /** True when the signal should be dropped — the wall is too close to pay. */
  veto: boolean;
  /** Reward from entry to the (possibly capped) target, in R — measured
   *  against the possibly-WIDENED stop, i.e. what the trade is actually
   *  worth if taken. */
  rewardR: number | null;
  /** Reward the SIGNAL asked for, in R: its own target over its own stop,
   *  before this function touched either.
   *
   *  Recorded (2026-08-31) because `rewardR` alone cannot tell you what the
   *  adjustment COST. Widening a stop to clear support leaves the target at
   *  its original price, so the R multiple falls — a 2R signal taken at 1.5R
   *  looks identical in the journal to a 1.5R signal taken whole. On
   *  2026-08-31 every one of 285 adjusted plans came out under 2.0R (median
   *  1.53R, 45% under 1.5R) and nothing recorded that they had all started
   *  higher.
   *
   *  This is measurement, not a gate. Whether the right response is a higher
   *  `minRewardR`, a widening cap coupled to it, or nothing at all is a
   *  question about the DISTRIBUTION of this degradation, and that question
   *  was unanswerable while only the post-adjustment number was kept. Note
   *  the two parameters currently cannot interact: widening is capped at
   *  `maxStopWidenPct` of the original risk, so a kR signal can only fall to
   *  k/(1 + maxStopWidenPct/100) — at 2R and 60% that is 1.25R, always above
   *  a 1.0 `minRewardR`. The veto therefore never fires on widening alone,
   *  only on a target capped by a wall. */
  intendedRewardR: number | null;
  stopAdjusted: boolean;
  targetAdjusted: boolean;
  /** The levels this plan reasoned about, for the journal. */
  supportPrice: number | null;
  resistancePrice: number | null;
  detail: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Re-place an ATR-derived stop/target against real structure. `entry`, `stop`
 * and `target` are what the decision stage already produced; the returned plan
 * is what should actually be used.
 */
export function planAroundLevels(input: {
  side: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  levels: PriceLevel[];
  cfg: LevelPlanConfig;
}): LevelPlan {
  const { side, entry, stop, target, levels, cfg } = input;
  const untouched = (detail: string): LevelPlan => ({
    stop,
    target,
    veto: false,
    rewardR: null,
    intendedRewardR: null,
    stopAdjusted: false,
    targetAdjusted: false,
    supportPrice: null,
    resistancePrice: null,
    detail,
  });
  if (!cfg.enabled) return untouched('inactive — level-aware exits off');
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !(entry > 0)) return untouched('inactive — no usable ATR stop to re-place');
  if (levels.length === 0) return untouched('inactive — no confirmed structure on this chart');

  const { above, below } = surroundingLevels(levels, entry, cfg.minStrength);
  // A long is stopped out BELOW and capped ABOVE; a short is the mirror.
  const stopSideLevel = side === 'long' ? below : above;
  const targetSideLevel = side === 'long' ? above : below;
  const buffer = entry * (cfg.bufferPct / 100);

  // --- 1. stop: clear the level it would otherwise sit inside ---------------
  let newStop = stop;
  let stopAdjusted = false;
  if (stopSideLevel) {
    const beyond =
      side === 'long'
        ? stopSideLevel.price - stopSideLevel.halfWidth - buffer
        : stopSideLevel.price + stopSideLevel.halfWidth + buffer;
    // Only WIDEN — a stop already clear of the level is left alone, and a
    // level is never used as an excuse to risk less than the ATR plan.
    const wouldWiden = side === 'long' ? beyond < stop : beyond > stop;
    if (wouldWiden) {
      const maxDistance = risk * (1 + cfg.maxStopWidenPct / 100);
      const distance = Math.abs(entry - beyond);
      if (distance <= maxDistance && beyond > 0) {
        newStop = round2(beyond);
        stopAdjusted = true;
      }
    }
  }

  // --- 2. target: never price it through the wall ---------------------------
  const newRisk = Math.abs(entry - newStop);
  let newTarget = target;
  let targetAdjusted = false;
  if (targetSideLevel) {
    const shortOf =
      side === 'long'
        ? targetSideLevel.price - targetSideLevel.halfWidth - buffer
        : targetSideLevel.price + targetSideLevel.halfWidth + buffer;
    const isBeyondWall = side === 'long' ? target > shortOf : target < shortOf;
    if (isBeyondWall && shortOf > 0) {
      newTarget = round2(shortOf);
      targetAdjusted = true;
    }
  }

  // --- 3. veto: is what's left actually worth the risk? ---------------------
  const rewardR = newRisk > 0 ? round2(Math.abs(newTarget - entry) / newRisk) : null;
  // The signal's own ask, against its own (pre-widening) risk — `risk`, not
  // `newRisk`. Using newRisk here would silently make the two numbers equal
  // and record nothing.
  const intendedRewardR = round2(Math.abs(target - entry) / risk);
  const reachedWrongSide = side === 'long' ? newTarget <= entry : newTarget >= entry;
  const veto = cfg.minRewardR > 0 && (reachedWrongSide || (rewardR !== null && rewardR < cfg.minRewardR));

  const parts: string[] = [];
  if (stopAdjusted)
    parts.push(
      `stop widened to ${newStop} to clear ${side === 'long' ? 'support' : 'resistance'} ${stopSideLevel!.price}`,
    );
  if (targetAdjusted)
    parts.push(
      `target capped at ${newTarget} short of ${side === 'long' ? 'resistance' : 'support'} ${targetSideLevel!.price} (${targetSideLevel!.touches} touches)`,
    );
  if (veto) parts.push(`REJECTED — only ${rewardR}R to the wall, under the ${cfg.minRewardR}R minimum`);
  if (parts.length === 0) parts.push('structure checked — the ATR plan already clears it');

  return {
    stop: newStop,
    target: newTarget,
    veto,
    rewardR,
    intendedRewardR,
    stopAdjusted,
    targetAdjusted,
    supportPrice: below?.price ?? null,
    resistancePrice: above?.price ?? null,
    detail: parts.join('; '),
  };
}
