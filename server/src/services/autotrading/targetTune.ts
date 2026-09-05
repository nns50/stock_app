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
    // 0.25, not a tighter conservative number of its own: the config stores
    // only MODERATE/AGGRESSIVE, so a conservative tune journals as MODERATE and
    // is READ BACK as the moderate fraction by maxOrderEquityFractionFor —
    // which deriveDollarCaps and liveCapsReanchor both use. A different value
    // here would mean a freshly-applied conservative tune instantly looked
    // hand-edited, freezing its per-order cap out of re-anchoring forever
    // (2026-08-25). The cap is a fat-finger backstop, not primary sizing, so
    // agreeing with the value the rest of the system can actually recover
    // matters more than a marginally tighter one it cannot.
    maxOrderEquityFraction: 0.25,
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
/** Orders a single trade can need in a day: the ENTRY, plus one loop-placed
 *  CLOSE for it. Bracket stop/target legs ride along with the entry order and
 *  cost nothing extra here; a scale-in add-on is deliberately NOT multiplied
 *  in — when the budget runs out, blocking an optional add-on is the right
 *  thing to lose, and closing a position is not. */
const ORDERS_PER_TRADE = 2;

/** ...and THREE when scale-out is on (2026-09-01): entry, the partial exit at
 *  partialExitRMultiple, then the final close. Enabling liveScaleOutEnabled
 *  silently raised every trade's order cost by 50% while this formula still
 *  said 2, leaving the cap short by a third of a day's budget — the same
 *  exit-starvation shape the comment below describes, arrived at from a new
 *  direction. A partial exit is a CLOSE, not an optional add-on: it is the
 *  half of the position that actually banks the move, so it must be inside
 *  the budget rather than competing with it. */
const ORDERS_PER_TRADE_WITH_SCALE_OUT = 3;

/**
 * `liveMaxOrdersPerDay` for a given entry budget.
 *
 * This used to be `maxTradesPerDay` exactly, which quietly made the two caps
 * fight: maxTradesPerDay counts ENTRIES, while the guardrail this feeds
 * (countTodaysOrders, guardrails.ts's max_orders_per_day) counts every
 * submitted intent — entries AND exits. So "4 trades a day" really bought
 * 4 orders total, and every exit the loop placed cost an entry.
 *
 * That is not theoretical. On 2026-08-24, with both caps at 4, the day spent
 * its budget on three entries plus one stagnation scratch; GRMN's own
 * stagnation exit was then blocked 44 times on `max_orders_per_day: 4 placed
 * vs 4/day` and the position was carried overnight against the loop's own
 * judgement. The intraday stagnation exit exists to recycle a slot, so having
 * each scratch cost a fresh entry defeated the feature that placed it.
 *
 * The entry budget is unchanged — maxTradesPerDay still caps entries, and
 * riskCheck still enforces it. This only stops exits from eating that budget.
 */
export function liveOrderCapForTrades(maxTradesPerDay: number, scaleOutEnabled = false): number {
  return maxTradesPerDay * (scaleOutEnabled ? ORDERS_PER_TRADE_WITH_SCALE_OUT : ORDERS_PER_TRADE);
}

/** The dollar caps a tune derives, and the only ones liveCapsReanchor moves.
 *  Kept here, beside the formulas that produce them, so the tuner and the
 *  re-anchor can never derive a cap two different ways. */
export const DOLLAR_CAP_KEYS = [
  'liveMaxOrderUsd',
  'liveMaxDailyLossUsd',
  'liveOptionsMaxOrderUsd',
  'liveOptionsMaxDailyLossUsd',
] as const;
export type DollarCapKey = (typeof DOLLAR_CAP_KEYS)[number];
export type DollarCaps = Record<DollarCapKey, number>;

/** The dollar caps THIS config's percentages imply at `equityUsd`. Derived
 *  from the CURRENT config rather than by replaying a tune, so it stays correct
 *  after auto-tune or a hand edit moves the percentages. */
/** Headroom above the smallest order the sizer can produce. A tighter stop
 *  makes the notional BIGGER (same dollars of risk over a shorter distance),
 *  so the floor is only the smallest case; 1.5x leaves room for ordinary
 *  tighter-stop candidates without the cap ceasing to be a backstop. */
const ORDER_CAP_SIZER_HEADROOM = 1.5;

/** The smallest order the sizer can produce at this equity, in dollars. A
 *  per-order cap below this blocks every entry. */
export function sizerFloorUsd(
  cfg: Pick<AutotradeConfig, 'riskPerTradePct' | 'maxStopDistancePct'>,
  equityUsd: number,
): number {
  return equityUsd * sizerFloorFraction(cfg);
}

/**
 * The smallest position the sizer can legitimately produce, as a fraction of
 * equity: risk% spread over the WIDEST stop it will accept.
 *
 * This is the term the cap formula was missing, and its absence is not a
 * rounding issue — it is a contradiction. On 2026-08-27 at riskPerTradePct
 * 1.25 and maxStopDistancePct 2.5, the sizer produced 50% of equity while the
 * profile fraction allowed 25%: a correctly-sized position could never fit its
 * own cap, and re-anchoring would have rewritten the cap DOWN from $1,600 to
 * $1,290, tightening the block. The failure surfaced twice in one day — once
 * at $2,283 of equity and again after a $5,000 deposit — because nothing tied
 * the two formulas together.
 */
export function sizerFloorFraction(cfg: Pick<AutotradeConfig, 'riskPerTradePct' | 'maxStopDistancePct'>): number {
  const stop = cfg.maxStopDistancePct;
  if (!(stop > 0) || !(cfg.riskPerTradePct > 0)) return 0;
  return cfg.riskPerTradePct / stop;
}

export function deriveDollarCaps(
  cfg: Pick<AutotradeConfig, 'maxDailyDrawdownPct' | 'riskProfile' | 'riskPerTradePct' | 'maxStopDistancePct'>,
  equityUsd: number,
): DollarCaps {
  const dailyLossUsd = Math.round(equityUsd * (cfg.maxDailyDrawdownPct / 100));
  // The larger of the fat-finger intent and what the sizer actually makes.
  // max(), not min(): a cap below the sizer's own output blocks every order,
  // which is not caution, it is a system that cannot trade.
  const byProfile = equityUsd * maxOrderEquityFractionFor(cfg.riskProfile);
  const bySizer = equityUsd * sizerFloorFraction(cfg) * ORDER_CAP_SIZER_HEADROOM;
  // NOT bounded by buying power any more (2026-09-05). The bound was added on
  // the reasonable premise that "an order the account cannot fund is not a cap
  // worth having" — but it made this function's output depend on a number only
  // ONE of its three call sites can see, and that is precisely the trap the
  // comment below already describes for the options twin.
  //
  // The tune apply passes buying power (it has a broker call). handEditedDollarCaps
  // and liveCapsReanchor cannot — the re-anchor works from config alone, by
  // design. So on any day funding actually bound the cap, the tune would STORE
  // the smaller figure while the anchor check re-derived the larger one, the
  // two would disagree, and the cap would be flagged hand-edited and skipped by
  // every future re-anchor. Frozen for good by an argument about one afternoon's
  // buying power.
  //
  // It is also redundant now. Since the sizer learned every dollar bound
  // (fundableMaxQuantity), buying power is enforced where the live figure is
  // actually in hand — at decision time, alongside the per-order and exposure
  // caps — which is exactly where the options comment below argues it belongs.
  // A stored cap should describe intent; funding is a fact about right now.
  const orderUsd = Math.max(byProfile, bySizer);
  // The options twin deliberately tracks the equity cap rather than option
  // buying power, even though option BP is a far smaller pool ($322-471 against
  // a day BP of $8,644 on 2026-08-27). These are STORED caps, re-derived
  // independently by the tune and by liveCapsReanchor -- and the re-anchor
  // works from config alone, with no broker call, so it cannot see option BP.
  // A cap bound to a number only one derivation path can observe, and which
  // moved 32% in an hour that day, would read as hand-edited to the other path
  // and freeze out of re-anchoring forever: exactly the trap the 2026-08-27
  // decision log describes. Bounding options ORDERS by option BP belongs at
  // use time, where the live figure is in hand -- not in a stored cap.
  return {
    liveMaxOrderUsd: Math.round(orderUsd),
    liveMaxDailyLossUsd: dailyLossUsd,
    liveOptionsMaxOrderUsd: Math.round(orderUsd),
    liveOptionsMaxDailyLossUsd: dailyLossUsd,
  };
}

/** The config a hand-edit check needs: the caps themselves, the percentages
 *  they were derived from, and the equity they were derived AT. */
export type DollarCapConfig = Pick<
  AutotradeConfig,
  | DollarCapKey
  | 'maxDailyDrawdownPct'
  | 'riskProfile'
  | 'riskPerTradePct'
  | 'maxStopDistancePct'
  | 'liveCapsAnchorEquityUsd'
>;

/**
 * Dollar caps a human set deliberately — those that no longer equal what the
 * anchor equity derives. "Only move what you own."
 *
 * liveCapsReanchor has enforced this since it was written, and its header
 * described it as "the same rule that keeps the tune itself from stomping
 * deliberate config" — but the tune never actually implemented it, so applying
 * a tune silently reverted a hand-raised cap while the re-anchor carefully
 * preserved it. That is not academic: liveMaxOrderUsd was raised from the
 * derived $439 to $1,600 on 2026-08-24 because the derived value was BELOW
 * what correct position sizing produces on a small account and was blocking
 * every entry (`order_notional: $1,236.06 vs cap $439.00`). A retune would
 * have put the account straight back into that state.
 *
 * No anchor = not armed: nothing is treated as hand-edited, because without
 * the equity the caps were derived at there is no way to tell a deliberate
 * value from a derived one. Same posture as the re-anchor's own no-op.
 */
export function handEditedDollarCaps(cfg: DollarCapConfig): DollarCapKey[] {
  const anchor = cfg.liveCapsAnchorEquityUsd;
  if (anchor === null || !(anchor > 0)) return [];
  const atAnchor = deriveDollarCaps(cfg, anchor);
  return DOLLAR_CAP_KEYS.filter((key) => cfg[key] !== atAnchor[key]);
}

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
  // Account CAPACITY, not strategy. Both describe what the brokerage account
  // can actually fund; neither follows from a target daily gain, and a tune
  // that "helpfully" widened either would be inventing leverage the broker
  // never granted.
  'liveMaxExposurePct',
  'liveDayBuyingPowerUsd',
  // A data-quality guard on the broker feed. Nothing about a target daily gain
  // implies how much a net-liquidation reading is allowed to jump.
  'equitySyncMaxJumpPct',
  // A slot reservation for the evidence track, not a risk parameter — the
  // combined aggregate-RISK budget the tune does calibrate is untouched by it.
  'optionsMaxConcurrentPositions',
  // Structural facts about the CHART, not about a desired return. How far a
  // name travels in a session, how much volume marks a real breakout, and how
  // much history counts as structure are all properties of the market; a tune
  // that stretched them to reach a daily target would be moving the measuring
  // stick rather than the trade. levelMinRewardR and the rest of the level
  // family are already NEVER_TUNED for the same reason.
  // Whether 1R is reachable on a given name is a fact about that stock's daily
  // range, not about a desired return. A tune that relaxed it to hit a target
  // would be buying trades that cannot pay, which is the opposite of tuning.
  'maxRiskAtrFraction',
  // How long to stay away from a name just exited is a discipline rule, not a
  // dial on a desired return — same reason the LOSS cooldown's own fields are
  // never tuned.
  'symbolReentryCooldownMinutes',
  'levelTargetReachAtrMultiple',
  'levelBreakoutRelVolPace',
  'levelLookbackBars',
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
  'minRelVolPace',
  'minChangePct',
  'momentumIntradayOnly',
  'maxStopDistancePct',
  'liveScaleOutEnabled',
  'liveScaleOutCancelReplaceEnabled',
  'liveTrailingEnabled',
  'dayProtectiveStopEnabled',
  'shortDatedOptionsEnabled',
  'optionsHardExitMinutesBeforeClose',
  'optionsNoEntryMinutesBeforeClose',
  'optionsUnderlyingStopPct',
  'optionsGiveBackArmPct',
  'optionsGiveBackPct',
  'optionsStagnationMinutes',
  'optionsStagnationMinMovePct',
  'optionsDisasterStopPct',
  'stagnationExitMinutes',
  'stagnationExitMinR',
  'endOfDayFlattenMinutes',
  'levelExitsEnabled',
  'levelMinStrength',
  'levelBufferPct',
  'levelMaxStopWidenPct',
  'levelMinRewardR',
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
  /** The stop ceiling the sizer works to. deriveDollarCaps needs it to keep
   *  the order cap above what the sizer can actually produce; the tune itself
   *  does not set it, so it is threaded in from live config. */
  maxStopDistancePct: number,
  /** Whether the live book takes a partial exit — threaded in from live config
   *  for the same reason maxStopDistancePct is: the tune does not set it, but
   *  the order cap it derives is wrong without it. */
  scaleOutEnabled = false,
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
  // Through deriveDollarCaps, NOT a second copy of its arithmetic: that
  // function is what liveCapsReanchor reads, and the two must agree by
  // construction or a fresh tune reads as drifted. This file used to compute
  // the order cap inline from maxOrderEquityFractionFor and they agreed by
  // coincidence of formula; once deriveDollarCaps gained the sizer-floor term
  // (see its doc comment) the copies diverged, which is precisely the failure
  // the old comment here was written to prevent.
  const caps = deriveDollarCaps(
    { maxDailyDrawdownPct, riskProfile: shape.riskProfile, riskPerTradePct, maxStopDistancePct },
    equityUsd,
  );
  const dailyLossUsd = caps.liveMaxDailyLossUsd;
  const orderUsd = caps.liveMaxOrderUsd;
  // Read from `caps`, never re-using orderUsd: the options twin is its own
  // field, and assigning the equity figure to it silently DISCARDED whatever
  // deriveDollarCaps decided for options. Found 2026-08-27, when an option-BP
  // bound was computed here and thrown away -- unit tests on deriveDollarCaps
  // passed throughout, because nothing tested the patch this builds.
  const optionsOrderUsd = caps.liveOptionsMaxOrderUsd;
  const optionsDailyLossUsd = caps.liveOptionsMaxDailyLossUsd;
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
    liveMaxOrdersPerDay: liveOrderCapForTrades(shape.maxTradesPerDay, scaleOutEnabled),
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
    liveOptionsMaxOrderUsd: optionsOrderUsd,
    liveOptionsMaxDailyLossUsd: optionsDailyLossUsd,
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
  /** Current config — read only, never mutated: to warn about interactions
   *  (the auto-tuners), and to spot dollar caps a human set deliberately so
   *  this tune preserves them instead of reverting them. */
  config: Pick<AutotradeConfig, 'autoTuneEnabled' | 'autoTuneExitsEnabled' | 'liveScaleOutEnabled'> & DollarCapConfig;
  /** Available buying power, when the caller knows it. WARNS only — it must
   *  never bound a stored cap (see deriveDollarCaps): this figure is visible
   *  to the tune and invisible to liveCapsReanchor, so a cap derived from it
   *  would read as hand-edited to the re-anchor and freeze forever. Funding is
   *  enforced at decision time by the sizer; here it only tells the operator
   *  the cap they are about to store is above what today can actually fund. */
  buyingPowerUsd?: number;
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

  const patch = shapeToPatch(
    shape,
    equityUsd,
    riskPerTradePct,
    targetDailyGainPct,
    input.config.maxStopDistancePct,
    input.config.liveScaleOutEnabled,
  );

  const warnings: string[] = [];

  // Only move what you own. A dollar cap that no longer matches its
  // anchor-derived value was set by a human; carry it through unchanged rather
  // than reverting it — the rule liveCapsReanchor already enforces, and which
  // its header wrongly assumed the tune enforced too. The keys stay in the
  // patch (set to their current values) so it remains a complete TunablePatch;
  // applying it is simply a no-op for them.
  const preserved = handEditedDollarCaps(input.config);
  for (const key of preserved) patch[key] = input.config[key];
  if (preserved.length > 0) {
    warnings.push(
      `Kept your own ${preserved.join(', ')} instead of the equity-derived value — these were set by hand, so this tune leaves them alone. Clear them back to the suggested figures if you want the tune to size them again.`,
    );
  }
  // Funding is a fact about today, not a property of the shape being stored,
  // so it informs rather than binds. The sizer (fundableMaxQuantity) already
  // trims a real order to what buying power supports; this only stops the
  // preview from showing a per-order cap the operator would read as spendable.
  const bp = input.buyingPowerUsd;
  if (bp !== undefined && bp > 0 && patch.liveMaxOrderUsd > bp) {
    warnings.push(
      `The $${patch.liveMaxOrderUsd.toLocaleString()} per-order cap is above your current buying power ($${Math.round(bp).toLocaleString()}), so today's orders will be trimmed to what the account can fund. The cap is deliberately NOT lowered to match — it is a stored ceiling on intent, and pinning it to one afternoon's buying power would freeze it out of future re-anchoring.`,
    );
  }
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
export function resetToModerate(equityUsd: number, maxStopDistancePct: number, scaleOutEnabled = false): TunablePatch {
  // No declared goal — the moderate baseline is a risk shape, not a promise;
  // writing null here also DISARMS the daily-goal tracker until the next tune.
  return shapeToPatch(BANDS.moderate, equityUsd, 1, null, maxStopDistancePct, scaleOutEnabled);
}
