// MAE / MFE excursion analysis. For a closed trade, over the candles spanning its
// holding period, how far did price run in your favor (Maximum Favorable
// Excursion) and against you (Maximum Adverse Excursion)? Expressed in R when a
// stop was logged. Reveals stops that are too tight and winners exited too early.

import { Candle, Timeframe } from '../providers/types';
import { etDateTimeToMs } from '../util/marketDate';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ExcursionInput {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  multiplier: number;
  stopPrice: number | null;
  realizedPnl: number;
  entryDate: string;
  /** Last exit date (ET, YYYY-MM-DD). Null for a trade with no dated exit —
   *  the window is then open-ended forward from the entry. */
  exitDate?: string | null;
  /** ET wall-clock entry time (HH:MM), when known. Narrows an INTRADAY window
   *  only; ignored on daily bars, which have no intraday extent. */
  entryTime?: string | null;
  /** Epoch ms of the last exit, when known. Same intraday-only role. */
  exitAt?: number | null;
}

/** Which bars an excursion was measured on. Daily is an UPPER BOUND for a trade
 *  held less than a session: that bar's high/low span the whole day, including
 *  hours the position did not exist. */
export type ExcursionResolution = 'intraday' | 'daily';

/** 5-minute bars: fine enough that a 90-minute hold is ~18 observations instead
 *  of one daily high/low, coarse enough that a 50-trade report stays one
 *  reasonable fetch per trade. 1-minute is sharper on wicks but 5x the payload
 *  and the shortest history providers retain. */
export const INTRADAY_TIMEFRAME: Timeframe = '5min';

export interface TradeExcursion {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  entryDate: string;
  mfePct: number; // best favorable excursion, % of cost basis (>= 0)
  maePct: number; // worst adverse excursion, % of cost basis (<= 0)
  mfeR: number | null;
  maeR: number | null;
  realizedR: number | null;
  /** Of the favorable move available (MFE), what fraction you kept. Winners only. */
  capturedPct: number | null;
  /** Bars this row was measured on. A 'daily' row for a same-session trade is an
   *  upper bound, not a measurement — it includes hours the position did not
   *  exist. Carried per row so a mixed report can be read honestly. */
  resolution: ExcursionResolution;
}

/** ET calendar date of a bar, matching how entry/exit dates are stored. */
const etDateOf = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The bars that fall inside `[entryDate, exitDate]`, inclusive.
 *
 * This function used to take the caller's word for it and scan EVERY bar it was
 * handed. Both callers ask their provider for `{start: entryDate, end:
 * exitDate}` and reasonably assumed that bounded the fetch — but the live
 * provider (Webull) has no date-range parameter at all: its bars endpoint takes
 * only a `count`, and `start`/`end` were dropped on the floor. So the fetch
 * returned the most recent 120 daily bars (the default limit) and this walked
 * all of them, making MAE/MFE the symbol's ~6-MONTH high/low rather than the
 * trade's excursion.
 *
 * The numbers that produced were not subtly wrong, they were impossible:
 * +20.95R average MFE and -4.28R average MAE across the book on 2026-08-25 — an
 * average adverse excursion four times the stop distance, on trades that would
 * have been stopped out at 1R. A single VALE day trade reported +3.98R / -2.72R
 * against an actual daily-bar excursion of +0.14R / -0.90R; its "15.26% MFE"
 * was VALE's six-month high, months before the position existed.
 *
 * So the window is enforced HERE, where the requirement actually lives, rather
 * than trusted to a provider that may not support ranges. Providers that do
 * honor start/end simply hand over a set this filter passes through untouched.
 */
export function barsWithinHoldingPeriod(
  candles: Candle[],
  entryDate: string,
  exitDate?: string | null,
  /** Intraday only: narrow further to the minutes actually held. A DAILY bar is
   *  stamped at its session and has no intraday extent, so applying these to one
   *  would discard the very bar being measured. */
  bounds?: { entryAt?: number | null; exitAt?: number | null },
): Candle[] {
  return candles.filter((c) => {
    if (!(c.time > 0)) return false;
    const day = etDateOf.format(c.time);
    if (day < entryDate) return false;
    if (exitDate != null && day > exitDate) return false;
    if (bounds?.entryAt != null && c.time < bounds.entryAt) return false;
    if (bounds?.exitAt != null && c.time > bounds.exitAt) return false;
    return true;
  });
}

/** Just enough of a provider to fetch candles — structural so callers and tests
 *  can pass anything shaped right. */
export interface CandleSource {
  getCandles(
    symbol: string,
    timeframe: Timeframe,
    query?: { start?: string; end?: string; limit?: number },
  ): Promise<Candle[]>;
}

/**
 * Fetch the right bars for a trade and measure its excursion — the ONE path
 * both callers (the Journal's /excursions route and auto-tune's own report)
 * now share. They previously carried near-identical copies of this logic and
 * therefore carried identical bugs; keeping it in one place is what stops the
 * next fix from landing on only one of them.
 *
 * A trade opened and closed in the SAME session is measured on intraday bars.
 * On daily bars such a trade gets that whole day's high and low — including
 * hours it did not exist — which for this loop (90-minute stagnation exit,
 * maxHoldDays 1) is most of them. VALE on 2026-08-24 was held 11:37-13:09 and
 * read its full session range.
 *
 * Intraday history is short (providers retain far less of it than daily), so
 * when it cannot be had this falls back to daily and SAYS SO via the row's
 * `resolution` — an upper bound labelled as one, never a precise-looking number
 * that quietly isn't.
 */
export async function excursionForTrade(source: CandleSource, p: ExcursionInput): Promise<TradeExcursion | null> {
  const sameSession = p.exitDate != null && p.exitDate === p.entryDate;
  if (sameSession) {
    try {
      const intraday = await source.getCandles(p.symbol, INTRADAY_TIMEFRAME, {
        start: p.entryDate,
        end: p.exitDate ?? undefined,
      });
      const row = computeExcursion(p, intraday, 'intraday');
      if (row) return row;
      // No usable intraday bars in the window (history aged out, or a provider
      // that only serves daily) — fall through rather than report nothing.
    } catch {
      // Same: an intraday fetch failure must not lose the trade entirely.
    }
  }
  const daily = await source.getCandles(p.symbol, 'daily', { start: p.entryDate, end: p.exitDate ?? undefined });
  return computeExcursion(p, daily, 'daily');
}

export function computeExcursion(
  p: ExcursionInput,
  candles: Candle[],
  resolution: ExcursionResolution = 'daily',
): TradeExcursion | null {
  if (!candles.length || !p.entryPrice) return null;
  const sign = p.side === 'long' ? 1 : -1;
  const costBasis = p.entryPrice * p.quantity * p.multiplier;
  const initialRisk =
    p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.quantity * p.multiplier || null : null;

  // Bars outside the holding period are not this trade's excursion. A window
  // that lands on no bars at all measures nothing, and is reported as
  // unmeasurable (null) rather than silently falling back to the full set —
  // the whole defect this filter exists to fix was a silent widening.
  //
  // On intraday bars the window narrows again to the MINUTES held: a daily bar
  // can only say "somewhere that session", but 5-minute bars can say "while you
  // were actually in it", which is the whole point of fetching them.
  const held = barsWithinHoldingPeriod(
    candles,
    p.entryDate,
    p.exitDate,
    resolution === 'intraday'
      ? { entryAt: p.entryTime ? etDateTimeToMs(p.entryDate, p.entryTime) : null, exitAt: p.exitAt ?? null }
      : undefined,
  );
  if (!held.length) return null;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const c of held) {
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
  }
  const favPrice = sign === 1 ? maxHigh : minLow; // most favorable price reached
  const advPrice = sign === 1 ? minLow : maxHigh; // most adverse price reached
  const favDollar = Math.max(0, (favPrice - p.entryPrice) * sign * p.quantity * p.multiplier);
  const advDollar = Math.min(0, (advPrice - p.entryPrice) * sign * p.quantity * p.multiplier);

  const mfeR = initialRisk ? round2(favDollar / initialRisk) : null;
  const maeR = initialRisk ? round2(advDollar / initialRisk) : null;
  const realizedR = initialRisk ? round2(p.realizedPnl / initialRisk) : null;
  return {
    positionId: p.positionId,
    symbol: p.symbol,
    side: p.side,
    entryDate: p.entryDate,
    mfePct: costBasis ? round2((favDollar / costBasis) * 100) : 0,
    maePct: costBasis ? round2((advDollar / costBasis) * 100) : 0,
    mfeR,
    maeR,
    realizedR,
    capturedPct: mfeR && mfeR > 0 && realizedR != null ? round2((realizedR / mfeR) * 100) : null,
    resolution,
  };
}

/**
 * What the analysis actually covered. This endpoint fetches daily candles per
 * trade, so it caps how many it will do and cannot always get data — both of
 * which used to happen invisibly: `trades` counts only what SUCCEEDED, so a
 * report over 12 of your 70 trades was indistinguishable from one over all 12
 * you have. Averages computed from a silently truncated sample are the kind of
 * number you would act on without knowing you shouldn't.
 */
export interface ExcursionCoverage {
  /** Closed stock trades in the journal — the population before any filtering. */
  closedStockTrades: number;
  /** Skipped: an excursion walks candles from the entry, so it needs an entry date. */
  undated: number;
  /** Dropped by the per-request cap, most recent trades kept. */
  overCap: number;
  /** Attempted but unusable — the candle fetch failed or returned nothing. */
  unavailable: number;
}

export interface ExcursionReport {
  /** Trades actually analysed — the rows below. See `coverage` for what it took. */
  trades: number;
  avgMfeR: number | null;
  avgMaeR: number | null;
  avgRealizedR: number | null;
  /** Average % of the favorable move captured on winning trades. */
  capturePct: number | null;
  rows: TradeExcursion[];
  coverage: ExcursionCoverage;
  /** How many rows were measured on intraday vs daily bars. A same-session
   *  trade measured on a DAILY bar reports that whole day's range, so a report
   *  averaging the two is mixing measurements with upper bounds — visible here
   *  rather than left for the reader to assume. */
  resolutionMix: { intraday: number; daily: number };
}

function mean(xs: number[]): number | null {
  return xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

/**
 * `coverage` defaults to "these rows were the whole population", which is true
 * for a direct call and false for the route — so the route passes its real
 * counts. It is deliberately not optional-and-ignored: a default that claimed
 * full coverage while the caller had truncated would reintroduce the bug.
 */
export function aggregateExcursions(rows: TradeExcursion[], coverage?: Partial<ExcursionCoverage>): ExcursionReport {
  const withR = rows.filter((r) => r.mfeR !== null);
  const captures = rows.filter((r) => r.capturedPct !== null).map((r) => r.capturedPct as number);
  return {
    trades: rows.length,
    avgMfeR: mean(withR.map((r) => r.mfeR as number)),
    avgMaeR: mean(withR.map((r) => r.maeR as number)),
    avgRealizedR: mean(withR.map((r) => r.realizedR as number)),
    capturePct: mean(captures),
    rows,
    resolutionMix: {
      intraday: rows.filter((r) => r.resolution === 'intraday').length,
      daily: rows.filter((r) => r.resolution !== 'intraday').length,
    },
    coverage: {
      closedStockTrades: rows.length,
      undated: 0,
      overCap: 0,
      unavailable: 0,
      ...coverage,
    },
  };
}
