import { AutotradeConfig, getAutotradeConfig } from '../../db/autotradeConfig';
import { strategyDayFor } from './dailyResults';
import {
  DailyBaseline,
  getDailyBaseline,
  setDailyGoalScale,
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
//
// THE GOAL IS HELD CONSTANT IN R (2026-09-08, the ML regime overlay). The goal
// is `expected day % = entries/session × risk % × avg R` (targetTune.ts), and
// the tune solved riskPerTradePct from it for a calm day. On a regime day the
// sizer cuts every entry's risk by a factor f (effectiveRisk.ts's
// regimeTriggers); a % goal left where it was would then be 1/f harder in R —
// reachable only through more entries, in the one regime where more entries
// is the wrong answer — and the bank line and the guard's arm would come later
// or never. So the day's % goal, arm and floor are all scaled by that SAME f,
// from the SAME call the executors size by (loop.ts), and the identity holds
// on both kinds of day: entries × (risk × f) × avg R = f × goal. Every
// mechanism keeps its meaning at the scaled line. The scale is written to the
// baseline row per in-session tick until the day has a gain to protect (the
// guard armed, or the day banked), then frozen — a mid-morning reading update
// before that is harmless; after it, the line must not move. A skip (the
// sizer refusing every entry) opens nothing, so it does not scale the goal:
// banking a day at +0% would be the opposite of the point.
// ---------------------------------------------------------------------------

export interface DailyTargetStatus {
  /** False when no target is set, or no baseline/equity exists to measure
   *  against — entries are NEVER halted by an unmeasurable goal. */
  active: boolean;
  /** Why tracking is inactive (unset target, no equity, no baseline yet). */
  inactiveReason?: string;
  /** The EFFECTIVE goal % for the day — the configured goal × goalScale. */
  targetPct?: number;
  /** The configured goal % (targetDailyGainPct), before any regime scale. */
  configuredTargetPct?: number;
  /** The regime overlay's scale applied to the goal, arm and floor today
   *  (1 = unscaled) — the sizer's own factor, from the baseline row. */
  goalScale?: number;
  /** The trigger line behind a scale below 1. */
  goalScaleReason?: string;
  baselineEquityUsd?: number;
  /** baseline × (1 + targetPct/100) — the equity that banks the day. */
  targetEquityUsd?: number;
  currentEquityUsd?: number;
  /** Day gain so far as a % of the baseline (can be negative). */
  gainPct?: number;
  /** The loop's own realized P&L for the session, the numerator of `gainPct`. */
  strategyPnlUsd?: number;
  /** The loop P&L that banks the day — `baselineEquityUsd × targetPct`. The
   *  dollar twin of the goal, and the thing `targetEquityUsd` STOPPED being on
   *  2026-09-14: the account crossing its target no longer banks anything. */
  targetPnlUsd?: number;
  /** How far the loop still is from banking, in dollars (negative once past).
   *  THE one derivation of that distance — the finish-line trim reads this
   *  field rather than subtracting a pair of equities of its own, so the trim
   *  and the halt can never disagree about how close the day is. */
  gapToTargetUsd?: number;
  /** The whole account's move, DISPLAY ONLY — it carries the operator's manual
   *  trading and their open positions' unrealized P&L. It banked the loop's day
   *  at 14:41 on 2026-09-14; it decides nothing now. */
  accountGainPct?: number;
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
  /** The EFFECTIVE levels (configured × goalScale), echoed only when the guard
   *  is configured and coherent (arm > floor ≥ 0). The one floor every
   *  consumer reads — the guard, the day-protective stop, the goal card. */
  giveBackArmPct?: number;
  giveBackFloorPct?: number;
  /** Epoch ms the guard fired today, from the persisted baseline row. */
  giveBackHaltedAt?: number | null;
  /** How much loop P&L the day may still give back before the guard fires, in
   *  dollars — `strategyPnlUsd - baselineEquityUsd × giveBackFloorPct`. Present
   *  only when a coherent floor is configured. THE one derivation of that
   *  headroom, for the same reason `gapToTargetUsd` is: the day-protective stop
   *  sets a REAL stop on a REAL position from it, and a headroom it computed
   *  itself off account equity would carry the operator's manual trading into
   *  where that stop goes. */
  headroomToFloorUsd?: number;
  /** The day-protective stop's OWN effective floor (configured x goalScale)
   *  and the loop dollars standing above it, present only when that rule is
   *  enabled with a floor. Independent of the give-back guard since
   *  2026-09-15: the rule used to borrow the guard's floor and fire only while
   *  it was armed, so switching the guard off disabled this one too. */
  dayProtectiveFloorPct?: number;
  dayProtectiveHeadroomUsd?: number;
  /** THE flag the loop's live entry/scale-in gates read: the day is done for
   *  new real risk, either banked (reached) or protected (giveBackHalted). */
  entriesHalted: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The scale a baseline row applies to the day's goal: its goalScale when that
 *  is a real cut (strictly between 0 and 1), else 1. */
export function goalScaleOf(baseline: Pick<DailyBaseline, 'goalScale'> | null): number {
  const s = baseline?.goalScale;
  return s !== null && s !== undefined && s > 0 && s < 1 ? s : 1;
}

/**
 * How many loop dollars the day has above a level, where the level is a % of
 * the day's OPENING equity (2026-09-15).
 *
 * ONE derivation, because two rules now aim at a day level and both set REAL
 * stops or halts from the answer: the give-back guard's floor and the
 * day-protective stop's own. Each computing its own `strategyPnl - baseline x
 * pct` would be two expressions agreeing by coincidence, one edit apart — the
 * disease CLAUDE.md names, and the exact shape of the 2026-09-08 bug where
 * this rule read `cfg.giveBackFloorPct` while the guard read the status.
 */
function headroomToLevelUsd(strategyPnlUsd: number, baselineEquityUsd: number, levelPct: number): number {
  return round2(strategyPnlUsd - baselineEquityUsd * (levelPct / 100));
}

/**
 * The day-protective stop's own floor, scaled by the day's goal scale exactly
 * as the goal and the guard's levels are.
 *
 * Scaled, not raw: on a regime-cut day the goal, the arm and the floor all
 * shrink together so the day keeps its shape in R, and a protective floor left
 * at its configured percentage would sit at a different height than everything
 * around it. The give-back floor has been scaled since 2026-09-08 for this
 * reason; this is the same rule, not a new one.
 */
function dayProtectiveFloor(
  cfg: Pick<AutotradeConfig, 'dayProtectiveStopEnabled' | 'dayProtectiveStopFloorPct'>,
  scale: number,
): number | null {
  const floor = cfg.dayProtectiveStopFloorPct;
  if (!cfg.dayProtectiveStopEnabled || floor === null || !(floor >= 0)) return null;
  return round4(floor * scale);
}

/** The guard needs BOTH levels, coherent: arm above floor, floor at or above
 *  water (see the header for why negative floors belong to the loss halts).
 *  Both scaled by the day's goal scale, like the goal itself. */
function giveBackLevels(
  cfg: Pick<AutotradeConfig, 'giveBackArmPct' | 'giveBackFloorPct'>,
  scale: number,
): { armPct: number; floorPct: number } | null {
  const { giveBackArmPct: arm, giveBackFloorPct: floor } = cfg;
  if (arm === null || floor === null || !(arm > 0) || !(floor >= 0) || !(floor < arm)) return null;
  return { armPct: round4(arm * scale), floorPct: round4(floor * scale) };
}

/** Pure evaluation — all I/O stays in updateDailyTarget. */
/**
 * WHAT THE DAY IS MEASURED ON (2026-09-14, the operator's call).
 *
 * This used to be `(accountEquityUsd - baseline) / baseline` — the whole
 * brokerage account, synced from the broker every tick, including the
 * operator's own manual trading and the UNREALIZED P&L of their open
 * positions. So the loop banked its day on money it had not made.
 *
 * It happened, and cost most of a session. On 2026-09-14 the loop's own
 * realized closes were +$117.79 and the operator's were -$34.60 — together
 * +2.36% of the baseline, BELOW the 3% target. Then a manual TSLA options
 * position moved roughly +$88, the account crossed 3% at 14:41:01 ET, the day
 * was banked, and every tick for the rest of the session refused 26-28 live
 * candidates with `live_entries_halted`.
 *
 * The unrealized half is the sharper edge: an open manual position merely UP
 * ON PAPER banks the loop's day, and can then give it back, leaving the book
 * halted for a gain that never existed. The same number drove the give-back
 * guard, so a manual LOSS could halt the book just as easily.
 *
 * So the day is now the LOOP's own realized P&L — `strategyDayFor`, the exact
 * figure the results calendar already reports, live stock plus live options and
 * independent of every equity reading. Two quantities that were being confused
 * for each other now have one name each: `gainPct` is what the loop did, and
 * `currentEquityUsd`/`accountGainPct` stay on the status as what the operator
 * feels.
 *
 * The daily DRAWDOWN halt needed no change — `getLivePortfolioSnapshot`'s
 * `dailyPnl` already counts autotrade-tagged closes only.
 *
 * Realized, not marked-to-market, matching the halt's own long-standing
 * convention: an open winner does not bank the day, which is the same reason
 * the halt lets open positions carry a loss a little past it.
 */
export function evaluateDailyTarget(
  cfg: Pick<
    AutotradeConfig,
    | 'targetDailyGainPct'
    | 'accountEquityUsd'
    | 'giveBackArmPct'
    | 'giveBackFloorPct'
    | 'dayProtectiveStopEnabled'
    | 'dayProtectiveStopFloorPct'
  >,
  baseline: DailyBaseline | null,
  /** The loop's OWN realized P&L for this ET session, in dollars. Passed in
   *  rather than read here so this stays pure and one derivation
   *  (`strategyDayFor`) serves the live control and the results calendar. */
  strategyPnlUsd: number,
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
  // The regime overlay's scale (see the header): the goal, the arm and the
  // floor all move together, from the one factor on the baseline row.
  const goalScale = goalScaleOf(baseline);
  const targetPct = round4(cfg.targetDailyGainPct * goalScale);
  const targetEquityUsd = round2(baseline.equityUsd * (1 + targetPct / 100));
  // The goal in DOLLARS OF LOOP P&L, which is what the day is decided on now.
  // Same baseline and same targetPct as `targetEquityUsd`, so the two agree
  // about the size of the goal; they differ only in what they measure it on.
  const targetPnlUsd = baseline.equityUsd * (targetPct / 100);
  // Unrounded for the threshold comparisons; rounded only for display. The
  // numerator is the LOOP's realized P&L and the denominator the day's opening
  // equity — both in dollars of the same account, so the ratio is a percentage
  // of equity and comparable to targetPct directly.
  const rawGainPct = (strategyPnlUsd / baseline.equityUsd) * 100;
  const gainPct = round2(rawGainPct);
  // Sticky: a recorded reach holds for the day even if the book gives some back.
  const reached = baseline.reachedAt !== null || rawGainPct >= targetPct;
  const levels = giveBackLevels(cfg, goalScale);
  const protectiveFloorPct = dayProtectiveFloor(cfg, goalScale);
  const giveBackArmed = baseline.giveBackArmedAt !== null || (levels !== null && rawGainPct >= levels.armPct);
  // Fires only on an armed, not-yet-banked day — once reached, entries are
  // already halted and a second halt would just double-journal the same day.
  // Sticky via the persisted timestamp, same as the reach.
  const giveBackHalted =
    baseline.giveBackHaltedAt !== null ||
    (levels !== null && giveBackArmed && !reached && rawGainPct <= levels.floorPct);
  return {
    active: true,
    targetPct,
    configuredTargetPct: cfg.targetDailyGainPct,
    goalScale,
    ...(goalScale !== 1 && baseline.goalScaleReason ? { goalScaleReason: baseline.goalScaleReason } : {}),
    baselineEquityUsd: baseline.equityUsd,
    targetEquityUsd,
    currentEquityUsd: equity,
    gainPct,
    strategyPnlUsd: round2(strategyPnlUsd),
    targetPnlUsd: round2(targetPnlUsd),
    // Both terms are the loop's own dollars against the same baseline, so this
    // crosses zero on exactly the tick `reached` turns true.
    gapToTargetUsd: round2(targetPnlUsd - strategyPnlUsd),
    // What the ACCOUNT did, kept beside what the loop did so the difference —
    // the operator's own trading — is visible rather than inferred. Never used
    // for a halt decision again.
    accountGainPct: round2(((equity - baseline.equityUsd) / baseline.equityUsd) * 100),
    reached,
    reachedAt: baseline.reachedAt,
    giveBackArmed,
    giveBackHalted,
    ...(levels !== null
      ? {
          giveBackArmPct: levels.armPct,
          giveBackFloorPct: levels.floorPct,
          // Loop dollars minus loop dollars: positive while the day still has
          // something above the floor to protect, and crossing zero on exactly
          // the tick `giveBackHalted` would fire.
          headroomToFloorUsd: headroomToLevelUsd(strategyPnlUsd, baseline.equityUsd, levels.floorPct),
        }
      : {}),
    ...(protectiveFloorPct !== null
      ? {
          dayProtectiveFloorPct: protectiveFloorPct,
          dayProtectiveHeadroomUsd: headroomToLevelUsd(strategyPnlUsd, baseline.equityUsd, protectiveFloorPct),
        }
      : {}),
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

  // The loop's OWN day, not the account's — see evaluateDailyTarget's header
  // for the session this cost. Read once per tick, here, so the pure evaluator
  // stays pure and every caller below gets the same number.
  const status = evaluateDailyTarget(cfg, baseline, strategyDayFor(today).pnlUsd);

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
        configuredTargetPct: status.configuredTargetPct,
        goalScale: status.goalScale,
        baselineEquityUsd: status.baselineEquityUsd,
        // The loop's P&L is the numerator of `gainPct`; `currentEquityUsd` is
        // the whole account and decides nothing. Both are here so a row read
        // months later cannot mistake one for the other.
        strategyPnlUsd: status.strategyPnlUsd,
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
    // 'strategy' because evaluateDailyTarget above measured the LOOP's own
    // realized P&L. Stamped with the reach so the results row cannot later
    // assert a basis the reach did not have.
    markDailyTargetReached(now, 'strategy');
    status.reachedAt = now;
    logAutotradeEvent({
      stage: 'execution',
      action: 'daily_target_reached',
      detail: {
        targetPct: status.targetPct,
        configuredTargetPct: status.configuredTargetPct,
        goalScale: status.goalScale,
        baselineEquityUsd: status.baselineEquityUsd,
        targetPnlUsd: status.targetPnlUsd,
        strategyPnlUsd: status.strategyPnlUsd,
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
        goalScale: status.goalScale,
        configuredTargetPct: status.configuredTargetPct,
        baselineEquityUsd: status.baselineEquityUsd,
        strategyPnlUsd: status.strategyPnlUsd,
        currentEquityUsd: status.currentEquityUsd,
        gainPct: status.gainPct,
        note: 'day gain fell back to the give-back floor after arming — new live entries and scale-ins halted until the next ET day',
      },
      riskProfile: cfg.riskProfile,
    });
  }
  return status;
}

/** Journal action for a change of the day's goal scale — one line on a regime morning. */
export const DAILY_GOAL_SCALED_ACTION = 'daily_goal_scaled';

export interface DailyGoalScaleOutcome {
  /** The scale on the row after this call (1 = unscaled). */
  scale: number;
  /** The row moved (and one daily_goal_scaled event was journaled). */
  changed: boolean;
  /** The day already has a gain to protect (guard armed or day banked), so a
   *  different factor was NOT written — the line stays where it was. */
  frozen: boolean;
}

/**
 * Hold the day's goal constant in R under the regime overlay (see the header).
 * Called by loop.ts once per in-session tick with the SAME regimeTriggers
 * result the executors size by — one factor, one derivation. Writes only when
 * the factor differs from the row's, and only while nothing sticky has
 * happened (setDailyGoalScale's freeze); journals one daily_goal_scaled event
 * per change while a goal is configured. A factor of 1, or a skip (nothing
 * opens, so nothing to scale the goal for), reads as unscaled.
 */
export function updateDailyGoalScale(
  triggers: { factor: number; skip: boolean; detail: string },
  now: number = Date.now(),
): DailyGoalScaleOutcome {
  const baseline = getDailyBaseline();
  if (!baseline || baseline.etDate !== etToday(now)) return { scale: 1, changed: false, frozen: false };
  const scale = triggers.skip || !(triggers.factor > 0) || triggers.factor >= 1 ? 1 : round4(triggers.factor);
  const current = goalScaleOf(baseline);
  if (scale === current) return { scale, changed: false, frozen: false };
  if (baseline.giveBackArmedAt !== null || baseline.reachedAt !== null) {
    return { scale: current, changed: false, frozen: true };
  }
  if (!setDailyGoalScale(scale, scale === 1 ? null : triggers.detail)) {
    return { scale: current, changed: false, frozen: true };
  }
  const cfg = getAutotradeConfig();
  if (cfg.targetDailyGainPct !== null && cfg.targetDailyGainPct > 0) {
    const levels = giveBackLevels(cfg, 1);
    const effective = giveBackLevels(cfg, scale);
    logAutotradeEvent({
      stage: 'execution',
      action: DAILY_GOAL_SCALED_ACTION,
      detail: {
        factor: scale,
        detail: triggers.detail,
        configured: {
          targetPct: cfg.targetDailyGainPct,
          giveBackArmPct: levels?.armPct ?? null,
          giveBackFloorPct: levels?.floorPct ?? null,
        },
        effective: {
          targetPct: round4(cfg.targetDailyGainPct * scale),
          giveBackArmPct: effective?.armPct ?? null,
          giveBackFloorPct: effective?.floorPct ?? null,
        },
        note:
          scale === 1
            ? 'the regime cut lifted before the day had a gain to protect — the goal, arm and floor are back at their configured levels'
            : 'the regime cut scales the day’s goal, arm and floor by the same factor it cut entries by, so the goal is held constant in R (docs/TUNE_FROM_TARGET.md §6c)',
      },
      riskProfile: cfg.riskProfile,
    });
  }
  return { scale, changed: true, frozen: false };
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
