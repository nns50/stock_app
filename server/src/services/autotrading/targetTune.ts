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
// nudges riskPerTradePct toward realized Kelly OVER TIME): this is a one-shot
// human-initiated preset, that is a continuous background adjuster. If autoTune
// is enabled, computeTargetTune warns that it will later re-move risk-per-trade
// — the two writing the same field is surfaced, never silent.
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
  maxTickerAtrPct: number;
  maxMarketAtrPct: number;
  optionsDeltaMin: number;
  optionsDeltaMax: number;
  optionsMaxSpreadPct: number;
  optionsMinDte: number;
  optionsMaxDte: number;
  optionsIvRankMax: number;
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
  // The 'moderate' band reproduces defaultAutotradeConfig()'s shape exactly, so
  // "reset to moderate" is a true baseline, not a nearby approximation.
  conservative: {
    maxConcurrentPositions: 2,
    maxTradesPerDay: 4,
    targetRMultiple: 2,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxCorrelatedExposurePct: 4,
    maxSectorExposurePct: 15,
    minRelVol: 2,
    maxTickerAtrPct: 10,
    maxMarketAtrPct: 4,
    optionsDeltaMin: 0.25,
    optionsDeltaMax: 0.5,
    optionsMaxSpreadPct: 8,
    optionsMinDte: 14,
    optionsMaxDte: 60,
    optionsIvRankMax: 60,
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
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    optionsDeltaMin: 0.3,
    optionsDeltaMax: 0.6,
    optionsMaxSpreadPct: 10,
    optionsMinDte: 7,
    optionsMaxDte: 60,
    optionsIvRankMax: 70,
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
    maxTickerAtrPct: 20,
    maxMarketAtrPct: 7,
    optionsDeltaMin: 0.4,
    optionsDeltaMax: 0.7,
    optionsMaxSpreadPct: 15,
    optionsMinDte: 3,
    optionsMaxDte: 45,
    optionsIvRankMax: 85,
    optionsStopLossPct: 60,
    optionsTakeProfitPct: 100,
    riskProfile: 'AGGRESSIVE',
    maxOrderEquityFraction: 0.35,
  },
};

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
 *  the risk/aggressiveness axis, contract selection, and equity-scaled caps.
 *  Everything NOT listed is deliberately left untouched: the live-enable gates
 *  (liveTradingEnabled/liveOptionsEnabled/…At), killSwitch, enabled,
 *  liveAccountId, both probation ramps, liveAllowNakedShort, accountEquityUsd
 *  (the input), tradeDirection, the scoring-factor opt-ins (relativeStrength/
 *  sentiment/benchmark), correlation methodology, the entry/exit-refinement
 *  toolkits (regime sizing, maxHoldDays, equity + options breakeven/trail/
 *  partial), earnings/macro/session windows, optionsStrategyType, autoPromote*,
 *  and autoTune* — safety, identity, methodology, and independent strategy
 *  choices, none of which "how aggressively do I chase a daily % gain" should
 *  silently move. */
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
  | 'maxTickerAtrPct'
  | 'maxMarketAtrPct'
  | 'targetRMultiple'
  | 'liveMaxOrderUsd'
  | 'liveMaxDailyLossUsd'
  | 'liveMaxOrdersPerDay'
  | 'liveOptionsMaxOrderUsd'
  | 'liveOptionsMaxDailyLossUsd'
  | 'liveOptionsMaxOrdersPerDay'
  | 'optionsDeltaMin'
  | 'optionsDeltaMax'
  | 'optionsMaxSpreadPct'
  | 'optionsMinDte'
  | 'optionsMaxDte'
  | 'optionsIvRankMax'
  | 'optionsStopLossPct'
  | 'optionsTakeProfitPct'
>;

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

function shapeToPatch(shape: BandShape, equityUsd: number, riskPerTradePct: number): TunablePatch {
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
    maxTickerAtrPct: shape.maxTickerAtrPct,
    maxMarketAtrPct: shape.maxMarketAtrPct,
    targetRMultiple: shape.targetRMultiple,
    liveMaxOrderUsd: orderUsd,
    liveMaxDailyLossUsd: dailyLossUsd,
    liveMaxOrdersPerDay: shape.maxTradesPerDay,
    liveOptionsMaxOrderUsd: orderUsd,
    liveOptionsMaxDailyLossUsd: dailyLossUsd,
    liveOptionsMaxOrdersPerDay: shape.maxTradesPerDay,
    optionsDeltaMin: shape.optionsDeltaMin,
    optionsDeltaMax: shape.optionsDeltaMax,
    optionsMaxSpreadPct: shape.optionsMaxSpreadPct,
    optionsMinDte: shape.optionsMinDte,
    optionsMaxDte: shape.optionsMaxDte,
    optionsIvRankMax: shape.optionsIvRankMax,
    optionsStopLossPct: shape.optionsStopLossPct,
    optionsTakeProfitPct: shape.optionsTakeProfitPct,
  };
}

export interface ComputeTargetTuneInput {
  equityUsd: number;
  targetDailyGainPct: number;
  basis: TuneBasis;
  /** Current config — read only to warn about interactions (autoTuneEnabled);
   *  never mutated. */
  config: Pick<AutotradeConfig, 'autoTuneEnabled'>;
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

  const patch = shapeToPatch(shape, equityUsd, riskPerTradePct);

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
  return { band, basis, targetDailyGainPct, edgeR: round2(edgeR), rawRiskPerTradePct, patch, warnings };
}

/** The moderate baseline, equity-scaled — "reset to moderate for THIS account".
 *  Same shape defaultAutotradeConfig() ships (the moderate band reproduces it),
 *  with the dollar caps recomputed from current equity and risk-per-trade back
 *  at the 1% default. */
export function resetToModerate(equityUsd: number): TunablePatch {
  return shapeToPatch(BANDS.moderate, equityUsd, 1);
}
