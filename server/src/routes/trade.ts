import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { asyncHandler, parseBody, param } from './_helpers';
import { getTradingConfig, setKillSwitch, setTradingConfig } from '../db/trading';
import { getEvents, listIntents } from '../db/orders';
import { dryRunOrder } from '../services/trading/dryRun';
import type { AccountState, OrderIntent } from '../services/trading/guardrails';

// Live-trading endpoints (design §6/§7). Session-gated (mounted after the auth
// middleware). NOTHING here submits an order — `dry-run` validates + audits an
// order and stops; config/kill-switch persist the guardrail settings. The live
// submit path is a later, env-gated phase.
export const tradeRouter = Router();

tradeRouter.get('/config', (_req, res) => res.json(getTradingConfig()));

const configPatch = z.object({
  enabled: z.boolean().optional(),
  killSwitch: z.boolean().optional(),
  maxOrderUsd: z.number().min(0).optional(),
  maxSymbolPositionQty: z.number().min(0).optional(),
  maxExposureUsd: z.number().min(0).optional(),
  maxOrdersPerDay: z.number().min(0).optional(),
  maxDailyLossUsd: z.number().min(0).optional(),
  fatFingerPct: z.number().min(0).max(100).optional(),
  allowNakedShort: z.boolean().optional(),
});
tradeRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    res.json(setTradingConfig(parseBody(configPatch, req)));
  }),
);

tradeRouter.post(
  '/kill-switch',
  asyncHandler(async (req, res) => {
    const { on } = parseBody(z.object({ on: z.boolean() }), req);
    res.json(setKillSwitch(on));
  }),
);

const intentSchema = z.object({
  symbol: z.string().min(1).max(24),
  assetKind: z.enum(['stock', 'option']),
  side: z.enum(['buy', 'sell']),
  openClose: z.enum(['open', 'close']),
  quantity: z.number(),
  orderType: z.enum(['market', 'limit']),
  limitPrice: z.number().optional(),
  referencePrice: z.number().optional(),
  optionType: z.enum(['call', 'put']).optional(),
  strike: z.number().optional(),
  expiration: z.string().optional(),
  multiplier: z.number().optional(),
});
const accountSchema = z.object({
  buyingPowerUsd: z.number(),
  exposureUsd: z.number(),
  realizedPnlTodayUsd: z.number(),
  ordersToday: z.number(),
  currentPositionQty: z.number(),
});
const dryRunBody = z.object({
  intent: intentSchema,
  account: accountSchema,
  idempotencyKey: z.string().min(1).max(64).optional(),
});

// Validate + audit an order without submitting it. Never calls a broker.
tradeRouter.post(
  '/dry-run',
  asyncHandler(async (req, res) => {
    const { intent, account, idempotencyKey } = parseBody(dryRunBody, req);
    res.json(dryRunOrder(intent as OrderIntent, account as AccountState, idempotencyKey ?? randomUUID()));
  }),
);

// Recent intents + an intent's audit trail (the dry-run history).
tradeRouter.get('/intents', (_req, res) => res.json({ intents: listIntents().slice(0, 50) }));
tradeRouter.get(
  '/intents/:id/events',
  asyncHandler(async (req, res) => {
    res.json({ events: getEvents(Number(param(req, 'id'))) });
  }),
);
