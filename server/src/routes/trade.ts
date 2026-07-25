import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { asyncHandler, parseBody, parseQuery, param } from './_helpers';
import { getTradingConfig, setKillSwitch, setTradingConfig } from '../db/trading';
import { getEvents, listIntents } from '../db/orders';
import { dryRunOrder } from '../services/trading/dryRun';
import { livePreview } from '../services/trading/livePreview';
import { placeOrder } from '../services/trading/placeOrder';
import { reconcileAllWorking, reconcileIntent } from '../services/trading/reconcile';
import { cancelIntent } from '../services/trading/cancelOrder';
import { replaceIntent } from '../services/trading/replaceOrder';
import { webullAccountState } from '../providers/webull/accountState';
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
  orderType: z.enum(['market', 'limit', 'stop_loss', 'stop_loss_limit']),
  session: z.enum(['core', 'extended', 'overnight']).optional(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
  bracket: z.object({ takeProfitPrice: z.number().optional(), stopLossPrice: z.number().optional() }).optional(),
  referencePrice: z.number().optional(),
  optionType: z.enum(['call', 'put']).optional(),
  strike: z.number().optional(),
  expiration: z.string().optional(),
  multiplier: z.number().optional(),
  optionStrategy: z.enum(['SINGLE', 'VERTICAL', 'COVERED', 'IRON_CONDOR']).optional(),
  optionLegs: z
    .array(
      z.object({
        side: z.enum(['buy', 'sell']),
        optionType: z.enum(['call', 'put']),
        strike: z.number(),
        expiration: z.string(),
      }),
    )
    .optional(),
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

// Live pre-submit check: real account-state → guardrails → broker cost estimate
// (only if guardrails pass). PLACES NOTHING — /openapi/trade/order/preview is an
// estimate. The Place step is a separate, env-gated slice.
const previewBody = z.object({
  intent: intentSchema,
  accountId: z.string().min(1).max(64),
});
tradeRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const { intent, accountId } = parseBody(previewBody, req);
    res.json(await livePreview(intent as OrderIntent, accountId));
  }),
);

// PLACE a live order (stock or single-leg option) — the only endpoint that can
// move real money. Gated by TRADING_ENABLED (server env) + a type-to-confirm
// phrase + the guardrails (re-run server-side against fresh account state) + kill switch.
const placeBody = z.object({
  intent: intentSchema,
  accountId: z.string().min(1).max(64),
  confirmation: z.string().min(1).max(64),
  // Optional idempotency key: a repeated /place with the same key never submits
  // a second live order (double-click / retry / proxy replay safety).
  idempotencyKey: z.string().min(1).max(64).optional(),
});
tradeRouter.post(
  '/place',
  asyncHandler(async (req, res) => {
    const { intent, accountId, confirmation, idempotencyKey } = parseBody(placeBody, req);
    res.json(await placeOrder(intent as OrderIntent, accountId, confirmation, idempotencyKey));
  }),
);

// Live account-state for the guardrails (read-only): real buying power /
// exposure / day P&L from the cash account, and the signed position in `symbol`.
// Places nothing.
const accountStateQuery = z.object({
  accountId: z.string().min(1).max(64),
  symbol: z.string().max(24).optional(),
});
tradeRouter.get(
  '/account-state',
  asyncHandler(async (req, res) => {
    const { accountId, symbol } = parseQuery(accountStateQuery, req);
    res.json(await webullAccountState(accountId, symbol));
  }),
);

// Recent intents + an intent's audit trail (the dry-run / order history).
tradeRouter.get('/intents', (_req, res) => res.json({ intents: listIntents().slice(0, 50) }));
tradeRouter.get(
  '/intents/:id/events',
  asyncHandler(async (req, res) => {
    res.json({ events: getEvents(Number(param(req, 'id'))) });
  }),
);

// Reconcile a live intent's state with the broker (read-only pull by
// client_order_id): advances acknowledged → filled / partially_filled /
// cancelled / expired and audits the change. Places/cancels nothing.
const reconcileBody = z.object({ accountId: z.string().min(1).max(64) });
tradeRouter.post(
  '/intents/:id/reconcile',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(reconcileBody, req);
    res.json(await reconcileIntent(Number(param(req, 'id')), accountId));
  }),
);

// Reconcile every still-working order in one pass (the "Refresh all" action).
tradeRouter.post(
  '/intents/reconcile-all',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(reconcileBody, req);
    res.json(await reconcileAllWorking(accountId));
  }),
);

// Cancel a live order. Risk-reducing, so NOT gated by TRADING_ENABLED — it only
// acts on orders that reached the broker and are still cancellable, then
// reconciles to record the resulting terminal state.
tradeRouter.post(
  '/intents/:id/cancel',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(reconcileBody, req);
    res.json(await cancelIntent(Number(param(req, 'id')), accountId));
  }),
);

// Replace (modify) a still-open order's quantity / limit / stop price. Gated like
// placing (TRADING_ENABLED + guardrails on the modified order), since it can
// increase exposure.
const replaceBody = z.object({
  accountId: z.string().min(1).max(64),
  patch: z
    .object({
      quantity: z.number().optional(),
      limitPrice: z.number().optional(),
      stopPrice: z.number().optional(),
    })
    .refine((p) => p.quantity !== undefined || p.limitPrice !== undefined || p.stopPrice !== undefined, {
      message: 'patch must change at least one of quantity / limitPrice / stopPrice',
    }),
});
tradeRouter.post(
  '/intents/:id/replace',
  asyncHandler(async (req, res) => {
    const { accountId, patch } = parseBody(replaceBody, req);
    res.json(await replaceIntent(Number(param(req, 'id')), accountId, patch));
  }),
);
