import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import {
  Alert,
  AlertInput,
  AlertPatch,
  AlertPlan,
  applyEvaluation,
  createAlert,
  deleteAlert,
  listAlerts,
  updateAlert,
} from '../db/alerts';
import { AlertMetrics, evaluateAlert } from '../services/alertEngine';
import { evaluateOpenPositionExits } from '../services/positionExits';
import { getProvider } from '../providers';
import {
  computeCandleMetrics,
  CandleMetrics,
  OptionContractMetrics,
  optionContractMetrics,
} from '../services/alertMetrics';
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

/** Human descriptor for an alert's message — bare symbol, or a contract. */
function alertSubject(a: Alert): string {
  if (a.assetType === 'option' && a.optionType && a.strike != null) {
    const cp = a.optionType === 'call' ? 'C' : 'P';
    return `${a.symbol.toUpperCase()} ${a.strike}${cp}${a.expiration ? ' ' + a.expiration : ''}`;
  }
  return a.symbol.toUpperCase();
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
    const alerts = listAlerts(true);
    const symbols = Array.from(new Set(alerts.map((a) => a.symbol.toUpperCase())));
    const provider = getProvider();

    const quotes = new Map<string, any>();
    try {
      const fetched = provider.getQuotes
        ? await provider.getQuotes(symbols)
        : await Promise.all(symbols.map((s) => provider.getQuote(s)));
      for (const q of fetched) quotes.set(q.symbol.toUpperCase(), q);
    } catch {
      // leave quotes empty; alerts simply won't trigger this round
    }

    // RSI, MA-cross and 52-week-distance all need candle history; fetch once per
    // symbol that has any such alert and derive them together.
    const CANDLE_KINDS = ['rsi', 'macross', 'high52', 'low52'];
    const EMPTY_CANDLE: CandleMetrics = { rsi: null, maSpreadPct: null, pctFromHigh52: null, pctFromLow52: null };
    const candleSymbols = Array.from(
      new Set(
        alerts
          .filter((a) => a.assetType === 'stock' && CANDLE_KINDS.includes(a.kind))
          .map((a) => a.symbol.toUpperCase()),
      ),
    );
    const candleMetrics = new Map<string, CandleMetrics>();
    await Promise.all(
      candleSymbols.map(async (s) => {
        try {
          const candles = await provider.getCandles(s, 'daily', { limit: 260 });
          candleMetrics.set(s, computeCandleMetrics(candles, quotes.get(s)?.last ?? null));
        } catch {
          // leave unset → metrics stay null and the alert just won't trigger
        }
      }),
    );

    // Option-contract alerts: fetch each needed (symbol, expiration) chain once
    // and read the targeted contract's mark/bid/ask/delta/IV. Skipped silently
    // when the provider has no options data (metrics stay null → no trigger).
    const optionAlerts = alerts.filter(
      (a) => a.assetType === 'option' && a.optionType && a.strike != null && a.expiration,
    );
    const optionMetrics = new Map<number, OptionContractMetrics>();
    if (optionAlerts.length && provider.capabilities.options) {
      const groups = new Map<string, Alert[]>();
      for (const a of optionAlerts) {
        const key = `${a.symbol.toUpperCase()}|${a.expiration}`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
      }
      await Promise.all(
        Array.from(groups.entries()).map(async ([key, members]) => {
          const [sym, exp] = key.split('|');
          try {
            const chain = await provider.getOptionsChain(sym, exp);
            for (const a of members) optionMetrics.set(a.id, optionContractMetrics(chain, a.optionType!, a.strike!));
          } catch {
            // leave unset → metrics null → alert won't trigger this round
          }
        }),
      );
    }

    const newlyTriggered: { id: number; symbol: string; message: string | null }[] = [];
    for (const a of alerts) {
      const sym = a.symbol.toUpperCase();
      const q = quotes.get(sym);
      const cm = candleMetrics.get(sym) ?? EMPTY_CANDLE;
      const om = optionMetrics.get(a.id);
      const metrics: AlertMetrics = {
        price: a.assetType === 'option' ? (om?.underlyingPrice ?? q?.last ?? null) : (q?.last ?? null),
        changePct: q?.changePct ?? null,
        relVol: q && q.avgVolume ? q.volume / q.avgVolume : null,
        rsi: cm.rsi,
        maSpreadPct: cm.maSpreadPct,
        pctFromHigh52: cm.pctFromHigh52,
        pctFromLow52: cm.pctFromLow52,
        optMark: om?.mark ?? null,
        optBid: om?.bid ?? null,
        optAsk: om?.ask ?? null,
        optDelta: om?.delta ?? null,
        optIv: om?.iv ?? null,
      };
      const ev = evaluateAlert(a.symbol, a, metrics, alertSubject(a));
      // An entry alert is "a good entry point with the suggestion of when to
      // exit" — fold its planned exit into the fired message.
      let message = ev.message;
      if (ev.triggered && a.role === 'entry' && a.plan?.suggestedExit) {
        message = `${message} — plan exit: ${a.plan.suggestedExit}`;
      }
      const wasTriggered = a.triggered;
      applyEvaluation(a.id, ev.value, ev.triggered, message);
      if (ev.triggered && !wasTriggered) newlyTriggered.push({ id: a.id, symbol: a.symbol, message });
    }

    // Also surface open option positions that have hit an exit rule.
    const positionAlerts = await evaluateOpenPositionExits().catch(() => []);

    res.json({ alerts: listAlerts(), newlyTriggered, positionAlerts, checkedAt: Date.now() });
  }),
);
