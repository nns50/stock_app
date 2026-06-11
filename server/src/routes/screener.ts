import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from './_helpers';
import { getProvider, getProviderStatus } from '../providers';
import { listUniverseSymbols } from '../db/universe';
import { saveQuote } from '../services/quotes';
import { mapPool } from '../util/async';
import {
  defaultScreenerConfig,
  resolveScreenerConfig,
  scoreSymbol,
  ScreenerConfig,
  SymbolScore,
} from '../indicators/screener';

export const screenerRouter = Router();

// Expose the defaults so the UI can render the (transparent) controls.
screenerRouter.get('/config/default', (_req, res) => {
  res.json(defaultScreenerConfig());
});

const runBody = z.object({
  symbols: z.array(z.string().min(1)).optional(),
  config: z.record(z.unknown()).optional(),
  /** Cap the scan to respect provider rate limits (real providers). */
  maxSymbols: z.number().int().min(1).max(500).default(75),
  includeFailed: z.boolean().default(false),
});

screenerRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const body = parseBody(runBody, req);
    const cfg: ScreenerConfig = resolveScreenerConfig(body.config as Partial<ScreenerConfig> | undefined);
    const provider = getProvider();

    const universe = body.symbols && body.symbols.length ? body.symbols : listUniverseSymbols();
    const upper = Array.from(new Set(universe.map((s) => s.toUpperCase())));
    const scanned = upper.slice(0, body.maxSymbols);

    // Warm the quote cache in one batched call (best-effort).
    let quoteOk = true;
    try {
      const quotes = provider.getQuotes ? await provider.getQuotes(scanned) : [];
      quotes.forEach(saveQuote);
    } catch {
      quoteOk = false;
    }

    const candleLimit = Math.min(2000, Math.max(120, cfg.maLong * 2 + 20));
    const errors: { symbol: string; message: string }[] = [];

    const scored = await mapPool(scanned, 6, async (symbol): Promise<SymbolScore | null> => {
      try {
        const [candles, quote] = await Promise.all([
          provider.getCandles(symbol, 'daily', { limit: candleLimit }),
          provider.getQuote(symbol).catch(() => undefined),
        ]);
        if (quote) saveQuote(quote);
        return scoreSymbol(symbol, candles, quote, cfg);
      } catch (err) {
        errors.push({ symbol, message: (err as Error).message });
        return null;
      }
    });

    const all = scored.filter((s): s is SymbolScore => s !== null);
    const passed = all.filter((s) => s.passedFilters).sort((a, b) => b.total - a.total);
    const failed = all.filter((s) => !s.passedFilters).sort((a, b) => b.total - a.total);

    const status = getProviderStatus();
    res.json({
      generatedAt: Date.now(),
      provider: { name: status.name, synthetic: status.synthetic },
      config: cfg,
      universeCount: upper.length,
      scannedCount: scanned.length,
      quoteWarmup: quoteOk,
      results: passed,
      filteredOut: body.includeFailed
        ? failed
        : failed.map((s) => ({ symbol: s.symbol, price: s.price, total: s.total, filterReasons: s.filterReasons })),
      errors,
    });
  }),
);
