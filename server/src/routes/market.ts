import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseQuery } from './_helpers';
import { getProvider, getProviderStatus } from '../providers';
import { CachingProvider } from '../providers/CachingProvider';
import { Timeframe } from '../providers/types';
import { saveQuote } from '../services/quotes';
import { smaSeries } from '../indicators/indicators';
import { computeIndicators, defaultScreenerConfig } from '../indicators/screener';

export const marketRouter = Router();

const TIMEFRAMES = ['1min', '5min', '15min', 'daily', 'weekly'] as const;

marketRouter.get('/provider', (_req, res) => {
  res.json(getProviderStatus());
});

// Force a refresh by clearing the in-memory quote/candle caches.
marketRouter.post('/refresh', (_req, res) => {
  const provider = getProvider();
  if (provider instanceof CachingProvider) provider.clearCaches();
  res.json({ ok: true, clearedAt: Date.now() });
});

const quotesQuery = z.object({ symbols: z.string().min(1) });
marketRouter.get(
  '/quotes',
  asyncHandler(async (req, res) => {
    const { symbols } = parseQuery(quotesQuery, req);
    const list = symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const provider = getProvider();
    const quotes = provider.getQuotes ? await provider.getQuotes(list) : await Promise.all(list.map((s) => provider.getQuote(s)));
    quotes.forEach(saveQuote);
    res.json({ quotes, asOf: Date.now() });
  }),
);

marketRouter.get(
  '/quotes/:symbol',
  asyncHandler(async (req, res) => {
    const quote = await getProvider().getQuote(req.params.symbol);
    saveQuote(quote);
    res.json(quote);
  }),
);

const candlesQuery = z.object({
  timeframe: z.enum(TIMEFRAMES).default('daily'),
  limit: z.coerce.number().int().min(2).max(2000).default(200),
  start: z.string().optional(),
  end: z.string().optional(),
});
marketRouter.get(
  '/candles/:symbol',
  asyncHandler(async (req, res) => {
    const q = parseQuery(candlesQuery, req);
    const candles = await getProvider().getCandles(req.params.symbol, q.timeframe as Timeframe, {
      limit: q.limit,
      start: q.start,
      end: q.end,
    });
    res.json({ symbol: req.params.symbol.toUpperCase(), timeframe: q.timeframe, candles });
  }),
);

marketRouter.get(
  '/fundamentals/:symbol',
  asyncHandler(async (req, res) => {
    const fundamentals = await getProvider().getFundamentals(req.params.symbol);
    res.json(fundamentals);
  }),
);

// Per-symbol detail bundle for the chart view: quote + candles + MA overlays +
// indicator snapshot + (best-effort) fundamentals.
const detailQuery = z.object({
  timeframe: z.enum(TIMEFRAMES).default('daily'),
  limit: z.coerce.number().int().min(20).max(2000).default(200),
  maShort: z.coerce.number().int().min(2).max(400).default(20),
  maLong: z.coerce.number().int().min(2).max(400).default(50),
});
marketRouter.get(
  '/symbol/:symbol',
  asyncHandler(async (req, res) => {
    const q = parseQuery(detailQuery, req);
    const symbol = req.params.symbol.toUpperCase();
    const provider = getProvider();

    const [candles, quote] = await Promise.all([
      provider.getCandles(symbol, q.timeframe as Timeframe, { limit: q.limit }),
      provider.getQuote(symbol).catch(() => undefined),
    ]);
    if (quote) saveQuote(quote);
    if (candles.length === 0) throw new HttpError(404, `No candle data for ${symbol}`);

    const closes = candles.map((c) => c.close);
    const cfg = { ...defaultScreenerConfig(), maShort: q.maShort, maLong: q.maLong };
    const fundamentals = await provider.getFundamentals(symbol).catch(() => null);

    res.json({
      symbol,
      timeframe: q.timeframe,
      quote: quote ?? null,
      candles,
      overlays: {
        maShortPeriod: q.maShort,
        maLongPeriod: q.maLong,
        maShort: smaSeries(closes, q.maShort),
        maLong: smaSeries(closes, q.maLong),
      },
      indicators: computeIndicators(candles, quote, cfg),
      fundamentals,
      synthetic: getProviderStatus().synthetic,
    });
  }),
);
