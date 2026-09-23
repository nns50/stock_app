import { listPositions, Position } from '../../db/positions';
import { listClosedLiveOptionsPositionsBetween, liveOptionsPnl } from '../../db/autotradeLiveOptionsPositions';
import { realizedPnlOf } from '../pnl';
import { etDateTimeToMs } from '../../util/marketDate';
import { sessionCloseMinute } from '../trading/marketCalendar';

// ---------------------------------------------------------------------------
// The loop's closes on one ET date, and whether they ever put the day at or
// under a halt line (2026-09-23).
//
// ONE LIST FOR TWO READERS. The day's record (strategyDayFor) sums these, and
// the halt retraction walks them in time order. Both read this function, so the
// retraction can never judge a different day from the one the calendar shows.
// It is the same two pools the live risk checks add up: an autotrade stock
// position once it is closed, counted on its last exit's date, and a live
// options position once its exit falls on the date.
//
// The options side is read by date, not through listLiveOptionsPositions, whose
// newest-200 default drops any date older than the book's latest 200 closes.
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isAutotrade = (p: Position): boolean => p.tags.includes('autotrade');

/** The ET date a position's realized P&L belongs to: its LAST exit's date. A
 *  trade opened Monday and closed Wednesday books on Wednesday, which is when
 *  the money actually moved. */
export function lastExitDate(p: Position): string | null {
  if (p.exits.length === 0) return null;
  return p.exits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).exitDate;
}

export interface LiveDayClose {
  book: 'stock' | 'options';
  /** The position's id in its own table. */
  id: number;
  pnl: number;
  /** When the close reached the ledger: the closing exit's booking time for a
   *  stock position, the exit time for an options position. */
  bookedAt: number | null;
}

/** `etDate` + n calendar days. The input is already an ET date label. */
function shiftDays(etDate: string, n: number): string {
  const [y, m, d] = etDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every close the live book realized on `etDate`, in no particular order. */
export function liveDayCloses(etDate: string): LiveDayClose[] {
  const out: LiveDayClose[] = [];
  for (const p of listPositions({ status: 'closed' })) {
    if (!isAutotrade(p) || lastExitDate(p) !== etDate) continue;
    out.push({
      book: 'stock',
      id: p.id,
      pnl: realizedPnlOf(p),
      bookedAt: Math.max(...p.exits.map((e) => e.createdAt)),
    });
  }
  const from = etDateTimeToMs(etDate, '00:00');
  const to = etDateTimeToMs(shiftDays(etDate, 1), '00:00');
  if (from !== null && to !== null) {
    for (const p of listClosedLiveOptionsPositionsBetween(from, to)) {
      if (p.exitPrice === null) continue;
      out.push({ book: 'options', id: p.id, pnl: liveOptionsPnl(p, p.exitPrice), bookedAt: p.exitAt });
    }
  }
  return out;
}

export interface DayLineReading {
  /** The day's realized total, every close counted. */
  total: number;
  stockPnl: number;
  optionsPnl: number;
  /** The lowest the day's running total ever stood (0 before the first close). */
  lowest: number;
  /** Whether `lowest` is at or under the line: the checks halt at `pnl <= level`. */
  reached: boolean;
  /** Closes with no booking time inside the session, placed by the worst case. */
  untimed: number;
}

/**
 * Pure: did these closes ever put the day's running total at or under `level`?
 *
 * The halt is recomputed on every risk check from the closes booked so far, so
 * "was it earned" is not a question about the total, and not about any single
 * moment either. A day that crossed the line at 11:30 and recovered by 15:00
 * earned its halt at 11:30. So the closes are walked in booking order and the
 * lowest running total is what is judged.
 *
 * A close with no booking time inside the session (one entered by hand after
 * the close, or re-entered to correct it) cannot be placed. It is put where it
 * does the most harm to the answer "never reached": a loss before everything
 * else, a gain after everything else. So a halt is never withdrawn because a
 * loss was re-typed after the bell.
 */
export function dayReachedLine(closes: LiveDayClose[], level: number, sessionCloseMs: number): DayLineReading {
  const timed = closes
    .filter((c) => c.bookedAt !== null && c.bookedAt <= sessionCloseMs)
    // Equal times: the loss first, which can only lower the minimum.
    .sort((a, b) => (a.bookedAt as number) - (b.bookedAt as number) || a.pnl - b.pnl);
  const untimed = closes.filter((c) => c.bookedAt === null || c.bookedAt > sessionCloseMs);
  let running = 0;
  let lowest = 0;
  for (const c of untimed) if (c.pnl < 0) running += c.pnl;
  lowest = Math.min(lowest, running);
  for (const c of timed) {
    running += c.pnl;
    lowest = Math.min(lowest, running);
  }
  const total = closes.reduce((s, c) => s + c.pnl, 0);
  const stockPnl = closes.filter((c) => c.book === 'stock').reduce((s, c) => s + c.pnl, 0);
  return {
    total: round2(total),
    stockPnl: round2(stockPnl),
    optionsPnl: round2(total - stockPnl),
    lowest: round2(Math.min(lowest, total)),
    reached: Math.min(lowest, total) <= level,
    untimed: untimed.length,
  };
}

/** When `etDate`'s session closed (early closes honoured), or null for a date
 *  that does not parse. */
export function sessionCloseMs(etDate: string): number | null {
  const noon = etDateTimeToMs(etDate, '12:00');
  if (noon === null) return null;
  const minute = sessionCloseMinute(noon);
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return etDateTimeToMs(etDate, `${hh}:${mm}`);
}

/** The live book's `etDate` against `level`, read from the ledger as it stands
 *  now. Null when the date does not parse. */
export function liveDayAgainstLine(etDate: string, level: number): DayLineReading | null {
  const close = sessionCloseMs(etDate);
  if (close === null) return null;
  return dayReachedLine(liveDayCloses(etDate), level, close);
}
