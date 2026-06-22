import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody, parseQuery } from './_helpers';
import { getProvider, getProviderStatus, requireCapability } from '../providers';
import { listPositions } from '../db/positions';
import { resolveOptionMarks } from '../services/quotes';
import { defaultEntryConfig, EntryStrategyConfig, scanEntries } from '../options/entryRules';
import { defaultExitConfig, evaluateExit, ExitRulesConfig } from '../options/exitRules';
import { atmIvOfChain, computeIvContext } from '../services/ivRank';
import { getIvHistory, recordAtmIv } from '../db/ivHistory';
import { Candle } from '../providers/types';

export const optionsRouter = Router();

// Capability/feature-flag gate. The UI reads /api/provider to decide whether to
// render the module at all; this guards the endpoints server-side too.
optionsRouter.use((_req, res, next) => {
  const status = getProviderStatus();
  if (!status.configured) {
    res.status(503).json({ error: status.message ?? 'Provider not configured', code: 'not_configured' });
    return;
  }
  if (!status.capabilities.options) {
    res.status(501).json({
      error: `Provider "${status.name}" does not provide options data. Switch providers or enable mock data.`,
      code: 'options_unavailable',
    });
    return;
  }
  next();
});

optionsRouter.get('/entry/default', (_req, res) => res.json(defaultEntryConfig('call')));
optionsRouter.get('/exit/default', (_req, res) => res.json(defaultExitConfig()));

/** Fetch the chain, record today's ATM IV, and rank it vs history (HV fallback). */
async function ivContextFor(symbol: string, expiration: string) {
  const provider = getProvider();
  const chain = await provider.getOptionsChain(symbol, expiration);
  const atmIv = atmIvOfChain(chain);
  if (atmIv !== undefined) recordAtmIv(chain.underlying, atmIv);
  const history = getIvHistory(chain.underlying);
  let candles: Candle[] = [];
  if (history.length < 15 && atmIv !== undefined) {
    candles = await provider.getCandles(symbol, 'daily', { limit: 260 }).catch(() => []);
  }
  return { chain, ivContext: computeIvContext(atmIv, history, candles) };
}

optionsRouter.get(
  '/:symbol/expirations',
  asyncHandler(async (req, res) => {
    requireCapability('options');
    const expirations = await getProvider().getOptionsExpirations(param(req, 'symbol'));
    res.json({ symbol: param(req, 'symbol').toUpperCase(), expirations });
  }),
);

const chainQuery = z.object({ expiration: z.string().min(8) });
optionsRouter.get(
  '/:symbol/chain',
  asyncHandler(async (req, res) => {
    requireCapability('options');
    const { expiration } = parseQuery(chainQuery, req);
    const chain = await getProvider().getOptionsChain(param(req, 'symbol'), expiration);
    const atmIv = atmIvOfChain(chain);
    if (atmIv !== undefined) recordAtmIv(chain.underlying, atmIv); // accrue IV history
    res.json({ ...chain, atmIv: atmIv ?? null, synthetic: getProviderStatus().synthetic });
  }),
);

// Lightweight IV context (rank/percentile) for the timing banner — no full scan.
optionsRouter.get(
  '/:symbol/iv',
  asyncHandler(async (req, res) => {
    requireCapability('options');
    const { expiration } = parseQuery(chainQuery, req);
    const { chain, ivContext } = await ivContextFor(param(req, 'symbol'), expiration);
    res.json({
      symbol: param(req, 'symbol').toUpperCase(),
      expiration,
      underlyingPrice: chain.underlyingPrice ?? null,
      ivContext,
    });
  }),
);

const entryScanBody = z.object({
  symbol: z.string().min(1),
  expiration: z.string().min(8),
  config: z
    .object({
      side: z.enum(['call', 'put']).optional(),
      deltaMin: z.number().optional(),
      deltaMax: z.number().optional(),
      maxSpreadPct: z.number().optional(),
      minOpenInterest: z.number().optional(),
      minVolume: z.number().optional(),
      minDaysToExpiration: z.number().optional(),
      maxDaysToExpiration: z.number().optional(),
      ivMin: z.number().optional(),
      ivMax: z.number().optional(),
      ivRankMin: z.number().optional(),
      ivRankMax: z.number().optional(),
      weights: z.object({ spread: z.number(), liquidity: z.number(), deltaFit: z.number() }).partial().optional(),
    })
    .optional(),
});

optionsRouter.post(
  '/entry-scan',
  asyncHandler(async (req, res) => {
    requireCapability('options');
    const body = parseBody(entryScanBody, req);
    const side = body.config?.side ?? 'call';
    const cfg: EntryStrategyConfig = {
      ...defaultEntryConfig(side),
      ...(body.config ?? {}),
      side,
      weights: { ...defaultEntryConfig(side).weights!, ...(body.config?.weights ?? {}) },
    };
    // IV context: record today's ATM IV, then rank it vs accumulated history
    // (or realized-vol as a labeled fallback until history builds).
    const { chain, ivContext } = await ivContextFor(body.symbol, body.expiration);
    const candidates = scanEntries(chain, cfg, new Date(), ivContext.ivRank);
    res.json({
      symbol: body.symbol.toUpperCase(),
      expiration: body.expiration,
      underlyingPrice: chain.underlyingPrice ?? null,
      config: cfg,
      ivContext,
      candidates,
      synthetic: getProviderStatus().synthetic,
    });
  }),
);

const exitCheckBody = z.object({
  config: z
    .object({
      takeProfitPct: z.number().optional(),
      stopLossPct: z.number().optional(),
      timeExitDaysBeforeExpiry: z.number().optional(),
      deltaMin: z.number().optional(),
      deltaMax: z.number().optional(),
    })
    .optional(),
});

optionsRouter.post(
  '/exit-check',
  asyncHandler(async (req, res) => {
    requireCapability('options');
    const body = parseBody(exitCheckBody, req);
    const cfg: ExitRulesConfig = { ...defaultExitConfig(), ...(body.config ?? {}) };

    const open = listPositions({ status: 'open', assetType: 'option' });
    const marks = await resolveOptionMarks(open);

    const now = new Date();
    const evaluations = open.map((p) => {
      const m = marks.get(p.id) ?? { mark: null, delta: null };
      const evaluation = evaluateExit(
        {
          entryPrice: p.entryPrice,
          currentPrice: m.mark,
          side: p.side,
          expiration: p.expiration ?? '',
          currentDelta: m.delta,
        },
        cfg,
        now,
      );
      return {
        position: {
          id: p.id,
          symbol: p.symbol,
          optionType: p.optionType,
          strike: p.strike,
          expiration: p.expiration,
          side: p.side,
          quantity: p.remainingQuantity,
          entryPrice: p.entryPrice,
        },
        currentMark: m.mark,
        currentDelta: m.delta,
        evaluation,
      };
    });

    res.json({ config: cfg, evaluations, checkedAt: Date.now(), synthetic: getProviderStatus().synthetic });
  }),
);
