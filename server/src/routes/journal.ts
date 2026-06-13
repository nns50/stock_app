import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { aggregateExcursions, computeExcursion, TradeExcursion } from '../services/excursion';
import { computeBenchmark } from '../services/benchmark';
import { getProvider } from '../providers';

export const journalRouter = Router();

const lastExitDate = (p: Position): string =>
  p.exits.length
    ? p.exits
        .map((e) => e.exitDate)
        .sort()
        .slice(-1)[0]
    : p.entryDate;

// "Am I beating the index?" Compare realized return vs buy-and-hold of a
// benchmark (default SPY) over the trading period. accountSize (optional) turns
// the realized $ into a % for an apples-to-apples comparison.
const benchmarkQuery = z.object({
  symbol: z.string().min(1).default('SPY'),
  accountSize: z.coerce.number().positive().optional(),
});
journalRouter.get(
  '/benchmark',
  asyncHandler(async (req, res) => {
    const q = parseQuery(benchmarkQuery, req);
    const closed = listPositions({ status: 'closed' });
    const symbol = q.symbol.toUpperCase();
    if (closed.length === 0) {
      res.json(
        computeBenchmark({
          symbol,
          startDate: null,
          endDate: null,
          benchStart: null,
          benchEnd: null,
          totalRealized: 0,
          accountSize: q.accountSize ?? null,
        }),
      );
      return;
    }
    const startDate = closed.map((p) => p.entryDate).sort()[0];
    const endDate = closed.map(lastExitDate).sort().slice(-1)[0];
    const totalRealized = closed.reduce((s, p) => s + realizedPnlOf(p), 0);

    let benchStart: number | null = null;
    let benchEnd: number | null = null;
    try {
      const candles = await getProvider().getCandles(symbol, 'daily', { start: startDate, end: endDate });
      if (candles.length) {
        benchStart = candles[0].close;
        benchEnd = candles[candles.length - 1].close;
      }
    } catch {
      // benchmark unavailable from the provider; return user side only
    }
    res.json(
      computeBenchmark({
        symbol,
        startDate,
        endDate,
        benchStart,
        benchEnd,
        totalRealized,
        accountSize: q.accountSize ?? null,
      }),
    );
  }),
);

// Aggregate journal statistics over CLOSED positions (completed trades).
journalRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const closed = listPositions({ status: 'closed' });
    res.json(computeJournalStats(closed));
  }),
);

// MAE/MFE excursions: for each closed STOCK trade, how far price ran for/against
// you over the holding period. Fetches daily candles per trade (capped), so it's
// an on-demand analysis. Options are skipped (excursion would be on the
// underlying, not the option premium).
journalRouter.get(
  '/excursions',
  asyncHandler(async (_req, res) => {
    const closed = listPositions({ status: 'closed', assetType: 'stock' }).slice(0, 50);
    const provider = getProvider();
    const rows: TradeExcursion[] = [];
    await Promise.all(
      closed.map(async (p) => {
        try {
          const candles = await provider.getCandles(p.symbol, 'daily', {
            start: p.entryDate,
            end: lastExitDate(p),
          });
          const ex = computeExcursion(
            {
              positionId: p.id,
              symbol: p.symbol,
              side: p.side,
              entryPrice: p.entryPrice,
              quantity: p.quantity,
              multiplier: p.multiplier,
              stopPrice: p.stopPrice,
              realizedPnl: realizedPnlOf(p),
              entryDate: p.entryDate,
            },
            candles,
          );
          if (ex) rows.push(ex);
        } catch {
          // skip trades whose candles can't be fetched
        }
      }),
    );
    rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    res.json(aggregateExcursions(rows));
  }),
);

// All distinct tags in use (for filter chips in the UI).
journalRouter.get(
  '/tags',
  asyncHandler(async (_req, res) => {
    const all = listPositions();
    const tags = new Set<string>();
    for (const p of all) for (const t of p.tags) tags.add(t);
    res.json({ tags: Array.from(tags).sort() });
  }),
);
