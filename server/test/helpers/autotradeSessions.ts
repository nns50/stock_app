import { importPositions, ImportablePosition } from '../../src/db/positions';
import { etDateTimeToMs } from '../../src/util/marketDate';

// ---------------------------------------------------------------------------
// Closed autotrade journal rows with DETERMINISTIC moments, for the daily-goal
// evidence and sweep tests. Entry 100 / stop 95 / qty 10 → initialRiskOf() is
// $50, so a trade's realized R chooses its exit price: exit = 100 + 5 × r.
// Built on importPositions because it is the one writer that accepts an entry
// time, a row createdAt and a per-exit createdAt — the three timestamps the
// collector reads (dailyTargetSweepData.ts).
// ---------------------------------------------------------------------------

export interface SeededTrade {
  /** ET HH:MM the trade was entered. */
  entryTime: string;
  /** ET HH:MM the trade was exited (same date unless `exitDate` is given). */
  exitTime?: string;
  exitDate?: string;
  r: number;
  symbol?: string;
  tags?: string[];
}

export interface SeedSessionsInput {
  /** One entry per session date, in any order; an empty array is a 0R session
   *  that still exists on the calendar (nothing is written for it). */
  sessions: Record<string, SeededTrade[]>;
}

const at = (date: string, time: string): number => {
  const ms = etDateTimeToMs(date, time);
  if (ms === null) throw new Error(`bad seed moment ${date} ${time}`);
  return ms;
};

/** Writes the rows and returns how many trades were seeded. */
export function seedClosedAutotradeSessions(input: SeedSessionsInput): number {
  const rows: ImportablePosition[] = [];
  let n = 0;
  for (const [date, trades] of Object.entries(input.sessions)) {
    trades.forEach((t, i) => {
      const exitTime = t.exitTime ?? '15:30';
      const exitDate = t.exitDate ?? date;
      rows.push({
        assetType: 'stock',
        symbol: t.symbol ?? `SYM${n % 7}`,
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: date,
        entryTime: t.entryTime,
        stopPrice: 95,
        targetPrice: 110,
        status: 'closed',
        tags: t.tags ?? ['live', 'autotrade'],
        createdAt: at(date, t.entryTime),
        updatedAt: at(exitDate, exitTime),
        exits: [
          {
            quantity: 10,
            exitPrice: Math.round((100 + 5 * t.r) * 100) / 100,
            exitDate,
            createdAt: at(exitDate, exitTime) + i, // strictly increasing inside a session
          },
        ],
      });
      n += 1;
    });
  }
  if (rows.length) importPositions(rows, 'merge');
  return n;
}

/** `n` consecutive trading sessions ending on `lastDate` (a weekday), oldest
 *  first — a test-side twin of marketCalendar.sessionDatesEndingAt that only
 *  knows weekends, for building fixtures without importing the calendar. */
export function weekdaysEndingAt(lastDate: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = lastDate.split('-').map(Number);
  let cursor = new Date(Date.UTC(y, m - 1, d));
  while (out.length < n) {
    const wd = cursor.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return out.reverse();
}
