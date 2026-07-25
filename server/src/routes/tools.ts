import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from './_helpers';
import { computeRiskSizing, computeSpreadSizing } from '../services/riskSizing';
import { analyzeStrategy } from '../options/optionStrategy';
import { analyzeRoll } from '../options/optionRoll';
import { normalizeRuinParams, simulateRiskOfRuin } from '../services/riskOfRuin';

export const toolsRouter = Router();

const ruinBody = z.object({
  winRate: z.number().optional(),
  payoffRatio: z.number().optional(),
  riskPct: z.number().optional(),
  ruinThresholdPct: z.number().optional(),
  trades: z.number().optional(),
  sims: z.number().optional(),
});

toolsRouter.post(
  '/risk-of-ruin',
  asyncHandler(async (req, res) => {
    const params = normalizeRuinParams(parseBody(ruinBody, req));
    res.json({ params, result: simulateRiskOfRuin(params) });
  }),
);

const sizeBody = z.object({
  accountSize: z.number().positive(),
  riskPct: z.number().positive().max(100),
  entryPrice: z.number().positive(),
  stopPrice: z.number().nonnegative(),
  assetType: z.enum(['stock', 'option']),
  side: z.enum(['long', 'short']).optional(),
  multiplier: z.number().int().positive().optional(),
  targetRMultiple: z.number().positive().optional(),
});

toolsRouter.post(
  '/position-size',
  asyncHandler(async (req, res) => {
    const body = parseBody(sizeBody, req);
    res.json(computeRiskSizing(body));
  }),
);

// Size a defined-risk vertical spread by its capped max loss (no price stop).
const spreadSizeBody = z.object({
  accountSize: z.number().positive(),
  riskPct: z.number().positive().max(100),
  width: z.number().positive(),
  netPremium: z.number().nonnegative(),
  direction: z.enum(['debit', 'credit']),
  multiplier: z.number().int().positive().optional(),
});

toolsRouter.post(
  '/spread-size',
  asyncHandler(async (req, res) => {
    res.json(computeSpreadSizing(parseBody(spreadSizeBody, req)));
  }),
);

const strategyBody = z.object({
  underlyingPrice: z.number().positive(),
  dte: z.number().nonnegative(),
  riskFreeRate: z.number().optional(),
  ivForPop: z.number().positive().optional(),
  legs: z
    .array(
      z.object({
        type: z.enum(['call', 'put']),
        action: z.enum(['buy', 'sell']),
        strike: z.number().positive(),
        quantity: z.number().positive(),
        premium: z.number().nonnegative(),
        iv: z.number().positive().optional(),
      }),
    )
    .min(1)
    .max(8),
});

toolsRouter.post(
  '/strategy',
  asyncHandler(async (req, res) => {
    res.json(analyzeStrategy(parseBody(strategyBody, req)));
  }),
);

const rollLegBody = z.object({
  optionType: z.enum(['call', 'put']),
  strike: z.number().positive(),
  dte: z.number().nonnegative(),
  premium: z.number().nonnegative(),
  iv: z.number().positive().optional(),
});

const rollBody = z.object({
  side: z.enum(['long', 'short']),
  quantity: z.number().positive(),
  underlyingPrice: z.number().positive(),
  riskFreeRate: z.number().optional(),
  current: rollLegBody,
  target: rollLegBody,
});

toolsRouter.post(
  '/roll',
  asyncHandler(async (req, res) => {
    res.json(analyzeRoll(parseBody(rollBody, req)));
  }),
);
