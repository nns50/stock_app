// ---------------------------------------------------------------------------
// The ONE place that decides what conviction score a LIVE EQUITY entry has to
// clear right now, and says which rule set the bar.
//
// WHY A LIVE-ONLY FLOOR EXISTS AT ALL (2026-09-06). The screener's ranking
// works — Spearman rho(entryScore, realized R) = +0.320 across 57 closed live
// trades, past the 5% significance line at that n. What it does not do is stop
// the book taking trades far below where that edge begins. Split into thirds:
//
//   scores 56-69   n=19   meanR -0.073    -$59.08
//   scores 70-75   n=19   meanR -0.055   -$153.18
//   scores 76-94   n=19   meanR +0.501   +$411.26
//
// Every dollar came from the top third. Sweeping a floor over the same trades:
// at 60 (the everyday minSignalScore) the book keeps 56 trades for +$204.81; at
// 72 it keeps 29 for +$427.22; at 74, 22 for +$446.17. The 35 trades under 74
// lost $247.17 between them.
//
// It is better on BOTH axes, which is unusual and is the reason this is worth
// doing: 22 trades x 0.510R beats 56 x 0.128R, on fewer trades and less capital
// at risk. And it compounds, because those entries were not merely losing —
// 17 of the 35 held one of the three concurrent slots while the book was AT its
// cap, so they also blocked the higher-scoring signals queued behind them.
//
// WHY IT IS SEPARATE FROM minSignalScore. That field feeds decide.ts for BOTH
// books (loop.ts). Raising it would starve the paper track that every other
// open question is waiting on — the stagnation counterfactual, component
// attribution, the exit-geometry read. Paper keeps screening at 60 and stays
// the control group; live takes only what clears this bar.
//
// THE NUMBER IS FITTED, so the recommendation is the conservative end. 72, 74,
// 76 and 78 all score within noise of each other on n=57, which means the sweep
// identifies a REGION (the low 70s) and not a point; 72 keeps roughly half the
// trades instead of a third, so it concedes less if the true edge line sits
// lower than this sample says.
//
// The field DEFAULTS TO 0, i.e. off. A default that changes what a live book
// trades the moment it deploys is a decision taken by a diff rather than by an
// operator, and the existing execution tests said so loudly the first time it
// shipped at 72 — twenty of them were driving fixtures scored in the sixties.
// It is set explicitly and recorded, like every other live-money number here.
//
// THREE BARS, ONE DECISION. finishLineScoreGate already raises the bar on a day
// the give-back guard has armed, and the ML regime overlay (2026-09-08) raises
// it again while the effective regime is High Volatility/Bearish — the bar
// rises where the size falls, because the same score carries less edge in a
// High-Vol tape (mlRegimeHighVolMinSignalScore, 0 = off). Three independent
// gates would be three places deriving "the minimum score for a live entry" —
// the shape CLAUDE.md's agree-by-construction rule exists to prevent. So they
// compose here instead: the STRICTEST bar binds, and `source` names which one
// it was, so a skip is still attributable to the rule that caused it. Ties go
// to the rule whose journal action already has a history (armed day, then the
// everyday floor), so the counts in the tuning plan keep their meaning.
// ---------------------------------------------------------------------------

import { AutotradeConfig } from '../../db/autotradeConfig';
import { DailyTargetStatus } from './dailyTarget';
import { finishLineScoreGate } from './finishLine';

/** Which rule produced the binding bar. */
export type ScoreBarSource = 'none' | 'live_floor' | 'armed_day' | 'high_vol_regime';

export interface EntryScoreGate {
  skip: boolean;
  /** The bar actually applied, 0 when no rule is active. */
  bar: number;
  source: ScoreBarSource;
  detail: string;
  /** The journal action to log for a skip — null when nothing was skipped.
   *  The armed-day case keeps its ORIGINAL action so the tuning plan's
   *  existing count of finish_line_skipped stays comparable across the
   *  change. */
  action: 'live_score_floor_skipped' | 'finish_line_skipped' | 'regime_score_floor_skipped' | null;
}

export type EntryScoreGateConfig = Pick<
  AutotradeConfig,
  'liveMinSignalScore' | 'finishLineMinSignalScore' | 'mlRegimeEnabled' | 'mlRegimeHighVolMinSignalScore'
>;

/** The High-Vol bar in force for a tick: the configured bar while the overlay
 *  is on and the tick's EFFECTIVE regime (effectiveRisk.ts's regimeTriggers —
 *  the model's reading, or a shock day) is High Volatility/Bearish; 0 otherwise. */
export function highVolScoreBar(
  cfg: Pick<AutotradeConfig, 'mlRegimeEnabled' | 'mlRegimeHighVolMinSignalScore'>,
  effectiveRegime: string | null | undefined,
): number {
  return cfg.mlRegimeEnabled && effectiveRegime === 'high_vol_bearish' && cfg.mlRegimeHighVolMinSignalScore > 0
    ? cfg.mlRegimeHighVolMinSignalScore
    : 0;
}

/**
 * May this live equity signal open a position, on conviction grounds?
 *
 * The everyday floor, the armed-day ramp and the High-Vol bar are all
 * "minimum score for a live entry", so whichever is STRICTEST right now is the
 * one that decides. A skip reports the bar it failed and names the rule,
 * because a refusal nobody can attribute is a refusal nobody can count.
 * `effectiveRegime` is the tick's (loop.ts's one derivation); a caller with
 * no tick behind it leaves it out and gets no High-Vol bar.
 */
export function liveEntryScoreGate(
  score: number,
  dailyTarget: DailyTargetStatus,
  cfg: EntryScoreGateConfig,
  effectiveRegime: string | null | undefined = undefined,
): EntryScoreGate {
  const armed = finishLineScoreGate(score, dailyTarget, cfg);
  const armedBar = armed.detail === 'inactive' ? 0 : cfg.finishLineMinSignalScore;
  const floor = cfg.liveMinSignalScore > 0 ? cfg.liveMinSignalScore : 0;
  const regimeBar = highVolScoreBar(cfg, effectiveRegime);
  const everyday = Math.max(floor, regimeBar);

  // The armed-day rule wins ties so its existing journal action, and the
  // history already recorded under it, keep their meaning.
  if (armedBar >= everyday && armedBar > 0) {
    return {
      skip: armed.skip,
      bar: armedBar,
      source: 'armed_day',
      detail: armed.detail,
      action: armed.skip ? 'finish_line_skipped' : null,
    };
  }
  if (everyday <= 0) return { skip: false, bar: 0, source: 'none', detail: 'inactive', action: null };
  // The High-Vol bar binds only when it is STRICTLY above the everyday floor —
  // a tie keeps reporting under the floor's action, for the same reason.
  if (regimeBar > floor) {
    if (score >= regimeBar) {
      return {
        skip: false,
        bar: regimeBar,
        source: 'high_vol_regime',
        detail: `passed — score ${score} ≥ the High Volatility/Bearish bar ${regimeBar}`,
        action: null,
      };
    }
    return {
      skip: true,
      bar: regimeBar,
      source: 'high_vol_regime',
      detail:
        `score ${score} below the High Volatility/Bearish conviction bar ${regimeBar}` +
        `${floor > 0 ? ` (everyday floor ${floor})` : ''} — the same score carries less edge in a High-Vol tape; ` +
        `the paper book still takes this signal, so the counterfactual stays measurable`,
      action: 'regime_score_floor_skipped',
    };
  }
  if (score >= floor) {
    return {
      skip: false,
      bar: floor,
      source: 'live_floor',
      detail: `passed — score ${score} ≥ live floor ${floor}`,
      action: null,
    };
  }
  return {
    skip: true,
    bar: floor,
    source: 'live_floor',
    detail:
      `score ${score} below the live conviction floor ${floor} — the paper book still takes this signal, ` +
      `so the counterfactual stays measurable`,
    action: 'live_score_floor_skipped',
  };
}
