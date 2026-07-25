import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { getIntent } from '../db/orders';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { computeDayStats } from '../services/dayGuard';
import { aggregateExcursions, computeExcursion, TradeExcursion } from '../services/excursion';
import { aggregateSlippage, computeSlippage, SlippageRow } from '../services/slippage';
import { computeBenchmark } from '../services/benchmark';
import { computeAutoTuneRiskEfficacy } from '../services/autotrading/autoTuneEfficacy';
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

// Did auto-tune's past risk-% adjustments (Auto-Trade's "Auto-tune from
// realized edge" setting) actually help? Before/after stats around each
// past adjustment's own date — see autoTuneEfficacy.ts's own header comment
// for why this is informational only (no auto-revert).
journalRouter.get(
  '/auto-tune-efficacy',
  asyncHandler(async (_req, res) => {
    res.json({ adjustments: computeAutoTuneRiskEfficacy() });
  }),
);

// Daily guardrail: P&L booked and positions opened on a given day (the client
// passes its own local date, so the day boundary matches the user's timezone).
const todayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
journalRouter.get(
  '/today',
  asyncHandler(async (req, res) => {
    const { date } = parseQuery(todayQuery, req);
    res.json(computeDayStats(listPositions({}), date));
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

// Execution quality: for live-traded fills (entries + exits linked back to an
// order with a limit price), how the actual fill compared to the price you
// committed to. Manually logged/imported positions and stop-market fills have
// no comparable reference and are simply not counted.
journalRouter.get(
  '/slippage',
  asyncHandler(async (_req, res) => {
    const rows: SlippageRow[] = [];
    for (const p of listPositions()) {
      if (p.sourceIntentId != null) {
        const intent = getIntent(p.sourceIntentId);
        if (intent?.limitPrice != null) {
          rows.push(
            computeSlippage({
              positionId: p.id,
              symbol: p.symbol,
              kind: 'entry',
              side: intent.side,
              date: p.entryDate,
              limitPrice: intent.limitPrice,
              fillPrice: p.entryPrice,
              quantity: p.quantity,
              multiplier: p.multiplier,
            }),
          );
        }
      }
      for (const e of p.exits) {
        if (e.sourceIntentId == null) continue;
        const intent = getIntent(e.sourceIntentId);
        if (intent?.limitPrice == null) continue;
        rows.push(
          computeSlippage({
            positionId: p.id,
            symbol: p.symbol,
            kind: 'exit',
            side: intent.side,
            date: e.exitDate,
            limitPrice: intent.limitPrice,
            fillPrice: e.exitPrice,
            quantity: e.quantity,
            multiplier: p.multiplier,
          }),
        );
      }
    }
    res.json(aggregateSlippage(rows));
  }),
);
