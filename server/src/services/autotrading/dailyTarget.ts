import { AutotradeConfig, getAutotradeConfig } from '../../db/autotradeConfig';
import { DailyBaseline, getDailyBaseline, markDailyTargetReached, saveDailyBaseline } from '../../db/dailyBaseline';
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
// pre-2026-08 behavior). The baseline is still maintained — it costs one row
// write per day and the dashboard can show "today so far" regardless.
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
   *  ET day; this is what halts new live entries. */
  reached: boolean;
  /** Epoch ms of the first reach today, from the persisted baseline row. */
  reachedAt?: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure evaluation — all I/O stays in updateDailyTarget. */
export function evaluateDailyTarget(
  cfg: Pick<AutotradeConfig, 'targetDailyGainPct' | 'accountEquityUsd'>,
  baseline: DailyBaseline | null,
): DailyTargetStatus {
  if (cfg.targetDailyGainPct === null || !(cfg.targetDailyGainPct > 0)) {
    return { active: false, reached: false, inactiveReason: 'no daily-gain target set (apply a tune to set one)' };
  }
  const equity = cfg.accountEquityUsd;
  if (equity === null || !(equity > 0)) {
    return { active: false, reached: false, inactiveReason: 'no usable account equity to measure against' };
  }
  if (!baseline || !(baseline.equityUsd > 0)) {
    return { active: false, reached: false, inactiveReason: 'no day-start baseline captured yet' };
  }
  const targetEquityUsd = round2(baseline.equityUsd * (1 + cfg.targetDailyGainPct / 100));
  const gainPct = round2(((equity - baseline.equityUsd) / baseline.equityUsd) * 100);
  // Sticky: a recorded reach holds for the day even if equity slips back.
  const reached = baseline.reachedAt !== null || equity >= targetEquityUsd;
  return {
    active: true,
    targetPct: cfg.targetDailyGainPct,
    baselineEquityUsd: baseline.equityUsd,
    targetEquityUsd,
    currentEquityUsd: equity,
    gainPct,
    reached,
    reachedAt: baseline.reachedAt,
  };
}

/**
 * Per-tick entry point (loop.ts, right after the equity sync so it sees this
 * tick's number): roll the baseline on a new ET day, evaluate the goal, and on
 * the FIRST reach of the day persist the flag and journal one event. Returns
 * the status the tick's entry gates read. Never throws to the caller beyond
 * what the DB itself throws — the loop wraps it like every other stage.
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
  if (status.active && status.reached && baseline && baseline.reachedAt === null) {
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
  return status;
}
