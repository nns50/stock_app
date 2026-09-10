import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody, parseQuery } from './_helpers';
import { getProvider, getProviderStatus } from '../providers';
import { CachingProvider } from '../providers/CachingProvider';
import { Timeframe } from '../providers/types';
import { saveQuote } from '../services/quotes';
import { runProviderTest } from '../services/providerTest';
import { smaSeries } from '../indicators/indicators';
import { computeIndicators, defaultScreenerConfig } from '../indicators/screener';
import { computeMarketRegime } from '../services/marketRegime';
import { getMarketRegime } from '../services/mlRegime';
import { getMlRegimeReadiness, recordMlRegimeParityCheck } from '../services/mlRegimeReadiness';
import { ML_REGIMES } from '../services/regimeModel';

export const marketRouter = Router();

const TIMEFRAMES = ['1min', '5min', '15min', 'daily', 'weekly'] as const;

marketRouter.get('/provider', (_req, res) => {
  res.json(getProviderStatus());
});

// Live connectivity check — exercises the provider with real calls.
marketRouter.get(
  '/provider/test',
  asyncHandler(async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol : 'AAPL';
    res.json(await runProviderTest(symbol));
  }),
);

// Read-only market-regime gauge (Risk-on / Neutral / Risk-off) for the Today
// dashboard — see services/marketRegime.ts. Cached ~1h in the service; `force`
// bypasses that cache for a manual refresh.
const regimeQuery = z.object({ force: z.coerce.boolean().optional() });
marketRouter.get(
  '/market/regime',
  asyncHandler(async (req, res) => {
    const q = parseQuery(regimeQuery, req);
    res.json(await computeMarketRegime({ force: q.force }));
  }),
);

// The ML market-regime reading — the shipped HMM's filtered posterior over the
// last 250 sessions, sticky-switched from yesterday (services/mlRegime.ts,
// docs/MARKET_REGIME_MODEL.md). Cached per ET day in the service; `force`
// refetches FRED and re-classifies. Never throws: a missing model, missing
// data or a stale data date reads `unknown` with a reason.
marketRouter.get(
  '/market/regime-ml',
  asyncHandler(async (req, res) => {
    const q = parseQuery(regimeQuery, req);
    res.json(await getMarketRegime({ force: q.force }));
  }),
);

// The enabling rules, counted by the app (2026-09-10; services/mlRegimeReadiness.ts,
// docs/AUTOTRADING_SPEC.md §"Pre-committed enabling rules"): rules 2–4 over the
// last 20 sessions' persisted readings. Rows only — never a fetch. The same
// object rides on GET /api/autotrade/dashboard.
marketRouter.get('/market/regime-ml/readiness', (_req, res) => {
  res.json(getMlRegimeReadiness());
});

// Rule 3, recorded: the Python `regime:predict` reading for one ET day,
// compared with the persisted reading for that day and stored beside it.
// 404 when no reading exists for the day — there is nothing to compare.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const parityBody = z.object({
  etDate: isoDate,
  asOf: isoDate.nullable(),
  regime: z.enum(ML_REGIMES),
  probabilities: z.object({
    high_vol_bearish: z.number().finite(),
    low_vol_bullish: z.number().finite(),
    sideways: z.number().finite(),
  }),
});
marketRouter.post(
  '/market/regime-ml/parity',
  asyncHandler(async (req, res) => {
    const body = parseBody(parityBody, req);
    const result = recordMlRegimeParityCheck(body);
    if (!result) throw new HttpError(404, `no reading persisted for ${body.etDate}`);
    res.json(result);
  }),
);

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
    const list = symbols
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const provider = getProvider();
    const quotes = provider.getQuotes
      ? await provider.getQuotes(list)
      : await Promise.all(list.map((s) => provider.getQuote(s)));
    quotes.forEach(saveQuote);
    res.json({ quotes, asOf: Date.now() });
  }),
);

marketRouter.get(
  '/quotes/:symbol',
  asyncHandler(async (req, res) => {
    const quote = await getProvider().getQuote(param(req, 'symbol'));
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
    const candles = await getProvider().getCandles(param(req, 'symbol'), q.timeframe as Timeframe, {
      limit: q.limit,
      start: q.start,
      end: q.end,
    });
    res.json({ symbol: param(req, 'symbol').toUpperCase(), timeframe: q.timeframe, candles });
  }),
);

marketRouter.get(
  '/fundamentals/:symbol',
  asyncHandler(async (req, res) => {
    const fundamentals = await getProvider().getFundamentals(param(req, 'symbol'));
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
    const symbol = param(req, 'symbol').toUpperCase();
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
