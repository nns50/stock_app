import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody, parseQuery } from './_helpers';
import { tuneBuyingPower } from '../services/autotrading/tuneFunding';
import { resetDailyBaselineFlags } from '../db/dailyBaseline';
import { updateDailyTarget } from '../services/autotrading/dailyTarget';
import {
  AutotradeConfig,
  getAutotradeConfig,
  setAutotradeConfig,
  setAutotradeKillSwitch,
  LIVE_TRADING_CONFIRMATION_PHRASE,
} from '../db/autotradeConfig';
import { addExclusion, listExclusions, removeExclusion } from '../db/autotradeExclusions';
import { addMacroEvent, listMacroEvents, removeMacroEvent } from '../db/macroEvents';
import {
  AutotradeStage,
  countAutotradeEventsByDay,
  listAutotradeEvents,
  listKnownAutotradeEventActions,
  logAutotradeEvent,
} from '../db/autotradeEvents';
import { runAutotradeScreen } from '../services/autotrading/screen';
import { DecisionConfig, runAutotradeDecision } from '../services/autotrading/decide';
import { OptionsDecisionConfig, runOptionsDecision } from '../services/autotrading/optionsDecide';
import { runAutotradeRiskCheck } from '../services/autotrading/riskCheck';
import { runOptionsRiskCheck } from '../services/autotrading/optionsRiskCheck';
import { ScreenerConfig } from '../indicators/screener';
import { computeMarketRegime, RegimeLabel } from '../services/marketRegime';
import { resolveScoringWeights } from '../services/autotrading/regimeWeights';
import { computeBacktestStats, runBacktest, runWalkForwardBacktest } from '../services/autotrading/backtest';
import { runOptionsBacktest, runOptionsWalkForwardBacktest } from '../services/autotrading/optionsBacktest';
import { runCombinedBacktest, runCombinedWalkForwardBacktest } from '../services/autotrading/combinedBacktest';
import { computeSignificanceStats } from '../services/autotrading/significance';
import { listPaperPositions, PaperPosition } from '../db/autotradePaperPositions';
import { listOptionsPaperPositions, OptionsPaperPosition } from '../db/autotradeOptionsPaperPositions';
import { listAutotradeLivePositions, syncAccountEquityFromBroker } from '../services/autotrading/liveExecute';
import { countLiveAddOns } from '../db/autotradeLiveOrders';
import {
  listLiveOptionsPositions,
  getLiveOptionsPosition,
  LiveOptionsPosition,
} from '../db/autotradeLiveOptionsPositions';
import { Position } from '../db/positions';
import { closeLiveOptionsAutotradePosition } from '../services/trading/closePosition';
import { runAutotradeLoopTick } from '../services/autotrading/loop';
import { getAutotradeDashboard } from '../services/autotrading/dashboard';
import { getOptionsPaperPortfolioSnapshot } from '../services/autotrading/optionsExecute';
import { getLiveOptionsPortfolioSnapshot } from '../services/autotrading/liveOptionsExecute';
import { computeAutotradeOptionsGreeks } from '../services/portfolioGreeks';
import { resolveStockPrices, priceMap } from '../services/quotes';
import {
  computePaperUnrealizedPnl,
  computeOptionsPaperUnrealizedPnl,
  computePositionPnl,
  PositionPnl,
} from '../services/pnl';
import { getProvider } from '../providers';
import { dispatchNotifications } from '../services/notifier';
import { suggestLiveCaps } from '../services/autotrading/liveCaps';
import { computeTargetTune, realizedBasisAvailability, resetToModerate } from '../services/autotrading/targetTune';
import { collectBook, DEFAULT_LOOKBACK_SESSIONS, realizedEdgeOf } from '../services/autotrading/dailyTargetSweepData';
import { runDailyTargetSweep } from '../services/autotrading/dailyTargetSweep';
import { listUniverseSymbols } from '../db/universe';
import { previewWebullPositions } from '../providers/webull/positions';
import {
  committedProtectiveQuantity,
  listWebullOpenOrders,
  webullCancelOrder,
  webullPlaceStandaloneBracket,
} from '../providers/webull/orders';
import { webullAccountState } from '../providers/webull/accountState';
import { config } from '../config';

export const autotradeRouter = Router();

// ---- Config: master enable + risk profile ---------------------------------

autotradeRouter.get('/config', (_req, res) => {
  res.json(getAutotradeConfig());
});

/** Suggested starting values for the live-only guardrail caps (liveCaps.ts),
 *  derived from the current account equity and the already-configured
 *  maxDailyDrawdownPct/maxTradesPerDay — a starting point the UI offers next
 *  to those fields, not an enforced value; the caller can accept, edit, or
 *  ignore it entirely. Fails closed (400) rather than suggesting a
 *  meaningless $0 cap when equity hasn't been set yet. */
autotradeRouter.get('/live-caps/suggest', (_req, res) => {
  const config = getAutotradeConfig();
  if (config.accountEquityUsd == null) {
    throw new HttpError(400, 'Set account equity before requesting suggested live caps.');
  }
  res.json(
    suggestLiveCaps(
      config.accountEquityUsd,
      config.maxDailyDrawdownPct,
      config.maxTradesPerDay,
      config.riskProfile,
      config.liveScaleOutEnabled,
    ),
  );
});

/** Preview a full "tune from target" — derive the whole risk/aggressiveness
 *  config from the stored account equity plus a target daily gain % and the
 *  chosen sizing basis (services/autotrading/targetTune.ts). Pure preview only:
 *  returns the patch + warnings the UI shows; applying it goes through the
 *  ordinary PUT /config (so the AGGRESSIVE-label confirmation and per-field
 *  validation there still apply). Fails closed (400) when equity is unset,
 *  same posture as /live-caps/suggest — every derived number scales with it. */
const tunePreviewBody = z.object({
  targetDailyGainPct: z.number().positive().max(1000),
  basis: z.enum(['expected', 'perfectDay', 'realized']),
});

autotradeRouter.post(
  '/tune/preview',
  asyncHandler(async (req, res) => {
    const body = parseBody(tunePreviewBody, req);
    const config = getAutotradeConfig();
    if (config.accountEquityUsd == null) {
      throw new HttpError(400, 'Set account equity before tuning from a target.');
    }
    // The record, always — every preview carries it beside the basis asked
    // for. The realized basis itself FAILS CLOSED when the record cannot
    // support it: a 200 whose basis differs from the one requested would be
    // the silent substitution this feature exists to end, and a 400 naming the
    // shortfall is the same posture as the equity-unset refusal above.
    const realized = realizedEdgeOf(collectBook('live', DEFAULT_LOOKBACK_SESSIONS));
    if (body.basis === 'realized') {
      const availability = realizedBasisAvailability(realized);
      if (!availability.available) throw new HttpError(400, availability.reason);
    }
    res.json(
      computeTargetTune({
        equityUsd: config.accountEquityUsd,
        targetDailyGainPct: body.targetDailyGainPct,
        basis: body.basis,
        realized,
        // The whole config: the tuner reads the auto-tune flags to warn about
        // interactions, and the dollar caps + their anchor to tell a hand-set cap
        // from a derived one so it preserves the former.
        config,
        // Buying power WARNS, it does not bound — see ComputeTargetTuneInput.
        ...(await tuneBuyingPower(config)),
      }),
    );
  }),
);

/** The moderate baseline for the current account — the "reset to moderate"
 *  patch, equity-scaled. Same fail-closed-on-unset-equity posture. */
autotradeRouter.get(
  '/tune/moderate',
  asyncHandler(async (_req, res) => {
    const config = getAutotradeConfig();
    if (config.accountEquityUsd == null) {
      throw new HttpError(400, 'Set account equity before resetting to moderate.');
    }
    res.json({
      // No broker call here: the STORED caps deliberately no longer depend on
      // buying power (see deriveDollarCaps). Funding is enforced at decision
      // time by the sizer, which is the only place the live figure is in hand.
      patch: resetToModerate(config.accountEquityUsd, config.maxStopDistancePct, config.liveScaleOutEnabled),
    });
  }),
);

const configBody = z.object({
  enabled: z.boolean().optional(),
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']).optional(),
  /** Required (and must be true) when riskProfile is 'AGGRESSIVE' — the spec's
   *  "explicit manual confirmation in the UI, not just a config edit" gate. */
  confirmAggressive: z.boolean().optional(),
  /** Account equity the risk engine sizes against; null clears it (fails
   *  closed until set again). */
  accountEquityUsd: z.number().positive().nullable().optional(),
  /** ONE combined open-position budget shared by equity + options. */
  maxConcurrentPositions: z.number().int().min(1).optional(),
  // --- Risk-check parameters (formerly riskProfiles.ts's MODERATE/AGGRESSIVE
  // preset table — see AutotradeConfig's own doc comments) --------------------
  riskPerTradePct: z.number().min(0).max(100).optional(),
  maxDailyDrawdownPct: z.number().min(0).max(100).optional(),
  stepDownAfterLosses: z.number().int().nonnegative().optional(),
  stepDownSizeCutPct: z.number().min(0).max(100).optional(),
  maxAggregateOpenRiskPct: z.number().min(0).max(100).optional(),
  maxCorrelatedExposurePct: z.number().min(0).max(100).optional(),
  maxSectorExposurePct: z.number().min(0).max(100).optional(),
  maxTradesPerDay: z.number().int().nonnegative().optional(),
  // --- Regime-aware sizing (live + paper only; 0 disables) -------------------
  regimeAtrThresholdPct: z.number().min(0).max(100).optional(),
  regimeSizeCutPct: z.number().min(0).max(100).optional(),
  equityCurveDeriskEnabled: z.boolean().optional(),
  equityCurveLookbackDays: z.number().int().min(1).optional(),
  equityCurveDeriskCutPct: z.number().min(0).max(100).optional(),
  maxAdvParticipationPct: z.number().min(0).max(100).optional(),
  convictionGradeAMinScore: z.number().min(0).max(100).optional(),
  convictionGradeBMinScore: z.number().min(0).max(100).optional(),
  expectancyWeightingEnabled: z.boolean().optional(),
  methodWeightingEnabled: z.boolean().optional(),
  expectancyMinTrades: z.number().int().min(1).optional(),
  // Bounded, unlike every other risk multiplier in this config, these are the
  // only ones that can size a trade UP (riskCheck.ts multiplies effectiveRiskPct
  // by the grade's multiplier). Left unbounded, a typo like 100 would scale
  // per-trade risk 100x with only the aggregate-open-risk veto behind it.
  // The ceiling is deliberately generous — the shipped default max is 1.5.
  expectancyMinMultiplier: z.number().positive().max(3).optional(),
  expectancyMaxMultiplier: z.number().positive().max(3).optional(),
  // --- Screening/decision thresholds ------------------------------------------
  tradeDirection: z.enum(['long', 'short', 'both']).optional(),
  minRelVol: z.number().nonnegative().optional(),
  minPrice: z.number().nonnegative().optional(),
  minAvgVolume: z.number().nonnegative().optional(),
  moversDiscoveryEnabled: z.boolean().optional(),
  minSignalScore: z.number().min(0).max(100).optional(),
  requireWeeklyTrendAlignment: z.boolean().optional(),
  relativeStrengthWeight: z.number().min(0).max(100).optional(),
  benchmarkSymbol: z.string().min(1).optional(),
  relativeStrengthLookbackDays: z.number().int().min(1).optional(),
  sentimentWeight: z.number().min(0).max(100).optional(),
  maxTickerAtrPct: z.number().min(0).max(100).optional(),
  maxMarketAtrPct: z.number().min(0).max(100).optional(),
  stopAtrMultiple: z.number().positive().optional(),
  maxStopDistancePct: z.number().min(0).max(100).optional(),
  liveScaleOutEnabled: z.boolean().optional(),
  liveScaleOutCancelReplaceEnabled: z.boolean().optional(),
  liveTrailingEnabled: z.boolean().optional(),
  dayProtectiveStopEnabled: z.boolean().optional(),
  shortDatedOptionsEnabled: z.boolean().optional(),
  optionsHardExitMinutesBeforeClose: z.number().nonnegative().optional(),
  optionsNoEntryMinutesBeforeClose: z.number().nonnegative().optional(),
  optionsUnderlyingStopPct: z.number().nonnegative().optional(),
  optionsGiveBackArmPct: z.number().nonnegative().optional(),
  optionsGiveBackPct: z.number().nonnegative().optional(),
  optionsStagnationMinutes: z.number().nonnegative().optional(),
  optionsStagnationMinMovePct: z.number().nonnegative().optional(),
  optionsDisasterStopPct: z.number().nonnegative().optional(),
  targetRMultiple: z.number().positive().optional(),
  sessionBufferMinutes: z.number().int().nonnegative().optional(),
  earningsBlackoutDays: z.number().int().nonnegative().optional(),
  minRelVolPace: z.number().min(0).max(50).optional(),
  minChangePct: z.number().min(0).max(100).optional(),
  momentumIntradayOnly: z.boolean().optional(),
  macroEventBlackoutHours: z.number().nonnegative().optional(),
  // --- Max hold time (0 disables) --------------------------------------------
  maxHoldDays: z.number().int().nonnegative().optional(),
  // --- Trailing stop / breakeven / partial profit-taking (0 disables each) --
  breakevenTriggerRMultiple: z.number().nonnegative().optional(),
  trailStartRMultiple: z.number().nonnegative().optional(),
  trailStopRMultiple: z.number().nonnegative().optional(),
  partialExitRMultiple: z.number().nonnegative().optional(),
  partialExitPct: z.number().min(0).max(100).optional(),
  // --- Scale into winners / pyramiding (0 disables) -------------------------
  addOnTriggerRMultiple: z.number().nonnegative().optional(),
  addOnSizePct: z.number().min(0).max(100).optional(),
  maxAddOns: z.number().int().min(0).optional(),
  // --- Correlation methodology (feeds maxCorrelatedExposurePct above) -------
  correlationLookbackDays: z.number().int().min(1).optional(),
  correlationThreshold: z.number().min(0).max(1).optional(),
  correlationAwareSelectionEnabled: z.boolean().optional(),
  // --- Regime-conditional scoring weights ------------------------------------
  regimeAdaptiveWeightsEnabled: z.boolean().optional(),
  regimeWeightPresets: z
    .object({
      riskOn: z.record(z.string(), z.number().min(0)).optional(),
      neutral: z.record(z.string(), z.number().min(0)).optional(),
      riskOff: z.record(z.string(), z.number().min(0)).optional(),
    })
    .optional(),
  // --- Phase 8: live trading -------------------------------------------------
  liveTradingEnabled: z.boolean().optional(),
  /** Required (and must exactly match LIVE_TRADING_CONFIRMATION_PHRASE) only
   *  when this request flips liveTradingEnabled false -> true — a one-time,
   *  deliberate gesture per enable (confirmed decision), not per-order
   *  friction. Trim/case-insensitive, same normalization style as
   *  services/trading/placeOrder.ts's placeConfirmation. */
  confirmLiveTrading: z.string().optional(),
  liveAccountId: z.string().min(1).nullable().optional(),
  liveMaxOrderUsd: z.number().nonnegative().optional(),
  liveMaxExposurePct: z.number().nonnegative().optional(),
  optionsMaxConcurrentPositions: z.number().nonnegative().optional(),
  equitySyncMaxJumpPct: z.number().nonnegative().optional(),
  liveDayBuyingPowerUsd: z.number().nonnegative().optional(),
  liveMaxDailyLossUsd: z.number().nonnegative().optional(),
  liveMaxOrdersPerDay: z.number().int().nonnegative().optional(),
  liveFatFingerPct: z.number().min(0).max(100).optional(),
  liveAllowNakedShort: z.boolean().optional(),
  liveProbationTrades: z.number().int().nonnegative().optional(),
  liveProbationSizeMultiplier: z.number().positive().max(1).optional(),
  // --- Live scale-into-winners (nested under liveTradingEnabled) --------------
  liveScaleInEnabled: z.boolean().optional(),
  liveMaxAddOns: z.number().int().min(0).optional(),
  // --- Task #70: live options trading ----------------------------------------
  /** Nested under liveTradingEnabled — no separate typed confirmation (the
   *  master phrase already covers "real money is now live"); see route
   *  handler for the fails-closed "master must be on" gate. */
  liveOptionsEnabled: z.boolean().optional(),
  liveOptionsMaxOrderUsd: z.number().nonnegative().optional(),
  liveOptionsMaxDailyLossUsd: z.number().nonnegative().optional(),
  liveOptionsMaxOrdersPerDay: z.number().int().nonnegative().optional(),
  /** Equity the four $ caps were last derived from — stamped by a tune apply
   *  (the /tune patches carry it) to arm automatic re-anchoring; null disarms.
   *  See services/autotrading/liveCapsReanchor.ts. */
  liveCapsAnchorEquityUsd: z.number().positive().nullable().optional(),
  /** The live daily-gain goal (% of the day's starting account value) —
   *  stamped by tune applies; null disarms the tracker. */
  targetDailyGainPct: z.number().positive().max(1000).nullable().optional(),
  /** Give-back guard levels on the same day-gain axis — stamped by tune
   *  applies at 2/3 and 1/3 of the target; the guard runs only when both are
   *  set and arm > floor ≥ 0 (services/autotrading/dailyTarget.ts). */
  giveBackArmPct: z.number().positive().max(1000).nullable().optional(),
  giveBackFloorPct: z.number().min(0).max(1000).nullable().optional(),
  /** Symbol loss cooldown + finish-line discipline (2026-08-22) — see the
   *  AutotradeConfig doc comments; 0 disables each of the 0-able fields. */
  symbolCooldownLosses: z.number().int().nonnegative().optional(),
  symbolCooldownWindowDays: z.number().int().min(1).optional(),
  symbolCooldownDays: z.number().int().min(1).optional(),
  finishLineSizingEnabled: z.boolean().optional(),
  finishLineMinSignalScore: z.number().min(0).max(100).optional(),
  liveMinSignalScore: z.number().min(0).max(100).optional(),
  stagnationExitMinutes: z.number().int().nonnegative().optional(),
  stagnationExitMinR: z.number().min(0).optional(),
  // Capped at one session (390 minutes): a longer window would mean "always
  // flattening", which is a way of saying "never hold a position".
  endOfDayFlattenMinutes: z.number().int().nonnegative().max(390).optional(),
  /** Level-aware exits (services/autotrading/levelPlan.ts). */
  levelExitsEnabled: z.boolean().optional(),
  levelMinStrength: z.number().min(0).max(1).optional(),
  levelBufferPct: z.number().min(0).optional(),
  levelMaxStopWidenPct: z.number().min(0).optional(),
  levelMinRewardR: z.number().min(0).optional(),
  maxRiskAtrFraction: z.number().min(0).optional(),
  symbolReentryCooldownMinutes: z.number().min(0).optional(),
  levelTargetReachAtrMultiple: z.number().min(0).optional(),
  levelBreakoutRelVolPace: z.number().min(0).optional(),
  levelLookbackBars: z.number().min(0).optional(),
  liveOptionsFatFingerPct: z.number().min(0).max(100).optional(),
  liveOptionsProbationTrades: z.number().int().nonnegative().optional(),
  liveOptionsProbationSizeMultiplier: z.number().positive().max(1).optional(),
  // --- Options strategy shape -------------------------------------------------
  optionsStrategyType: z.enum(['single_leg', 'debit_spread', 'auto']).optional(),
  // --- Options entry-rule thresholds (the contract-quality screen run before
  // risk-check) ---------------------------------------------------------------
  optionsDeltaMin: z.number().min(0).max(1).optional(),
  optionsDeltaMax: z.number().min(0).max(1).optional(),
  optionsMaxSpreadPct: z.number().min(0).max(100).optional(),
  optionsMinOpenInterest: z.number().int().nonnegative().optional(),
  optionsMinVolume: z.number().int().nonnegative().optional(),
  optionsMinDte: z.number().int().nonnegative().optional(),
  optionsMaxDte: z.number().int().min(1).optional(),
  optionsIvRankMax: z.number().min(0).max(100).optional(),
  optionsIvRankMin: z.number().min(0).max(100).optional(),
  // --- Options IV/RV cheapness gate (0 disables) ------------------------------
  optionsMaxIvRvRatio: z.number().min(0).optional(),
  // --- Options stop-loss / take-profit (paper + backtest only; 0 disables) ----
  optionsStopLossPct: z.number().min(0).max(100).optional(),
  optionsTakeProfitPct: z.number().min(0).max(100).optional(),
  // --- Options trailing stop / breakeven / partial profit-taking (0 disables each) --
  optionsBreakevenTriggerPct: z.number().min(0).max(100).optional(),
  optionsTrailStartPct: z.number().min(0).max(100).optional(),
  optionsTrailStopPct: z.number().min(0).max(100).optional(),
  optionsPartialExitTriggerPct: z.number().min(0).max(100).optional(),
  optionsPartialExitPct: z.number().min(0).max(100).optional(),
  // --- Movers auto-promotion --------------------------------------------------
  autoPromoteMoversEnabled: z.boolean().optional(),
  autoPromoteThreshold: z.number().int().min(1).optional(),
  autoPromoteWindowDays: z.number().int().min(1).optional(),
  autoPromoteMaxSymbols: z.number().int().nonnegative().optional(),
  // --- Auto-tune from realized edge (autoTuneEnabled false by default; the
  // three bounds below are inert until it's turned on) -----------------------
  autoTuneEnabled: z.boolean().optional(),
  autoTuneMinTrades: z.number().int().min(1).optional(),
  autoTuneMaxStepPct: z.number().min(0).max(100).optional(),
  autoTuneSlippageExcludePct: z.number().min(0).max(100).optional(),
  autoTuneExitsEnabled: z.boolean().optional(),
  autoTuneExitMaxStep: z.number().positive().optional(),
  autoTuneRequireOosConfirmation: z.boolean().optional(),
});
autotradeRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    const body = parseBody(configBody, req);
    const before = getAutotradeConfig();
    // Gate the SWITCH, not the label. Comparing the body alone meant a client
    // that echoes the current riskProfile back on save (any "save everything"
    // patch, including the /tune patches, which always carry riskProfile) could
    // never save at all while already AGGRESSIVE.
    if (body.riskProfile === 'AGGRESSIVE' && before.riskProfile !== 'AGGRESSIVE' && body.confirmAggressive !== true) {
      throw new HttpError(400, 'Switching to AGGRESSIVE requires explicit confirmation (confirmAggressive: true)');
    }

    // Paired bounds, checked against the MERGED result rather than the body:
    // this is a partial patch, so a request may move only one side of a pair and
    // still invert it against the stored value. An inverted pair isn't caught by
    // any single-field rule, and each fails silently at runtime — an empty delta
    // band or DTE window makes the options leg stop finding any contract, and
    // grade B above grade A makes B unreachable (decide.ts tests A first) —
    // surfacing only as candidates that never trade.
    const merged = <K extends keyof typeof before>(key: K, sent: (typeof before)[K] | undefined) =>
      sent !== undefined ? sent : before[key];
    const orderedPairs: [string, number, string, number, string][] = [
      [
        'expectancyMinMultiplier',
        merged('expectancyMinMultiplier', body.expectancyMinMultiplier),
        'expectancyMaxMultiplier',
        merged('expectancyMaxMultiplier', body.expectancyMaxMultiplier),
        'every conviction grade would size at the same multiplier',
      ],
      [
        'optionsDeltaMin',
        merged('optionsDeltaMin', body.optionsDeltaMin),
        'optionsDeltaMax',
        merged('optionsDeltaMax', body.optionsDeltaMax),
        'no contract could satisfy the delta band',
      ],
      [
        'optionsMinDte',
        merged('optionsMinDte', body.optionsMinDte),
        'optionsMaxDte',
        merged('optionsMaxDte', body.optionsMaxDte),
        'the DTE window would be empty',
      ],
      [
        'convictionGradeBMinScore',
        merged('convictionGradeBMinScore', body.convictionGradeBMinScore),
        'convictionGradeAMinScore',
        merged('convictionGradeAMinScore', body.convictionGradeAMinScore),
        'grade B would be unreachable',
      ],
    ];
    for (const [loName, lo, hiName, hi, consequence] of orderedPairs) {
      if (lo > hi) throw new HttpError(400, `${loName} (${lo}) cannot exceed ${hiName} (${hi}) — ${consequence}`);
    }

    // The daily-goal triple (services/autotrading/dailyTarget.ts) is a third
    // ordered set, nullable on every side, so it does not fit the numeric
    // pairs above. Checked on the merged result for the same reason: the
    // sanitizer sees one field at a time by design (autotradeConfig.ts), so a
    // partial PUT can invert the levels against the stored value — and an
    // inverted pair does not fail anywhere. giveBackLevels() reads it as
    // "guard unconfigured" and the day quietly runs with no give-back
    // protection while the config reads as if it had one (2026-09-07).
    const goalTarget = merged('targetDailyGainPct', body.targetDailyGainPct);
    const goalArm = merged('giveBackArmPct', body.giveBackArmPct);
    const goalFloor = merged('giveBackFloorPct', body.giveBackFloorPct);
    if (goalArm !== null && goalFloor !== null && !(goalArm > goalFloor)) {
      throw new HttpError(
        400,
        `giveBackArmPct (${goalArm}) must be above giveBackFloorPct (${goalFloor}) — stored as-is, the give-back guard would silently stay off`,
      );
    }
    if (goalArm !== null && goalTarget !== null && !(goalArm < goalTarget)) {
      throw new HttpError(
        400,
        `giveBackArmPct (${goalArm}) must sit below targetDailyGainPct (${goalTarget}) — the day would bank before the guard could arm`,
      );
    }

    // Only pass along fields the client actually sent — building
    // { enabled: body.enabled, ... } unconditionally would put an
    // `enabled: undefined` OWN PROPERTY on the patch for any request that
    // omits it, which setAutotradeConfig's spread treats as "explicitly clear
    // it" (falling back to the default), not "leave it alone" — silently
    // resetting a field to its default on every save that doesn't happen to
    // also re-send it. (This is the exact bug class found and fixed live —
    // see docs/AUTOTRADING_SPEC.md's Phase 7 writeup.)
    const patch: Partial<AutotradeConfig> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.riskProfile !== undefined) patch.riskProfile = body.riskProfile;
    if (body.accountEquityUsd !== undefined) patch.accountEquityUsd = body.accountEquityUsd;
    if (body.maxConcurrentPositions !== undefined) patch.maxConcurrentPositions = body.maxConcurrentPositions;
    if (body.riskPerTradePct !== undefined) patch.riskPerTradePct = body.riskPerTradePct;
    if (body.maxDailyDrawdownPct !== undefined) patch.maxDailyDrawdownPct = body.maxDailyDrawdownPct;
    if (body.stepDownAfterLosses !== undefined) patch.stepDownAfterLosses = body.stepDownAfterLosses;
    if (body.stepDownSizeCutPct !== undefined) patch.stepDownSizeCutPct = body.stepDownSizeCutPct;
    if (body.maxAggregateOpenRiskPct !== undefined) patch.maxAggregateOpenRiskPct = body.maxAggregateOpenRiskPct;
    if (body.maxCorrelatedExposurePct !== undefined) patch.maxCorrelatedExposurePct = body.maxCorrelatedExposurePct;
    if (body.maxSectorExposurePct !== undefined) patch.maxSectorExposurePct = body.maxSectorExposurePct;
    if (body.maxTradesPerDay !== undefined) patch.maxTradesPerDay = body.maxTradesPerDay;
    if (body.regimeAtrThresholdPct !== undefined) patch.regimeAtrThresholdPct = body.regimeAtrThresholdPct;
    if (body.regimeSizeCutPct !== undefined) patch.regimeSizeCutPct = body.regimeSizeCutPct;
    if (body.equityCurveDeriskEnabled !== undefined) patch.equityCurveDeriskEnabled = body.equityCurveDeriskEnabled;
    if (body.equityCurveLookbackDays !== undefined) patch.equityCurveLookbackDays = body.equityCurveLookbackDays;
    if (body.equityCurveDeriskCutPct !== undefined) patch.equityCurveDeriskCutPct = body.equityCurveDeriskCutPct;
    if (body.maxAdvParticipationPct !== undefined) patch.maxAdvParticipationPct = body.maxAdvParticipationPct;
    if (body.convictionGradeAMinScore !== undefined) patch.convictionGradeAMinScore = body.convictionGradeAMinScore;
    if (body.convictionGradeBMinScore !== undefined) patch.convictionGradeBMinScore = body.convictionGradeBMinScore;
    if (body.expectancyWeightingEnabled !== undefined)
      patch.expectancyWeightingEnabled = body.expectancyWeightingEnabled;
    if (body.methodWeightingEnabled !== undefined) patch.methodWeightingEnabled = body.methodWeightingEnabled;
    if (body.expectancyMinTrades !== undefined) patch.expectancyMinTrades = body.expectancyMinTrades;
    if (body.expectancyMinMultiplier !== undefined) patch.expectancyMinMultiplier = body.expectancyMinMultiplier;
    if (body.expectancyMaxMultiplier !== undefined) patch.expectancyMaxMultiplier = body.expectancyMaxMultiplier;
    if (body.tradeDirection !== undefined) patch.tradeDirection = body.tradeDirection;
    if (body.minRelVol !== undefined) patch.minRelVol = body.minRelVol;
    if (body.minPrice !== undefined) patch.minPrice = body.minPrice;
    if (body.minAvgVolume !== undefined) patch.minAvgVolume = body.minAvgVolume;
    if (body.moversDiscoveryEnabled !== undefined) patch.moversDiscoveryEnabled = body.moversDiscoveryEnabled;
    if (body.minSignalScore !== undefined) patch.minSignalScore = body.minSignalScore;
    if (body.requireWeeklyTrendAlignment !== undefined)
      patch.requireWeeklyTrendAlignment = body.requireWeeklyTrendAlignment;
    if (body.relativeStrengthWeight !== undefined) patch.relativeStrengthWeight = body.relativeStrengthWeight;
    if (body.benchmarkSymbol !== undefined) patch.benchmarkSymbol = body.benchmarkSymbol;
    if (body.relativeStrengthLookbackDays !== undefined)
      patch.relativeStrengthLookbackDays = body.relativeStrengthLookbackDays;
    if (body.sentimentWeight !== undefined) patch.sentimentWeight = body.sentimentWeight;
    if (body.maxTickerAtrPct !== undefined) patch.maxTickerAtrPct = body.maxTickerAtrPct;
    if (body.maxMarketAtrPct !== undefined) patch.maxMarketAtrPct = body.maxMarketAtrPct;
    if (body.stopAtrMultiple !== undefined) patch.stopAtrMultiple = body.stopAtrMultiple;
    if (body.maxStopDistancePct !== undefined) patch.maxStopDistancePct = body.maxStopDistancePct;
    if (body.liveScaleOutEnabled !== undefined) patch.liveScaleOutEnabled = body.liveScaleOutEnabled;
    if (body.liveScaleOutCancelReplaceEnabled !== undefined)
      patch.liveScaleOutCancelReplaceEnabled = body.liveScaleOutCancelReplaceEnabled;
    if (body.liveTrailingEnabled !== undefined) patch.liveTrailingEnabled = body.liveTrailingEnabled;
    if (body.dayProtectiveStopEnabled !== undefined) patch.dayProtectiveStopEnabled = body.dayProtectiveStopEnabled;
    if (body.shortDatedOptionsEnabled !== undefined) patch.shortDatedOptionsEnabled = body.shortDatedOptionsEnabled;
    if (body.optionsHardExitMinutesBeforeClose !== undefined)
      patch.optionsHardExitMinutesBeforeClose = body.optionsHardExitMinutesBeforeClose;
    if (body.optionsNoEntryMinutesBeforeClose !== undefined)
      patch.optionsNoEntryMinutesBeforeClose = body.optionsNoEntryMinutesBeforeClose;
    if (body.optionsUnderlyingStopPct !== undefined) patch.optionsUnderlyingStopPct = body.optionsUnderlyingStopPct;
    if (body.optionsGiveBackArmPct !== undefined) patch.optionsGiveBackArmPct = body.optionsGiveBackArmPct;
    if (body.optionsGiveBackPct !== undefined) patch.optionsGiveBackPct = body.optionsGiveBackPct;
    if (body.optionsStagnationMinutes !== undefined) patch.optionsStagnationMinutes = body.optionsStagnationMinutes;
    if (body.optionsStagnationMinMovePct !== undefined)
      patch.optionsStagnationMinMovePct = body.optionsStagnationMinMovePct;
    if (body.optionsDisasterStopPct !== undefined) patch.optionsDisasterStopPct = body.optionsDisasterStopPct;
    if (body.targetRMultiple !== undefined) patch.targetRMultiple = body.targetRMultiple;
    if (body.sessionBufferMinutes !== undefined) patch.sessionBufferMinutes = body.sessionBufferMinutes;
    if (body.earningsBlackoutDays !== undefined) patch.earningsBlackoutDays = body.earningsBlackoutDays;
    if (body.minRelVolPace !== undefined) patch.minRelVolPace = body.minRelVolPace;
    if (body.minChangePct !== undefined) patch.minChangePct = body.minChangePct;
    if (body.momentumIntradayOnly !== undefined) patch.momentumIntradayOnly = body.momentumIntradayOnly;
    if (body.macroEventBlackoutHours !== undefined) patch.macroEventBlackoutHours = body.macroEventBlackoutHours;
    if (body.maxHoldDays !== undefined) patch.maxHoldDays = body.maxHoldDays;
    if (body.breakevenTriggerRMultiple !== undefined) {
      patch.breakevenTriggerRMultiple = body.breakevenTriggerRMultiple;
    }
    if (body.trailStartRMultiple !== undefined) patch.trailStartRMultiple = body.trailStartRMultiple;
    if (body.trailStopRMultiple !== undefined) patch.trailStopRMultiple = body.trailStopRMultiple;
    if (body.partialExitRMultiple !== undefined) patch.partialExitRMultiple = body.partialExitRMultiple;
    if (body.partialExitPct !== undefined) patch.partialExitPct = body.partialExitPct;
    if (body.addOnTriggerRMultiple !== undefined) patch.addOnTriggerRMultiple = body.addOnTriggerRMultiple;
    if (body.addOnSizePct !== undefined) patch.addOnSizePct = body.addOnSizePct;
    if (body.maxAddOns !== undefined) patch.maxAddOns = body.maxAddOns;
    if (body.correlationLookbackDays !== undefined) patch.correlationLookbackDays = body.correlationLookbackDays;
    if (body.correlationThreshold !== undefined) patch.correlationThreshold = body.correlationThreshold;
    if (body.correlationAwareSelectionEnabled !== undefined)
      patch.correlationAwareSelectionEnabled = body.correlationAwareSelectionEnabled;
    if (body.regimeAdaptiveWeightsEnabled !== undefined)
      patch.regimeAdaptiveWeightsEnabled = body.regimeAdaptiveWeightsEnabled;
    if (body.regimeWeightPresets !== undefined) {
      // Deep-merge each preset onto the CURRENT presets so a partial send (one
      // regime, or one weight) only touches what it names and never resets the
      // other presets/weights — then sanitize() re-fills/validates every key.
      // The cast bridges the loose request shape to the strict stored type.
      const p = body.regimeWeightPresets;
      patch.regimeWeightPresets = {
        riskOn: { ...before.regimeWeightPresets.riskOn, ...p.riskOn },
        neutral: { ...before.regimeWeightPresets.neutral, ...p.neutral },
        riskOff: { ...before.regimeWeightPresets.riskOff, ...p.riskOff },
      } as AutotradeConfig['regimeWeightPresets'];
    }
    if (body.liveMaxOrderUsd !== undefined) patch.liveMaxOrderUsd = body.liveMaxOrderUsd;
    if (body.liveMaxExposurePct !== undefined) patch.liveMaxExposurePct = body.liveMaxExposurePct;
    if (body.optionsMaxConcurrentPositions !== undefined)
      patch.optionsMaxConcurrentPositions = body.optionsMaxConcurrentPositions;
    if (body.equitySyncMaxJumpPct !== undefined) patch.equitySyncMaxJumpPct = body.equitySyncMaxJumpPct;
    if (body.liveDayBuyingPowerUsd !== undefined) patch.liveDayBuyingPowerUsd = body.liveDayBuyingPowerUsd;
    if (body.liveMaxDailyLossUsd !== undefined) patch.liveMaxDailyLossUsd = body.liveMaxDailyLossUsd;
    if (body.liveMaxOrdersPerDay !== undefined) patch.liveMaxOrdersPerDay = body.liveMaxOrdersPerDay;
    if (body.liveFatFingerPct !== undefined) patch.liveFatFingerPct = body.liveFatFingerPct;
    if (body.liveAllowNakedShort !== undefined) patch.liveAllowNakedShort = body.liveAllowNakedShort;
    if (body.liveProbationTrades !== undefined) patch.liveProbationTrades = body.liveProbationTrades;
    if (body.liveProbationSizeMultiplier !== undefined) {
      patch.liveProbationSizeMultiplier = body.liveProbationSizeMultiplier;
    }
    if (body.liveOptionsMaxOrderUsd !== undefined) patch.liveOptionsMaxOrderUsd = body.liveOptionsMaxOrderUsd;
    if (body.liveOptionsMaxDailyLossUsd !== undefined) {
      patch.liveOptionsMaxDailyLossUsd = body.liveOptionsMaxDailyLossUsd;
    }
    if (body.liveOptionsMaxOrdersPerDay !== undefined) {
      patch.liveOptionsMaxOrdersPerDay = body.liveOptionsMaxOrdersPerDay;
    }
    if (body.liveCapsAnchorEquityUsd !== undefined) patch.liveCapsAnchorEquityUsd = body.liveCapsAnchorEquityUsd;
    if (body.targetDailyGainPct !== undefined) patch.targetDailyGainPct = body.targetDailyGainPct;
    if (body.giveBackArmPct !== undefined) patch.giveBackArmPct = body.giveBackArmPct;
    if (body.giveBackFloorPct !== undefined) patch.giveBackFloorPct = body.giveBackFloorPct;
    if (body.symbolCooldownLosses !== undefined) patch.symbolCooldownLosses = body.symbolCooldownLosses;
    if (body.symbolCooldownWindowDays !== undefined) patch.symbolCooldownWindowDays = body.symbolCooldownWindowDays;
    if (body.symbolCooldownDays !== undefined) patch.symbolCooldownDays = body.symbolCooldownDays;
    if (body.finishLineSizingEnabled !== undefined) patch.finishLineSizingEnabled = body.finishLineSizingEnabled;
    if (body.finishLineMinSignalScore !== undefined) patch.finishLineMinSignalScore = body.finishLineMinSignalScore;
    if (body.liveMinSignalScore !== undefined) patch.liveMinSignalScore = body.liveMinSignalScore;
    if (body.stagnationExitMinutes !== undefined) patch.stagnationExitMinutes = body.stagnationExitMinutes;
    if (body.stagnationExitMinR !== undefined) patch.stagnationExitMinR = body.stagnationExitMinR;
    if (body.endOfDayFlattenMinutes !== undefined) patch.endOfDayFlattenMinutes = body.endOfDayFlattenMinutes;
    if (body.levelExitsEnabled !== undefined) patch.levelExitsEnabled = body.levelExitsEnabled;
    if (body.levelMinStrength !== undefined) patch.levelMinStrength = body.levelMinStrength;
    if (body.levelBufferPct !== undefined) patch.levelBufferPct = body.levelBufferPct;
    if (body.levelMaxStopWidenPct !== undefined) patch.levelMaxStopWidenPct = body.levelMaxStopWidenPct;
    if (body.levelMinRewardR !== undefined) patch.levelMinRewardR = body.levelMinRewardR;
    if (body.maxRiskAtrFraction !== undefined) patch.maxRiskAtrFraction = body.maxRiskAtrFraction;
    if (body.symbolReentryCooldownMinutes !== undefined)
      patch.symbolReentryCooldownMinutes = body.symbolReentryCooldownMinutes;
    if (body.levelTargetReachAtrMultiple !== undefined)
      patch.levelTargetReachAtrMultiple = body.levelTargetReachAtrMultiple;
    if (body.levelBreakoutRelVolPace !== undefined) patch.levelBreakoutRelVolPace = body.levelBreakoutRelVolPace;
    if (body.levelLookbackBars !== undefined) patch.levelLookbackBars = body.levelLookbackBars;
    if (body.liveOptionsFatFingerPct !== undefined) patch.liveOptionsFatFingerPct = body.liveOptionsFatFingerPct;
    if (body.liveOptionsProbationTrades !== undefined) {
      patch.liveOptionsProbationTrades = body.liveOptionsProbationTrades;
    }
    if (body.liveOptionsProbationSizeMultiplier !== undefined) {
      patch.liveOptionsProbationSizeMultiplier = body.liveOptionsProbationSizeMultiplier;
    }
    if (body.optionsStrategyType !== undefined) patch.optionsStrategyType = body.optionsStrategyType;
    if (body.optionsDeltaMin !== undefined) patch.optionsDeltaMin = body.optionsDeltaMin;
    if (body.optionsDeltaMax !== undefined) patch.optionsDeltaMax = body.optionsDeltaMax;
    if (body.optionsMaxSpreadPct !== undefined) patch.optionsMaxSpreadPct = body.optionsMaxSpreadPct;
    if (body.optionsMinOpenInterest !== undefined) patch.optionsMinOpenInterest = body.optionsMinOpenInterest;
    if (body.optionsMinVolume !== undefined) patch.optionsMinVolume = body.optionsMinVolume;
    if (body.optionsMinDte !== undefined) patch.optionsMinDte = body.optionsMinDte;
    if (body.optionsMaxDte !== undefined) patch.optionsMaxDte = body.optionsMaxDte;
    if (body.optionsIvRankMax !== undefined) patch.optionsIvRankMax = body.optionsIvRankMax;
    if (body.optionsIvRankMin !== undefined) patch.optionsIvRankMin = body.optionsIvRankMin;
    if (body.optionsMaxIvRvRatio !== undefined) patch.optionsMaxIvRvRatio = body.optionsMaxIvRvRatio;
    if (body.optionsStopLossPct !== undefined) patch.optionsStopLossPct = body.optionsStopLossPct;
    if (body.optionsTakeProfitPct !== undefined) patch.optionsTakeProfitPct = body.optionsTakeProfitPct;
    if (body.optionsBreakevenTriggerPct !== undefined) {
      patch.optionsBreakevenTriggerPct = body.optionsBreakevenTriggerPct;
    }
    if (body.optionsTrailStartPct !== undefined) patch.optionsTrailStartPct = body.optionsTrailStartPct;
    if (body.optionsTrailStopPct !== undefined) patch.optionsTrailStopPct = body.optionsTrailStopPct;
    if (body.optionsPartialExitTriggerPct !== undefined) {
      patch.optionsPartialExitTriggerPct = body.optionsPartialExitTriggerPct;
    }
    if (body.optionsPartialExitPct !== undefined) patch.optionsPartialExitPct = body.optionsPartialExitPct;
    if (body.autoPromoteMoversEnabled !== undefined) patch.autoPromoteMoversEnabled = body.autoPromoteMoversEnabled;
    if (body.autoPromoteThreshold !== undefined) patch.autoPromoteThreshold = body.autoPromoteThreshold;
    if (body.autoPromoteWindowDays !== undefined) patch.autoPromoteWindowDays = body.autoPromoteWindowDays;
    if (body.autoPromoteMaxSymbols !== undefined) patch.autoPromoteMaxSymbols = body.autoPromoteMaxSymbols;
    if (body.autoTuneEnabled !== undefined) patch.autoTuneEnabled = body.autoTuneEnabled;
    if (body.autoTuneMinTrades !== undefined) patch.autoTuneMinTrades = body.autoTuneMinTrades;
    if (body.autoTuneMaxStepPct !== undefined) patch.autoTuneMaxStepPct = body.autoTuneMaxStepPct;
    if (body.autoTuneSlippageExcludePct !== undefined) {
      patch.autoTuneSlippageExcludePct = body.autoTuneSlippageExcludePct;
    }
    if (body.autoTuneExitsEnabled !== undefined) patch.autoTuneExitsEnabled = body.autoTuneExitsEnabled;
    if (body.autoTuneExitMaxStep !== undefined) patch.autoTuneExitMaxStep = body.autoTuneExitMaxStep;
    if (body.autoTuneRequireOosConfirmation !== undefined)
      patch.autoTuneRequireOosConfirmation = body.autoTuneRequireOosConfirmation;

    // liveTradingEnabled and liveAccountId are handled together, NOT in the
    // generic patch above: going false -> true requires the typed
    // confirmation phrase AND a live account already on file (either already
    // stored, or set in this same request) — fails closed, same posture as
    // accountEquityUsd. The SAME confirmation is also required to CHANGE
    // liveAccountId to a genuinely different value while live trading is (or
    // will remain) enabled — an adversarial review caught that this route
    // originally let the account be silently redirected post-enable with no
    // re-confirmation at all, which would have quietly sent real orders to a
    // different broker account. Going true -> false, or an unrelated save
    // that doesn't touch the account id, needs neither and always passes
    // through — releasing/leaving-alone is never the risky direction.
    const accountIdChanging = body.liveAccountId !== undefined && body.liveAccountId !== before.liveAccountId;
    const enablingNow = body.liveTradingEnabled === true && !before.liveTradingEnabled;
    const stayingEnabled = before.liveTradingEnabled && body.liveTradingEnabled !== false;
    if (enablingNow || (stayingEnabled && accountIdChanging)) {
      if ((body.confirmLiveTrading ?? '').trim().toUpperCase() !== LIVE_TRADING_CONFIRMATION_PHRASE) {
        throw new HttpError(
          400,
          `${enablingNow ? 'Enabling live trading' : 'Changing the live account while live trading is enabled'} requires explicit confirmation (confirmLiveTrading: "${LIVE_TRADING_CONFIRMATION_PHRASE}")`,
        );
      }
      // NOT `??` — that would treat an explicit `liveAccountId: null` (a
      // deliberate clear) the same as "omitted", silently keeping the OLD
      // account instead of honoring the clear. Only fall back to `before`
      // when the field is genuinely absent from this request.
      // Trim BEFORE the guard: sanitize() (db/autotradeConfig.ts) trims and turns
      // a whitespace-only id into null, so a truthy "   " would pass this check
      // and then be stored as null — landing in exactly the live-enabled-with-no-
      // account state this guard exists to make unreachable.
      const rawAccountId = body.liveAccountId !== undefined ? body.liveAccountId : before.liveAccountId;
      const accountId = rawAccountId?.trim() ? rawAccountId.trim() : null;
      if (!accountId) {
        throw new HttpError(
          400,
          enablingNow
            ? 'Enabling live trading requires a liveAccountId to be set first'
            : 'Cannot clear liveAccountId while live trading remains enabled — disable it first',
        );
      }
      patch.liveAccountId = accountId;
    } else if (body.liveAccountId !== undefined) {
      patch.liveAccountId = body.liveAccountId;
    }
    if (enablingNow) {
      patch.liveTradingEnabled = true;
      patch.liveEnabledAt = Date.now();
    } else if (body.liveTradingEnabled !== undefined) {
      patch.liveTradingEnabled = body.liveTradingEnabled;
    }

    // liveOptionsEnabled needs no typed confirmation of its own (the master
    // phrase above already covers "real money is now live"), but fails
    // closed if requested while the master isn't (and isn't concurrently
    // becoming) enabled — a plain checkbox nested under a gate that isn't on
    // yet would otherwise silently sit inert with no feedback. Turning it
    // OFF, or an unrelated save that doesn't touch it, always passes through.
    // A request that turns the master OFF cannot also arm anything nested under
    // it: without the explicit false check, `before.liveTradingEnabled` kept this
    // true, so one combined request could disable live trading while enabling
    // live options / live scale-in — both then already armed the moment the
    // master was switched back on, without the user ever ticking them in an
    // enabled state. Sent individually each is correctly rejected.
    const masterWillBeEnabled = body.liveTradingEnabled === false ? false : enablingNow || before.liveTradingEnabled;
    if (body.liveOptionsEnabled === true && !masterWillBeEnabled) {
      throw new HttpError(400, 'Enabling live options trading requires live trading to be enabled first');
    }
    const enablingOptionsNow = body.liveOptionsEnabled === true && !before.liveOptionsEnabled;
    if (enablingOptionsNow) {
      patch.liveOptionsEnabled = true;
      patch.liveOptionsEnabledAt = Date.now();
    } else if (body.liveOptionsEnabled !== undefined) {
      patch.liveOptionsEnabled = body.liveOptionsEnabled;
    }

    // liveScaleInEnabled — same "plain checkbox nested under the master gate,
    // fails closed if requested while the master isn't (concurrently) on" shape
    // as liveOptionsEnabled above. It ADDS risk to real positions, but the
    // master's typed confirmation already covers "real money is live".
    if (body.liveScaleInEnabled === true && !masterWillBeEnabled) {
      throw new HttpError(400, 'Enabling live scale-in requires live trading to be enabled first');
    }
    if (body.liveScaleInEnabled !== undefined) patch.liveScaleInEnabled = body.liveScaleInEnabled;
    if (body.liveMaxAddOns !== undefined) patch.liveMaxAddOns = body.liveMaxAddOns;

    const next = setAutotradeConfig(patch);
    if (next.riskProfile !== before.riskProfile) {
      logAutotradeEvent({
        stage: 'config',
        action: 'risk_profile_changed',
        detail: { from: before.riskProfile, to: next.riskProfile },
        riskProfile: next.riskProfile,
      });
    }
    if (next.enabled !== before.enabled) {
      logAutotradeEvent({
        stage: 'config',
        action: next.enabled ? 'enabled' : 'disabled',
        riskProfile: next.riskProfile,
      });
    }
    if (next.accountEquityUsd !== before.accountEquityUsd) {
      logAutotradeEvent({
        stage: 'config',
        action: 'equity_changed',
        detail: { from: before.accountEquityUsd, to: next.accountEquityUsd },
        riskProfile: next.riskProfile,
      });
    }
    if (next.liveTradingEnabled !== before.liveTradingEnabled) {
      logAutotradeEvent({
        stage: 'config',
        action: next.liveTradingEnabled ? 'live_trading_enabled' : 'live_trading_disabled',
        riskProfile: next.riskProfile,
      });
    }
    if (next.liveOptionsEnabled !== before.liveOptionsEnabled) {
      logAutotradeEvent({
        stage: 'config',
        action: next.liveOptionsEnabled ? 'live_options_trading_enabled' : 'live_options_trading_disabled',
        riskProfile: next.riskProfile,
      });
    }
    if (next.optionsStrategyType !== before.optionsStrategyType) {
      logAutotradeEvent({
        stage: 'config',
        action: 'options_strategy_type_changed',
        detail: { from: before.optionsStrategyType, to: next.optionsStrategyType },
        riskProfile: next.riskProfile,
      });
    }
    res.json(next);
  }),
);

/** Pull accountEquityUsd from the live Webull account's net liquidation
 *  value, using the configured liveAccountId — see syncAccountEquityFromBroker()
 *  for why netLiquidationUsd (not buying power) is the right figure. Read-only
 *  against the broker; requires no confirmation phrase, unlike liveTradingEnabled
 *  itself, since nothing here places an order. */
/** Clear today's sticky daily-target halt flags, optionally re-basing the day.
 *
 *  Every halt is sticky on purpose — a faded gain must not un-bank a real win.
 *  That is right until a flag is set on a reading that never happened: on
 *  2026-08-27 a spurious net-liquidation tick banked the day at a fictional
 *  +9.69% and there was no way to undo it short of editing the database.
 *
 *  Clearing the flags alone is often not enough, and the response says so:
 *  `reached` is recomputed as `reachedAt !== null || equity >= target`, so
 *  while the feed still reads above the target the next tick re-trips it.
 *  Pass `baselineEquityUsd` to re-base the day onto the equity that is
 *  actually true. Read-write against our own DB only — places no order. */
autotradeRouter.post(
  '/daily-target/reset',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ baselineEquityUsd: z.number().positive().optional() }), req);
    const before = updateDailyTarget();
    const baseline = resetDailyBaselineFlags(body.baselineEquityUsd);
    logAutotradeEvent({
      stage: 'config',
      action: 'daily_target_reset',
      detail: {
        clearedReachedAt: before.reachedAt ?? null,
        clearedGiveBackHaltedAt: before.giveBackHaltedAt ?? null,
        previousBaselineEquityUsd: before.baselineEquityUsd ?? null,
        newBaselineEquityUsd: baseline?.equityUsd ?? null,
        note: 'sticky daily-target halt flags cleared by hand',
      },
    });
    const after = updateDailyTarget();
    res.json({ ok: true, baseline, status: after });
  }),
);

/** The daily goal against the record (2026-09-07): replay the book's recent
 *  sessions under each stopping policy at a grid of levels, with a bootstrap
 *  CI on every level's per-session delta against the record as it happened.
 *  Pure read of our own tables — no broker, no network — and synchronous:
 *  2000 resamples × 13 levels × 3 policies over ≤ 250 sessions is the same
 *  budget significance.ts already claims for a request handler. `book` and
 *  `sessions` are request parameters on purpose: a lookback stored in config
 *  would be a field read only by a read-only route. */
const dailyTargetSweepQuery = z.object({
  book: z.enum(['live', 'paper']).default('live'),
  sessions: z.coerce.number().int().min(5).max(250).default(DEFAULT_LOOKBACK_SESSIONS),
});

autotradeRouter.get('/daily-target/sweep', (req, res) => {
  const q = parseQuery(dailyTargetSweepQuery, req);
  const cfg = getAutotradeConfig();
  const collected = collectBook(q.book, q.sessions);
  res.json(
    runDailyTargetSweep({
      book: collected.book,
      trades: collected.trades,
      sessionDates: collected.sessionDates,
      droppedTrades: collected.droppedTrades,
      approximatedExits: collected.approximatedExits,
      lookbackSessions: collected.lookbackSessions,
      riskPerTradePct: cfg.riskPerTradePct,
      storedTargetPct: cfg.targetDailyGainPct,
    }),
  );
});

autotradeRouter.post(
  '/sync-equity',
  asyncHandler(async (_req, res) => {
    const result = await syncAccountEquityFromBroker();
    res.json(result);
  }),
);

// ---- Real-estate exclusion list --------------------------------------------

autotradeRouter.get('/exclusions', (_req, res) => {
  res.json({ exclusions: listExclusions() });
});

const exclusionBody = z.object({ symbol: z.string().min(1).max(10), reason: z.string().max(200).optional() });
autotradeRouter.post(
  '/exclusions',
  asyncHandler(async (req, res) => {
    const body = parseBody(exclusionBody, req);
    const record = addExclusion(body.symbol, body.reason);
    logAutotradeEvent({
      symbol: record.symbol,
      stage: 'config',
      action: 'exclusion_added',
      detail: { reason: record.reason },
    });
    res.status(201).json(record);
  }),
);

autotradeRouter.delete(
  '/exclusions/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = param(req, 'symbol');
    if (!removeExclusion(symbol)) throw new HttpError(404, `${symbol} is not on the exclusion list`);
    logAutotradeEvent({ symbol, stage: 'config', action: 'exclusion_removed' });
    res.json({ removed: symbol.toUpperCase() });
  }),
);

// ---- Scheduled macro-event blackout list ------------------------------------
// User-maintained date-times (FOMC, CPI, jobs reports, ...) checked by
// macroEventBlackoutHours above — see db/macroEvents.ts's own header comment
// on why this is hand-maintained rather than fetched from a live calendar.

autotradeRouter.get('/macro-events', (_req, res) => {
  res.json({ events: listMacroEvents() });
});

const macroEventBody = z.object({ label: z.string().min(1).max(200), eventAt: z.number().int().positive() });
autotradeRouter.post(
  '/macro-events',
  asyncHandler(async (req, res) => {
    const body = parseBody(macroEventBody, req);
    const record = addMacroEvent(body.label, body.eventAt);
    logAutotradeEvent({ stage: 'config', action: 'macro_event_added', detail: { label: record.label } });
    res.status(201).json(record);
  }),
);

autotradeRouter.delete(
  '/macro-events/:id',
  asyncHandler(async (req, res) => {
    const id = Number(param(req, 'id'));
    if (!Number.isInteger(id) || !removeMacroEvent(id)) {
      throw new HttpError(404, `No macro event with id ${param(req, 'id')}`);
    }
    logAutotradeEvent({ stage: 'config', action: 'macro_event_removed', detail: { id } });
    res.json({ removed: id });
  }),
);

// ---- Research & Screen ------------------------------------------------------

/** Defaults minRelVol to the persisted config's value — so the manual preview
 *  matches what the automated loop actually does — while still letting an ad
 *  hoc request override it (a caller-supplied filters.minRelVol wins, since
 *  it's spread last). */
function screenerConfigOverride(
  config: AutotradeConfig,
  requested?: Partial<ScreenerConfig>,
  regimeLabel: RegimeLabel | null = null,
): Partial<ScreenerConfig> {
  return {
    ...requested,
    filters: {
      minRelVol: config.minRelVol,
      minPrice: config.minPrice,
      minAvgVolume: config.minAvgVolume,
      minScore: config.minSignalScore,
      requireWeeklyTrendAlignment: config.requireWeeklyTrendAlignment,
      ...requested?.filters,
    },
    weights: {
      // Base is the regime-adaptive weight set the loop would use right now
      // (today's fixed defaults when the feature is off), so the manual preview
      // matches the automated loop; an ad hoc requested.weights still wins.
      ...resolveScoringWeights(config, regimeLabel),
      ...requested?.weights,
    },
    benchmarkSymbol: requested?.benchmarkSymbol ?? config.benchmarkSymbol,
    relativeStrengthLookbackDays: requested?.relativeStrengthLookbackDays ?? config.relativeStrengthLookbackDays,
  };
}

/** The current market-regime label when regime-adaptive weighting is on (else
 *  null), best-effort — a failed regime read falls back to the fixed weights
 *  rather than failing the request. Mirrors the loop's own gate. */
async function currentRegimeLabel(config: AutotradeConfig): Promise<RegimeLabel | null> {
  if (!config.regimeAdaptiveWeightsEnabled) return null;
  return (await computeMarketRegime().catch(() => null))?.label ?? null;
}

/** Same reasoning as screenerConfigOverride, for stopAtrMultiple/targetRMultiple. */
function decisionConfigOverride(config: AutotradeConfig, requested?: Partial<DecisionConfig>): Partial<DecisionConfig> {
  return { stopAtrMultiple: config.stopAtrMultiple, targetRMultiple: config.targetRMultiple, ...requested };
}

const screenBody = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(z.string().min(1)).optional(),
  /** Defaults to config.tradeDirection (what the loop would actually use) —
   *  same "persisted config as base, request can still override for a
   *  one-off preview" convention as earningsBlackoutDays/minRelVol above.
   *  'both' is what makes this preview capable of showing a long candidate
   *  and a short candidate together. */
  directionMode: z.enum(['long', 'short', 'both']).optional(),
});
autotradeRouter.post(
  '/screen',
  asyncHandler(async (req, res) => {
    const body = parseBody(screenBody, req);
    const config = getAutotradeConfig();
    const regimeLabel = await currentRegimeLabel(config);
    const result = await runAutotradeScreen({
      config: screenerConfigOverride(config, body.config as Partial<ScreenerConfig> | undefined, regimeLabel),
      symbols: body.symbols,
      earningsBlackoutDays: config.earningsBlackoutDays,
      directionMode: body.directionMode ?? config.tradeDirection,
      moversEnabled: config.moversDiscoveryEnabled,
    });
    res.json(result);
  }),
);

// ---- Explain: why did this symbol not get traded today? ---------------------
//
// The screener journals SOME rejections per symbol -- excluded_re,
// excluded_rel_vol_pace, excluded_volatility, excluded_earnings,
// skipped_unknown_sector -- and NOT the ones inside the score filter
// (minChangePct, minScore, weekly-trend alignment, minPrice, minAvgVolume).
// Those reasons were computed and dropped, so a name that simply never appeared
// left no trace of what stopped it. That is the more common case and the more
// useful question: SPY and QQQ were added to the universe on an explicit
// operator decision (2026-08-27), had their unknown-sector skip fixed
// (2026-09-03), and then produced zero candidates and zero signals with nothing
// anywhere saying why.
//
// The fix is NOT to journal every rejection. `excluded_re` alone is 31% of a
// 507k-row table that nothing prunes; per-symbol reasons for 528 names every
// tick would dwarf it. This asks the question on demand instead.
//
// WHY IT SCREENS THE WHOLE UNIVERSE for a single answer. runAutotradeScreen
// takes a `symbols` override and scanning one name would be far cheaper -- and
// would give a WRONG answer. relVolPace is a multiple of the universe's MEDIAN
// relVolume this tick, so a one-symbol screen makes that median the symbol's
// own relVolume and every pace comes out at exactly 1.0x. The pace gate would
// then pass or fail on an arithmetic artifact. An explain endpoint whose
// verdict differs from the loop's is worse than none, which is this codebase's
// most repeated lesson, so it pays for the real screen.
autotradeRouter.get(
  '/explain/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) throw new HttpError(400, 'A symbol is required.');
    const config = getAutotradeConfig();
    const regimeLabel = await currentRegimeLabel(config);
    const result = await runAutotradeScreen({
      config: screenerConfigOverride(config, undefined, regimeLabel),
      earningsBlackoutDays: config.earningsBlackoutDays,
      directionMode: config.tradeDirection,
      moversEnabled: config.moversDiscoveryEnabled,
    });

    const inUniverse = listUniverseSymbols().includes(symbol);
    const candidate = result.candidates.find((c) => c.symbol === symbol) ?? null;
    const rejected = result.rejected.find((r) => r.symbol === symbol) ?? null;
    const excluded = result.excluded.find((e) => e.symbol === symbol) ?? null;
    const skipped = result.skipped.find((e) => e.symbol === symbol) ?? null;
    const errored = result.errors.find((e) => e.symbol === symbol) ?? null;

    // Ordered by how far the symbol actually got, so `outcome` answers "where
    // did it stop" rather than "which list happened to be checked first".
    const outcome = candidate
      ? 'candidate'
      : errored
        ? 'error'
        : skipped
          ? 'skipped'
          : excluded
            ? 'excluded'
            : rejected
              ? 'rejected_by_filters'
              : inUniverse
                ? 'not_scanned'
                : 'not_in_universe';

    const detail = candidate
      ? `passed the screen with a score of ${candidate.total}`
      : errored
        ? errored.message
        : skipped
          ? skipped.reason
          : excluded
            ? excluded.reason
            : rejected
              ? rejected.reasons.join('; ')
              : inUniverse
                ? 'in the universe but not scanned this cycle — discovery or a provider error dropped it before scoring'
                : 'not in the universe and not surfaced by movers discovery this cycle';

    res.json({
      symbol,
      outcome,
      detail,
      inUniverse,
      score: candidate?.total ?? rejected?.total ?? null,
      direction: candidate?.direction ?? rejected?.direction ?? null,
      reasons: rejected?.reasons ?? [],
      candidate,
      // The context the reasons only make sense against: the pace denominator
      // is the market's median this tick, not a fixed number.
      screen: {
        generatedAt: result.generatedAt,
        scannedCount: result.discovery.scannedCount,
        candidateCount: result.candidates.length,
        relVolMedian: result.relVolMedian,
      },
      filters: {
        minChangePct: config.minChangePct,
        minSignalScore: config.minSignalScore,
        minPrice: config.minPrice,
        minAvgVolume: config.minAvgVolume,
        minRelVol: config.minRelVol,
        minRelVolPace: config.minRelVolPace,
        requireWeeklyTrendAlignment: config.requireWeeklyTrendAlignment,
        // Live entries face a HIGHER bar than the screen's own minimum, so an
        // explain that only reported minSignalScore would say "passed" about a
        // signal the live book then refuses.
        liveMinSignalScore: config.liveMinSignalScore,
      },
    });
  }),
);

// ---- Decision ---------------------------------------------------------------

const decideBody = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(z.string().min(1)).optional(),
  directionMode: z.enum(['long', 'short', 'both']).optional(),
  decision: z
    .object({
      stopAtrMultiple: z.number().positive().optional(),
      targetRMultiple: z.number().positive().optional(),
    })
    .optional(),
});
autotradeRouter.post(
  '/decide',
  asyncHandler(async (req, res) => {
    const body = parseBody(decideBody, req);
    const config = getAutotradeConfig();
    const regimeLabel = await currentRegimeLabel(config);
    const screen = await runAutotradeScreen({
      config: screenerConfigOverride(config, body.config as Partial<ScreenerConfig> | undefined, regimeLabel),
      symbols: body.symbols,
      earningsBlackoutDays: config.earningsBlackoutDays,
      directionMode: body.directionMode ?? config.tradeDirection,
      moversEnabled: config.moversDiscoveryEnabled,
    });
    const decision = runAutotradeDecision(
      screen.candidates,
      decisionConfigOverride(config, body.decision as Partial<DecisionConfig> | undefined),
    );
    const optionsDecision = await runOptionsDecision(screen.candidates, {
      strategyType: config.optionsStrategyType,
      maxIvRvRatio: config.optionsMaxIvRvRatio,
      entryConfig: {
        deltaMin: config.optionsDeltaMin,
        deltaMax: config.optionsDeltaMax,
        maxSpreadPct: config.optionsMaxSpreadPct,
        minOpenInterest: config.optionsMinOpenInterest,
        minVolume: config.optionsMinVolume,
        minDaysToExpiration: config.optionsMinDte,
        maxDaysToExpiration: config.optionsMaxDte,
        ivRankMax: config.optionsIvRankMax,
        ivRankMin: config.optionsIvRankMin,
      },
    });
    res.json({ screen, decision, optionsDecision });
  }),
);

// ---- Risk Check --------------------------------------------------------------

const signalBody = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  entry: z.number().positive(),
  stop: z.number().positive(),
  target: z.number().positive(),
  rMultiple: z.number().positive(),
  rationale: z.string(),
  score: z.number(),
  // Echoed back by the UI from /decide's own response. Omitting it here meant
  // zod silently stripped it, so the ADV participation cap (riskCheck.ts, which
  // only applies when avgVolume != null) went unenforced on this route — the
  // manual preview then showed a LARGER quantity than the loop, which calls
  // runAutotradeRiskCheck in-process with the signal intact, actually takes.
  avgVolume: z.number().nullable().optional(),
});
const riskCheckBody = z.object({ signals: z.array(signalBody).min(1) });
autotradeRouter.post(
  '/risk-check',
  asyncHandler(async (req, res) => {
    const body = parseBody(riskCheckBody, req);
    const results = await runAutotradeRiskCheck(body.signals);
    res.json({ results });
  }),
);

const singleLegSignalBody = z.object({
  kind: z.literal('single_leg'),
  symbol: z.string().min(1),
  side: z.enum(['call', 'put']),
  // Defaulted rather than required: an older client echoing back a signal it
  // received before this field existed would otherwise 400. Risk-checking is
  // read-only and never reads it — only the live exit path does, off the
  // position row — so 0 here costs nothing.
  underlyingPrice: z.number().nonnegative().default(0),
  contractSymbol: z.string().min(1),
  strike: z.number().positive(),
  expiration: z.string().min(8),
  dte: z.number().nonnegative(),
  premium: z.number().nonnegative(),
  delta: z.number().nullable(),
  ivRank: z.number(),
  maxLossPerContract: z.number().nonnegative(),
  rationale: z.string(),
  score: z.number(),
});
const debitSpreadSignalBody = z.object({
  kind: z.literal('debit_spread'),
  symbol: z.string().min(1),
  side: z.enum(['call', 'put']),
  underlyingPrice: z.number().nonnegative().default(0), // see singleLegSignalBody
  expiration: z.string().min(8),
  dte: z.number().nonnegative(),
  ivRank: z.number(),
  longContractSymbol: z.string().min(1),
  longStrike: z.number().positive(),
  longPremium: z.number().nonnegative(),
  longDelta: z.number().nullable(),
  shortContractSymbol: z.string().min(1),
  shortStrike: z.number().positive(),
  shortPremium: z.number().nonnegative(),
  shortDelta: z.number().nullable(),
  width: z.number().positive(),
  netDebit: z.number().nonnegative(),
  maxLossPerContract: z.number().nonnegative(),
  maxProfitPerContract: z.number().nonnegative(),
  rationale: z.string(),
  score: z.number(),
});
// Discriminated on `kind` — matches optionsDecide.ts's OptionsTradeSignal
// union exactly; the frontend only ever echoes back a signal it already got
// verbatim from an earlier /decide response.
const optionsSignalBody = z.discriminatedUnion('kind', [singleLegSignalBody, debitSpreadSignalBody]);
// Only the fields runOptionsRiskCheck actually reads to seed the combined
// budget — not a full re-validation of a RiskCheckResult's nested checks/
// sizing shape, which the frontend only ever echoes back verbatim from an
// earlier /risk-check response it already trusts.
const equityResultBody = z.object({
  symbol: z.string().min(1),
  ok: z.boolean(),
  approvedRiskAmount: z.number(),
  approvedNotional: z.number(),
});
const riskCheckOptionsBody = z.object({
  signals: z.array(optionsSignalBody).min(1),
  equityResults: z.array(equityResultBody).optional(),
});
autotradeRouter.post(
  '/risk-check-options',
  asyncHandler(async (req, res) => {
    const body = parseBody(riskCheckOptionsBody, req);
    const results = await runOptionsRiskCheck(body.signals, body.equityResults);
    res.json({ results });
  }),
);

// ---- Backtesting & walk-forward (the validation gate) -----------------------

/** True only for a real calendar date — rejects both structurally-invalid
 *  values (month 00/13+, day 00/32+) AND values JS's Date would otherwise
 *  silently roll over to a different date (e.g. "2024-02-30" -> Mar 1,
 *  "2023-02-29" -> Mar 1 on a non-leap year) by round-tripping through
 *  Date.UTC and comparing every field back against the input. Without this,
 *  a structurally-invalid date reaches backtest.ts's addDays()/toISO(), whose
 *  `new Date(NaN).toISOString()` throws an uncaught RangeError — a 500, not a
 *  clean 400. */
function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isValidCalendarDate, { message: 'Not a valid calendar date' });

/** No cap here previously meant a request could ask for an arbitrarily long
 *  span — each engine's day-by-day simulation is synchronous-ish CPU work
 *  (see backtest.ts/combinedBacktest.ts/optionsBacktest.ts's own periodic
 *  yield-point comments), so an unbounded span risked tying up the server
 *  for the whole request. 3 years is generous for a strategy-validation
 *  tool (spans multiple market regimes) while keeping worst case bounded. */
const MAX_BACKTEST_SPAN_DAYS = 1095;
function withinMaxSpan(from: string, to: string): boolean {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000);
  return days <= MAX_BACKTEST_SPAN_DAYS;
}
// Optional per-request overrides for the nine risk-check parameters — when
// omitted, a backtest falls back field-by-field to riskProfile's OLD
// MODERATE/AGGRESSIVE preset bundle (see backtest.ts's
// resolveBacktestRiskParams/LEGACY_BACKTEST_RISK_DEFAULTS). Shared across all
// three backtest body schemas below.
const backtestRiskParamsSchema = {
  riskPerTradePct: z.number().nonnegative().optional(),
  maxDailyDrawdownPct: z.number().min(0).max(100).optional(),
  stepDownAfterLosses: z.number().int().nonnegative().optional(),
  stepDownSizeCutPct: z.number().min(0).max(100).optional(),
  maxAggregateOpenRiskPct: z.number().min(0).max(100).optional(),
  maxCorrelatedExposurePct: z.number().min(0).max(100).optional(),
  maxTradesPerDay: z.number().int().nonnegative().optional(),
  correlationLookbackDays: z.number().int().min(1).optional(),
  correlationThreshold: z.number().min(0).max(1).optional(),
  correlationAwareSelectionEnabled: z.boolean().optional(),
  // Scoring flag (not a risk param), accepted on every backtest body via the
  // shared spread; the presets it uses are pulled from the live config.
  regimeAdaptiveWeightsEnabled: z.boolean().optional(),
};
/** Pulls the optional risk-param overrides off an already-parsed backtest
 *  body, for spreading into a runXBacktest({...}) call — avoids repeating all
 *  the field names at each of the six call sites below. */
function backtestRiskParamsFrom(body: {
  riskPerTradePct?: number;
  maxDailyDrawdownPct?: number;
  stepDownAfterLosses?: number;
  stepDownSizeCutPct?: number;
  maxAggregateOpenRiskPct?: number;
  maxCorrelatedExposurePct?: number;
  maxTradesPerDay?: number;
  correlationLookbackDays?: number;
  correlationThreshold?: number;
  correlationAwareSelectionEnabled?: boolean;
}) {
  return {
    riskPerTradePct: body.riskPerTradePct,
    maxDailyDrawdownPct: body.maxDailyDrawdownPct,
    stepDownAfterLosses: body.stepDownAfterLosses,
    stepDownSizeCutPct: body.stepDownSizeCutPct,
    maxAggregateOpenRiskPct: body.maxAggregateOpenRiskPct,
    maxCorrelatedExposurePct: body.maxCorrelatedExposurePct,
    maxTradesPerDay: body.maxTradesPerDay,
    correlationLookbackDays: body.correlationLookbackDays,
    correlationThreshold: body.correlationThreshold,
    correlationAwareSelectionEnabled: body.correlationAwareSelectionEnabled,
  };
}

/** Regime-adaptive-weights fields for a backtest run. The flag comes from the
 *  request; the presets themselves are pulled from the LIVE config, so a user
 *  edits their presets once (on the Config page) and validates them in a
 *  backtest by just flipping this on — no need to re-send 18 numbers per run. */
function regimeBacktestFields(body: { regimeAdaptiveWeightsEnabled?: boolean }) {
  return {
    regimeAdaptiveWeightsEnabled: body.regimeAdaptiveWeightsEnabled,
    regimeWeightPresets: body.regimeAdaptiveWeightsEnabled ? getAutotradeConfig().regimeWeightPresets : undefined,
  };
}
const backtestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50, 'At most 50 symbols per backtest run'),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
  maxConcurrentPositions: z.number().int().min(1),
  maxHoldDays: z.number().int().nonnegative().optional(),
  breakevenTriggerRMultiple: z.number().nonnegative().optional(),
  trailStartRMultiple: z.number().nonnegative().optional(),
  trailStopRMultiple: z.number().nonnegative().optional(),
  partialExitRMultiple: z.number().nonnegative().optional(),
  partialExitPct: z.number().min(0).max(100).optional(),
  addOnTriggerRMultiple: z.number().nonnegative().optional(),
  addOnSizePct: z.number().min(0).max(100).optional(),
  maxAddOns: z.number().int().min(0).optional(),
  ...backtestRiskParamsSchema,
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  decisionConfig: z.record(z.string(), z.unknown()).optional(),
  /** Own value here, NOT read from live config if omitted — same
   *  self-contained-hypothesis convention as every other backtest field
   *  (maxConcurrentPositions, maxHoldDays, etc. — see BacktestConfig's own
   *  doc comments). Falls back to 'long' via simulateBacktest's own
   *  screenerCfg.direction default when omitted entirely. */
  directionMode: z.enum(['long', 'short', 'both']).optional(),
});
const backtestBody = backtestBodyBase
  .refine((b) => b.from <= b.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });
const walkForwardBody = backtestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
  })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });

autotradeRouter.post(
  '/backtest',
  asyncHandler(async (req, res) => {
    const body = parseBody(backtestBody, req);
    const report = await runBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      maxHoldDays: body.maxHoldDays,
      breakevenTriggerRMultiple: body.breakevenTriggerRMultiple,
      trailStartRMultiple: body.trailStartRMultiple,
      trailStopRMultiple: body.trailStopRMultiple,
      partialExitRMultiple: body.partialExitRMultiple,
      partialExitPct: body.partialExitPct,
      addOnTriggerRMultiple: body.addOnTriggerRMultiple,
      addOnSizePct: body.addOnSizePct,
      maxAddOns: body.maxAddOns,
      ...backtestRiskParamsFrom(body),
      ...regimeBacktestFields(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      directionMode: body.directionMode,
    });
    res.json({ report, stats: computeBacktestStats(report) });
  }),
);

autotradeRouter.post(
  '/backtest/walk-forward',
  asyncHandler(async (req, res) => {
    const body = parseBody(walkForwardBody, req);
    const wf = await runWalkForwardBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      splitDate: body.splitDate,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      maxHoldDays: body.maxHoldDays,
      breakevenTriggerRMultiple: body.breakevenTriggerRMultiple,
      trailStartRMultiple: body.trailStartRMultiple,
      trailStopRMultiple: body.trailStopRMultiple,
      partialExitRMultiple: body.partialExitRMultiple,
      partialExitPct: body.partialExitPct,
      addOnTriggerRMultiple: body.addOnTriggerRMultiple,
      addOnSizePct: body.addOnSizePct,
      maxAddOns: body.maxAddOns,
      ...backtestRiskParamsFrom(body),
      ...regimeBacktestFields(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      directionMode: body.directionMode,
    });
    res.json({
      inSample: {
        report: wf.inSample,
        stats: computeBacktestStats(wf.inSample),
        significance: computeSignificanceStats(wf.inSample.trades),
      },
      outOfSample: {
        report: wf.outOfSample,
        stats: computeBacktestStats(wf.outOfSample),
        significance: computeSignificanceStats(wf.outOfSample.trades),
      },
      excludedSymbols: wf.excludedSymbols,
      errors: wf.errors,
    });
  }),
);

const optionsBacktestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50, 'At most 50 symbols per backtest run'),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
  maxConcurrentPositions: z.number().int().min(1),
  ...backtestRiskParamsSchema,
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  optionsDecisionConfig: z.record(z.string(), z.unknown()).optional(),
  /** Own value here, NOT read from live config if omitted — same
   *  self-contained-hypothesis convention as the equity /backtest route's
   *  own directionMode. Falls back to 'long' via simulateOptionsBacktest's
   *  own default when omitted entirely. Governs call vs put too — see
   *  OptionsBacktestConfig's own doc comment. */
  directionMode: z.enum(['long', 'short', 'both']).optional(),
  // --- Options stop-loss / take-profit (own value, not read from live config) -
  optionsStopLossPct: z.number().min(0).max(100).optional(),
  optionsTakeProfitPct: z.number().min(0).max(100).optional(),
  // --- Options trailing stop / breakeven / partial profit-taking (own value) -
  optionsBreakevenTriggerPct: z.number().min(0).max(100).optional(),
  optionsTrailStartPct: z.number().min(0).max(100).optional(),
  optionsTrailStopPct: z.number().min(0).max(100).optional(),
  optionsPartialExitTriggerPct: z.number().min(0).max(100).optional(),
  optionsPartialExitPct: z.number().min(0).max(100).optional(),
});
const optionsBacktestBody = optionsBacktestBodyBase
  .refine((b) => b.from <= b.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });
const optionsWalkForwardBody = optionsBacktestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
  })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });

autotradeRouter.post(
  '/backtest-options',
  asyncHandler(async (req, res) => {
    const body = parseBody(optionsBacktestBody, req);
    const report = await runOptionsBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      ...backtestRiskParamsFrom(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
      directionMode: body.directionMode,
      optionsStopLossPct: body.optionsStopLossPct,
      optionsTakeProfitPct: body.optionsTakeProfitPct,
      optionsBreakevenTriggerPct: body.optionsBreakevenTriggerPct,
      optionsTrailStartPct: body.optionsTrailStartPct,
      optionsTrailStopPct: body.optionsTrailStopPct,
      optionsPartialExitTriggerPct: body.optionsPartialExitTriggerPct,
      optionsPartialExitPct: body.optionsPartialExitPct,
    });
    res.json({ report, stats: computeBacktestStats(report) });
  }),
);

autotradeRouter.post(
  '/backtest-options/walk-forward',
  asyncHandler(async (req, res) => {
    const body = parseBody(optionsWalkForwardBody, req);
    const wf = await runOptionsWalkForwardBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      splitDate: body.splitDate,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      ...backtestRiskParamsFrom(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
      directionMode: body.directionMode,
      optionsStopLossPct: body.optionsStopLossPct,
      optionsTakeProfitPct: body.optionsTakeProfitPct,
      optionsBreakevenTriggerPct: body.optionsBreakevenTriggerPct,
      optionsTrailStartPct: body.optionsTrailStartPct,
      optionsTrailStopPct: body.optionsTrailStopPct,
      optionsPartialExitTriggerPct: body.optionsPartialExitTriggerPct,
      optionsPartialExitPct: body.optionsPartialExitPct,
    });
    res.json({
      inSample: {
        report: wf.inSample,
        stats: computeBacktestStats(wf.inSample),
        significance: computeSignificanceStats(wf.inSample.trades),
      },
      outOfSample: {
        report: wf.outOfSample,
        stats: computeBacktestStats(wf.outOfSample),
        significance: computeSignificanceStats(wf.outOfSample.trades),
      },
      excludedSymbols: wf.excludedSymbols,
      errors: wf.errors,
    });
  }),
);

/** A combined report's stats span BOTH books (equityTrades + optionsTrades)
 *  against the ONE shared equity curve — the whole point of "genuinely
 *  combined" is a single risk-adjusted performance read, not two separate
 *  ones a human has to add up themselves. computeBacktestStats() needs no
 *  changes for this — {pnl, rMultiple} is already satisfied by both trade shapes. */
function combinedStats(report: {
  equityTrades: { pnl: number; rMultiple: number }[];
  optionsTrades: { pnl: number; rMultiple: number }[];
  startingEquity: number;
  finalEquity: number;
}) {
  return computeBacktestStats({
    trades: [...report.equityTrades, ...report.optionsTrades],
    startingEquity: report.startingEquity,
    finalEquity: report.finalEquity,
  });
}

/** Same both-books concatenation as combinedStats() above, for the
 *  significance check — {pnl} is already satisfied by both trade shapes. */
function combinedSignificance(report: { equityTrades: { pnl: number }[]; optionsTrades: { pnl: number }[] }) {
  return computeSignificanceStats([...report.equityTrades, ...report.optionsTrades]);
}

const combinedBacktestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50, 'At most 50 symbols per backtest run'),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
  maxConcurrentPositions: z.number().int().min(1),
  maxHoldDays: z.number().int().nonnegative().optional(),
  breakevenTriggerRMultiple: z.number().nonnegative().optional(),
  trailStartRMultiple: z.number().nonnegative().optional(),
  trailStopRMultiple: z.number().nonnegative().optional(),
  partialExitRMultiple: z.number().nonnegative().optional(),
  partialExitPct: z.number().min(0).max(100).optional(),
  addOnTriggerRMultiple: z.number().nonnegative().optional(),
  addOnSizePct: z.number().min(0).max(100).optional(),
  maxAddOns: z.number().int().min(0).optional(),
  ...backtestRiskParamsSchema,
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  decisionConfig: z.record(z.string(), z.unknown()).optional(),
  optionsDecisionConfig: z.record(z.string(), z.unknown()).optional(),
  /** Own value here, NOT read from live config if omitted — same
   *  self-contained-hypothesis convention as the equity /backtest route's
   *  own directionMode. Falls back to 'long' via simulateCombinedBacktest's
   *  own default when omitted entirely. Governs BOTH legs — see
   *  CombinedBacktestConfig's own doc comment. */
  directionMode: z.enum(['long', 'short', 'both']).optional(),
  // --- Options stop-loss / take-profit (own value; options leg only) ----------
  optionsStopLossPct: z.number().min(0).max(100).optional(),
  optionsTakeProfitPct: z.number().min(0).max(100).optional(),
  // --- Options trailing stop / breakeven / partial profit-taking (options leg only) -
  optionsBreakevenTriggerPct: z.number().min(0).max(100).optional(),
  optionsTrailStartPct: z.number().min(0).max(100).optional(),
  optionsTrailStopPct: z.number().min(0).max(100).optional(),
  optionsPartialExitTriggerPct: z.number().min(0).max(100).optional(),
  optionsPartialExitPct: z.number().min(0).max(100).optional(),
});
const combinedBacktestBody = combinedBacktestBodyBase
  .refine((b) => b.from <= b.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });
const combinedWalkForwardBody = combinedBacktestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
  })
  .refine((b) => withinMaxSpan(b.from, b.to), {
    message: `Span from from to to cannot exceed ${MAX_BACKTEST_SPAN_DAYS} days`,
    path: ['to'],
  });

autotradeRouter.post(
  '/backtest-combined',
  asyncHandler(async (req, res) => {
    const body = parseBody(combinedBacktestBody, req);
    const report = await runCombinedBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      maxHoldDays: body.maxHoldDays,
      breakevenTriggerRMultiple: body.breakevenTriggerRMultiple,
      trailStartRMultiple: body.trailStartRMultiple,
      trailStopRMultiple: body.trailStopRMultiple,
      partialExitRMultiple: body.partialExitRMultiple,
      partialExitPct: body.partialExitPct,
      addOnTriggerRMultiple: body.addOnTriggerRMultiple,
      addOnSizePct: body.addOnSizePct,
      maxAddOns: body.maxAddOns,
      ...backtestRiskParamsFrom(body),
      ...regimeBacktestFields(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
      directionMode: body.directionMode,
      optionsStopLossPct: body.optionsStopLossPct,
      optionsTakeProfitPct: body.optionsTakeProfitPct,
      optionsBreakevenTriggerPct: body.optionsBreakevenTriggerPct,
      optionsTrailStartPct: body.optionsTrailStartPct,
      optionsTrailStopPct: body.optionsTrailStopPct,
      optionsPartialExitTriggerPct: body.optionsPartialExitTriggerPct,
      optionsPartialExitPct: body.optionsPartialExitPct,
    });
    res.json({ report, stats: combinedStats(report) });
  }),
);

autotradeRouter.post(
  '/backtest-combined/walk-forward',
  asyncHandler(async (req, res) => {
    const body = parseBody(combinedWalkForwardBody, req);
    const wf = await runCombinedWalkForwardBacktest({
      symbols: body.symbols,
      from: body.from,
      to: body.to,
      splitDate: body.splitDate,
      riskProfile: body.riskProfile,
      startingEquity: body.startingEquity,
      maxConcurrentPositions: body.maxConcurrentPositions,
      maxHoldDays: body.maxHoldDays,
      breakevenTriggerRMultiple: body.breakevenTriggerRMultiple,
      trailStartRMultiple: body.trailStartRMultiple,
      trailStopRMultiple: body.trailStopRMultiple,
      partialExitRMultiple: body.partialExitRMultiple,
      partialExitPct: body.partialExitPct,
      addOnTriggerRMultiple: body.addOnTriggerRMultiple,
      addOnSizePct: body.addOnSizePct,
      maxAddOns: body.maxAddOns,
      ...backtestRiskParamsFrom(body),
      ...regimeBacktestFields(body),
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
      directionMode: body.directionMode,
      optionsStopLossPct: body.optionsStopLossPct,
      optionsTakeProfitPct: body.optionsTakeProfitPct,
      optionsBreakevenTriggerPct: body.optionsBreakevenTriggerPct,
      optionsTrailStartPct: body.optionsTrailStartPct,
      optionsTrailStopPct: body.optionsTrailStopPct,
      optionsPartialExitTriggerPct: body.optionsPartialExitTriggerPct,
      optionsPartialExitPct: body.optionsPartialExitPct,
    });
    res.json({
      inSample: {
        report: wf.inSample,
        stats: combinedStats(wf.inSample),
        significance: combinedSignificance(wf.inSample),
      },
      outOfSample: {
        report: wf.outOfSample,
        stats: combinedStats(wf.outOfSample),
        significance: combinedSignificance(wf.outOfSample),
      },
      excludedSymbols: wf.excludedSymbols,
      errors: wf.errors,
    });
  }),
);

// ---- Paper execution loop (Phase 6) ------------------------------------------

/** Run one loop cycle right now — the same function the background scheduler
 *  calls, exposed so a human can watch it work without waiting for the next
 *  real-time tick. Still fully paper — see services/autotrading/execute.ts. */
autotradeRouter.post(
  '/loop/run-once',
  asyncHandler(async (_req, res) => {
    const summary = await runAutotradeLoopTick();
    res.json(summary);
  }),
);

export interface PaperPositionLive extends PaperPosition {
  /** A live quote as of this request — null for a closed position (its own
   *  exitPrice is the number that matters there) or if the quote fetch
   *  failed with nothing cached either. */
  currentPrice: number | null;
  /** True when currentPrice came from the last-known cache, not a live
   *  quote (provider rate-limited or down) — mirrors the human Positions
   *  page's own "stale" flag (services/quotes.ts). */
  stale: boolean;
  /** (currentPrice - entryPrice) * quantity, sign-adjusted for side — null
   *  for a closed position (use exitPrice-based realized P&L instead) or
   *  when currentPrice itself is unavailable. */
  unrealizedPnl: number | null;
}

/** Enrich open positions with a live quote + unrealized P&L, same live-price
 *  resolution the human Positions page uses (services/quotes.ts) — batched
 *  and gracefully degrading per-symbol, never failing the whole request.
 *  Closed positions pass through with currentPrice/unrealizedPnl null (their
 *  own exitPrice/realized P&L already covers them; the client computes that
 *  side unchanged). The list here is always small (bounded by the active
 *  risk profile's concurrent-position cap), so this is cheap on every call —
 *  the same per-cycle cost checkPaperExits() already pays for these same
 *  symbols, just from a different trigger. */
async function withLivePrices(positions: PaperPosition[]): Promise<PaperPositionLive[]> {
  const openSymbols = positions.filter((p) => p.status === 'open').map((p) => p.symbol);
  const prices = openSymbols.length ? await resolveStockPrices(openSymbols) : new Map();
  return positions.map((p) => {
    const resolved = p.status === 'open' ? prices.get(p.symbol.toUpperCase()) : undefined;
    const currentPrice = resolved?.price ?? null;
    return {
      ...p,
      currentPrice,
      stale: resolved?.stale ?? false,
      unrealizedPnl: computePaperUnrealizedPnl(p, currentPrice),
    };
  });
}

const paperPositionsQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  symbol: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
autotradeRouter.get(
  '/paper-positions',
  asyncHandler(async (req, res) => {
    const q = parseQuery(paperPositionsQuery, req);
    const positions = await withLivePrices(listPaperPositions(q));
    res.json({ positions });
  }),
);

export interface OptionsPaperPositionLive extends OptionsPaperPosition {
  /** A live contract mark as of this request (long leg, for a spread) — null
   *  for a closed position or if the chain fetch failed. */
  currentPrice: number | null;
  /** The short leg's live mark — null for single_leg, a closed position, or
   *  a chain-fetch failure. */
  shortCurrentPrice: number | null;
  /** The chain fetch's own underlyingPrice as of this request — null for a
   *  closed position, a chain-fetch failure, or a provider that doesn't
   *  report it. Free byproduct of the SAME chain fetch marks/shortMarks
   *  already use, not an extra provider call — lets the web badge derive a
   *  short leg's intrinsic/extrinsic value (assignment risk) without its
   *  own stock-quote round trip. */
  underlyingPrice: number | null;
  /** See computeOptionsPaperUnrealizedPnl — null for a closed position or
   *  when a needed mark is unavailable. */
  unrealizedPnl: number | null;
}

/** Enrich open options paper positions with live contract mark(s) + unrealized
 *  P&L. Fetches one chain per distinct (symbol, expiration) among the open
 *  positions (mirrors services/quotes.ts's resolveOptionMarks grouping, just
 *  keyed off this table's own shape instead of the human Position type) and
 *  matches strike + side within it — for a debit spread, both the long and
 *  short strike are matched from that SAME chain fetch, no extra network
 *  call. A chain-fetch failure degrades that group to null marks, never
 *  fails the whole request. */
async function withLiveOptionMarks(positions: OptionsPaperPosition[]): Promise<OptionsPaperPositionLive[]> {
  const open = positions.filter((p) => p.status === 'open');
  const marks = new Map<number, number | null>();
  const shortMarks = new Map<number, number | null>();
  const underlyingPrices = new Map<number, number | null>();
  if (open.length) {
    const groups = new Map<string, OptionsPaperPosition[]>();
    for (const p of open) {
      const key = `${p.symbol}|${p.expiration}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    const provider = getProvider();
    await Promise.all(
      Array.from(groups.entries()).map(async ([key, members]) => {
        const [symbol, expiration] = key.split('|');
        try {
          const chain = await provider.getOptionsChain(symbol, expiration);
          const markFor = (strike: number, side: 'call' | 'put') => {
            const pool = side === 'call' ? chain.calls : chain.puts;
            const match = pool.find((c) => Math.abs(c.strike - strike) < 1e-6);
            return match?.mark ?? match?.last ?? null;
          };
          for (const p of members) {
            marks.set(p.id, markFor(p.strike, p.side));
            if (p.kind === 'debit_spread' && p.shortStrike !== null) {
              shortMarks.set(p.id, markFor(p.shortStrike, p.side));
            }
            underlyingPrices.set(p.id, chain.underlyingPrice ?? null);
          }
        } catch {
          for (const p of members) {
            marks.set(p.id, null);
            if (p.kind === 'debit_spread') shortMarks.set(p.id, null);
            underlyingPrices.set(p.id, null);
          }
        }
      }),
    );
  }
  return positions.map((p) => {
    const currentPrice = p.status === 'open' ? (marks.get(p.id) ?? null) : null;
    const shortCurrentPrice = p.status === 'open' && p.kind === 'debit_spread' ? (shortMarks.get(p.id) ?? null) : null;
    const underlyingPrice = p.status === 'open' ? (underlyingPrices.get(p.id) ?? null) : null;
    return {
      ...p,
      currentPrice,
      shortCurrentPrice,
      underlyingPrice,
      unrealizedPnl: computeOptionsPaperUnrealizedPnl(p, currentPrice, shortCurrentPrice),
    };
  });
}

autotradeRouter.get(
  '/options-paper-positions',
  asyncHandler(async (req, res) => {
    const q = parseQuery(paperPositionsQuery, req);
    const positions = await withLiveOptionMarks(listOptionsPaperPositions(q));
    res.json({ positions });
  }),
);

export interface LiveOptionsPositionLive extends LiveOptionsPosition {
  /** A live contract mark as of this request (long leg, for a spread) — null
   *  for a closed position or if the chain fetch failed. */
  currentPrice: number | null;
  /** The short leg's live mark — null for single_leg, a closed position, or
   *  a chain-fetch failure. */
  shortCurrentPrice: number | null;
  /** See OptionsPaperPositionLive's own doc comment — same free byproduct of
   *  the chain fetch, same null-when-unavailable semantics. */
  underlyingPrice: number | null;
  /** See computeOptionsPaperUnrealizedPnl — null for a closed position or
   *  when a needed mark is unavailable. Reused as-is (not a live-options
   *  variant): the formula is asset/book-agnostic, keyed structurally off
   *  {status, kind, entryPrice, shortEntryPrice, quantity} — LiveOptionsPosition
   *  and OptionsPaperPosition both satisfy it. */
  unrealizedPnl: number | null;
}

/** Enrich open LIVE options positions with live contract mark(s) + unrealized
 *  P&L — identical grouping/matching logic to withLiveOptionMarks() above,
 *  just over autotrade_live_options_positions instead of the paper table.
 *  Kept as its own function (not a generic shared one) since the two
 *  position types, while structurally similar, are nominally distinct — same
 *  "deliberately parallel, not shared" convention as the execution services
 *  themselves. */
async function withLiveOptionsPositionMarks(positions: LiveOptionsPosition[]): Promise<LiveOptionsPositionLive[]> {
  const open = positions.filter((p) => p.status === 'open');
  const marks = new Map<number, number | null>();
  const shortMarks = new Map<number, number | null>();
  const underlyingPrices = new Map<number, number | null>();
  if (open.length) {
    const groups = new Map<string, LiveOptionsPosition[]>();
    for (const p of open) {
      const key = `${p.symbol}|${p.expiration}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    const provider = getProvider();
    await Promise.all(
      Array.from(groups.entries()).map(async ([key, members]) => {
        const [symbol, expiration] = key.split('|');
        try {
          const chain = await provider.getOptionsChain(symbol, expiration);
          const markFor = (strike: number, side: 'call' | 'put') => {
            const pool = side === 'call' ? chain.calls : chain.puts;
            const match = pool.find((c) => Math.abs(c.strike - strike) < 1e-6);
            return match?.mark ?? match?.last ?? null;
          };
          for (const p of members) {
            marks.set(p.id, markFor(p.strike, p.side));
            if (p.kind === 'debit_spread' && p.shortStrike !== null) {
              shortMarks.set(p.id, markFor(p.shortStrike, p.side));
            }
            underlyingPrices.set(p.id, chain.underlyingPrice ?? null);
          }
        } catch {
          for (const p of members) {
            marks.set(p.id, null);
            if (p.kind === 'debit_spread') shortMarks.set(p.id, null);
            underlyingPrices.set(p.id, null);
          }
        }
      }),
    );
  }
  return positions.map((p) => {
    const currentPrice = p.status === 'open' ? (marks.get(p.id) ?? null) : null;
    const shortCurrentPrice = p.status === 'open' && p.kind === 'debit_spread' ? (shortMarks.get(p.id) ?? null) : null;
    const underlyingPrice = p.status === 'open' ? (underlyingPrices.get(p.id) ?? null) : null;
    return {
      ...p,
      currentPrice,
      shortCurrentPrice,
      underlyingPrice,
      unrealizedPnl: computeOptionsPaperUnrealizedPnl(p, currentPrice, shortCurrentPrice),
    };
  });
}

autotradeRouter.get(
  '/live-options-positions',
  asyncHandler(async (req, res) => {
    const q = parseQuery(paperPositionsQuery, req);
    const positions = await withLiveOptionsPositionMarks(listLiveOptionsPositions(q));
    res.json({ positions });
  }),
);

// Manually close a live options position autotrade itself opened — the
// options counterpart to routes/positions.ts's POST /positions/:id/close.
// Places a REAL closing order through the same TRADING_ENABLED + confirm-
// phrase + guardrails pipeline the Trade page and the equity close route
// use (services/trading/closePosition.ts's closeLiveOptionsAutotradePosition).
const closeLiveOptionsBody = z.object({
  accountId: z.string().min(1).max(64),
  confirmation: z.string().min(1).max(64),
});
autotradeRouter.post(
  '/live-options-positions/:id/close',
  asyncHandler(async (req, res) => {
    const body = parseBody(closeLiveOptionsBody, req);
    const pos = getLiveOptionsPosition(Number(param(req, 'id')));
    if (!pos) throw new HttpError(404, 'live options position not found');
    if (pos.status !== 'open') throw new HttpError(409, 'position is already closed');
    res.json(await closeLiveOptionsAutotradePosition(pos, body.accountId, body.confirmation));
  }),
);

export interface AutotradeLivePositionLive extends Position {
  /** A live quote/mark as of this request — null for a closed position or a
   *  resolution failure. */
  currentPrice: number | null;
  stale: boolean;
  /** Full P&L breakdown (realized/unrealized/total/R-multiple/market value),
   *  reusing services/pnl.ts's computePositionPnl() unchanged — the exact
   *  same math the human Positions/Journal pages already use, so this never
   *  shows a number those pages would disagree with. Handles partial exits
   *  and the stock/option multiplier difference correctly, unlike paper
   *  trading's simpler single-entry/single-exit shape. */
  pnl: PositionPnl;
  /** How many scale-in add-ons this live position has had committed (0 unless
   *  liveScaleInEnabled pyramided it) — surfaced so the Live positions table
   *  can badge a pyramided position. */
  addOnsTaken: number;
}

/** Enrich real autotrade-placed positions with a live price/mark + full P&L —
 *  reuses services/quotes.ts's priceMap() (shared with routes/positions.ts,
 *  the human's own book) rather than a second stock/option price-resolution
 *  implementation. */
async function withLivePositionPnl(positions: Position[]): Promise<AutotradeLivePositionLive[]> {
  const prices = await priceMap(positions);
  return positions.map((p) => {
    const info = prices.get(p.id) ?? { price: null, stale: false, asOf: null };
    return {
      ...p,
      currentPrice: info.price,
      stale: info.stale,
      pnl: computePositionPnl(p, info.price),
      addOnsTaken: countLiveAddOns(p.id),
    };
  });
}

autotradeRouter.get(
  '/live-positions',
  asyncHandler(async (req, res) => {
    const q = parseQuery(paperPositionsQuery, req);
    const positions = await withLivePositionPnl(listAutotradeLivePositions(q));
    res.json({ positions });
  }),
);

// ---- Monitoring dashboard & kill switch (Phase 7) ----------------------------

/** Real-time snapshot for the monitoring panel: active profile, open paper
 *  positions, aggregate open risk used vs limit, day P&L vs the drawdown
 *  halt, trade count vs max, and the consecutive-loss streak — plus the
 *  enabled/kill-switch state itself. Read-only. */
autotradeRouter.get('/dashboard', (_req, res) => {
  res.json(getAutotradeDashboard());
});

/** Net delta/theta/vega across autotrade's own combined open options book
 *  (paper + live) — a SEPARATE, on-demand endpoint rather than a field on
 *  /dashboard above: computing it needs a live options-chain fetch per open
 *  (symbol, expiration), unlike every other /dashboard figure (a pure read of
 *  already-persisted state), and /dashboard is polled far more often than a
 *  Greeks snapshot needs to be (see AutoTradePage's own polling-frequency
 *  precedent, Perf #5) — bundling this in would mean either a real network
 *  round-trip on every dashboard poll, or a rate-limit risk, for a number
 *  most callers of /dashboard (e.g. dailyHaltAlert.ts's own per-tick read)
 *  never asked for. */
autotradeRouter.get(
  '/portfolio-greeks',
  asyncHandler(async (_req, res) => {
    const paperOptions = getOptionsPaperPortfolioSnapshot().openPositions;
    // null = every account: portfolio greeks describe the whole book.
    const liveOptions = getLiveOptionsPortfolioSnapshot(null).openPositions;
    res.json(await computeAutotradeOptionsGreeks(paperOptions, liveOptions));
  }),
);

const killSwitchBody = z.object({ on: z.boolean() });
autotradeRouter.post(
  '/kill-switch',
  asyncHandler(async (req, res) => {
    const { on } = parseBody(killSwitchBody, req);
    const next = setAutotradeKillSwitch(on);
    logAutotradeEvent({
      stage: 'config',
      action: on ? 'kill_switch_engaged' : 'kill_switch_released',
      riskProfile: next.riskProfile,
    });
    // Best-effort, same reasoning as liveExecute.ts's live-order notification
    // — reuses the existing Slack/Discord/webhook infra rather than a new
    // path. Only the ENGAGE direction notifies (a deliberate emergency-halt
    // action worth knowing about away from the app); releasing it is the
    // safe direction and doesn't need a push.
    if (on) {
      await dispatchNotifications([
        { title: 'Autotrade', message: 'Autotrade kill switch ENGAGED — new entries halted.' },
      ]);
    }
    res.json(next);
  }),
);

// ---- Journal ----------------------------------------------------------------

const STAGES: [AutotradeStage, ...AutotradeStage[]] = ['screen', 'decision', 'risk_check', 'execution', 'config'];
const eventsQuery = z.object({
  stage: z.enum(STAGES).optional(),
  symbol: z.string().optional(),
  /** Comma-separated action names. With `since` below, this is what makes a
   *  multi-day read possible: the journal writes ~1000 rows every 8 hours, so
   *  an unfiltered read cannot reach yesterday, let alone a two-week window. */
  actions: z.string().optional(),
  /** Epoch ms; only events at or after it. */
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
/** Counts by ET date and action. The row endpoint below caps at 1000, which
 *  during market hours is ~3 hours of the busiest actions — so a multi-day
 *  distribution (what docs/OPTIONS_TUNING_PLAN.md decides on) is not reachable
 *  by paging rows and needs this instead. */
/** Which of the requested action names the journal has never recorded.
 *
 *  A filtered read returns nothing both when an action has genuinely never
 *  fired and when the caller mistyped its name — and on 2026-09-03 that
 *  ambiguity cost a real conclusion: months of checks for `live_stop_adjusted`
 *  read zero and were taken as "the ratchet never fires", when no code has ever
 *  emitted that name (the success event is `live_stop_ratcheted`, while the
 *  failures are live_stop_adjust_blocked/_failed — the verb changes between
 *  them). Reporting the never-seen names makes a zero say WHICH kind of zero it
 *  is, instead of leaving the caller to assume the flattering one.
 *
 *  Note it does not distinguish the two cases by itself — a real action that
 *  has genuinely never fired is also listed, which is exactly the other thing a
 *  caller must not silently read as a measured zero. Omitted entirely when
 *  every requested name has been seen, so a healthy response is unchanged. */
function neverSeen(list: string[] | undefined): { actionsNeverSeen?: string[] } {
  if (!list || list.length === 0) return {};
  const known = new Set(listKnownAutotradeEventActions());
  const missing = list.filter((a) => !known.has(a));
  return missing.length ? { actionsNeverSeen: missing } : {};
}

autotradeRouter.get(
  '/events/summary',
  asyncHandler(async (req, res) => {
    const { actions, limit: _limit, ...q } = parseQuery(eventsQuery, req);
    const list = actions
      ? actions
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined;
    res.json({
      summary: countAutotradeEventsByDay({ ...q, ...(list ? { actions: list } : {}) }),
      ...neverSeen(list),
    });
  }),
);

autotradeRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const { actions, ...q } = parseQuery(eventsQuery, req);
    const list = actions
      ? actions
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined;
    res.json({
      events: listAutotradeEvents({ ...q, ...(list ? { actions: list } : {}) }),
      ...neverSeen(list),
    });
  }),
);

// ---------------------------------------------------------------------------
// Re-arm a protective bracket on shares ALREADY HELD (2026-09-08).
//
// checkLiveBracketProtection's own alert says "check the broker and re-arm
// protection by hand" — and until now there was no hand to do it with. The
// no-MASTER standalone bracket existed in the provider
// (webullPlaceStandaloneBracket) but was reachable only from
// cancelReplaceBracket, behind a flag that is off. So the one action the
// naked-position alarm asks for could only be taken in Webull's own UI.
//
// Vendor-documented shape, quoted from Place Order:
//   "To sell and close an existing position with take-profit/stop-loss, submit
//    only STOP_PROFIT/STOP_LOSS sub-orders (side = SELL) grouped under the same
//    client_combo_order_id; no MASTER order is required in this scenario."
// and, on combo_type: "no MASTER order is required OR SUPPORTED in this
// scenario, since no new position is being opened."
//
// THE GUARD THAT MATTERS: quantity may not exceed the shares the BROKER says
// are held right now. A protective sell for more than you own is a naked short
// dressed as protection, and it is the one way this route could lose real
// money. Read fresh from the broker every call — a stale ledger is exactly how
// that mistake gets made.
// ---------------------------------------------------------------------------
const standaloneBracketBody = z.object({
  symbol: z.string().min(1).max(12),
  quantity: z.number().int().positive(),
  takeProfitPrice: z.number().positive().optional(),
  stopLossPrice: z.number().positive().optional(),
  /** Typed confirmation: the symbol itself, same posture as the other routes
   *  here that send real orders. */
  confirmation: z.string().min(1),
});

autotradeRouter.post(
  '/live/standalone-bracket',
  asyncHandler(async (req, res) => {
    const body = parseBody(standaloneBracketBody, req);
    const symbol = body.symbol.trim().toUpperCase();
    if (body.confirmation.trim().toUpperCase() !== symbol) {
      throw new HttpError(400, `Confirmation must be the symbol ("${symbol}").`);
    }
    // buildStandaloneBracketRequest returns null with neither price and the
    // caller must not read that as success — refuse here with a reason instead.
    if (body.takeProfitPrice === undefined && body.stopLossPrice === undefined) {
      throw new HttpError(400, 'At least one of takeProfitPrice / stopLossPrice is required.');
    }
    if (!config.trading.placeEnabled) throw new HttpError(400, 'Order placement is disabled (TRADING_PLACE_ENABLED).');
    const cfg = getAutotradeConfig();
    const accountId = cfg.liveAccountId;
    if (!accountId) throw new HttpError(400, 'No live account is configured.');

    const account = await webullAccountState(accountId, symbol);
    if (!account.ok) throw new HttpError(502, `Could not read the account: ${account.error ?? 'unknown'}`);
    const held = account.state?.currentPositionQty ?? 0;
    if (!(held > 0)) throw new HttpError(400, `The account holds no ${symbol} to protect (broker says ${held}).`);
    if (body.quantity > held) {
      throw new HttpError(
        400,
        `Refusing to protect ${body.quantity} ${symbol} against ${held} held — a protective sell larger than the position is a short, not protection.`,
      );
    }

    // HELD IS NOT THE BROKER'S BOUND. Shipped 2026-09-08 with the check above
    // and only that; the first real call — 1 share of FCX against 38 held —
    // was refused as a position reversal, because a full-size bracket was
    // already resting and the broker counts held MINUS committed. This guard
    // says so before the order leaves, with both numbers named, instead of
    // handing back a broker string that sounds like the position is wrong.
    // committedProtectiveQuantity carries the measurement and the two counting
    // rules it implies.
    const book = await listWebullOpenOrders(accountId);
    if (!book.ok) throw new HttpError(502, `Could not read resting orders: ${book.error ?? 'unknown'}`);
    // 'sell' because this route arms protection over a LONG — the intent below
    // is side 'buy' with openClose 'close', whose legs rest on the sell side.
    const committed = committedProtectiveQuantity(book.orders, symbol, 'sell');
    if (committed === null) {
      throw new HttpError(
        502,
        `A resting ${symbol} order carries no quantity, so the protected size cannot be computed. Refusing rather than guessing it low.`,
      );
    }
    const available = held - committed;
    if (body.quantity > available) {
      throw new HttpError(
        400,
        `Refusing to protect ${body.quantity} ${symbol}: ${held} held, ${committed} already committed to resting exits, ` +
          `so ${available} can be protected. The broker refuses the rest as a position reversal — cancel a resting leg first.`,
      );
    }

    const placed = await webullPlaceStandaloneBracket(
      accountId,
      {
        symbol,
        assetKind: 'stock',
        // The ENTRY side; bracketExit emits the legs on the closing side.
        side: 'buy',
        openClose: 'close',
        quantity: body.quantity,
        orderType: 'limit',
      },
      body.takeProfitPrice,
      body.stopLossPrice,
    );
    logAutotradeEvent({
      symbol,
      stage: 'execution',
      action: placed.ok ? 'live_bracket_rearmed' : 'live_bracket_rearm_failed',
      detail: {
        quantity: body.quantity,
        heldAtBroker: held,
        takeProfitPrice: body.takeProfitPrice ?? null,
        stopLossPrice: body.stopLossPrice ?? null,
        clientComboOrderId: placed.ok ? placed.clientComboOrderId : null,
        error: placed.ok ? null : (placed.error ?? null),
        ambiguous: placed.ok ? false : (placed.ambiguous ?? false),
      },
      riskProfile: cfg.riskProfile,
    });
    // The RAW broker payload is returned deliberately: this route exists partly
    // to answer questions the docs cannot, and a summarized response would lose
    // the combo ids that answer them.
    res.json({ heldAtBroker: held, ...placed });
  }),
);

// ---------------------------------------------------------------------------
// See and cancel what is actually resting at the broker (2026-09-08).
//
// The other half of the standalone-bracket route above. Two gaps it closes:
//
//  1. When the naked-position alarm says "check the broker", there was nothing
//     in this app to check it WITH — you had to open Webull. GET open-orders is
//     that read, returning the mapped legs with their comboOrderId so a
//     protective group can be told apart from a stray order.
//  2. A bracket you can place but not cancel is half a tool. The standalone
//     route could arm protection and nothing here could take it back.
//
// CANCELLING IS NOT GATED ON placeEnabled, deliberately. Placement is the
// direction that adds risk; cancelling is the direction that removes an order,
// and an operator who has just killed placement is exactly the operator who
// most needs to pull a resting order. Gating it behind the same switch would
// disarm the brake along with the accelerator.
//
// BUT IT CAN LEAVE A POSITION NAKED. Cancelling a STOP_LOSS leg removes the
// protection on live shares — the state checkLiveBracketProtection alarms on.
// So it takes the client order id as its own typed confirmation (no fat-finger
// path from a symbol name to a specific leg) and journals every attempt.
// ---------------------------------------------------------------------------
autotradeRouter.get(
  '/live/open-orders',
  asyncHandler(async (_req, res) => {
    const cfg = getAutotradeConfig();
    const accountId = cfg.liveAccountId;
    if (!accountId) throw new HttpError(400, 'No live account is configured.');
    const open = await listWebullOpenOrders(accountId);
    if (!open.ok) throw new HttpError(502, `Could not read open orders: ${open.error ?? 'unknown'}`);
    // Grouped by comboOrderId as well as listed flat: "how many distinct combo
    // groups rest on this symbol" is the question this endpoint exists to
    // answer, and counting it here beats every caller re-deriving it.
    const byCombo = new Map<string, number>();
    for (const o of open.orders) {
      const key = o.comboOrderId ?? '(none)';
      byCombo.set(key, (byCombo.get(key) ?? 0) + 1);
    }
    res.json({
      count: open.orders.length,
      comboGroups: [...byCombo].map(([comboOrderId, legs]) => ({ comboOrderId, legs })),
      orders: open.orders,
    });
  }),
);

// ---------------------------------------------------------------------------
// WHAT DOES THE BROKER ACTUALLY HOLD? (2026-09-08)
//
// There was no read-only way to ask. The question came up three times in one
// session — an adopted SMCI position, the FCX bracket probe, and a NOK
// scale-out whose remainder looked naked — and each time the answer had to be
// INFERRED from a side effect: a position_reconcile_skipped detail, or the
// refusal message of the standalone-bracket route.
//
// Using an ORDER PLACEMENT endpoint as a read is the wrong shape and it showed:
// the probe that finally answered the NOK question was a deliberately oversized
// protective order, sent only so its own guard would refuse it and name the
// held quantity. That is a read dressed as a write, and it deserved the
// suspicion it got.
//
// It also matters for a specific, recurring confusion: zero resting exit legs
// looks identical whether a stop was never accepted or has just FILLED. The
// held quantity is what separates them (see checkLiveBracketProtection), and
// until now nothing could ask it directly.
//
// WRITES NOTHING. previewWebullPositions fetches /openapi/assets/positions and
// maps it; the import path is a different call.
autotradeRouter.get(
  '/live/holdings',
  asyncHandler(async (req, res) => {
    const cfg = getAutotradeConfig();
    const accountId = cfg.liveAccountId;
    if (!accountId) throw new HttpError(400, 'No live account is configured.');
    const preview = await previewWebullPositions(accountId);
    if (!preview.ok) throw new HttpError(502, `Could not read holdings: ${preview.error ?? 'unknown'}`);

    // Equities only for the quantity roll-up: an option row's "quantity" is
    // contracts on a specific contract, so summing it next to share counts
    // would produce a number that means nothing.
    const holdings = new Map<string, number>();
    for (const p of preview.positions) {
      if (p.assetType !== 'stock') continue;
      const sym = p.symbol.toUpperCase();
      const signed = p.side === 'short' ? -p.quantity : p.quantity;
      holdings.set(sym, (holdings.get(sym) ?? 0) + signed);
    }
    // A row the mapper could not parse still PROVES the broker holds something
    // in that symbol. Reporting such a symbol as "not held" would be exactly
    // the false negative this endpoint exists to prevent, so it is surfaced
    // separately and callers must treat it as "held, quantity unknown" — never
    // as zero. The same reasoning already governs the close-detector's freeze
    // list; see PositionsPreview.unmappedSymbols.
    const unknown = preview.unmappedSymbols.map((s) => s.toUpperCase());

    const wanted = typeof req.query.symbol === 'string' ? req.query.symbol.trim().toUpperCase() : null;
    if (wanted) {
      const isUnknown = unknown.includes(wanted);
      res.json({
        accountId,
        symbol: wanted,
        quantity: holdings.get(wanted) ?? 0,
        // false means DO NOT trust the quantity: the broker returned a row for
        // this symbol that could not be mapped.
        known: !isUnknown,
        unmapped: preview.unmapped,
      });
      return;
    }
    res.json({
      accountId,
      holdings: [...holdings]
        .map(([symbol, quantity]) => ({ symbol, quantity }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      /** Symbols the broker reported but the mapper could not parse. Held,
       *  quantity unknown — NOT zero. */
      unknownSymbols: unknown,
      unmapped: preview.unmapped,
    });
  }),
);

const cancelOrderBody = z.object({
  clientOrderId: z.string().min(1).max(64),
  /** The client order id again. Not the symbol: a symbol would let a slip cancel
   *  the wrong leg of the right stock, which is how a stop gets pulled by
   *  accident. */
  confirmation: z.string().min(1).max(64),
});

autotradeRouter.post(
  '/live/cancel-order',
  asyncHandler(async (req, res) => {
    const body = parseBody(cancelOrderBody, req);
    if (body.confirmation.trim() !== body.clientOrderId.trim()) {
      throw new HttpError(400, 'Confirmation must repeat the clientOrderId exactly.');
    }
    const cfg = getAutotradeConfig();
    const accountId = cfg.liveAccountId;
    if (!accountId) throw new HttpError(400, 'No live account is configured.');
    const result = await webullCancelOrder(accountId, body.clientOrderId.trim());
    logAutotradeEvent({
      stage: 'execution',
      action: result.ok ? 'live_order_cancelled_by_hand' : 'live_order_cancel_by_hand_failed',
      detail: {
        clientOrderId: body.clientOrderId.trim(),
        error: result.ok ? null : (result.error ?? null),
        note: result.ok
          ? 'Cancelled through the manual route. If this was a STOP_LOSS leg the position is now unprotected.'
          : null,
      },
      riskProfile: cfg.riskProfile,
    });
    res.json(result);
  }),
);
