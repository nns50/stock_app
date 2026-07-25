// Exit-geometry tuning from realized excursion (2026-07-24). Turns the MAE/MFE
// the Journal page already computes (services/excursion.ts) into a bounded nudge
// to stopAtrMultiple / targetRMultiple, so the loop's exits track what winning
// autotrade trades actually did instead of the fixed 1.5×ATR / 2R defaults.
//
// Pure and DB-free (mirrors targetTune.ts): the async orchestration that fetches
// candles and builds the ExcursionReport lives in the caller (autoTune.ts). Off
// unless AutotradeConfig.autoTuneExitsEnabled; each run moves a multiple by at
// most bounds.maxStep, and never outside the absolute safety clamps below.
//
// Signals are taken from WINNING trades only, deliberately: a trade that stopped
// out did so *because of* the current stop, so its adverse excursion is censored
// at ~−1R and can't tell you whether a different stop was better. A winner was
// never stopped, so its worst drawdown (MAE) is an honest read of how much room a
// good trade needs, and its favorable peak (MFE) is an honest read of how far a
// good trade runs.

import { ExcursionReport } from '../excursion';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// Absolute clamps — the tuner may never push exits outside sane bounds, no
// matter what the sample says.
const STOP_MULT_MIN = 0.5;
const STOP_MULT_MAX = 4;
const TARGET_R_MIN = 1;
const TARGET_R_MAX = 6;
// Keep the stop this far beyond the heat a winning trade typically takes, so a
// normal pullback inside a good trade doesn't stop it out.
const STOP_SAFETY_BUFFER = 1.3;
// Aim the target at this fraction of a winner's average favorable peak — you
// can't sell the exact high, so target a bit below it to actually get filled.
const TARGET_CAPTURE_FRACTION = 0.8;

export interface ExcursionTuneBounds {
  /** Minimum winning trades (with excursion data) required before tuning acts. */
  minTrades: number;
  /** Max change to either multiple in a single run, in multiple units. */
  maxStep: number;
  /** Epoch ms of the last exit-geometry change, or null if never tuned. Trades
   *  entered at/before this are EXCLUDED from the sample.
   *
   *  Both signals here are denominated in R — maeR and mfeR are measured against
   *  each trade's own stop AT ENTRY — so a trade taken under the previous
   *  geometry says nothing about the geometry that replaced it. Without this
   *  gate the stop rule re-applied the same correction to an already-corrected
   *  value: winners averaging 0.5R heat give neededRoomR = 0.65, and 1.5 -> 1.25
   *  -> 1.0 -> 0.75 -> 0.5 walks the stop to its floor in four runs off a sample
   *  that never changed. Requiring fresh evidence makes each correction settle
   *  before the next one is judged. */
  sampleSince?: number | null;
}

export interface ExcursionTuneResult {
  /** Only the multiples that actually changed; empty when nothing to do. */
  patch: { stopAtrMultiple?: number; targetRMultiple?: number };
  warnings: string[];
  diagnostics: {
    winners: number;
    /** Mean |MAE| over winners, in R — how much stop room a good trade uses. */
    avgWinnerHeatR: number | null;
    /** Mean MFE over winners, in R — how far a good trade runs. */
    avgWinnerMfeR: number | null;
    /** Average % of the favorable move captured on winners (from the report). */
    capturePct: number | null;
    stopAtrMultiple: { current: number; suggested: number | null };
    targetRMultiple: { current: number; suggested: number | null };
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Move `current` toward `desired`, but by at most `maxStep`. */
function stepToward(desired: number, current: number, maxStep: number): number {
  const delta = clamp(desired - current, -maxStep, maxStep);
  return round2(current + delta);
}

/**
 * Suggest a bounded stopAtrMultiple / targetRMultiple from realized winner
 * excursion. Returns a patch containing only the multiples that changed (empty
 * when the sample is too small or the current geometry already fits), plus
 * diagnostics for the journal/notification.
 */
export function computeExcursionTune(
  report: ExcursionReport,
  current: { stopAtrMultiple: number; targetRMultiple: number },
  bounds: ExcursionTuneBounds,
): ExcursionTuneResult {
  const warnings: string[] = [];
  const since = bounds.sampleSince ?? null;
  const allWinners = report.rows.filter(
    (r) => r.realizedR != null && r.realizedR > 0 && r.maeR != null && r.mfeR != null,
  );
  // Only trades entered AFTER the last change — see ExcursionTuneBounds.sampleSince.
  const winners =
    since == null ? allWinners : allWinners.filter((r) => new Date(r.entryDate).getTime() > (since as number));
  const staleExcluded = allWinners.length - winners.length;

  const diagnostics: ExcursionTuneResult['diagnostics'] = {
    winners: winners.length,
    avgWinnerHeatR: null,
    avgWinnerMfeR: null,
    capturePct: report.capturePct,
    stopAtrMultiple: { current: current.stopAtrMultiple, suggested: null },
    targetRMultiple: { current: current.targetRMultiple, suggested: null },
  };

  if (winners.length < bounds.minTrades) {
    warnings.push(
      `Only ${winners.length} winning trade${winners.length === 1 ? '' : 's'} with excursion data — ` +
        `need ${bounds.minTrades} before tuning exits.` +
        (staleExcluded > 0
          ? ` (${staleExcluded} excluded: entered under the previous exit geometry, so their R-denominated` +
            ` excursion can't judge the current one.)`
          : ''),
    );
    return { patch: {}, warnings, diagnostics };
  }

  // maeR is <= 0 (adverse); take the magnitude as "heat" in R.
  const avgHeatR = round2(mean(winners.map((w) => Math.abs(w.maeR as number))));
  const avgMfeR = round2(mean(winners.map((w) => w.mfeR as number)));
  diagnostics.avgWinnerHeatR = avgHeatR;
  diagnostics.avgWinnerMfeR = avgMfeR;

  const patch: ExcursionTuneResult['patch'] = {};

  // STOP: the current stop distance IS 1R by construction (initialRisk =
  // |entry−stop|×qty). A winner uses avgHeatR of that room; keep a buffer beyond
  // it, then scale the ATR multiple by that needed fraction of R.
  const neededRoomR = clamp(avgHeatR * STOP_SAFETY_BUFFER, 0.1, 2);
  const rawStop = clamp(current.stopAtrMultiple * neededRoomR, STOP_MULT_MIN, STOP_MULT_MAX);
  const suggestedStop = stepToward(rawStop, current.stopAtrMultiple, bounds.maxStep);
  diagnostics.stopAtrMultiple.suggested = suggestedStop;
  if (Math.abs(suggestedStop - current.stopAtrMultiple) > 1e-9) patch.stopAtrMultiple = suggestedStop;

  // TARGET: aim at a fraction of a winner's average favorable peak.
  const rawTarget = clamp(avgMfeR * TARGET_CAPTURE_FRACTION, TARGET_R_MIN, TARGET_R_MAX);
  const suggestedTarget = stepToward(rawTarget, current.targetRMultiple, bounds.maxStep);
  diagnostics.targetRMultiple.suggested = suggestedTarget;
  if (Math.abs(suggestedTarget - current.targetRMultiple) > 1e-9) patch.targetRMultiple = suggestedTarget;

  if (patch.stopAtrMultiple === undefined && patch.targetRMultiple === undefined) {
    warnings.push('Current exit geometry already matches realized excursion — no change.');
  }

  return { patch, warnings, diagnostics };
}
