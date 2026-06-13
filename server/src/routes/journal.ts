import { Router } from 'express';
import { asyncHandler } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { aggregateExcursions, computeExcursion, TradeExcursion } from '../services/excursion';
import { getProvider } from '../providers';

export const journalRouter = Router();

const lastExitDate = (p: Position): string =>
  p.exits.length
    ? p.exits
        .map((e) => e.exitDate)
        .sort()
        .slice(-1)[0]
    : p.entryDate;

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
