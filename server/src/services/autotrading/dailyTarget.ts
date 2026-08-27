import { AutotradeConfig, getAutotradeConfig } from '../../db/autotradeConfig';
import {
  DailyBaseline,
  getDailyBaseline,
  setReachCandidate,
  markDailyTargetReached,
  markGiveBackArmed,
  markGiveBackHalted,
  rebaseDailyBaseline,
  saveDailyBaseline,
} from '../../db/dailyBaseline';
import { detectExternalCashFlow } from './externalCashFlow';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { etToday } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// The live daily-gain GOAL — the half of "tune from target" that runs during
// the session.
//
// Until 2026-08-21, the tune's target % was calibration only: it solved a
// static risk-per-trade once and was then forgotten — nothing in the loop knew
// a day HAD a goal, so nothing stopped when it was reached and nothing ever
// reported progress toward it. The operator's stated intent is stronger: take
// the account's value at the start of each ET day, aim for the set % ON THAT
// VALUE within the day, and repeat daily (each day's goal compounds off the
// new day's base).
//
// So: at the first tick of each ET day, snapshot synced equity as the day's
// baseline (db/dailyBaseline.ts — persisted, so a mid-day restart neither
// loses the base nor re-baselines). Each tick, compare current synced equity
// to baseline × (1 + target%/100). Once reached, journal ONE
// daily_target_reached event and halt NEW live entries and live scale-ins for
// the REST of the day — bank the day. Exits, reconcile, sync, and paper all
// keep running; only the opening of new real risk stops.
//
// STICKY by design: once reached, the halt holds even if equity later slips
// back under the line. The goal is "make X% and stop", not "hover at X%" —
// re-opening entries on a dip would spend the banked day chasing it back, and
// a flapping gate would churn entries around the threshold.
//
// THE GIVE-BACK GUARD (2026-08-22) covers the day the target protects least:
// the one that ALMOST made it. Without it, a day that runs to +2.9% of a 3%
// goal has no floor at all — the loop keeps opening entries on the way back
// down and can round-trip the whole gain (the halts that do exist all key off
// LOSSES from zero, not give-back from a high). Two config levels, both on
// the same day-gain axis as the target and stamped by the tune at 2/3 and 1/3
// of it: once the day's gain touches giveBackArmPct the guard ARMS (sticky —
// a fade doesn't disarm); if an armed day's gain then falls back to
// giveBackFloorPct or below, new live entries and scale-ins halt for the rest
// of the day, exactly like a reached target (journaled once as
// daily_give_back_halted; exits and paper keep running; the next ET day
// starts clean). Arm-then-floor rather than a plain trailing stop on equity
// so an ordinary morning chop below +1% can't lock the day out before it ever
// had a gain worth protecting. The guard only halts ABOVE water — the floor
// can't be negative — because below water the daily-loss halts already own
// the day.
//
// Equity-based, including unrealized, and including anything the human does
// manually in the same account — deliberately. The goal is on the ACCOUNT'S
// value ("take the account value of the day and get the set percentage return
// on that value"), not on the loop's own realized P&L, and synced net
// liquidation is the one number that measures it.
//
// What this file deliberately does NOT do: press. When the day is BEHIND the
// target, sizing stays exactly what the tune calibrated — no scaling up to
// chase the shortfall. Escalating risk into a losing day is the classic path
// to ruin, and every guardrail in this app points the other way. The honest
// levers for "not enough gain" are a lower target or more trade flow, both of
// which the tune's bands already control.
//
// Null targetDailyGainPct = tracking off entirely (calibration-only tune, the
// pre-2026-08 behavior), and the guard rides the same switch — with no goal
// there is no day-gain axis to put its levels on. The baseline is still
// maintained — it costs one row write per day and the dashboard can show
// "today so far" regardless.
// ---------------------------------------------------------------------------

export interface DailyTargetStatus {
  /** False when no target is set, or no baseline/equity exists to measure
   *  against — entries are NEVER halted by an unmeasurable goal. */
  active: boolean;
  /** Why tracking is inactive (unset target, no equity, no baseline yet). */
  inactiveReason?: string;
  targetPct?: number;
  baselineEquityUsd?: number;
  /** baseline × (1 + targetPct/100) — the equity that banks the day. */
  targetEquityUsd?: number;
  currentEquityUsd?: number;
  /** Day gain so far as a % of the baseline (can be negative). */
  gainPct?: number;
  /** True once the target has been reached TODAY — sticky for the rest of the
   *  ET day. */
  reached: boolean;
  /** Epoch ms of the first reach today, from the persisted baseline row. */
  reachedAt?: number | null;
  /** True once the give-back guard has ARMED today (day gain touched
   *  giveBackArmPct) — sticky; always false while the guard is unconfigured. */
  giveBackArmed: boolean;
  /** True once the guard has FIRED today (an armed day's gain fell back to
   *  giveBackFloorPct) — sticky, and one of the two entriesHalted reasons. */
  giveBackHalted: boolean;
  /** The configured levels, echoed only when the guard is configured and
   *  coherent (arm > floor ≥ 0). */
  giveBackArmPct?: number;
  giveBackFloorPct?: number;
  /** Epoch ms the guard fired today, from the persisted baseline row. */
  giveBackHaltedAt?: number | null;
  /** THE flag the loop's live entry/scale-in gates read: the day is done for
   *  new real risk, either banked (reached) or protected (giveBackHalted). */
  entriesHalted: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The guard needs BOTH levels, coherent: arm above floor, floor at or above
 *  water (see the header for why negative floors belong to the loss halts). */
function giveBackLevels(
  cfg: Pick<AutotradeConfig, 'giveBackArmPct' | 'giveBackFloorPct'>,
): { armPct: number; floorPct: number } | null {
  const { giveBackArmPct: arm, giveBackFloorPct: floor } = cfg;
  if (arm === null || floor === null || !(arm > 0) || !(floor >= 0) || !(floor < arm)) return null;
  return { armPct: arm, floorPct: floor };
}

/** Pure evaluation — all I/O stays in updateDailyTarget. */
export function evaluateDailyTarget(
  cfg: Pick<AutotradeConfig, 'targetDailyGainPct' | 'accountEquityUsd' | 'giveBackArmPct' | 'giveBackFloorPct'>,
  baseline: DailyBaseline | null,
): DailyTargetStatus {
  const inactive = (reason: string): DailyTargetStatus => ({
    active: false,
    reached: false,
    giveBackArmed: false,
    giveBackHalted: false,
    entriesHalted: false,
    inactiveReason: reason,
  });
  if (cfg.targetDailyGainPct === null || !(cfg.targetDailyGainPct > 0)) {
    return inactive('no daily-gain target set (apply a tune to set one)');
  }
  const equity = cfg.accountEquityUsd;
  if (equity === null || !(equity > 0)) {
    return inactive('no usable account equity to measure against');
  }
  if (!baseline || !(baseline.equityUsd > 0)) {
    return inactive('no day-start baseline captured yet');
  }
  const targetEquityUsd = round2(baseline.equityUsd * (1 + cfg.targetDailyGainPct / 100));
  // Unrounded for the threshold comparisons; rounded only for display.
  const rawGainPct = ((equity - baseline.equityUsd) / baseline.equityUsd) * 100;
  const gainPct = round2(rawGainPct);
  // Sticky: a recorded reach holds for the day even if equity slips back.
  const reached = baseline.reachedAt !== null || equity >= targetEquityUsd;
  const levels = giveBackLevels(cfg);
  const giveBackArmed = baseline.giveBackArmedAt !== null || (levels !== null && rawGainPct >= levels.armPct);
  // Fires only on an armed, not-yet-banked day — once reached, entries are
  // already halted and a second halt would just double-journal the same day.
  // Sticky via the persisted timestamp, same as the reach.
  const giveBackHalted =
    baseline.giveBackHaltedAt !== null ||
    (levels !== null && giveBackArmed && !reached && rawGainPct <= levels.floorPct);
  return {
    active: true,
    targetPct: cfg.targetDailyGainPct,
    baselineEquityUsd: baseline.equityUsd,
    targetEquityUsd,
    currentEquityUsd: equity,
    gainPct,
    reached,
    reachedAt: baseline.reachedAt,
    giveBackArmed,
    giveBackHalted,
    ...(levels !== null ? { giveBackArmPct: levels.armPct, giveBackFloorPct: levels.floorPct } : {}),
    giveBackHaltedAt: baseline.giveBackHaltedAt,
    entriesHalted: reached || giveBackHalted,
  };
}

/**
 * Per-tick entry point (loop.ts, right after the equity sync so it sees this
 * tick's number): roll the baseline on a new ET day, evaluate the goal, and on
 * the FIRST reach (or give-back fire) of the day persist the flag and journal
 * one event. Returns the status the tick's entry gates read. Never throws to
 * the caller beyond what the DB itself throws — the loop wraps it like every
 * other stage.
 */
export function updateDailyTarget(now: number = Date.now()): DailyTargetStatus {
  const cfg = getAutotradeConfig();
  const today = etToday(now);

  let baseline = getDailyBaseline();
  if (baseline?.etDate !== today) {
    // New ET day (or first run ever): today's base is the equity we see NOW —
    // the first tick after midnight ET, i.e. effectively the prior session's
    // close. If equity isn't usable yet, leave the stale row; we'll try again
    // next tick rather than baseline a day at 0.
    const equity = cfg.accountEquityUsd;
    if (equity !== null && equity > 0) {
      baseline = saveDailyBaseline(today, equity);
    } else if (baseline?.etDate !== today) {
      baseline = null; // yesterday's row must not measure today
    }
  }

  const status = evaluateDailyTarget(cfg, baseline);

  // Two-tick confirmation before the FIRST bank of the day. Banking is
  // irreversible for the session, so it must not rest on one instantaneous
  // reading: on 2026-08-27 a single spurious net-liquidation tick banked a
  // fictional +9.69% day and halted live entries for the rest of it.
  // equitySyncGuard.ts stops such a reading reaching the config at all; this
  // is the second line, and it is cheap — a REAL +3% day is still +3% sixty
  // seconds later. An already-recorded reach is sticky and skips this
  // entirely: the confirmation guards the moment of banking, not the state.
  const firstReachThisTick = status.active && status.reached && baseline !== null && baseline.reachedAt === null;
  const confirmed = firstReachThisTick && baseline !== null && baseline.reachCandidateAt !== null;
  if (baseline && (firstReachThisTick ? baseline.reachCandidateAt === null : baseline.reachCandidateAt !== null)) {
    // Set on the first sighting, cleared the moment the target is not met —
    // so two NON-consecutive spikes can never add up to a confirmation.
    setReachCandidate(firstReachThisTick ? now : null);
    baseline.reachCandidateAt = firstReachThisTick ? now : null;
  }
  if (firstReachThisTick && !confirmed) {
    logAutotradeEvent({
      stage: 'execution',
      action: 'daily_target_pending_confirmation',
      detail: {
        targetPct: status.targetPct,
        baselineEquityUsd: status.baselineEquityUsd,
        currentEquityUsd: status.currentEquityUsd,
        gainPct: status.gainPct,
        note: 'target reached on this tick — banking the day needs it again on the next one',
      },
      riskProfile: cfg.riskProfile,
    });
    // Not banked yet, so nothing is halted BY THE REACH this tick. An already
    // -fired give-back halt below still stands on its own.
    status.reached = false;
    status.entriesHalted = status.giveBackHalted;
  }

  if (confirmed && baseline) {
    markDailyTargetReached(now);
    status.reachedAt = now;
    logAutotradeEvent({
      stage: 'execution',
      action: 'daily_target_reached',
      detail: {
        targetPct: status.targetPct,
        baselineEquityUsd: status.baselineEquityUsd,
        targetEquityUsd: status.targetEquityUsd,
        currentEquityUsd: status.currentEquityUsd,
        gainPct: status.gainPct,
        note: 'day banked — new live entries and scale-ins halted until the next ET day',
      },
      riskProfile: cfg.riskProfile,
    });
  }
  // Persist the guard's arming silently (the dashboard shows it; an event per
  // arm would be noise on every decent morning) …
  if (status.active && status.giveBackArmed && baseline && baseline.giveBackArmedAt === null) {
    markGiveBackArmed(now);
  }
  // … but a FIRE is a halt, and halts journal — once, guarded by the
  // persisted timestamp exactly like the reach above.
  if (status.active && status.giveBackHalted && baseline && baseline.giveBackHaltedAt === null) {
    markGiveBackHalted(now);
    status.giveBackHaltedAt = now;
    logAutotradeEvent({
      stage: 'execution',
      action: 'daily_give_back_halted',
      detail: {
        giveBackArmPct: status.giveBackArmPct,
        giveBackFloorPct: status.giveBackFloorPct,
        baselineEquityUsd: status.baselineEquityUsd,
        currentEquityUsd: status.currentEquityUsd,
        gainPct: status.gainPct,
        note: 'day gain fell back to the give-back floor after arming — new live entries and scale-ins halted until the next ET day',
      },
      riskProfile: cfg.riskProfile,
    });
  }
  return status;
}

/**
 * Absorb a deposit or withdrawal into today's baseline so it is not counted as
 * gain — see externalCashFlow.ts for why this is a baseline move rather than a
 * change to the equity-based axis, and why it needs two agreeing signals.
 *
 * Called from the equity sync on the ONE tick where the guard accepts a
 * sustained out-of-band reading (signal 1); the detector supplies signal 2.
 * Runs BEFORE updateDailyTarget in the loop's tick order, which is what stops
 * a deposit banking the day on the tick it lands.
 *
 * Returns the flow it applied, or null when there was nothing to do — the
 * ordinary case, which writes and journals nothing.
 */
export function applyExternalCashFlow(
  currentEquityUsd: number,
  brokerDayPnlUsd: number | undefined,
  now: number = Date.now(),
): { flowUsd: number; baselineUsd: number } | null {
  const baseline = getDailyBaseline();
  if (!baseline || baseline.etDate !== etToday(now) || !(baseline.equityUsd > 0)) return null;

  const flow = detectExternalCashFlow({
    baselineUsd: baseline.equityUsd,
    currentEquityUsd,
    brokerDayPnlUsd,
  });
  if (!flow) return null;

  rebaseDailyBaseline(flow.adjustedBaselineUsd);
  logAutotradeEvent({
    stage: 'config',
    action: 'daily_baseline_rebased',
    detail: {
      flowUsd: round2(flow.flowUsd),
      fromBaselineUsd: baseline.equityUsd,
      toBaselineUsd: round2(flow.adjustedBaselineUsd),
      currentEquityUsd,
      brokerDayPnlUsd,
      reason: flow.reason,
    },
  });
  return { flowUsd: flow.flowUsd, baselineUsd: flow.adjustedBaselineUsd };
}
