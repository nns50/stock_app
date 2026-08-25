import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { getIntent } from '../db/orders';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { computeDayStats } from '../services/dayGuard';
import { aggregateExcursions, computeExcursion, TradeExcursion } from '../services/excursion';
import { aggregateSlippage, computeSlippage, SlippageRow } from '../services/slippage';
import { aggregateStopOverruns, classifyStopExit, computeStopOverrun, StopOverrunRow } from '../services/stopOverrun';
import { computeBenchmark } from '../services/benchmark';
import { computeAutoTuneRiskEfficacy } from '../services/autotrading/autoTuneEfficacy';
import { getProvider } from '../providers';

export const journalRouter = Router();

/** Null when neither an exit nor an entry date is known. */
const lastExitDate = (p: Position): string | null =>
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
    // The benchmark compares your realized return against buy-and-hold over the
    // period you traded, so the window has to come from trades that HAVE dates.
    // `null` would sort as the string "null" and quietly become the boundary.
    //
    // `?? null` is load-bearing: indexing an empty array yields undefined, which
    // the `is string` predicate lets TypeScript type as `string` anyway. Closed
    // trades can all be undated (the length check above doesn't cover it), and
    // an undefined here reached getCandles as a missing bound and computeBenchmark
    // as an absent field — a broken window reported as a real one.
    const startDate =
      closed
        .map((p) => p.entryDate)
        .filter((d): d is string => d !== null)
        .sort()[0] ?? null;
    const endDate =
      closed
        .map(lastExitDate)
        .filter((d): d is string => d !== null)
        .sort()
        .slice(-1)[0] ?? null;
    const totalRealized = closed.reduce((s, p) => s + realizedPnlOf(p), 0);

    let benchStart: number | null = null;
    let benchEnd: number | null = null;
    // No window, no comparison. The realized total is still returned, so the
    // response says "here is your P&L, there is nothing to compare it against"
    // instead of inventing a period.
    if (startDate !== null && endDate !== null) {
      try {
        const candles = await getProvider().getCandles(symbol, 'daily', { start: startDate, end: endDate });
        if (candles.length) {
          benchStart = candles[0].close;
          benchEnd = candles[candles.length - 1].close;
        }
      } catch {
        // benchmark unavailable from the provider; return user side only
      }
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
/** One daily-candle fetch per trade, so the work is bounded. Newest trades win
 *  (listPositions orders by date DESC) and the number dropped is REPORTED — see
 *  ExcursionCoverage. */
const EXCURSION_TRADE_CAP = 50;

journalRouter.get(
  '/excursions',
  asyncHandler(async (_req, res) => {
    const closedStock = listPositions({ status: 'closed', assetType: 'stock' });
    // An excursion walks daily candles from the entry to the exit, so a trade
    // with no known entry date cannot be measured and is left out.
    const dated = closedStock.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
    const selected = dated.slice(0, EXCURSION_TRADE_CAP);
    const provider = getProvider();
    const rows: TradeExcursion[] = [];
    let unavailable = 0;
    await Promise.all(
      selected.map(async (p) => {
        try {
          const candles = await provider.getCandles(p.symbol, 'daily', {
            start: p.entryDate,
            end: lastExitDate(p) ?? undefined,
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
              exitDate: lastExitDate(p),
            },
            candles,
          );
          // A null here means the candles arrived but held nothing usable over
          // the holding window — counted, not discarded, for the same reason a
          // failed fetch is.
          if (ex) rows.push(ex);
          else unavailable++;
        } catch {
          unavailable++;
        }
      }),
    );
    rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    res.json(
      aggregateExcursions(rows, {
        closedStockTrades: closedStock.length,
        undated: closedStock.length - dated.length,
        overCap: dated.length - selected.length,
        unavailable,
      }),
    );
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
      // Entry-side slippage is dated by the entry — see the same guard in
      // services/autotrading/autoTune.ts's buildSlippageRows().
      if (p.sourceIntentId != null && p.entryDate !== null) {
        const entryDate = p.entryDate;
        const intent = getIntent(p.sourceIntentId);
        if (intent?.limitPrice != null) {
          rows.push(
            computeSlippage({
              positionId: p.id,
              symbol: p.symbol,
              kind: 'entry',
              side: intent.side,
              date: entryDate,
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

// Stop overrun: for every stock exit that was a stop EXECUTION, how far beyond
// the declared stop the exit actually landed — the cost the zero-cost backtests
// can't see. Which exits count (and on what basis, recorded vs inferred) is
// classifyStopExit()'s call — see its doc comment in services/stopOverrun.ts.
journalRouter.get(
  '/stop-overrun',
  asyncHandler(async (_req, res) => {
    const rows: StopOverrunRow[] = [];
    for (const p of listPositions()) {
      if (p.assetType !== 'stock' || p.stopPrice == null) continue;
      const stopPrice = p.stopPrice;
      for (const e of p.exits) {
        const basis = classifyStopExit(p.side, stopPrice, e.exitPrice, e.exitReason);
        if (!basis) continue;
        rows.push(
          computeStopOverrun({
            positionId: p.id,
            symbol: p.symbol,
            side: p.side,
            date: e.exitDate,
            entryPrice: p.entryPrice,
            stopPrice,
            exitPrice: e.exitPrice,
            quantity: e.quantity,
            basis,
          }),
        );
      }
    }
    res.json(aggregateStopOverruns(rows));
  }),
);
