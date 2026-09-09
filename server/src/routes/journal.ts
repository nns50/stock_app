import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { getIntent } from '../db/orders';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { computeDayStats } from '../services/dayGuard';
import {
  aggregateExcursions,
  barsWithinHoldingPeriod,
  excursionForTrade,
  INTRADAY_TIMEFRAME,
  TradeExcursion,
} from '../services/excursion';
import { aggregateReplay, replayExit, type ExitRules, type ReplayResult } from '../services/exitReplay';
import { aggregateSlippage, computeSlippage, SlippageRow } from '../services/slippage';
import { aggregateStopOverruns, classifyStopExit, computeStopOverrun, StopOverrunRow } from '../services/stopOverrun';
import { computeBenchmark } from '../services/benchmark';
import { getAutotradeConfig } from '../db/autotradeConfig';
import { etDateTimeToMs } from '../util/marketDate';
import { mapPool } from '../util/async';
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

// ---------------------------------------------------------------------------
// Exit-rule PATH replay. Walks each same-session trade's 5-minute bars in order
// against a candidate exit geometry and reports where it would really have been
// closed — the question /excursions structurally cannot answer, because it
// collapses a trade to its high and low and so has no dip in it.
//
// Defaults come from the LIVE config, so a bare call answers "what would today's
// geometry have done" and any query param answers "what would this one change".
// Both are returned against the ACTUAL realized R on the same trades, paired.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/exit-replay',
  asyncHandler(async (req, res) => {
    const cfg = getAutotradeConfig();
    const num = (v: unknown, dflt: number): number => {
      const n = Number(v);
      // Same guard as the excursion cap: Number('abc') is NaN, and a NaN
      // threshold silently disables the rule it belongs to rather than erroring.
      return Number.isFinite(n) && n >= 0 ? n : dflt;
    };
    const rules: ExitRules = {
      breakevenTriggerR: num(req.query.breakevenR, cfg.breakevenTriggerRMultiple),
      trailStartR: num(req.query.trailStartR, cfg.trailStartRMultiple),
      trailStopR: num(req.query.trailStopR, cfg.trailStopRMultiple),
      targetR: num(req.query.targetR, cfg.targetRMultiple),
    };

    const closedStock = listPositions({ status: 'closed', assetType: 'stock' });
    const dated = closedStock.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
    // Intraday bars only exist for a trade that opened and closed in ONE
    // session; anything else would be replayed on daily bars, where a single
    // bar spans the whole day and the replay degenerates into the peak-and-
    // distance model this route exists to replace. Excluded and COUNTED.
    const sameSession = dated.filter((p) => lastExitDate(p) === p.entryDate);
    const selected = sameSession.slice(0, EXCURSION_TRADE_CAP);

    const provider = getProvider();
    const rows: {
      positionId: number;
      symbol: string;
      entryDate: string;
      actualR: number | null;
      replayR: number;
      reason: string;
      bestR: number;
    }[] = [];
    const results: ReplayResult[] = [];
    const actualRs: number[] = [];
    let unreplayable = 0;

    await mapPool(selected, EXCURSION_FETCH_CONCURRENCY, async (p) => {
      try {
        const stop = p.initialStopPrice ?? p.stopPrice;
        if (stop == null) {
          unreplayable++;
          return;
        }
        const candles = await provider.getCandles(p.symbol, INTRADAY_TIMEFRAME, {
          start: p.entryDate,
          end: lastExitDate(p) ?? undefined,
        });
        const bars = barsWithinHoldingPeriod(candles, p.entryDate, lastExitDate(p), {
          entryAt: p.entryTime ? etDateTimeToMs(p.entryDate, p.entryTime) : null,
          exitAt: lastExitAt(p),
        });
        const out = replayExit({ side: p.side, entryPrice: p.entryPrice, initialStopPrice: stop }, bars, rules);
        if (!out) {
          unreplayable++;
          return;
        }
        const risk = Math.abs(p.entryPrice - stop) * p.quantity * p.multiplier;
        const actualR = risk > 0 ? Math.round((realizedPnlOf(p) / risk) * 100) / 100 : null;
        results.push(out);
        if (actualR !== null) actualRs.push(actualR);
        rows.push({
          positionId: p.id,
          symbol: p.symbol,
          entryDate: p.entryDate,
          actualR,
          replayR: out.exitR,
          reason: out.reason,
          bestR: Math.round(out.bestR * 100) / 100,
        });
      } catch {
        unreplayable++;
      }
    });

    rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    const mean = (xs: number[]) =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
    res.json({
      rules,
      replay: aggregateReplay(results),
      // The SAME trades' real outcome. Paired on purpose: comparing a replay
      // over one population against a headline average over another is how a
      // rule change comes to look like an improvement it never made.
      actual: { trades: actualRs.length, meanR: mean(actualRs) },
      coverage: {
        closedStockTrades: closedStock.length,
        undated: closedStock.length - dated.length,
        notSameSession: dated.length - sameSession.length,
        overCap: sameSession.length - selected.length,
        unreplayable,
      },
      rows,
    });
  }),
);

// MAE/MFE excursions: for each closed STOCK trade, how far price ran for/against
// you over the holding period. Fetches daily candles per trade (capped), so it's
// an on-demand analysis. Options are skipped (excursion would be on the
// underlying, not the option premium).
/** One daily-candle fetch per trade, so the work is bounded. Newest trades win
 *  (listPositions orders by date DESC) and the number dropped is REPORTED — see
 *  ExcursionCoverage.
 *
 *  Raised from 50 on 2026-09-08. At 50 this route was analysing 50 of the 92
 *  measurable closed stock trades and silently reporting the other 42 as
 *  `overCap` — which is what made task #32's target-multiple comparison
 *  undecidable: every candidate target came out inside noise, and at 1.25R and
 *  above only three or four trades differed at all. A cap that throws away half
 *  the evidence is the binding constraint on a question about the tail. */
const EXCURSION_TRADE_CAP = 250;

/** Concurrent candle fetches. `Promise.all` over every selected trade fired all
 *  of them at once, which was survivable at 50 and is not the thing to scale:
 *  the provider rate-limits hard enough that the screener already loses ~47 of
 *  559 symbols a tick to it, and here a throttled fetch does not fail loudly —
 *  it lands in `unavailable` and SHRINKS the sample, which is the exact opposite
 *  of what raising the cap is for. Same pool size the screener uses. */
const EXCURSION_FETCH_CONCURRENCY = 6;

journalRouter.get(
  '/excursions',
  asyncHandler(async (req, res) => {
    // `?limit=` so a growing book can be analysed in full without a deploy —
    // the cap above exists to bound work, not to be the answer to "how much
    // history may I look at".
    //
    // Clamped to the cap so a request can never ask for more work than the
    // constant allows. That clamp is DEFENSIVE AND UNTESTED on purpose: making
    // it observable needs a fixture book larger than EXCURSION_TRADE_CAP, i.e.
    // 251 closed stock trades, and a test that slow buys less than it costs.
    // The junk-limit cases below are covered; this one bound is not, and saying
    // so beats a test that passes because the fixture never reaches it.
    const requested = Number(req.query.limit);
    const cap =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), EXCURSION_TRADE_CAP)
        : EXCURSION_TRADE_CAP;
    const closedStock = listPositions({ status: 'closed', assetType: 'stock' });
    // An excursion walks daily candles from the entry to the exit, so a trade
    // with no known entry date cannot be measured and is left out.
    const dated = closedStock.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
    const selected = dated.slice(0, cap);
    const provider = getProvider();
    const rows: TradeExcursion[] = [];
    let unavailable = 0;
    await mapPool(selected, EXCURSION_FETCH_CONCURRENCY, async (p) => {
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
    });
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
