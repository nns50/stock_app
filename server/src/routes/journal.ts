import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, parseQuery } from './_helpers';
import { listPositions, Position } from '../db/positions';
import { computeJournalStats, realizedPnlOf } from '../services/pnl';
import { computeDayStats } from '../services/dayGuard';
import {
  aggregateExcursions,
  barsWithinHoldingPeriod,
  computeExcursion,
  excursionForTrade,
  collectExcursions,
  EXCURSION_TRADE_CAP,
  EXCURSION_FETCH_CONCURRENCY,
  ExcursionInput,
  INTRADAY_TIMEFRAME,
} from '../services/excursion';
import {
  aggregateReplay,
  compareExitRules,
  counterfactualPathEnd,
  liveExitRules,
  replayExit,
  type ExitRules,
  type ReplayResult,
  type ReplayTrade,
} from '../services/exitReplay';
import {
  carriedExitRules,
  validateExitTuneRules,
  type ValidationTrade,
} from '../services/autotrading/exitTuneValidation';
import { computeShortShadowReport, SHORT_SHADOW_SINCE_MS } from '../services/autotrading/shortShadowRecordData';
import { getLastReentryShadowRecord } from '../db/reentryShadowRecords';
import { parseDeclinedEntry, type DeclinedEntry } from '../services/autotrading/declinedEntry';
import { readDay } from '../services/autotrading/dayMarks';
import { listDayMarkDates } from '../db/dayMarks';
import { buildDeclinedEntryShadow, SCORE_FLOOR_ACTIONS } from '../services/autotrading/declinedEntryShadow';
import { shadowFillInputs } from '../services/autotrading/declinedEntryShadowData';
import { listAutotradeEventsInWindow } from '../db/autotradeEvents';
import type { Candle } from '../providers/types';
import {
  buildRegimeTightenLedger,
  isTightenedFactor,
  tightenedStockPositions,
  tightenedTradeRow,
  tightenedTwinPathEnd,
  TightenedTradeInput,
  TightenedTradeRow,
} from '../services/autotrading/regimeTightenLedger';
import {
  countPaperPositions,
  listPaperPositions,
  listTightenedClosedPaperPositions,
  paperRealizedPnl,
  paperRealizedR,
} from '../db/autotradePaperPositions';
import { paperExcursionInput } from '../services/autotrading/paperExcursions';
import { listOptionsPaperPositions } from '../db/autotradeOptionsPaperPositions';
import { listLiveOptionsPositions } from '../db/autotradeLiveOptionsPositions';
import { aggregateSlippage } from '../services/slippage';
import { aggregateStopOverruns, classifyStopExit, computeStopOverrun, StopOverrunRow } from '../services/stopOverrun';
import { computeBenchmark } from '../services/benchmark';
import { getAutotradeConfig } from '../db/autotradeConfig';
import { runEdgeLeakScanFromDb } from '../services/autotrading/edgeLeakScanData';
import type { LeakBook } from '../services/autotrading/edgeLeakScan';
import { saveEdgeLeakScan } from '../db/edgeLeakScans';
import { buildTuneAdviceFromDb } from '../services/autotrading/tuneAdvisorData';
import { listDailyResults } from '../db/dailyResults';
import { backfillDailyResults, buildDailyResultsReport, recordDailyResult } from '../services/autotrading/dailyResults';
import { retractDailyHalt } from '../services/autotrading/dailyHaltRetraction';

/** YYYY-MM-DD. A date query that is not one should 400, not scan the world. */
const ET_DATE = /^\d{4}-\d{2}-\d{2}$/;
import { etDateTimeToMs, etTimeOfDay, etToday } from '../util/marketDate';
import { mapPool } from '../util/async';
import { computeAutoTuneRiskEfficacy } from '../services/autotrading/autoTuneEfficacy';
import { buildLiveSlippageRows } from '../services/autotrading/autoTune';
import { getProvider } from '../providers';

export const journalRouter = Router();

/** When the final exit was RECORDED (epoch ms) — the closing moment, to the
 *  precision the journal has. Autotrade books an exit on the reconcile tick
 *  that observes the fill, so this trails the real fill by up to a minute;
 *  that is well inside a 5-minute bar and is the best available answer. Null
 *  for a position with no exits. */
const lastExitAt = (p: Position): number | null =>
  p.exits.length ? Math.max(...p.exits.map((e) => e.createdAt)) : null;

/** The position's final exit — when and why — for counterfactualPathEnd and
 *  tightenedTwinPathEnd. */
const lastExitOf = (p: Position): { at: number; reason: string | null } | null => {
  if (!p.exits.length) return null;
  const last = p.exits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return { at: last.createdAt, reason: last.exitReason };
};

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
/** A same-session closed trade with its 5-minute bars already fetched, and the
 *  FROZEN stop that denominates its R. */
interface SameSessionTrade {
  position: Position & { entryDate: string };
  /** initialStopPrice, falling back to the live stop only when there is no
   *  frozen one. The ratchet mutates the live one, which is why the frozen
   *  value is preferred everywhere R is computed. */
  stop: number;
  bars: Candle[];
}

interface SameSessionLoad {
  trades: SameSessionTrade[];
  coverage: {
    closedStockTrades: number;
    undated: number;
    notSameSession: number;
    overCap: number;
    /** Trades that never produced bars at all: no stop to denominate R, or the
     *  candle fetch failed. A trade whose bars came back EMPTY is still in
     *  `trades` — the caller decides what an empty path means to it. */
    unusable: number;
  };
}

/**
 * The population both bar-path reads run on, loaded once here rather than
 * twice in two routes.
 *
 * Intraday bars only exist for a trade that opened and closed in ONE session;
 * anything else would be measured on daily bars, where a single bar spans the
 * whole day and a path replay degenerates into the peak-and-distance model
 * these routes exist to replace. Excluded and COUNTED.
 *
 * Each path runs from the entry to the END of the session, not to the exit
 * the traded geometry made (counterfactualPathEnd, 2026-09-24): both routes
 * replay OTHER geometries, and a path cut at the actual exit could never show
 * one that holds longer.
 */
async function loadSameSessionBars(): Promise<SameSessionLoad> {
  const closedStock = listPositions({ status: 'closed', assetType: 'stock' });
  const dated = closedStock.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
  const sameSession = dated.filter((p) => lastExitDate(p) === p.entryDate);
  const selected = sameSession.slice(0, EXCURSION_TRADE_CAP);

  const provider = getProvider();
  const trades: SameSessionTrade[] = [];
  let unusable = 0;
  await mapPool(selected, EXCURSION_FETCH_CONCURRENCY, async (p) => {
    try {
      const stop = p.initialStopPrice ?? p.stopPrice;
      if (stop == null) {
        unusable++;
        return;
      }
      const candles = await provider.getCandles(p.symbol, INTRADAY_TIMEFRAME, {
        start: p.entryDate,
        end: lastExitDate(p) ?? undefined,
      });
      const bars = barsWithinHoldingPeriod(candles, p.entryDate, lastExitDate(p), {
        entryAt: p.entryTime ? etDateTimeToMs(p.entryDate, p.entryTime) : null,
        exitAt: counterfactualPathEnd(lastExitOf(p)),
      });
      trades.push({ position: p, stop, bars });
    } catch {
      unusable++;
    }
  });

  return {
    trades,
    coverage: {
      closedStockTrades: closedStock.length,
      undated: closedStock.length - dated.length,
      notSameSession: dated.length - sameSession.length,
      overCap: sameSession.length - selected.length,
      unusable,
    },
  };
}

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
    // 0–100, for the scale-out share; anything else keeps the default.
    const pct = (v: unknown, dflt: number): number => Math.min(100, num(v, dflt));
    // The CURRENT policy is more than the four multiples (2026-09-11): the live
    // scale-out (when its flag is on) and the stagnation timer are part of it,
    // so a bare call replays them too. The defaults are liveExitRules, the one
    // function the paper book and the declined-entry shadow also read
    // (2026-09-23), so this route cannot replay a geometry they do not run.
    const live = liveExitRules(cfg);
    const rules: ExitRules = {
      breakevenTriggerR: num(req.query.breakevenR, live.breakevenTriggerR),
      trailStartR: num(req.query.trailStartR, live.trailStartR),
      trailStopR: num(req.query.trailStopR, live.trailStopR),
      targetR: num(req.query.targetR, live.targetR),
      scaleOutR: num(req.query.scaleOutR, live.scaleOutR ?? 0),
      scaleOutFraction: pct(req.query.scaleOutPct, cfg.partialExitPct) / 100,
      stagnationMinutes: num(req.query.stagnationMinutes, live.stagnationMinutes ?? 0),
      stagnationMinR: num(req.query.stagnationMinR, live.stagnationMinR ?? 0),
    };
    // A candidate shape rides on `c`-prefixed overrides of the SAME rules —
    // every field it does not name is the current one, so the comparison
    // isolates the change being asked about.
    const CANDIDATE_KEYS: Record<string, keyof ExitRules> = {
      cBreakevenR: 'breakevenTriggerR',
      cTrailStartR: 'trailStartR',
      cTrailStopR: 'trailStopR',
      cTargetR: 'targetR',
      cScaleOutR: 'scaleOutR',
      cStagnationMinutes: 'stagnationMinutes',
      cStagnationMinR: 'stagnationMinR',
    };
    const wantsCandidate =
      Object.keys(CANDIDATE_KEYS).some((k) => req.query[k] !== undefined) || req.query.cScaleOutPct !== undefined;
    const candidate: ExitRules | null = wantsCandidate
      ? {
          ...rules,
          ...Object.fromEntries(
            Object.entries(CANDIDATE_KEYS)
              .filter(([q]) => req.query[q] !== undefined)
              .map(([q, field]) => [field, num(req.query[q], rules[field] ?? 0)]),
          ),
          ...(req.query.cScaleOutPct !== undefined
            ? { scaleOutFraction: pct(req.query.cScaleOutPct, (rules.scaleOutFraction ?? 0) * 100) / 100 }
            : {}),
        }
      : null;

    const load = await loadSameSessionBars();
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
    const paired: ReplayTrade[] = [];
    // A trade with no stop or no candles is unreplayable for the same reason
    // one whose bars produce no path is: there is nothing to walk.
    const { unusable, ...coverage } = load.coverage;
    let unreplayable = unusable;

    for (const { position: p, stop, bars } of load.trades) {
      const input = { side: p.side, entryPrice: p.entryPrice, initialStopPrice: stop };
      const out = replayExit(input, bars, rules);
      if (!out) {
        unreplayable++;
        continue;
      }
      paired.push({ input, bars });
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
    }

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
      coverage: { ...coverage, unreplayable },
      // The candidate against the current rules over the SAME trades, with the
      // paired sign-flip test and the shared verdict rule. Null when no `c*`
      // override was asked for.
      comparison: candidate ? compareExitRules(paired, rules, candidate) : null,
      rows,
    });
  }),
);

// ---------------------------------------------------------------------------
// Does the exit AUTO-TUNE's rule make money? (task #58b)
//
// Fits excursionTune.ts's own rules on the older half of the same-session
// trades and replays the newer half under what they produced, against the
// geometry actually traded. Read this before touching autoTuneExitsEnabled —
// the rules have never been checked against a realized outcome, and their own
// answer on this book is "go to the clamp on both parameters".
//
// The bounds come from the LIVE config, so what is tested is the tuner as
// configured. See services/autotrading/exitTuneValidation.ts for the units.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/exit-tune-validation',
  asyncHandler(async (req, res) => {
    const cfg = getAutotradeConfig();
    const load = await loadSameSessionBars();
    const trades: ValidationTrade[] = [];
    const { unusable, ...coverage } = load.coverage;
    let unmeasured = unusable;

    for (const { position: p, stop, bars } of load.trades) {
      // The excursion row is computed from the SAME bars the replay walks, so
      // the rule's input and the outcome it is scored on can never come from
      // two different fetches of two different windows.
      //
      // Those bars now run to the end of the session (counterfactualPathEnd),
      // but the rule is fitted on the excursion AS HELD, bounded by the last
      // exit, because that is what autoTune.ts's own input reads. Fitted on
      // the path past the exit, this would validate a tuner that does not exist.
      const excursion = computeExcursion(
        {
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
        bars,
        'intraday',
      );
      if (!excursion) {
        unmeasured++;
        continue;
      }
      trades.push({
        positionId: p.id,
        symbol: p.symbol,
        entryDate: p.entryDate,
        side: p.side,
        entryPrice: p.entryPrice,
        initialStopPrice: stop,
        bars,
        excursion,
      });
    }

    const oosFraction = Number(req.query.oosFraction);
    const result = validateExitTuneRules(
      trades,
      { stopAtrMultiple: cfg.stopAtrMultiple, targetRMultiple: cfg.targetRMultiple },
      // Every live rule but the target the tuner varies: the scratch too, which
      // the paths now run past the exit to meet (carriedExitRules).
      carriedExitRules(liveExitRules(cfg)),
      {
        minTrades: cfg.autoTuneMinTrades,
        maxStep: cfg.autoTuneExitMaxStep,
        // NOT cfg.autoTuneExitTunedAt: this is a backtest of the rule over a
        // fixed history, and applying the live "ignore trades from before the
        // last change" gate would silently shrink the sample to whatever has
        // happened since the geometry last moved. The walk-forward split below
        // is what keeps the fit honest here.
        sampleSince: null,
      },
      { oosFraction: Number.isFinite(oosFraction) && oosFraction > 0 && oosFraction < 1 ? oosFraction : undefined },
    );

    res.json({
      ...result,
      autoTuneExitsEnabled: cfg.autoTuneExitsEnabled,
      autoTuneExitTunedAt: cfg.autoTuneExitTunedAt,
      coverage: { ...coverage, ...result.coverage, unmeasured },
    });
  }),
);

// MAE/MFE excursions: for each closed STOCK trade, how far price ran for/against
// you over the holding period. Fetches candles per trade (capped), so it's an
// on-demand analysis. Options are skipped (excursion would be on the
// underlying, not the option premium).
//
// `?book=paper` (2026-09-17) runs the identical measurement over the paper
// book — the unconstrained control arm, which had never been measured this
// way at all. Same candle walk, same cap, same coverage accounting; the only
// paper-specific line is the mapping in paperExcursions.ts.
const excursionsQuery = z.object({
  book: z.enum(['live', 'paper']).default('live'),
  limit: z.string().optional(),
});

journalRouter.get(
  '/excursions',
  asyncHandler(async (req, res) => {
    const { book } = parseQuery(excursionsQuery, req);
    // `?limit=` so a growing book can be analysed in full without a deploy —
    // the cap exists to bound work, not to be the answer to "how much history
    // may I look at".
    //
    // Clamped to the cap so a request can never ask for more work than the
    // constant allows. That clamp is DEFENSIVE AND UNTESTED on purpose: making
    // it observable needs a fixture book larger than EXCURSION_TRADE_CAP, i.e.
    // 251 closed stock trades, and a test that slow buys less than it costs.
    // The junk-limit cases are covered; this one bound is not, and saying so
    // beats a test that passes because the fixture never reaches it.
    const requested = Number(req.query.limit);
    const cap =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), EXCURSION_TRADE_CAP)
        : EXCURSION_TRADE_CAP;

    let inputs: ExcursionInput[];
    let population: number;
    let undated: number;
    // Rows the population holds that the listing never returned: this route
    // asks the paper listing for its newest 1,000, and a row beyond them is
    // beyond this request's cap in every sense that matters. Counted as overCap so
    // the coverage identity (rows + undated + overCap + unavailable =
    // population) holds past the clamp, not only under it. Untested for the
    // same reason as the `?limit=` clamp: a 1,001-row fixture is a test that
    // costs more than it buys, and saying so beats one the fixture never reaches.
    let unlisted = 0;
    if (book === 'paper') {
      const closed = listPaperPositions({ status: 'closed', limit: 1000 });
      inputs = closed.map(paperExcursionInput).filter((x): x is ExcursionInput => x !== null);
      population = countPaperPositions({ status: 'closed' });
      undated = closed.length - inputs.length;
      unlisted = population - closed.length;
    } else {
      const closedStock = listPositions({ status: 'closed', assetType: 'stock' });
      // An excursion walks candles from the entry to the exit, so a trade with
      // no known entry date cannot be measured and is left out.
      const dated = closedStock.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
      inputs = dated.map((p) => ({
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
      }));
      population = closedStock.length;
      undated = closedStock.length - dated.length;
    }
    const { rows, overCap, unavailable } = await collectExcursions(getProvider(), inputs, cap);
    res.json({
      book,
      ...aggregateExcursions(rows, {
        closedStockTrades: population,
        undated,
        overCap: overCap + unlisted,
        unavailable,
      }),
    });
  }),
);

// The counterfactual MFE ledger for the ML regime target tighten (2026-09-08):
// every closed stock trade stamped regime_target_factor < 1, paper and live,
// joined to its excursion and read per trade — see regimeTightenLedger.ts's
// header for the bound it computes and the reading it is pre-committed to.
// Same per-trade candle fetch, pool and cap as /excursions, so the work is
// bounded and what it could not cover is reported, not hidden.
const REGIME_TIGHTEN_TRADE_CAP = EXCURSION_TRADE_CAP;

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
          // "Would the FULL target have been reached?" is asked of the path
          // past the tightened TARGET's fill, to the end of the session: the
          // MFE as held stops at that exit and can never show it. Any other
          // exit closed the untightened twin at the same moment, so there the
          // path stops (tightenedTwinPathEnd, 2026-09-24).
          exitAt: tightenedTwinPathEnd(lastExitOf(p)),
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
          exitAt: tightenedTwinPathEnd(p.exitAt == null ? null : { at: p.exitAt, reason: p.exitReason }),
        },
        realizedR: paperRealizedR(p),
      });
    }
    candidates.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    const selected = candidates.slice(0, REGIME_TIGHTEN_TRADE_CAP);

    const provider = getProvider();
    const rows: TightenedTradeRow[] = [];
    let unavailable = 0;
    // Bounded like the excursion route above: fired all at once, a throttled
    // provider fails fetches that then count as `unavailable` and shrink the
    // sample the pre-committed reading is waiting on.
    await mapPool(selected, EXCURSION_FETCH_CONCURRENCY, async (c) => {
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
    });
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
// order whose limit is a fair reference for them), how the actual fill compared
// to the price you committed to. Manually logged/imported positions, bracket-leg
// exits and stop-market fills have no comparable reference and are simply not
// counted — see slippage.ts's limitIsReference for which fills count and why.
//
// The rows come from the ONE builder the leak scan and the per-symbol exclusion
// also read (2026-09-23). This route used to walk positions itself, reading only
// source_intent_id, and so measured the materialized minority of the book while
// the builder beside it had learned the adopted link.
journalRouter.get(
  '/slippage',
  asyncHandler(async (_req, res) => {
    res.json(aggregateSlippage(buildLiveSlippageRows()));
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

// ---------------------------------------------------------------------------
// THE DAILY RESULTS CALENDAR (2026-09-12, operator's ask).
//
// One row per trading session, with TWO percentages: the account figure (what
// the operator feels — it carries deposits, withdrawals and hand trading) and
// the strategy figure (what the loop did — realized P&L on its own positions
// over the same baseline). Days where they disagree by more than 0.5% of equity
// are flagged rather than quietly averaged.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/daily-results',
  asyncHandler(async (req, res) => {
    const { from, to } = parseQuery(
      z.object({ from: z.string().regex(ET_DATE).optional(), to: z.string().regex(ET_DATE).optional() }),
      req,
    );
    res.json(buildDailyResultsReport(listDailyResults(from, to)));
  }),
);

/** Re-record one day from what the database knows now — the correction path
 *  after a bad equity reading, and the way a day is written at all outside a
 *  post-close loop tick. */
journalRouter.post(
  '/daily-results/record',
  asyncHandler(async (req, res) => {
    const { date } = parseQuery(z.object({ date: z.string().regex(ET_DATE) }), req);
    res.json(recordDailyResult(date));
  }),
);

/**
 * Withdraw a live daily halt that tripped on a BOOKING ERROR (2026-09-23): a
 * loss the corrected ledger shows the loop never took. Agrees only after that
 * session has closed, and only when the corrected day's running total never
 * reached the line at any point in the session. So it cannot erase a halt the
 * loop's own trades earned; it answers 409 with the day's reading. Writes a
 * `daily_halt_retracted` row and re-records the day, so the results row and
 * the sizing review drop the halt at once. Idempotent.
 */
journalRouter.post(
  '/daily-halt/retract',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ date: z.string().regex(ET_DATE), reason: z.string().trim().min(10).max(500) }),
      req,
    );
    const outcome = retractDailyHalt({ date: body.date, reason: body.reason });
    // The refusal carries the day's reading, so a 409 says what the corrected
    // ledger shows rather than only that it said no.
    if (!outcome.ok) {
      res
        .status(outcome.status)
        .json({ error: outcome.error, ...(outcome.reading ? { reading: outcome.reading } : {}) });
      return;
    }
    res.json(outcome);
  }),
);

/** Fill the STRATEGY columns for past sessions. The account columns stay null:
 *  before the baseline row existed nothing recorded what equity opened at, and
 *  a cell that says "no account figure" beats one showing a guess. */
journalRouter.post(
  '/daily-results/backfill',
  asyncHandler(async (req, res) => {
    const { from } = parseQuery(z.object({ from: z.string().regex(ET_DATE) }), req);
    res.json(backfillDailyResults(from));
  }),
);

// ---------------------------------------------------------------------------
// THE TUNE ADVISOR (2026-09-12): what to change next, ranked by how much of the
// gap to the daily goal each change would actually close.
//
// Everything it returns is the app's own identity differentiated —
// `expected day % = trades/session x risk% x avg R` — so a recommendation names
// which term it moves and estimates its effect in percentage points of the
// expected day. Recommendations are not only settings: where the data implies
// something that has no config field, the action comes back as `code` with what
// to build.
//
// It reads the goal evidence, the last edge-leak scan and the review window.
// Nothing new is collected, so its numbers cannot disagree with the cards the
// operator is already reading.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/tune-advice',
  asyncHandler(async (req, res) => {
    const { sessions } = parseQuery(z.object({ sessions: z.coerce.number().int().min(1).max(250).optional() }), req);
    res.json(buildTuneAdviceFromDb(Date.now(), sessions));
  }),
);

// ---------------------------------------------------------------------------
// THE EDGE-LEAK SCAN (Decision 11, 2026-09-12).
//
// Walks a fixed catalog of dimensions over both books under one statistical
// bar and reports what fails it, with the lever that closes it. DB and journal
// only — no market data, no provider quota — so it is safe to run from the
// daily routine as well as on demand.
//
// It PERSISTS its result (one row, edge_leak_scans) because the dashboard's
// card reads the last scan rather than running one: a per-bucket bootstrap over
// both books is CPU the poll path must not pay. Same arrangement as the
// daily-target sweep.
//
// Why it exists at all is worth repeating here, where someone will read it:
// every leak found in this book so far was found because a human happened to
// look, and all of them were visible in journals the app was already writing.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/edge-leaks',
  asyncHandler(async (req, res) => {
    const { sessions, book, persist } = parseQuery(
      z.object({
        sessions: z.coerce.number().int().min(1).max(250).optional(),
        book: z.enum(['live', 'paper', 'both']).optional(),
        /** The daily routine persists; an exploratory read does not have to.
         *  NOT z.coerce.boolean(), which is how the neighbouring `force` flags
         *  are written: Boolean('false') is TRUE, so `persist=false` would
         *  silently persist. A flag whose whole purpose is to say "no" has to
         *  be able to. */
        persist: z.enum(['true', 'false']).optional(),
      }),
      req,
    );
    const books: LeakBook[] = book === 'live' ? ['live'] : book === 'paper' ? ['paper'] : ['live', 'paper'];
    const result = runEdgeLeakScanFromDb({ lookbackSessions: sessions, books });
    if (persist !== 'false') saveEdgeLeakScan(result);
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// The SHORT SHADOW RECORD (2026-09-10) — what the live book would have made on
// the shorts it declined, replayed on real bars.
//
// Task #21's enabling rule reads the PAPER book's closed shorts, and paper is
// the wrong instrument for the question: three slots, a score floor of 60
// against live's 72, filled first-come. On 2026-09-10 every one of 1000 sampled
// paper risk checks was refused on max_concurrent_positions and two of five
// paper entries scored below the live floor, so the sample the decision reads
// is a slot lottery skewed to early-session signals rather than a sample of
// live-eligible shorts.
//
// This replays the DECLINED signals instead. Every input is already journaled
// on live_short_skipped, so nothing new is captured — only bars are fetched.
// Read services/autotrading/shortShadowRecord.ts for the three things this
// number is NOT before quoting it; in particular it reuses exitReplay, which
// resolves every intrabar ambiguity against the trade, so it UNDERSTATES.
//
// The loader and the compute path live in shortShadowRecordData.ts since
// 2026-09-19, shared with the loop's after-close hook, which persists the
// default-window record for the `shorts` gated switch. Until then this route
// was the record's only reader — the switch that was written to read those
// three numbers evaluated to null for want of them.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/short-shadow-record',
  asyncHandler(async (req, res) => {
    const { since } = parseQuery(z.object({ since: z.coerce.number().optional() }), req);
    // Defaults to the day short-dated evidence started accruing, matching the
    // window task #21's own gate is measured over.
    res.json(await computeShortShadowReport(since ?? SHORT_SHADOW_SINCE_MS));
  }),
);

// ---------------------------------------------------------------------------
// GET /api/journal/reentry-shadow-record
//
// The re-entry cooldown's record as the leak scan read it (2026-09-19): every
// symbol-day the cooldown refused over the window, replayed at the first
// refusal and 60 / 120 / 180 minutes after the exit. STORED, not recomputed:
// the loop computes it once per session after the close
// (reentryShadowRecordData.ts) and this serves that row, so the reader and the
// scan's cooldown finding look at the same numbers. A fresh reading at one gap
// is `declined-entry-shadow?action=symbol_reentry_cooldown_skipped&
// minMinutesSinceExit=`. `record` is null before the first after-close tick.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/reentry-shadow-record',
  asyncHandler(async (_req, res) => {
    res.json({ record: getLastReentryShadowRecord() });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/journal/declined-entry-shadow?action=&since=
//
// The same replay as the short record, pointed at any other refusal class
// (2026-09-14). It exists because the biggest gate on the entry path had no
// reading at all: `risk_atr_unreachable_skipped` refused 80 symbol-days over
// eight sessions — SIXTEEN on 09-14 against four entries actually placed — and
// neither the journal nor the paper book could say whether that was the gate
// protecting the book or the gate being the reason the book has no flow.
//
// Paper is not the control it was assumed to be. The ATR gate was made
// live-only in 2026-09-01 expressly so paper would be the control group, and
// over those eight sessions exactly TWO closed paper trades land on a
// symbol-day the gate refused: paper's three slots fill early on the same
// high-ATR names and it never reaches the ones the gate turns away.
//
// Reads empty for rows written before the entry/stop fields existed — those
// cannot be scored and are counted as `unscorableRows` rather than silently
// skipped, so a thin reading is visibly thin instead of looking like a verdict.
//
// THE WHOLE WINDOW, NOT THE NEWEST 1,000 ROWS OF IT (2026-09-19). This read
// was `listAutotradeEvents({ limit: 1000 })`, which clamps and orders newest
// first — fine for a gate that journals once per symbol-day, and silently
// wrong for the re-entry cooldown, which journals EVERY tick it refuses a name
// (436 rows on 09-18 alone, three names cooling for an afternoon). Asked for
// the week of 09-14, it returned 09-18, 09-15 and the last 62 rows of 09-14,
// dropping 293 of that day's 355 without a word: the same LIMIT artifact the
// leak scan's skip collector walked into on 09-12. `journalTruncated` now says
// when even the windowed read hit its ceiling.
//
// `minMinutesSinceExit` (same day) is the question a SHORTER cooldown asks —
// see ShadowOptions — and is meaningful only for that gate's rows.
// ---------------------------------------------------------------------------
journalRouter.get(
  '/declined-entry-shadow',
  asyncHandler(async (req, res) => {
    const { action, since, minMinutesSinceExit } = parseQuery(
      z.object({
        action: z.string().min(1).max(64),
        since: z.coerce.number().optional(),
        minMinutesSinceExit: z.coerce
          .number()
          .int()
          .min(0)
          .max(24 * 60)
          .optional(),
      }),
      req,
    );
    const cfg = getAutotradeConfig();
    const from = since ?? Date.now() - 40 * 24 * 60 * 60 * 1000;
    const { events: journaled, truncated } = listAutotradeEventsInWindow({ actions: [action], since: from });
    const rows: DeclinedEntry[] = [];
    let unscorableRows = 0;
    for (const e of journaled) {
      const parsed = parseDeclinedEntry(e);
      if (parsed) rows.push(parsed);
      else unscorableRows += 1;
    }
    // The floor filter answers "would the book have wanted this candidate at
    // all, setting aside THIS gate" — which is the wrong question when the gate
    // under test is the floor itself: it would drop exactly the rows that
    // constitute the evidence and return an empty record that reads as "no
    // signal" instead of "wrong question".
    const applyScoreFloor = !SCORE_FLOOR_ACTIONS.has(action);
    const record = await buildDeclinedEntryShadow(getProvider(), rows, cfg, {
      applyScoreFloor,
      minMinutesSinceExit,
      ...shadowFillInputs(from),
    });
    res.json({
      action,
      since: from,
      journaledRows: journaled.length,
      journalTruncated: truncated,
      unscorableRows,
      applyScoreFloor,
      ...record,
    });
  }),
);

/**
 * The shape of one session's day (2026-09-15) — the series the baseline row
 * never kept, so that "we were over 3% for five minutes" has an answer after
 * the fact rather than only in the moment.
 *
 * `goal` defaults to the CONFIGURED target so the above-goal count means what
 * the reader expects, but it is overridable: judging a past session by today's
 * goal is the live-config-over-history mistake, and a caller reading an old day
 * should pass the goal that day actually ran.
 */
const dayMarksQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  goalPct: z.coerce.number().positive().optional(),
});
journalRouter.get(
  '/day-marks',
  asyncHandler(async (req, res) => {
    const { date, goalPct } = parseQuery(dayMarksQuery, req);
    const etDate = date ?? etToday();
    const goal = goalPct ?? getAutotradeConfig().targetDailyGainPct;
    const { points, summary } = readDay(etDate, goal);
    res.json({ etDate, goalPct: goal, samples: points.length, summary, points, dates: listDayMarkDates() });
  }),
);
