import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { AlertInput, AlertPatch, AlertPlan, createAlert, deleteAlert, listAlerts, updateAlert } from '../db/alerts';
import { runAlertEvaluation } from '../services/alertRun';
import { dispatchNotifications, notificationStatus } from '../services/notifier';
import { getSchedulerConfig, MIN_INTERVAL_SECONDS, setSchedulerConfig } from '../services/alertScheduler';
import { suggestedExitText } from '../services/optionAlertPlan';
import { defaultExitConfig, ExitRulesConfig } from '../options/exitRules';
import { getSetting } from '../db/settings';

export const alertsRouter = Router();

// Symbol/underlying metrics vs. option-contract metrics. `price` (underlying)
// is valid for both. Validated here at the edge; the DB stores `kind` freely.
const STOCK_KINDS = ['price', 'change', 'relvol', 'rsi', 'macross', 'high52', 'low52'] as const;
const OPTION_KINDS = ['price', 'optmark', 'optbid', 'optask', 'optdelta', 'optiv'] as const;
const ALL_KINDS = [...new Set([...STOCK_KINDS, ...OPTION_KINDS])] as [string, ...string[]];

const planObject = z.object({
  entry: z.string().max(2000).nullish(),
  exit: z.string().max(2000).nullish(),
  suggestedExit: z.string().max(2000).nullish(),
});

const createBody = z
  .object({
    symbol: z.string().min(1),
    assetType: z.enum(['stock', 'option']).default('stock'),
    kind: z.enum(ALL_KINDS),
    operator: z.enum(['above', 'below']),
    threshold: z.number(),
    optionType: z.enum(['call', 'put']).optional(),
    strike: z.number().positive().optional(),
    expiration: z.string().min(8).optional(),
    role: z.enum(['entry', 'exit']).optional(),
    plan: planObject.optional(),
    note: z.string().max(200).optional(),
  })
  .superRefine((b, ctx) => {
    const require = (cond: boolean, message: string, path: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    };
    if (b.assetType === 'option') {
      require(!!b.optionType, 'optionType is required for option alerts', 'optionType');
      require(b.strike !== undefined, 'strike is required for option alerts', 'strike');
      require(!!b.expiration, 'expiration is required for option alerts', 'expiration');
      require(!!b.role, 'role is required for option alerts', 'role');
      require((OPTION_KINDS as readonly string[]).includes(
        b.kind,
      ), `kind "${b.kind}" is not valid for option alerts`, 'kind');
    } else {
      require((STOCK_KINDS as readonly string[]).includes(
        b.kind,
      ), `kind "${b.kind}" is not valid for stock alerts`, 'kind');
    }
  });

type CreateBody = z.infer<typeof createBody>;

/** Merged exit-rules config: engine defaults overlaid with the user's setting. */
function exitConfig(): ExitRulesConfig {
  return { ...defaultExitConfig(), ...(getSetting<ExitRulesConfig>('optionExitConfig') ?? {}) };
}

/** Build the DB input, attaching an auto-suggested exit to option entry alerts. */
function toAlertInput(b: CreateBody): AlertInput {
  let plan: AlertPlan | null = b.plan
    ? { entry: b.plan.entry ?? null, exit: b.plan.exit ?? null, suggestedExit: b.plan.suggestedExit ?? null }
    : null;
  if (b.assetType === 'option' && b.role === 'entry') {
    const suggestedExit = plan?.suggestedExit || suggestedExitText(b.expiration ?? null, exitConfig());
    plan = { ...(plan ?? {}), suggestedExit };
  }
  return {
    symbol: b.symbol,
    assetType: b.assetType,
    kind: b.kind as AlertInput['kind'],
    operator: b.operator,
    threshold: b.threshold,
    optionType: b.optionType ?? null,
    strike: b.strike ?? null,
    expiration: b.expiration ?? null,
    role: b.role ?? null,
    plan,
    note: b.note ?? null,
  };
}

alertsRouter.get('/', (_req, res) => {
  res.json({ alerts: listAlerts() });
});

alertsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    res.status(201).json(createAlert(toAlertInput(parseBody(createBody, req))));
  }),
);

const patchBody = z.object({
  threshold: z.number().optional(),
  note: z.string().nullable().optional(),
  plan: planObject.nullable().optional(),
  enabled: z.boolean().optional(),
  triggered: z.boolean().optional(),
});

alertsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(patchBody, req);
    const patch: AlertPatch = {
      threshold: body.threshold,
      note: body.note,
      enabled: body.enabled,
      triggered: body.triggered,
    };
    if (body.plan !== undefined) patch.plan = body.plan as AlertPlan | null;
    const updated = updateAlert(Number(req.params.id), patch);
    if (!updated) throw new HttpError(404, 'alert not found');
    res.json(updated);
  }),
);

alertsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!deleteAlert(Number(req.params.id))) throw new HttpError(404, 'alert not found');
    res.json({ deleted: Number(req.params.id) });
  }),
);

// Evaluate all enabled alerts against current data; persist one-shot triggers.
alertsRouter.post(
  '/evaluate',
  asyncHandler(async (_req, res) => {
    res.json(await runAlertEvaluation());
  }),
);

// ---- Background watching: server-side poller + webhook notifications --------

/** Channel status + the poller's enable/interval (no secrets). */
alertsRouter.get('/notifications', (_req, res) => {
  res.json({ ...notificationStatus(), scheduler: getSchedulerConfig() });
});

const schedulerBody = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(86400).optional(),
});
alertsRouter.put(
  '/scheduler',
  asyncHandler(async (req, res) => {
    res.json(setSchedulerConfig(parseBody(schedulerBody, req)));
  }),
);

/** Send a test notification to verify the webhook is wired up. */
alertsRouter.post(
  '/notifications/test',
  asyncHandler(async (_req, res) => {
    const result = await dispatchNotifications([
      { title: 'Test', message: 'Test alert from your stock app — webhook is working.' },
    ]);
    res.json(result);
  }),
);
