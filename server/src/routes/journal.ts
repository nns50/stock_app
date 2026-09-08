import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { getIntent } from '../db/orders';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { computeDayStats } from '../services/dayGuard';
import { aggregateExcursions, excursionForTrade, ExcursionInput, TradeExcursion } from '../services/excursion';
import {
  buildRegimeTightenLedger,
  isTightenedFactor,
  tightenedStockPositions,
  tightenedTradeRow,
  TightenedTradeInput,
  TightenedTradeRow,
} from '../services/autotrading/regimeTightenLedger';
import { listTightenedClosedPaperPositions, paperRealizedPnl, paperRealizedR } from '../db/autotradePaperPositions';
import { listOptionsPaperPositions } from '../db/autotradeOptionsPaperPositions';
import { listLiveOptionsPositions } from '../db/autotradeLiveOptionsPositions';
import { etTimeOfDay, etToday } from '../util/marketDate';
import { aggregateSlippage, computeSlippage, SlippageRow } from '../services/slippage';
import { aggregateStopOverruns, classifyStopExit, computeStopOverrun, StopOverrunRow } from '../services/stopOverrun';
import { computeBenchmark } from '../services/benchmark';
import { computeAutoTuneRiskEfficacy } from '../services/autotrading/autoTuneEfficacy';
import { getProvider } from '../providers';

export const journalRouter = Router();

/** When the final exit was RECORDED (epoch ms) — the closing moment, to the
 *  precision the journal has. Autotrade books an exit on the reconcile tick
 *  that observes the fill, so this trails the real fill by up to a minute;
 *  that is well inside a 5-minute bar and is the best available answer. Null
 *  for a position with no exits. */
const lastExitAt = (p: Position): number | null =>
  p.exits.length ? Math.max(...p.exits.map((e) => e.createdAt)) : null;

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
          const ex = await excursionForTrade(provider, {
            positionId: p.id,
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            multiplier: p.multiplier,
            // The FROZEN stop — this is the excursion's R denominator, and the
            // ratchet mutates p.stopPrice (see initialRiskOf in services/pnl.ts).
            // Using the live value would inflate every mfeR/maeR/realizedR the
            // moment a trailing stop moves.
            stopPrice: p.initialStopPrice ?? p.stopPrice,
            realizedPnl: realizedPnlOf(p),
            entryDate: p.entryDate,
            exitDate: lastExitDate(p),
            entryTime: p.entryTime,
            exitAt: lastExitAt(p),
          });
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

// The counterfactual MFE ledger for the ML regime target tighten (2026-09-08):
// every closed stock trade stamped regime_target_factor < 1, paper and live,
// joined to its excursion and read per trade — see regimeTightenLedger.ts's
// header for the bound it computes and the reading it is pre-committed to.
// Same per-trade candle fetch and cap as /excursions, so the work is bounded
// and what it could not cover is reported, not hidden.
const REGIME_TIGHTEN_TRADE_CAP = 50;

/** A tightened trade before its excursion is known: the ledger's input minus
 *  the excursion fields, and the excursion fetch that fills them in. */
interface TightenedCandidate {
  entryDate: string;
  input: Omit<TightenedTradeInput, 'mfeR' | 'realizedR' | 'resolution'>;
  excursionInput: ExcursionInput;
  /** Paper's realized R is the book's own (paperRealizedR — P&L over the
   *  ORIGINAL risk); the journal's comes from the excursion. Null = use the
   *  excursion's. */
  realizedR: number | null;
}

journalRouter.get(
  '/regime-tighten',
  asyncHandler(async (_req, res) => {
    const live = tightenedStockPositions(listPositions({ status: 'closed' }));
    const paper = listTightenedClosedPaperPositions(1000);
    // Tightened OPTIONS trades exist in both options books, but their
    // excursion would be on the underlying, not the premium — counted so the
    // population the ledger cannot see stays visible.
    const optionsExcluded =
      listOptionsPaperPositions({ status: 'closed' }).filter((p) => isTightenedFactor(p.regimeTargetFactor)).length +
      listLiveOptionsPositions({ status: 'closed' }).filter((p) => isTightenedFactor(p.regimeTargetFactor)).length;

    const candidates: TightenedCandidate[] = [];
    let undated = 0;
    for (const p of live) {
      if (p.entryDate === null) {
        undated++;
        continue;
      }
      // The FROZEN stop — the ledger's target R and the excursion's mfeR
      // must share one denominator, and the ratchet mutates p.stopPrice.
      const stop = p.initialStopPrice ?? p.stopPrice;
      candidates.push({
        entryDate: p.entryDate,
        input: {
          positionId: p.id,
          symbol: p.symbol,
          book: 'live',
          side: p.side,
          entryDate: p.entryDate,
          entryPrice: p.entryPrice,
          stopPrice: stop,
          targetPrice: p.targetPrice,
          factor: p.regimeTargetFactor,
        },
        excursionInput: {
          positionId: p.id,
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          multiplier: p.multiplier,
          stopPrice: stop,
          realizedPnl: realizedPnlOf(p),
          entryDate: p.entryDate,
          exitDate: lastExitDate(p),
          entryTime: p.entryTime,
          exitAt: lastExitAt(p),
        },
        realizedR: null,
      });
    }
    for (const p of paper) {
      const entryDate = etToday(p.entryAt);
      const stop = p.initialStopPrice ?? p.stopPrice;
      const side = p.side === 'buy' ? 'long' : 'short';
      candidates.push({
        entryDate,
        input: {
          positionId: p.id,
          symbol: p.symbol,
          book: 'paper',
          side,
          entryDate,
          entryPrice: p.entryPrice,
          stopPrice: stop,
          targetPrice: p.targetPrice,
          factor: p.regimeTargetFactor,
        },
        // The row's quantity is what REMAINS after a scale-out; mfeR is per
        // share (the quantity cancels), so the excursion is exact regardless,
        // and realized R comes from paperRealizedR below rather than from a
        // denominator built on the remaining quantity.
        excursionInput: {
          positionId: p.id,
          symbol: p.symbol,
          side,
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          multiplier: 1,
          stopPrice: stop,
          realizedPnl: paperRealizedPnl(p),
          entryDate,
          exitDate: p.exitAt == null ? null : etToday(p.exitAt),
          entryTime: etTimeOfDay(p.entryAt),
          exitAt: p.exitAt,
        },
        realizedR: paperRealizedR(p),
      });
    }
    candidates.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    const selected = candidates.slice(0, REGIME_TIGHTEN_TRADE_CAP);

    const provider = getProvider();
    const rows: TightenedTradeRow[] = [];
    let unavailable = 0;
    await Promise.all(
      selected.map(async (c) => {
        try {
          const ex = await excursionForTrade(provider, c.excursionInput);
          const row = ex
            ? tightenedTradeRow({
                ...c.input,
                mfeR: ex.mfeR,
                realizedR: c.realizedR ?? ex.realizedR,
                resolution: ex.resolution,
              })
            : null;
          if (row) rows.push(row);
          else unavailable++;
        } catch {
          unavailable++;
        }
      }),
    );
    rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate) || a.book.localeCompare(b.book));
    res.json(
      buildRegimeTightenLedger(rows, {
        tightenedTrades: live.length + paper.length,
        undated,
        overCap: candidates.length - selected.length,
        unavailable,
        optionsExcluded,
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
            // The overrun COMPARISON uses the live stop above; the R
            // denominator uses the frozen one. Different units, same row.
            initialStopPrice: p.initialStopPrice,
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
