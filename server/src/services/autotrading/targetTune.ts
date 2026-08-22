import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// "Tune from target" — a ONE-SHOT preset generator that derives a full
// auto-trade risk config from the account equity plus a target daily gain %.
// Pure and equity/target-derived, in the same spirit as liveCaps.ts's
// suggestLiveCaps (its dollar caps mirror that equity × fraction approach): the
// UI offers the result as a preview the user reviews and applies through the
// applies through the ordinary config PUT — every field stays freely editable
// afterward. This never runs the loop, never persists on its own, and (the
// critical safety boundary) never touches a live-enable gate, the kill switch,
// the account id, or the probation ramps — see WRITES / NEVER-WRITES below.
//
// It is deliberately independent of services/autotrading/autoTune.ts (which
// nudges riskPerTradePct toward realized Kelly, and — when autoTuneExitsEnabled
// — stopAtrMultiple/targetRMultiple toward realized excursion, OVER TIME): this
// is a one-shot human-initiated preset, that is a continuous background
// adjuster. Both overlaps are surfaced as warnings by computeTargetTune, never
// silent: riskPerTradePct is written by both, and so is targetRMultiple, which
// is additionally an INPUT to this file's own risk% solve.
// ---------------------------------------------------------------------------

/** Which sizing assumption maps the target gain % to per-trade risk. Both use
 *  the same formula, `riskPerTradePct = target / (maxTradesPerDay × edgeR)`,
 *  differing only in `edgeR` (expected R per trade):
 *   - 'expected'   : edgeR = winRate×R − (1−winRate), a fixed 45% win rate at
 *                    the band's reward:risk — sizes so the target is your
 *                    AVERAGE day. More risk per trade.
 *   - 'perfectDay' : edgeR = R — sizes so the target is your BEST-CASE ceiling
 *                    (every trade hits its target). Less risk per trade. */
export type TuneBasis = 'expected' | 'perfectDay';

/** The fixed win rate the 'expected' basis assumes. Documented and constant so
 *  the suggestion is deterministic and explainable (this app's scoring
 *  invariant) — a later refinement could substitute the user's own realized
 *  win rate from the Journal, but v1 keeps it a stated assumption, not a hidden
 *  data dependency. */
export const ASSUMED_WIN_RATE = 0.45;

/** The tuner never SUGGESTS a per-trade risk above this, however high the
 *  target. It's a guard against the generator itself proposing account-suicide
 *  sizing — NOT a cap on what the user may hand-enter afterward (the field
 *  still accepts up to 100). When the raw solve exceeds this, the suggestion is
 *  clamped here and a warning says so. */
export const MAX_SUGGESTED_RISK_PER_TRADE_PCT = 10;

/** Floor on edgeR, so a small reward:risk can't blow the risk% solve up toward
 *  infinity. At the band targetRMultiples (≥2) the 'expected' edge is ~0.35, so
 *  this only ever bites on pathological inputs. */
const MIN_EDGE_R = 0.1;

export type TuneBand = 'conservative' | 'moderate' | 'aggressive';

/** The "shape" each band sets — everything EXCEPT riskPerTradePct (which is
 *  solved from the target) and the equity-scaled dollar caps (from
 *  suggestLiveCaps). Modeled on the old riskProfiles.ts MODERATE/AGGRESSIVE
 *  preset tables the config comments reference, with a conservative rung added
 *  below moderate. */
interface BandShape {
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  targetRMultiple: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  maxCorrelatedExposurePct: number;
  maxSectorExposurePct: number;
  minRelVol: number;
  /** Liquidity floors — the spread-vs-stop friction tax concentrates in cheap,
   *  thin names (the reason minPrice/minAvgVolume exist), so caution raises
   *  both. The aggressive row keeps the engine's old constants ($1 / 200k):
   *  the floors loosen with ambition but never disable — the biggest sizing is
   *  exactly where a bad fill hurts most. */
  minPrice: number;
  minAvgVolume: number;
  /** Conviction floor (total screener score, 0–100), anchored on the
   *  conviction grades (B = 60 by default): the conservative band trades only
   *  B-grade-or-better setups; looser bands admit lower scores but never 0 —
   *  more ambition needs more trade flow, not scoreless junk at full size. */
  minSignalScore: number;
  maxTickerAtrPct: number;
  maxMarketAtrPct: number;
  optionsDeltaMin: number;
  optionsDeltaMax: number;
  optionsMaxSpreadPct: number;
  optionsMinDte: number;
  optionsMaxDte: number;
  optionsIvRankMax: number;
  /** IV/RV cheapness ceiling — how rich an implied vol (vs 20-day realized)
   *  the band will pay for long premium. Tightest where the band is most
   *  patient; 0 in the aggressive row = gate off (the gate fails closed when
   *  realized vol is uncomputable, and that band needs the flow). */
  optionsMaxIvRvRatio: number;
  optionsStopLossPct: number;
  optionsTakeProfitPct: number;
  /** 'MODERATE' or 'AGGRESSIVE' — the config only has these two labels; the
   *  conservative and moderate bands both journal as MODERATE, the aggressive
   *  band as AGGRESSIVE (which also drives the extra apply-time confirmation). */
  riskProfile: 'MODERATE' | 'AGGRESSIVE';
  /** Fat-finger single-order notional as a fraction of equity — looser in the
   *  aggressive band, same "generous backstop, not primary sizing" role
   *  suggestLiveCaps documents. */
  maxOrderEquityFraction: number;
}

const BANDS: Record<TuneBand, BandShape> = {
  // The band table IS the definition of conservative/moderate/aggressive here —
  // it's the one published in docs/TUNE_FROM_TARGET.md §5, and "reset to
  // moderate" means the moderate row of it.
  //
  // It is NOT the same thing as defaultAutotradeConfig(), which this comment
  // used to claim. The moderate row legitimately differs from the shipped
  // defaults where the band table and the derivations are doing their job:
  //   - maxDailyDrawdownPct  — derived (6 trades x 1% x 0.75 = 4.5), not the
  //     hand-picked default of 3; see shapeToPatch.
  //   - optionsStopLossPct / optionsTakeProfitPct — 50 / 80 per the published
  //     moderate row; both ship defaulted to 0 (disabled).
  //   - minSignalScore / optionsMaxIvRvRatio — 50 / 1.2 per the published row;
  //     both ship at 0 (disabled) so an untouched config's behavior doesn't
  //     change, but a preset the user explicitly asks for takes a stance.
  //   - minPrice / minAvgVolume — 2 / 500k, a notch above the shipped engine
  //     constants (1 / 200k), which the aggressive row keeps as its floor.
  // Every one of them shows up in the preview's current -> tuned table before
  // anything is applied, so none of it lands silently.
  conservative: {
    maxConcurrentPositions: 2,
    maxTradesPerDay: 4,
    targetRMultiple: 2,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxCorrelatedExposurePct: 4,
    maxSectorExposurePct: 15,
    minRelVol: 2,
    minPrice: 5,
    minAvgVolume: 1_000_000,
    minSignalScore: 60,
    maxTickerAtrPct: 10,
    maxMarketAtrPct: 4,
    optionsDeltaMin: 0.25,
    optionsDeltaMax: 0.5,
    optionsMaxSpreadPct: 8,
    optionsMinDte: 14,
    optionsMaxDte: 60,
    optionsIvRankMax: 60,
    optionsMaxIvRvRatio: 1,
    optionsStopLossPct: 40,
    optionsTakeProfitPct: 60,
    riskProfile: 'MODERATE',
    maxOrderEquityFraction: 0.2,
  },
  moderate: {
    maxConcurrentPositions: 2,
    maxTradesPerDay: 6,
    targetRMultiple: 2,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxCorrelatedExposurePct: 6,
    maxSectorExposurePct: 20,
    minRelVol: 1.5,
    minPrice: 2,
    minAvgVolume: 500_000,
    minSignalScore: 50,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    optionsDeltaMin: 0.3,
    optionsDeltaMax: 0.6,
    optionsMaxSpreadPct: 10,
    optionsMinDte: 7,
    optionsMaxDte: 60,
    optionsIvRankMax: 70,
    optionsMaxIvRvRatio: 1.2,
    optionsStopLossPct: 50,
    optionsTakeProfitPct: 80,
    riskProfile: 'MODERATE',
    maxOrderEquityFraction: 0.25,
  },
  aggressive: {
    maxConcurrentPositions: 5,
    maxTradesPerDay: 10,
    targetRMultiple: 2.5,
    stepDownAfterLosses: 3,
    stepDownSizeCutPct: 40,
    maxCorrelatedExposurePct: 12,
    maxSectorExposurePct: 35,
    minRelVol: 1.2,
    minPrice: 1,
    minAvgVolume: 200_000,
    minSignalScore: 40,
    maxTickerAtrPct: 20,
    maxMarketAtrPct: 7,
    optionsDeltaMin: 0.4,
    optionsDeltaMax: 0.7,
    optionsMaxSpreadPct: 15,
    optionsMinDte: 3,
    optionsMaxDte: 45,
    optionsIvRankMax: 85,
    optionsMaxIvRvRatio: 0,
    optionsStopLossPct: 60,
    optionsTakeProfitPct: 100,
    riskProfile: 'AGGRESSIVE',
    maxOrderEquityFraction: 0.35,
  },
};

/** The single-order notional cap as a fraction of equity, for a stored risk
 *  profile. Exported so suggestLiveCaps derives the SAME number this tuner does
 *  instead of hardcoding its own — otherwise "Suggest from equity" silently
 *  overwrote a tune's order cap with a different one (it used a flat 0.25 while
 *  an aggressive tune had set 0.35).
 *
 *  Note the config only stores MODERATE/AGGRESSIVE, so a conservative tune —
 *  which journals as MODERATE — reads back as the moderate fraction here. That
 *  is the closest recoverable answer, and still agrees with the tune for both
 *  labels the config can actually represent. */
export function maxOrderEquityFractionFor(riskProfile: 'MODERATE' | 'AGGRESSIVE'): number {
  return riskProfile === 'AGGRESSIVE' ? BANDS.aggressive.maxOrderEquityFraction : BANDS.moderate.maxOrderEquityFraction;
}

/** Target daily gain % → aggressiveness band. Fixed thresholds so the mapping
 *  is deterministic and explainable: the target is the master dial, and higher
 *  ambition loosens the whole shape, not just position size. */
export function bandForTarget(targetDailyGainPct: number): TuneBand {
  if (targetDailyGainPct <= 3) return 'conservative';
  if (targetDailyGainPct <= 8) return 'moderate';
  return 'aggressive';
}

/** Expected R per trade under the chosen basis, floored so it can't blow up the
 *  risk% solve. */
function edgeRFor(basis: TuneBasis, targetRMultiple: number): number {
  const raw = basis === 'perfectDay' ? targetRMultiple : ASSUMED_WIN_RATE * targetRMultiple - (1 - ASSUMED_WIN_RATE);
  return Math.max(MIN_EDGE_R, raw);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The exact set of AutotradeConfig keys this tuner is allowed to write —
 *  the risk/aggressiveness axis, screening filters, contract selection, and
 *  equity-scaled caps. Everything NOT listed is deliberately left untouched:
 *  the live-enable gates (liveTradingEnabled/liveOptionsEnabled/…At),
 *  killSwitch, enabled, liveAccountId, both probation ramps,
 *  liveAllowNakedShort, accountEquityUsd (the input), tradeDirection, the
 *  scoring-factor opt-ins (relativeStrength/sentiment/benchmark), correlation
 *  methodology, moversDiscoveryEnabled (WHERE candidates come from is a
 *  universe choice, not an aggressiveness dial), the entry/exit-refinement
 *  toolkits (regime sizing, maxHoldDays, equity + options breakeven/trail/
 *  partial), earnings/macro/session windows, optionsStrategyType, autoPromote*,
 *  and autoTune* — safety, identity, methodology, and independent strategy
 *  choices, none of which "how aggressively do I chase a daily % gain" should
 *  silently move.
 *
 *  Every AutotradeConfig key must appear either here or in NEVER_TUNED_KEYS
 *  below — the compile-time assertion after that list fails the build when a
 *  new config field is added without deciding which side it belongs on (which
 *  is exactly how minPrice/minSignalScore/optionsIvRankMin & co. once slipped
 *  past the tuner unnoticed). */
export type TunablePatch = Pick<
  AutotradeConfig,
  | 'riskProfile'
  | 'maxConcurrentPositions'
  | 'riskPerTradePct'
  | 'maxDailyDrawdownPct'
  | 'stepDownAfterLosses'
  | 'stepDownSizeCutPct'
  | 'maxAggregateOpenRiskPct'
  | 'maxCorrelatedExposurePct'
  | 'maxSectorExposurePct'
  | 'maxTradesPerDay'
  | 'minRelVol'
  | 'minPrice'
  | 'minAvgVolume'
  | 'minSignalScore'
  | 'maxTickerAtrPct'
  | 'maxMarketAtrPct'
  | 'targetRMultiple'
  | 'liveMaxOrderUsd'
  | 'liveMaxDailyLossUsd'
  | 'liveMaxOrdersPerDay'
  | 'liveCapsAnchorEquityUsd'
  | 'targetDailyGainPct'
  | 'giveBackArmPct'
  | 'giveBackFloorPct'
  | 'liveOptionsMaxOrderUsd'
  | 'liveOptionsMaxDailyLossUsd'
  | 'liveOptionsMaxOrdersPerDay'
  | 'optionsDeltaMin'
  | 'optionsDeltaMax'
  | 'optionsMaxSpreadPct'
  | 'optionsMinDte'
  | 'optionsMaxDte'
  | 'optionsIvRankMax'
  | 'optionsIvRankMin'
  | 'optionsMaxIvRvRatio'
  | 'optionsStopLossPct'
  | 'optionsTakeProfitPct'
>;

/** The AutotradeConfig keys the tuner deliberately never writes — the other
 *  half of the classification TunablePatch starts. Grouped by the reason each
 *  is excluded; a key belongs here only with a reason, not by omission. */
export const NEVER_TUNED_KEYS = [
  // Safety gates & identity — a preset must never arm anything or change whose
  // account it is.
  'enabled',
  'killSwitch',
  'liveTradingEnabled',
  'liveEnabledAt',
  'liveOptionsEnabled',
  'liveOptionsEnabledAt',
  'liveAccountId',
  'liveAllowNakedShort',
  'liveFatFingerPct',
  'liveOptionsFatFingerPct',
  'liveProbationTrades',
  'liveProbationSizeMultiplier',
  'liveOptionsProbationTrades',
  'liveOptionsProbationSizeMultiplier',
  // The tune's own input.
  'accountEquityUsd',
  // Methodology / strategy identity — independent choices about HOW and WHERE
  // to trade, orthogonal to how aggressively.
  'tradeDirection',
  'moversDiscoveryEnabled',
  'requireWeeklyTrendAlignment',
  'relativeStrengthWeight',
  'benchmarkSymbol',
  'relativeStrengthLookbackDays',
  'sentimentWeight',
  'correlationLookbackDays',
  'correlationThreshold',
  'correlationAwareSelectionEnabled',
  'regimeAdaptiveWeightsEnabled',
  'regimeWeightPresets',
  'optionsStrategyType',
  'optionsMinOpenInterest',
  'optionsMinVolume',
  // Entry/exit-refinement toolkits & sizing overlays — tuned by their own
  // tools (or by hand), keyed to trade geometry rather than daily ambition.
  'stopAtrMultiple',
  'maxHoldDays',
  'breakevenTriggerRMultiple',
  'trailStartRMultiple',
  'trailStopRMultiple',
  'partialExitRMultiple',
  'partialExitPct',
  'addOnTriggerRMultiple',
  'addOnSizePct',
  'maxAddOns',
  'liveScaleInEnabled',
  'liveMaxAddOns',
  'optionsBreakevenTriggerPct',
  'optionsTrailStartPct',
  'optionsTrailStopPct',
  'optionsPartialExitTriggerPct',
  'optionsPartialExitPct',
  'regimeAtrThresholdPct',
  'regimeSizeCutPct',
  'equityCurveDeriskEnabled',
  'equityCurveLookbackDays',
  'equityCurveDeriskCutPct',
  'symbolCooldownLosses',
  'symbolCooldownWindowDays',
  'symbolCooldownDays',
  'finishLineSizingEnabled',
  'finishLineMinSignalScore',
  'maxAdvParticipationPct',
  'convictionGradeAMinScore',
  'convictionGradeBMinScore',
  'expectancyWeightingEnabled',
  'methodWeightingEnabled',
  'expectancyMinTrades',
  'expectancyMinMultiplier',
  'expectancyMaxMultiplier',
  // Session/event windows — calendar policy, not aggressiveness.
  'sessionBufferMinutes',
  'earningsBlackoutDays',
  'macroEventBlackoutHours',
  // The continuous tuners and movers auto-promotion — separate machinery this
  // one-shot preset only warns about, never reconfigures.
  'autoPromoteMoversEnabled',
  'autoPromoteThreshold',
  'autoPromoteWindowDays',
  'autoPromoteMaxSymbols',
  'autoTuneEnabled',
  'autoTuneMinTrades',
  'autoTuneMaxStepPct',
  'autoTuneSlippageExcludePct',
  'autoTuneExitsEnabled',
  'autoTuneExitMaxStep',
  'autoTuneExitTunedAt',
  'autoTuneRequireOosConfirmation',
] as const satisfies readonly (keyof AutotradeConfig)[];

type NeverTunedKey = (typeof NEVER_TUNED_KEYS)[number];
type AssertNever<T extends never> = T;
/** Compile-time exhaustiveness: a config key on neither list makes this alias
 *  non-never and the build fails, forcing the classification decision. */
export type UnclassifiedAutotradeConfigKey = AssertNever<
  Exclude<keyof AutotradeConfig, keyof TunablePatch | NeverTunedKey>
>;
/** …and a key on BOTH lists fails here. */
export type MisclassifiedAutotradeConfigKey = AssertNever<Extract<keyof TunablePatch, NeverTunedKey>>;

export interface TargetTuneResult {
  band: TuneBand;
  basis: TuneBasis;
  targetDailyGainPct: number;
  /** Expected R per trade the risk% solve used (basis-dependent). */
  edgeR: number;
  /** The raw solved risk% BEFORE the MAX_SUGGESTED_RISK_PER_TRADE_PCT clamp —
   *  surfaced so the UI can show what the target actually implied when it's
   *  clamped. */
  rawRiskPerTradePct: number;
  patch: TunablePatch;
  warnings: string[];
}

function shapeToPatch(
  shape: BandShape,
  equityUsd: number,
  riskPerTradePct: number,
  targetDailyGainPct: number | null,
): TunablePatch {
  // Daily-loss halt sized to a bad day at THIS sizing (~75% of the day's trades
  // losing), floored at 2% and capped at 40% so it never trips before the
  // target is reachable, and never disables itself.
  const maxDailyDrawdownPct = clamp(round2(shape.maxTradesPerDay * riskPerTradePct * 0.75), 2, 40);
  // Dollar caps mirror suggestLiveCaps's equity × fraction approach: the
  // per-order cap is a generous fat-finger backstop (band-varying fraction of
  // equity, not primary sizing), and the daily-loss cap matches the tuned
  // drawdown % in dollars so the guardrail layer agrees exactly with the risk
  // engine's own % halt rather than being a conflicting second number.
  const dailyLossUsd = Math.round(equityUsd * (maxDailyDrawdownPct / 100));
  const orderUsd = Math.round(equityUsd * shape.maxOrderEquityFraction);
  return {
    riskProfile: shape.riskProfile,
    maxConcurrentPositions: shape.maxConcurrentPositions,
    riskPerTradePct,
    maxDailyDrawdownPct,
    stepDownAfterLosses: shape.stepDownAfterLosses,
    stepDownSizeCutPct: shape.stepDownSizeCutPct,
    // The whole open book can hold its intended number of positions at this
    // per-trade risk; capped at 30% of equity as an absolute aggregate ceiling.
    maxAggregateOpenRiskPct: clamp(round2(riskPerTradePct * shape.maxConcurrentPositions), riskPerTradePct, 30),
    maxCorrelatedExposurePct: shape.maxCorrelatedExposurePct,
    maxSectorExposurePct: shape.maxSectorExposurePct,
    maxTradesPerDay: shape.maxTradesPerDay,
    minRelVol: shape.minRelVol,
    minPrice: shape.minPrice,
    minAvgVolume: shape.minAvgVolume,
    minSignalScore: shape.minSignalScore,
    maxTickerAtrPct: shape.maxTickerAtrPct,
    maxMarketAtrPct: shape.maxMarketAtrPct,
    targetRMultiple: shape.targetRMultiple,
    liveMaxOrderUsd: orderUsd,
    liveMaxDailyLossUsd: dailyLossUsd,
    liveMaxOrdersPerDay: shape.maxTradesPerDay,
    // Records the equity the dollar caps above were derived from, ARMING the
    // automatic re-anchor (liveCapsReanchor.ts): when synced equity later
    // drifts ≥15% from this, the caps are re-derived so they keep meaning what
    // this tune meant by them.
    liveCapsAnchorEquityUsd: equityUsd,
    // Applying a tune both CALIBRATES sizing to the goal and ARMS the live
    // daily-goal tracker (services/autotrading/dailyTarget.ts): the loop halts
    // new live entries for the rest of the ET day once the day's account value
    // has grown by this %. Null (reset-to-moderate) declares no goal, which
    // disarms the tracker.
    targetDailyGainPct,
    // The give-back guard rides the same dial: arm once the day is 2/3 of the
    // way to the goal, halt new entries if it then fades back to 1/3 — keep
    // most of an almost-banked day (dailyTarget.ts). Null target = guard off
    // too; there is no day-gain axis to put the levels on.
    giveBackArmPct: targetDailyGainPct === null ? null : round2((targetDailyGainPct * 2) / 3),
    giveBackFloorPct: targetDailyGainPct === null ? null : round2(targetDailyGainPct / 3),
    liveOptionsMaxOrderUsd: orderUsd,
    liveOptionsMaxDailyLossUsd: dailyLossUsd,
    liveOptionsMaxOrdersPerDay: shape.maxTradesPerDay,
    optionsDeltaMin: shape.optionsDeltaMin,
    optionsDeltaMax: shape.optionsDeltaMax,
    optionsMaxSpreadPct: shape.optionsMaxSpreadPct,
    optionsMinDte: shape.optionsMinDte,
    optionsMaxDte: shape.optionsMaxDte,
    optionsIvRankMax: shape.optionsIvRankMax,
    // The IV-rank floor stays OFF in every band: the bands select long-premium
    // contracts, where cheap implied vol is the goal and the ceiling above is
    // the active gate. Still written (as 0) so a leftover experimental floor
    // can't sit contradicting a fresh tune's ceiling.
    optionsIvRankMin: 0,
    optionsMaxIvRvRatio: shape.optionsMaxIvRvRatio,
    optionsStopLossPct: shape.optionsStopLossPct,
    optionsTakeProfitPct: shape.optionsTakeProfitPct,
  };
}

export interface ComputeTargetTuneInput {
  equityUsd: number;
  targetDailyGainPct: number;
  basis: TuneBasis;
  /** Current config — read only to warn about interactions (the auto-tuners);
   *  never mutated. */
  config: Pick<AutotradeConfig, 'autoTuneEnabled' | 'autoTuneExitsEnabled'>;
}

/** Derive a full tunable patch from equity + a target daily gain % under the
 *  chosen basis. Pure — returns the patch and any warnings; the caller applies
 *  it through the ordinary config PUT. */
export function computeTargetTune(input: ComputeTargetTuneInput): TargetTuneResult {
  const { equityUsd, targetDailyGainPct, basis } = input;
  const band = bandForTarget(targetDailyGainPct);
  const shape = BANDS[band];
  const edgeR = edgeRFor(basis, shape.targetRMultiple);

  const rawRiskPerTradePct = round2(targetDailyGainPct / (shape.maxTradesPerDay * edgeR));
  const riskPerTradePct = clamp(rawRiskPerTradePct, 0.1, MAX_SUGGESTED_RISK_PER_TRADE_PCT);

  const patch = shapeToPatch(shape, equityUsd, riskPerTradePct, targetDailyGainPct);

  const warnings: string[] = [];
  if (rawRiskPerTradePct > MAX_SUGGESTED_RISK_PER_TRADE_PCT) {
    warnings.push(
      `Reaching ${targetDailyGainPct}%/day under this basis would need ~${rawRiskPerTradePct}% risk per trade — well past a survivable level. Capped the suggestion at ${MAX_SUGGESTED_RISK_PER_TRADE_PCT}%; lower the target or accept a smaller expected day. (You can still hand-enter a higher risk %, but a few losers in a row would be account-ending.)`,
    );
  }
  if (riskPerTradePct >= 3) {
    warnings.push(
      `Suggested ${riskPerTradePct}% risk per trade is aggressive — a losing streak compounds fast at this size. Make sure the ${patch.maxDailyDrawdownPct}% daily-loss halt is a number you can actually stomach.`,
    );
  }
  if (input.config.autoTuneEnabled) {
    warnings.push(
      'Auto-tune from realized edge is ON — it re-adjusts risk-per-trade toward your realized Kelly over time, so it will gradually move the risk % this sets. Turn it off if you want this tune to stick exactly.',
    );
  }
  // The exit tuner writes targetRMultiple, which is an INPUT to the risk% solve
  // above (edgeRFor). Once it moves, the risk % this tune derived no longer
  // corresponds to the target you asked for, and nothing re-derives it — so this
  // is a stronger interaction than the risk-% one, not a footnote to it.
  if (input.config.autoTuneExitsEnabled) {
    warnings.push(
      `Auto-tune of exit geometry is ON — it moves the stop multiple and the ${patch.targetRMultiple}R target toward what your winning trades actually did. The reward:risk is what this tune solved the ${riskPerTradePct}% risk per trade FROM, so once it shifts, the risk % no longer matches ${targetDailyGainPct}%/day and is not re-derived. Turn it off if you want this tune to stick exactly.`,
    );
  }
  return { band, basis, targetDailyGainPct, edgeR: round2(edgeR), rawRiskPerTradePct, patch, warnings };
}

/** The moderate baseline, equity-scaled — "reset to moderate for THIS account":
 *  the moderate row of the published band table (docs/TUNE_FROM_TARGET.md §5),
 *  with risk-per-trade back at the 1% default and the dollar caps recomputed
 *  from current equity.
 *
 *  Deliberately NOT identical to defaultAutotradeConfig() — see the note on
 *  BANDS above for the three fields that differ and why. "Moderate" here means
 *  the band, not the shipped defaults. */
export function resetToModerate(equityUsd: number): TunablePatch {
  // No declared goal — the moderate baseline is a risk shape, not a promise;
  // writing null here also DISARMS the daily-goal tracker until the next tune.
  return shapeToPatch(BANDS.moderate, equityUsd, 1, null);
}
