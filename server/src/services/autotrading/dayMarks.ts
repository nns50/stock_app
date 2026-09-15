import { getProvider } from '../../providers';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { getDailyBaseline } from '../../db/dailyBaseline';
import { listPositions, Position } from '../../db/positions';
import { listLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { DayMark, listDayMarks, saveDayMark } from '../../db/dayMarks';
import { etToday } from '../../util/marketDate';
import { strategyDayFor } from './dailyResults';

// ---------------------------------------------------------------------------
// THE SHAPE OF THE DAY, SAMPLED (2026-09-15, the operator's ask).
//
// "We were over 3% for five minutes this morning, and now we're not" could not
// be checked: the app kept the day's OPENING equity and overwrote the current
// figure every tick. Nothing recorded what happened in between, so a question
// about 10:05 was unanswerable by 10:20.
//
// WHY NOT POLL EVERY SECOND, which is the obvious version of this. The account
// figure comes from the broker, whose API is rate-limited to roughly 2 requests
// per 2 seconds SHARED WITH THE ORDER PATHS (providers/webull/client.ts) —
// polling it per second would starve placement and cancellation to watch a
// number. And it is unnecessary: the day is computable locally. Realized P&L
// comes from the ledger, and the mark needs one quote per open position, which
// the tick ALREADY fetches for the stop ratchet and the stagnation check. The
// provider caches quotes, so this stage adds no provider calls in the ordinary
// case — it reads what the tick already paid for.
//
// 60-second resolution is not a compromise either: it is the cadence every
// other rule in this loop acts on, and it puts five samples inside a
// five-minute window.
//
// WHAT THE THREE NUMBERS ARE FOR. `realized` is what the day-level halts decide
// on since 2026-09-14. `realized + unrealizedEquity` is the day marked to
// market — what a "flatten at the goal" rule WOULD decide on, if that is ever
// built. `accountEquity` is what the operator sees. On a session with no hand
// trading the first two sum to the third's move, and the gap between the first
// two is exactly the open question: how often does a 3% MARK appear while the
// realized day never gets there, and how often does that mark survive to the
// close? This series is the evidence for that decision rather than one
// morning's impression of it.
//
// OPTIONS ARE NOT IN THE MARK, and the field is named for it. Pricing a
// contract needs a chain fetch, far too expensive per tick; `openOptions`
// records how many are excluded so a reader can tell a complete mark from a
// partial one instead of assuming.
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isAutotrade = (p: Position): boolean => p.tags.includes('autotrade');

/** Percentages are derived HERE, on read, and never stored — a stored
 *  percentage is a second derivation of the same quantity waiting to disagree
 *  with the dollars beside it. */
export interface DayMarkPoint extends DayMark {
  /** The loop's banked day, as a % of the baseline — `dailyTarget.gainPct`. */
  realizedPct: number;
  /** The loop's day marked to market: realized plus the open stock mark. */
  markedPct: number;
  /** The whole account's move, or null when the broker read failed. */
  accountPct: number | null;
}

export function toPoint(m: DayMark): DayMarkPoint {
  const base = m.baselineEquityUsd;
  const pct = (usd: number): number => (base > 0 ? round2((usd / base) * 100) : 0);
  return {
    ...m,
    realizedPct: pct(m.realizedUsd),
    markedPct: pct(m.realizedUsd + m.unrealizedEquityUsd),
    accountPct: m.accountEquityUsd === null || !(base > 0) ? null : round2(((m.accountEquityUsd - base) / base) * 100),
  };
}

export interface DayMarkExtreme {
  pct: number;
  at: number;
}

export interface DayMarkSummary {
  etDate: string;
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
  /** High-water and low-water marks for each series. Null when no sample
   *  carried that series (the account one is absent on a day the broker read
   *  never succeeded). */
  realizedPeak: DayMarkExtreme | null;
  realizedTrough: DayMarkExtreme | null;
  markedPeak: DayMarkExtreme | null;
  markedTrough: DayMarkExtreme | null;
  accountPeak: DayMarkExtreme | null;
  accountTrough: DayMarkExtreme | null;
  /** Samples whose MARKED day was at or above the goal, and how long that ran
   *  in minutes at the tick cadence. The direct answer to "we were over 3% for
   *  five minutes": null when no goal was configured on the samples. */
  goalPct: number | null;
  markedAtOrAboveGoal: number;
  markedAboveGoalMinutes: number | null;
  realizedAtOrAboveGoal: number;
}

/** Pure: everything the series says about a day. Split out so the peaks and the
 *  above-goal count are testable without a loop tick or a broker. */
export function summarizeDayMarks(etDate: string, marks: DayMark[], goalPct: number | null): DayMarkSummary {
  const points = marks.map(toPoint);
  const extreme = (pick: (p: DayMarkPoint) => number | null, cmp: (a: number, b: number) => boolean) => {
    let best: DayMarkExtreme | null = null;
    for (const p of points) {
      const v = pick(p);
      if (v === null) continue;
      if (best === null || cmp(v, best.pct)) best = { pct: v, at: p.at };
    }
    return best;
  };
  const gt = (a: number, b: number) => a > b;
  const lt = (a: number, b: number) => a < b;
  const markedAtOrAbove = goalPct === null ? 0 : points.filter((p) => p.markedPct >= goalPct).length;
  // Minutes from the tick CADENCE, not from a clock: the samples are what we
  // have, and a gap in them (a restart, a stalled tick) must not read as time
  // spent above the goal. Two samples a minute apart is one minute.
  const spanMinutes = (sel: DayMarkPoint[]): number | null => {
    if (sel.length === 0) return 0;
    if (points.length < 2) return null;
    const step = (points[points.length - 1].at - points[0].at) / (points.length - 1) / 60_000;
    return round2(sel.length * step);
  };
  return {
    etDate,
    samples: points.length,
    firstAt: points[0]?.at ?? null,
    lastAt: points[points.length - 1]?.at ?? null,
    realizedPeak: extreme((p) => p.realizedPct, gt),
    realizedTrough: extreme((p) => p.realizedPct, lt),
    markedPeak: extreme((p) => p.markedPct, gt),
    markedTrough: extreme((p) => p.markedPct, lt),
    accountPeak: extreme((p) => p.accountPct, gt),
    accountTrough: extreme((p) => p.accountPct, lt),
    goalPct,
    markedAtOrAboveGoal: markedAtOrAbove,
    markedAboveGoalMinutes: goalPct === null ? null : spanMinutes(points.filter((p) => p.markedPct >= goalPct)),
    realizedAtOrAboveGoal: goalPct === null ? 0 : points.filter((p) => p.realizedPct >= goalPct).length,
  };
}

/**
 * Sample the day. Called once per loop tick; a no-op (returns null) before the
 * baseline exists, because without a denominator there is nothing to record.
 *
 * Quotes come from the provider's cache in the ordinary case — the tick has
 * already priced these same symbols — and a quote that fails is simply left out
 * of the mark rather than failing the sample: a partial mark with a known
 * position count beats no row at all.
 */
export async function recordDayMark(now: number = Date.now()): Promise<DayMark | null> {
  const baseline = getDailyBaseline();
  const today = etToday(now);
  if (!baseline || baseline.etDate !== today || !(baseline.equityUsd > 0)) return null;

  const open = listPositions({ status: 'open' }).filter((p) => isAutotrade(p) && p.assetType === 'stock');
  let unrealized = 0;
  for (const p of open) {
    try {
      const { last } = await getProvider().getQuote(p.symbol.toUpperCase());
      if (!Number.isFinite(last) || last <= 0) continue;
      const dir = p.side === 'short' ? -1 : 1;
      unrealized += (last - p.entryPrice) * p.remainingQuantity * (p.multiplier ?? 1) * dir;
    } catch {
      // No quote for this name this tick — it drops out of the mark. The row
      // still records how many positions were open, so a reader can see the
      // mark is short of the book rather than trusting it as complete.
    }
  }

  const mark: DayMark = {
    etDate: today,
    at: now,
    baselineEquityUsd: baseline.equityUsd,
    realizedUsd: strategyDayFor(today).pnlUsd,
    unrealizedEquityUsd: round2(unrealized),
    accountEquityUsd: getAutotradeConfig().accountEquityUsd,
    openEquity: open.length,
    openOptions: listLiveOptionsPositions({ status: 'open' }).length,
  };
  saveDayMark(mark);
  return mark;
}

/** The series and its summary for one ET date. */
export function readDay(etDate: string, goalPct: number | null): { points: DayMarkPoint[]; summary: DayMarkSummary } {
  const marks = listDayMarks(etDate);
  return { points: marks.map(toPoint), summary: summarizeDayMarks(etDate, marks, goalPct) };
}
