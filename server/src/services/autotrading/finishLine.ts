import { AutotradeConfig } from '../../db/autotradeConfig';
import { DailyTargetStatus } from './dailyTarget';

// ---------------------------------------------------------------------------
// Finish-line discipline (2026-08-22) — the entry-side complement to the
// give-back guard. The guard reacts AFTER an almost-banked day fades; these
// two rules reduce the chance of the fade in the first place:
//
// 1) RIGHT-SIZE THE CLOSING TRADE (finishLineSizingEnabled). At +2.5% of a 3%
//    goal, the next entry doesn't need full risk: a full-size winner would
//    overshoot the target while a full-size loser gives back a third of the
//    day. When the remaining gap to the bank line is SMALLER than what a
//    full-size winner is expected to earn (risk × the trade's reward
//    multiple), trim the entry's risk so its win lands the day roughly at the
//    goal. Floored at quarter size so the closing trade stays viable —
//    trimming to dust would create a dead zone just under the line where
//    nothing can be sized, and the day could only drift across. NEVER sizes
//    up: behind the target, factor is 1 (the tune's calibration stands, and
//    pressing into a shortfall is the classic path to ruin).
//
// 2) SELECTIVITY RAMP (finishLineMinSignalScore). Once the give-back guard
//    has ARMED (the day has been up ≥ the arm level), new live entries must
//    clear a HIGHER conviction bar than the everyday minSignalScore — the
//    trades most likely to give the day back are held to the highest
//    standard. Rides the guard's arm flag deliberately: "armed" is already
//    the persisted, sticky definition of "this day has a gain worth
//    protecting," so the two features agree about when protection starts.
//
// Both LIVE-only (the goal is a % of the real account) and both off by
// default. Pure decisions here; the executors thread the results in.
// ---------------------------------------------------------------------------

export const FINISH_LINE_MIN_FACTOR = 0.25;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface FinishLineFactorResult {
  /** Sizing multiplier in (0, 1] — 1 when disabled/inactive/not yet near the line. */
  factor: number;
  detail: string;
}

/**
 * The sizing trim for the next live entry, from the day's remaining gap to
 * the bank line. `rewardMultiple` is what a winner pays per $1 risked — the
 * equity path's targetRMultiple, the options path's takeProfitPct/100.
 * Degrades to 1 (no trim) whenever the goal isn't measurable, the day is
 * behind, or a full-size win wouldn't overshoot.
 */
export function computeFinishLineFactor(input: {
  enabled: boolean;
  dailyTarget: DailyTargetStatus;
  equity: number;
  riskPerTradePct: number;
  rewardMultiple: number;
}): FinishLineFactorResult {
  const { enabled, dailyTarget: dt, equity, riskPerTradePct, rewardMultiple } = input;
  if (!enabled) return { factor: 1, detail: 'inactive — finish-line sizing off' };
  if (!dt.active || dt.targetEquityUsd === undefined || dt.currentEquityUsd === undefined) {
    return { factor: 1, detail: 'inactive — no measurable daily goal' };
  }
  const gapUsd = dt.targetEquityUsd - dt.currentEquityUsd;
  if (gapUsd <= 0) return { factor: 1, detail: 'inactive — day already at/past the bank line' };
  const fullRiskUsd = equity * (riskPerTradePct / 100);
  const fullWinUsd = fullRiskUsd * rewardMultiple;
  if (!(fullWinUsd > 0)) return { factor: 1, detail: 'inactive — no positive full-size payoff to compare' };
  if (gapUsd >= fullWinUsd) {
    return {
      factor: 1,
      detail: `inactive — ${usd(gapUsd)} still to the bank line ≥ a full-size win (~${usd(fullWinUsd)})`,
    };
  }
  const factor = Math.max(FINISH_LINE_MIN_FACTOR, round2(gapUsd / fullWinUsd));
  return {
    factor,
    detail: `active — only ${usd(gapUsd)} to the bank line; a full-size win pays ~${usd(fullWinUsd)}, so risk is trimmed to ${Math.round(factor * 100)}%`,
  };
}

export interface FinishLineScoreGate {
  skip: boolean;
  detail: string;
}

/**
 * The selectivity ramp: skip a live entry whose signal score is below
 * `finishLineMinSignalScore` while the give-back guard is armed (and the day
 * isn't already halted — a halted day never reaches the executors anyway).
 * 0 disables. A threshold at or below the everyday minSignalScore is
 * harmless — every screened signal already cleared that bar.
 */
export function finishLineScoreGate(
  score: number,
  dailyTarget: DailyTargetStatus,
  cfg: Pick<AutotradeConfig, 'finishLineMinSignalScore'>,
): FinishLineScoreGate {
  const threshold = cfg.finishLineMinSignalScore;
  if (threshold <= 0 || !dailyTarget.active || !dailyTarget.giveBackArmed) {
    return { skip: false, detail: 'inactive' };
  }
  if (score >= threshold) {
    return { skip: false, detail: `passed — score ${score} ≥ armed-day bar ${threshold}` };
  }
  return {
    skip: true,
    detail: `score ${score} below the armed-day bar ${threshold} — protecting a day that has been up ${dailyTarget.giveBackArmPct ?? '?'}%+`,
  };
}

const usdFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usd(n: number): string {
  return `$${usdFormatter.format(n)}`;
}
