import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody, parseQuery } from './_helpers';
import {
  AutotradeConfig,
  getAutotradeConfig,
  setAutotradeConfig,
  setAutotradeKillSwitch,
  LIVE_TRADING_CONFIRMATION_PHRASE,
} from '../db/autotradeConfig';
import { addExclusion, listExclusions, removeExclusion } from '../db/autotradeExclusions';
import { AutotradeStage, listAutotradeEvents, logAutotradeEvent } from '../db/autotradeEvents';
import { runAutotradeScreen } from '../services/autotrading/screen';
import { DecisionConfig, runAutotradeDecision } from '../services/autotrading/decide';
import { OptionsDecisionConfig, runOptionsDecision } from '../services/autotrading/optionsDecide';
import { runAutotradeRiskCheck } from '../services/autotrading/riskCheck';
import { runOptionsRiskCheck } from '../services/autotrading/optionsRiskCheck';
import { ScreenerConfig } from '../indicators/screener';
import { computeBacktestStats, runBacktest, runWalkForwardBacktest } from '../services/autotrading/backtest';
import { runOptionsBacktest, runOptionsWalkForwardBacktest } from '../services/autotrading/optionsBacktest';
import { runCombinedBacktest, runCombinedWalkForwardBacktest } from '../services/autotrading/combinedBacktest';
import { listPaperPositions, PaperPosition } from '../db/autotradePaperPositions';
import { listOptionsPaperPositions, OptionsPaperPosition } from '../db/autotradeOptionsPaperPositions';
import { listAutotradeLivePositions, syncAccountEquityFromBroker } from '../services/autotrading/liveExecute';
import { listLiveOptionsPositions, LiveOptionsPosition } from '../db/autotradeLiveOptionsPositions';
import { Position } from '../db/positions';
import { runAutotradeLoopTick } from '../services/autotrading/loop';
import { getAutotradeDashboard } from '../services/autotrading/dashboard';
import { resolveStockPrices, priceMap } from '../services/quotes';
import {
  computePaperUnrealizedPnl,
  computeOptionsPaperUnrealizedPnl,
  computePositionPnl,
  PositionPnl,
} from '../services/pnl';
import { getProvider } from '../providers';
import { dispatchNotifications } from '../services/notifier';

export const autotradeRouter = Router();

// ---- Config: master enable + risk profile ---------------------------------

autotradeRouter.get('/config', (_req, res) => {
  res.json(getAutotradeConfig());
});

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
  liveMaxDailyLossUsd: z.number().nonnegative().optional(),
  liveMaxOrdersPerDay: z.number().int().nonnegative().optional(),
  liveFatFingerPct: z.number().min(0).max(100).optional(),
  liveAllowNakedShort: z.boolean().optional(),
  liveProbationTrades: z.number().int().nonnegative().optional(),
  liveProbationSizeMultiplier: z.number().positive().max(1).optional(),
  // --- Task #70: live options trading ----------------------------------------
  /** Nested under liveTradingEnabled — no separate typed confirmation (the
   *  master phrase already covers "real money is now live"); see route
   *  handler for the fails-closed "master must be on" gate. */
  liveOptionsEnabled: z.boolean().optional(),
  liveOptionsMaxOrderUsd: z.number().nonnegative().optional(),
  liveOptionsMaxDailyLossUsd: z.number().nonnegative().optional(),
  liveOptionsMaxOrdersPerDay: z.number().int().nonnegative().optional(),
  liveOptionsFatFingerPct: z.number().min(0).max(100).optional(),
  liveOptionsProbationTrades: z.number().int().nonnegative().optional(),
  liveOptionsProbationSizeMultiplier: z.number().positive().max(1).optional(),
  // --- Options strategy shape -------------------------------------------------
  optionsStrategyType: z.enum(['single_leg', 'debit_spread']).optional(),
});
autotradeRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    const body = parseBody(configBody, req);
    if (body.riskProfile === 'AGGRESSIVE' && body.confirmAggressive !== true) {
      throw new HttpError(400, 'Switching to AGGRESSIVE requires explicit confirmation (confirmAggressive: true)');
    }
    const before = getAutotradeConfig();

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
    if (body.liveMaxOrderUsd !== undefined) patch.liveMaxOrderUsd = body.liveMaxOrderUsd;
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
    if (body.liveOptionsFatFingerPct !== undefined) patch.liveOptionsFatFingerPct = body.liveOptionsFatFingerPct;
    if (body.liveOptionsProbationTrades !== undefined) {
      patch.liveOptionsProbationTrades = body.liveOptionsProbationTrades;
    }
    if (body.liveOptionsProbationSizeMultiplier !== undefined) {
      patch.liveOptionsProbationSizeMultiplier = body.liveOptionsProbationSizeMultiplier;
    }
    if (body.optionsStrategyType !== undefined) patch.optionsStrategyType = body.optionsStrategyType;

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
      const accountId = body.liveAccountId !== undefined ? body.liveAccountId : before.liveAccountId;
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
    const masterWillBeEnabled = enablingNow || before.liveTradingEnabled;
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

// ---- Research & Screen ------------------------------------------------------

const screenBody = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(z.string().min(1)).optional(),
});
autotradeRouter.post(
  '/screen',
  asyncHandler(async (req, res) => {
    const body = parseBody(screenBody, req);
    const result = await runAutotradeScreen({
      config: body.config as Partial<ScreenerConfig> | undefined,
      symbols: body.symbols,
    });
    res.json(result);
  }),
);

// ---- Decision ---------------------------------------------------------------

const decideBody = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(z.string().min(1)).optional(),
  decision: z
    .object({
      direction: z.enum(['long', 'short']).optional(),
      stopAtrMultiple: z.number().positive().optional(),
      targetRMultiple: z.number().positive().optional(),
    })
    .optional(),
});
autotradeRouter.post(
  '/decide',
  asyncHandler(async (req, res) => {
    const body = parseBody(decideBody, req);
    const screen = await runAutotradeScreen({
      config: body.config as Partial<ScreenerConfig> | undefined,
      symbols: body.symbols,
    });
    const decision = runAutotradeDecision(screen.candidates, body.decision as Partial<DecisionConfig> | undefined);
    const optionsDecision = await runOptionsDecision(screen.candidates, {
      strategyType: getAutotradeConfig().optionsStrategyType,
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
const backtestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50, 'At most 50 symbols per backtest run'),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
  maxConcurrentPositions: z.number().int().min(1),
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  decisionConfig: z.record(z.string(), z.unknown()).optional(),
});
const backtestBody = backtestBodyBase.refine((b) => b.from <= b.to, {
  message: 'from must be on or before to',
  path: ['from'],
});
const walkForwardBody = backtestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
    });
    res.json({
      inSample: { report: wf.inSample, stats: computeBacktestStats(wf.inSample) },
      outOfSample: { report: wf.outOfSample, stats: computeBacktestStats(wf.outOfSample) },
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
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  optionsDecisionConfig: z.record(z.string(), z.unknown()).optional(),
});
const optionsBacktestBody = optionsBacktestBodyBase.refine((b) => b.from <= b.to, {
  message: 'from must be on or before to',
  path: ['from'],
});
const optionsWalkForwardBody = optionsBacktestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
    });
    res.json({
      inSample: { report: wf.inSample, stats: computeBacktestStats(wf.inSample) },
      outOfSample: { report: wf.outOfSample, stats: computeBacktestStats(wf.outOfSample) },
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

const combinedBacktestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50, 'At most 50 symbols per backtest run'),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
  maxConcurrentPositions: z.number().int().min(1),
  screenerConfig: z.record(z.string(), z.unknown()).optional(),
  decisionConfig: z.record(z.string(), z.unknown()).optional(),
  optionsDecisionConfig: z.record(z.string(), z.unknown()).optional(),
});
const combinedBacktestBody = combinedBacktestBodyBase.refine((b) => b.from <= b.to, {
  message: 'from must be on or before to',
  path: ['from'],
});
const combinedWalkForwardBody = combinedBacktestBodyBase
  .extend({ splitDate: dateStr })
  .refine((b) => b.from <= b.splitDate && b.splitDate < b.to, {
    message: 'splitDate must fall between from and to, leaving a non-empty out-of-sample window',
    path: ['splitDate'],
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
      optionsDecisionConfig: body.optionsDecisionConfig as Partial<OptionsDecisionConfig> | undefined,
    });
    res.json({
      inSample: { report: wf.inSample, stats: combinedStats(wf.inSample) },
      outOfSample: { report: wf.outOfSample, stats: combinedStats(wf.outOfSample) },
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
          }
        } catch {
          for (const p of members) {
            marks.set(p.id, null);
            if (p.kind === 'debit_spread') shortMarks.set(p.id, null);
          }
        }
      }),
    );
  }
  return positions.map((p) => {
    const currentPrice = p.status === 'open' ? (marks.get(p.id) ?? null) : null;
    const shortCurrentPrice = p.status === 'open' && p.kind === 'debit_spread' ? (shortMarks.get(p.id) ?? null) : null;
    return {
      ...p,
      currentPrice,
      shortCurrentPrice,
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
          }
        } catch {
          for (const p of members) {
            marks.set(p.id, null);
            if (p.kind === 'debit_spread') shortMarks.set(p.id, null);
          }
        }
      }),
    );
  }
  return positions.map((p) => {
    const currentPrice = p.status === 'open' ? (marks.get(p.id) ?? null) : null;
    const shortCurrentPrice = p.status === 'open' && p.kind === 'debit_spread' ? (shortMarks.get(p.id) ?? null) : null;
    return {
      ...p,
      currentPrice,
      shortCurrentPrice,
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
}

/** Enrich real autotrade-placed positions with a live price/mark + full P&L —
 *  reuses services/quotes.ts's priceMap() (shared with routes/positions.ts,
 *  the human's own book) rather than a second stock/option price-resolution
 *  implementation. */
async function withLivePositionPnl(positions: Position[]): Promise<AutotradeLivePositionLive[]> {
  const prices = await priceMap(positions);
  return positions.map((p) => {
    const info = prices.get(p.id) ?? { price: null, stale: false, asOf: null };
    return { ...p, currentPrice: info.price, stale: info.stale, pnl: computePositionPnl(p, info.price) };
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
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
autotradeRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const q = parseQuery(eventsQuery, req);
    res.json({ events: listAutotradeEvents(q) });
  }),
);
