import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// The regime TARGET tighten (2026-09-08, the ML regime overlay — the second
// thing that acts on the HMM reading after the size cut in effectiveRisk.ts).
//
// In a High Volatility/Bearish tape a breakout has less room before the next
// reversal, so the profit target is brought in: targetRMultiple (the equity
// bracket's reward multiple) and optionsTakeProfitPct (the options books'
// take-profit) are both multiplied by the SAME factor, 1 − tighten%/100, and
// nothing else. Three consumers, one helper, so the equity target, the options
// target and the finish-line's idea of "what a winner pays" cannot disagree:
//
//   1. decide.ts's targetRMultiple — new equity entries (the loop, and the
//      /decide preview from today's persisted reading);
//   2. the finish-line trim's rewardMultiple on both live books;
//   3. the options exit rules — from the regime STAMPED on the position at
//      entry (ml_regime), so a position opened on a High-Vol morning keeps its
//      tightened take-profit through a calm afternoon, and one opened in calm
//      tape is not tightened by a later switch. Equity targets are fixed at
//      entry anyway (the bracket leg), so both instruments tighten at entry.
//
// Never below MIN_TARGET_FACTOR: a tighten of 100 would make a 0R target,
// which is not a target. The factor is stamped on every position
// (regime_target_factor) so the counterfactual ledger can later ask what the
// untightened target would have done.
// ---------------------------------------------------------------------------

export type RegimeTargetConfig = Pick<
  AutotradeConfig,
  'mlRegimeEnabled' | 'mlRegimeTargetTightenPct' | 'targetRMultiple' | 'optionsTakeProfitPct'
>;

export interface RegimeAdjustedTargets {
  targetRMultiple: number;
  optionsTakeProfitPct: number;
  /** The factor moved something (overlay on, High Vol, tighten > 0). */
  tightened: boolean;
  /** The multiplier applied to both targets — 1 when not tightened. */
  factor: number;
}

/** A 90% tighten is the deepest that still leaves a target (0.1× the base). */
export const MIN_TARGET_FACTOR = 0.1;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The factor the overlay applies to targets under `regime` — 1 unless the
 *  overlay is on and the regime is High Volatility/Bearish. `regime` is the
 *  tick's effective regime (effectiveRisk.ts's regimeTriggers) at entry, or
 *  the label stamped on the position at exit; null/unknown never tightens. */
export function regimeTargetFactor(
  cfg: Pick<RegimeTargetConfig, 'mlRegimeEnabled' | 'mlRegimeTargetTightenPct'>,
  regime: string | null | undefined,
): number {
  if (!cfg.mlRegimeEnabled || regime !== 'high_vol_bearish') return 1;
  const pct = Number.isFinite(cfg.mlRegimeTargetTightenPct) ? cfg.mlRegimeTargetTightenPct : 0;
  if (pct <= 0) return 1;
  return Math.max(MIN_TARGET_FACTOR, Math.min(1, round4(1 - pct / 100)));
}

export function regimeAdjustedTargets(
  cfg: RegimeTargetConfig,
  regime: string | null | undefined,
): RegimeAdjustedTargets {
  const factor = regimeTargetFactor(cfg, regime);
  return {
    targetRMultiple: round4(cfg.targetRMultiple * factor),
    optionsTakeProfitPct: round4(cfg.optionsTakeProfitPct * factor),
    tightened: factor !== 1,
    factor,
  };
}

/** The config with both targets tightened — for callers that hand a whole
 *  config to an exit rule (shortDatedOptionsExit reads optionsTakeProfitPct
 *  itself). Returns the same object when nothing is tightened. */
export function withRegimeAdjustedTargets<T extends RegimeTargetConfig>(cfg: T, regime: string | null | undefined): T {
  const adjusted = regimeAdjustedTargets(cfg, regime);
  if (!adjusted.tightened) return cfg;
  return { ...cfg, targetRMultiple: adjusted.targetRMultiple, optionsTakeProfitPct: adjusted.optionsTakeProfitPct };
}
