import { listPositions, Position } from '../../db/positions';
import { listLiveOptionsPositions, liveOptionsPnl, LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { listPaperPositions, paperRealizedR, PaperPosition } from '../../db/autotradePaperPositions';
import { listOptionsPaperPositions, OptionsPaperPosition } from '../../db/autotradeOptionsPaperPositions';
import { optionsPaperRealizedPnl } from './optionsExecute';
import { initialRiskOf, realizedPnlOf } from '../pnl';
import { etDateTimeToMs, etTimeOfDay, etToday } from '../../util/marketDate';
import {
  isTradingSession,
  previousTradingSession,
  sessionCloseMinute,
  sessionDatesEndingAt,
} from '../trading/marketCalendar';
import { computeRealizedEdge, DropReasons, dropTotal, NO_DROPS, RealizedEdge, SweepTrade } from './dailyTargetSweep';

// ---------------------------------------------------------------------------
// The DB half of dailyTargetSweep.ts: turn each book's closed positions into
// SweepTrades and pick the session window they are read over. Kept apart from
// the pure module so the counterfactuals stay unit-testable on fixtures, and
// so no second derivation of R appears anywhere — each book's R comes from the
// helper that book already uses everywhere else:
//
//   journal (live equity)  realizedPnlOf / initialRiskOf   (autoTune.ts)
//   live options           liveOptionsPnl / riskAmount      (methodSizing.ts)
//   paper equity           paperRealizedR                   (expectancy sizing)
//   paper options          optionsPaperRealizedPnl / riskAmount
//
// A trade that cannot be placed on the timeline or scored in R is DROPPED and
// COUNTED, never guessed at: an undated journal row, one with no initial stop,
// an options row with no exit. The count travels with every result so a thin
// sample cannot pass for a quiet record.
// ---------------------------------------------------------------------------

export type SweepBook = 'live' | 'paper';

/** The window the tune preview and the dashboard read the evidence over. A
 *  request parameter on the sweep route (not config — a field read only by a
 *  read-only route is the "field read by nothing" trap CLAUDE.md names). */
export const DEFAULT_LOOKBACK_SESSIONS = 40;

/** 16:00 ET on the exit DATE, for a journal exit whose reconcile wall clock
 *  landed on a different ET day than the exit it records. */
const SESSION_CLOSE_TIME = '16:00';

export interface CollectedTrades {
  trades: SweepTrade[];
  droppedTrades: number;
  /** The same total, split by cause. Sums to `droppedTrades` by construction —
   *  `dropTotal()` is what both are derived from. */
  dropReasons: DropReasons;
  /** Journal exits whose moment was approximated to the close of their exit
   *  date because the reconcile timestamp fell on a different day. */
  approximatedExits: number;
}

export interface CollectedBook extends CollectedTrades {
  book: SweepBook;
  sessionDates: string[];
  lookbackSessions: number;
}

const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

/**
 * The live book: the journal's autotrade-tagged closed positions (auto-tune's
 * own population) plus the live options table — the daily goal gates both.
 *
 * Entry moment: `entryDate` + `entryTime` read back as a real instant; a row
 * with no entry time (adoption only started stamping it on 2026-08-31) falls
 * back to `createdAt` when that lands on the same ET date, and is dropped
 * otherwise. Exit moment: the latest exit row's `createdAt` (the reconcile
 * wall clock, at most a tick after the fill), approximated to the close of
 * the exit date if it disagrees with it.
 */
export function collectLiveTrades(closed: Position[], liveOptionsClosed: LiveOptionsPosition[]): CollectedTrades {
  const trades: SweepTrade[] = [];
  const drops: DropReasons = { ...NO_DROPS };
  let approximatedExits = 0;
  for (const p of closed) {
    if (!isAutotradePosition(p) || p.status !== 'closed') continue;
    if (p.entryDate === null || p.exits.length === 0) {
      drops.noEntryOrExit += 1;
      continue;
    }
    let entryAt = p.entryTime ? etDateTimeToMs(p.entryDate, p.entryTime) : null;
    if (entryAt === null && etToday(p.createdAt) === p.entryDate) entryAt = p.createdAt;
    const risk = initialRiskOf(p);
    // Counted SEPARATELY, and deliberately not as one "unusable" bucket: a
    // missing entry time is a fixed history gap, a missing initial risk means
    // the position had no recorded stop. Same drop, opposite significance.
    if (entryAt === null) {
      drops.noEntryTime += 1;
      continue;
    }
    if (risk === null) {
      drops.noInitialRisk += 1;
      continue;
    }
    const last = p.exits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    let exitAt = last.createdAt;
    if (etToday(exitAt) !== last.exitDate) {
      const approx = etDateTimeToMs(last.exitDate, SESSION_CLOSE_TIME);
      if (approx === null) {
        drops.unparseableExit += 1;
        continue;
      }
      exitAt = approx;
      approximatedExits += 1;
    }
    trades.push({ id: `pos:${p.id}`, entryAt, exitAt, r: realizedPnlOf(p) / risk });
  }
  for (const p of liveOptionsClosed) {
    if (p.status !== 'closed' || p.exitPrice === null || p.exitAt === null || !(p.riskAmount > 0)) {
      drops.optionsIncomplete += 1;
      continue;
    }
    trades.push({
      id: `lopt:${p.id}`,
      entryAt: p.entryAt,
      exitAt: p.exitAt,
      r: liveOptionsPnl(p, p.exitPrice) / p.riskAmount,
    });
  }
  return { trades, droppedTrades: dropTotal(drops), dropReasons: drops, approximatedExits };
}

/** The paper book — the control group the live book is measured against. */
export function collectPaperTrades(paper: PaperPosition[], optionsPaper: OptionsPaperPosition[]): CollectedTrades {
  const trades: SweepTrade[] = [];
  const drops: DropReasons = { ...NO_DROPS };
  for (const p of paper) {
    const r = paperRealizedR(p);
    if (p.status !== 'closed' || p.exitAt === null) {
      drops.noEntryOrExit += 1;
      continue;
    }
    // The paper twin of the live book's noInitialRisk: paperRealizedR is null
    // when the row carries no usable risk denominator.
    if (r === null) {
      drops.noInitialRisk += 1;
      continue;
    }
    trades.push({ id: `paper:${p.id}`, entryAt: p.entryAt, exitAt: p.exitAt, r });
  }
  for (const p of optionsPaper) {
    if (p.status !== 'closed' || p.exitAt === null || p.exitPrice === null || !(p.riskAmount > 0)) {
      drops.optionsIncomplete += 1;
      continue;
    }
    trades.push({
      id: `popt:${p.id}`,
      entryAt: p.entryAt,
      exitAt: p.exitAt,
      r: optionsPaperRealizedPnl(p) / p.riskAmount,
    });
  }
  return { trades, droppedTrades: dropTotal(drops), dropReasons: drops, approximatedExits: 0 };
}

/** The most recent session that has already CLOSED at `now`: today once the
 *  bell has rung on a trading day, otherwise the previous session. A
 *  half-finished day is not a session of the record yet. */
export function lastCompletedSessionDate(now: number = Date.now()): string {
  const today = etToday(now);
  const [h, m] = etTimeOfDay(now).split(':').map(Number);
  const pastClose = h * 60 + m >= sessionCloseMinute(now);
  return isTradingSession(today) && pastClose ? today : previousTradingSession(today);
}

/**
 * The window a book is read over: the last `lookbackSessions` sessions ending
 * at the most recent completed session that has a closed trade in it (so a
 * book that has been idle for a week is read as of its last exit, and the
 * idle sessions are reported by the collector's caller, not silently
 * appended), truncated at the book's first entry so sessions before the book
 * existed are not counted as 0R sessions of it.
 */
export function sessionWindowFor(trades: SweepTrade[], lookbackSessions: number, now: number = Date.now()): string[] {
  const lastCompleted = lastCompletedSessionDate(now);
  if (trades.length === 0) return sessionDatesEndingAt(lastCompleted, lookbackSessions, null);
  const lastExit = trades.reduce((d, t) => {
    const e = etToday(t.exitAt);
    return e > d ? e : d;
  }, '0000-00-00');
  const firstEntry = trades.reduce((d, t) => {
    const e = etToday(t.entryAt);
    return e < d ? e : d;
  }, '9999-99-99');
  return sessionDatesEndingAt(lastExit < lastCompleted ? lastExit : lastCompleted, lookbackSessions, firstEntry);
}

/** Lists a caller may already hold (the dashboard fetches both for
 *  methodPerformance) so the collector does not query twice per poll. */
export interface PrefetchedLiveBook {
  closed: Position[];
  liveOptionsClosed: LiveOptionsPosition[];
}

export function collectBook(
  book: SweepBook,
  lookbackSessions: number = DEFAULT_LOOKBACK_SESSIONS,
  now: number = Date.now(),
  prefetched?: PrefetchedLiveBook,
): CollectedBook {
  const collected =
    book === 'live'
      ? collectLiveTrades(
          prefetched?.closed ?? listPositions({ status: 'closed' }),
          prefetched?.liveOptionsClosed ?? listLiveOptionsPositions({ status: 'closed' }),
        )
      : collectPaperTrades(listPaperPositions({ status: 'closed' }), listOptionsPaperPositions({ status: 'closed' }));
  return {
    book,
    ...collected,
    sessionDates: sessionWindowFor(collected.trades, lookbackSessions, now),
    lookbackSessions,
  };
}

/** The realized edge of a book — the one call the tune preview and the
 *  dashboard both make, so they read the same window the same way. */
export function realizedEdgeOf(collected: CollectedBook): RealizedEdge {
  return computeRealizedEdge({
    trades: collected.trades,
    sessionDates: collected.sessionDates,
    droppedTrades: collected.droppedTrades,
    dropReasons: collected.dropReasons,
    lookbackSessions: collected.lookbackSessions,
  });
}
