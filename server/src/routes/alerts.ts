import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { applyEvaluation, createAlert, deleteAlert, listAlerts, updateAlert } from '../db/alerts';
import { AlertMetrics, evaluateAlert } from '../services/alertEngine';
import { getProvider } from '../providers';
import { rsi } from '../indicators/indicators';

export const alertsRouter = Router();

const createBody = z.object({
  symbol: z.string().min(1),
  kind: z.enum(['price', 'change', 'relvol', 'rsi']),
  operator: z.enum(['above', 'below']),
  threshold: z.number(),
  note: z.string().max(200).optional(),
});

alertsRouter.get('/', (_req, res) => {
  res.json({ alerts: listAlerts() });
});

alertsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    res.status(201).json(createAlert(parseBody(createBody, req)));
  }),
);

const patchBody = z.object({
  threshold: z.number().optional(),
  note: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  triggered: z.boolean().optional(),
});

alertsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const updated = updateAlert(Number(req.params.id), parseBody(patchBody, req));
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

    // RSI needs candle history; fetch only for symbols that have an RSI alert.
    const rsiSymbols = Array.from(new Set(alerts.filter((a) => a.kind === 'rsi').map((a) => a.symbol.toUpperCase())));
    const rsiValues = new Map<string, number | null>();
    await Promise.all(
      rsiSymbols.map(async (s) => {
        try {
          const candles = await provider.getCandles(s, 'daily', { limit: 60 });
          rsiValues.set(
            s,
            rsi(
              candles.map((c) => c.close),
              14,
            ),
          );
        } catch {
          rsiValues.set(s, null);
        }
      }),
    );

    const newlyTriggered: { id: number; symbol: string; message: string | null }[] = [];
    for (const a of alerts) {
      const q = quotes.get(a.symbol.toUpperCase());
      const metrics: AlertMetrics = {
        price: q?.last ?? null,
        changePct: q?.changePct ?? null,
        relVol: q && q.avgVolume ? q.volume / q.avgVolume : null,
        rsi: rsiValues.get(a.symbol.toUpperCase()) ?? null,
      };
      const ev = evaluateAlert(a.symbol, a, metrics);
      const wasTriggered = a.triggered;
      applyEvaluation(a.id, ev.value, ev.triggered, ev.message);
      if (ev.triggered && !wasTriggered) newlyTriggered.push({ id: a.id, symbol: a.symbol, message: ev.message });
    }

    res.json({ alerts: listAlerts(), newlyTriggered, checkedAt: Date.now() });
  }),
);
