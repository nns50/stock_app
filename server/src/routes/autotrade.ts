import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody, parseQuery } from './_helpers';
import { getAutotradeConfig, setAutotradeConfig } from '../db/autotradeConfig';
import { addExclusion, listExclusions, removeExclusion } from '../db/autotradeExclusions';
import { AutotradeStage, listAutotradeEvents, logAutotradeEvent } from '../db/autotradeEvents';
import { runAutotradeScreen } from '../services/autotrading/screen';
import { DecisionConfig, runAutotradeDecision } from '../services/autotrading/decide';
import { runAutotradeRiskCheck } from '../services/autotrading/riskCheck';
import { ScreenerConfig } from '../indicators/screener';
import { computeBacktestStats, runBacktest, runWalkForwardBacktest } from '../services/autotrading/backtest';

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
});
autotradeRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    const body = parseBody(configBody, req);
    if (body.riskProfile === 'AGGRESSIVE' && body.confirmAggressive !== true) {
      throw new HttpError(400, 'Switching to AGGRESSIVE requires explicit confirmation (confirmAggressive: true)');
    }
    const before = getAutotradeConfig();
    const next = setAutotradeConfig({
      enabled: body.enabled,
      riskProfile: body.riskProfile,
      accountEquityUsd: body.accountEquityUsd,
    });
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
    res.json(next);
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
    res.json({ screen, decision });
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

// ---- Backtesting & walk-forward (the validation gate) -----------------------

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const backtestBodyBase = z.object({
  symbols: z.array(z.string().min(1)).min(1),
  from: dateStr,
  to: dateStr,
  riskProfile: z.enum(['MODERATE', 'AGGRESSIVE']),
  startingEquity: z.number().positive(),
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
      screenerConfig: body.screenerConfig as Partial<ScreenerConfig> | undefined,
      decisionConfig: body.decisionConfig as Partial<DecisionConfig> | undefined,
    });
    res.json({
      inSample: { report: wf.inSample, stats: computeBacktestStats(wf.inSample) },
      outOfSample: { report: wf.outOfSample, stats: computeBacktestStats(wf.outOfSample) },
      excludedSymbols: wf.excludedSymbols,
    });
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
