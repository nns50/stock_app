import { listAutotradeEvents, listAutotradeEventsInWindow, logAutotradeEvent } from '../../db/autotradeEvents';
import { etDateTimeToMs } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// The daily-drawdown halt, recorded as an EVENT (2026-09-23).
//
// The halt itself is not a state anything stores: every risk check recomputes
// it from the day's realized P&L and the day's opening equity. The first tick
// of a day that finds a book at or below its level journals one marker row, and
// that row is the only place in the database a halt is ever dated.
//
// So this module owns both halves of that row — the one writer and the one
// reader — because the two consumers that need "did the live book halt on date
// X" had each drifted away from it:
//
//   - The daily-results recorder wrote `existing?.drawdownHalted ?? false`, and
//     nothing had ever set `existing` true. Every row read "no halt", so the
//     sizing review's "the drawdown halt tripped twice in any 5 sessions → revert"
//     rule (gatedSwitches.ts, `sizing_revert`) could never fire. Its unit test
//     passed throughout: it handed the review hand-built rows with
//     `drawdownHalted: true`, a shape no producer could emit.
//   - The edge-leak scan counted `daily_drawdown_halt` rows, a name that is a
//     guardrail RULE and was never journaled as an action.
//
// Kept a leaf (the events table and a date helper, nothing else) so the
// recorder can read it without importing the alert, whose dashboard import
// already depends on the recorder.
// ---------------------------------------------------------------------------

/** The marker's action. The name predates this module: keeping it means the
 *  once-a-day throttle still sees every marker written before it existed. */
export const DAILY_HALT_MARKER_ACTION = 'daily_halt_alerted';

/**
 * Which daily P&L a halt was measured on. Two pools, because there are two
 * halts:
 *
 * - `paper`: the paper stock and paper options books, combined.
 * - `live`: the live stock and live options books, combined.
 *
 * Both live risk checks halt on the combined figure: `liveExecute.ts` adds the
 * options seed to the stock snapshot, and `liveOptionsExecute.ts` adds the
 * stock snapshot to its own. So `live` means stock plus options.
 *
 * A third pool, `liveOptions`, existed until 2026-09-23. It alerted on options
 * alone, a halt no risk check applies. Its old markers are still in the journal,
 * and the reader below deliberately does not count them as live halts.
 */
export type HaltPool = 'paper' | 'live';

export interface DailyHaltMarkerDetail {
  pool: HaltPool;
  /** ET calendar date (YYYY-MM-DD) the halt belongs to. */
  date: string;
  /** The day's realized P&L when the halt was found, in dollars (negative). */
  dailyPnl: number;
  /** The halt level it crossed, in dollars (negative): the same number the
   *  risk checks compare against. */
  haltLevel: number;
  /** The live pool's two components, so the row says which sleeve lost. */
  stockPnl?: number;
  optionsPnl?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function parse(detail: string | null): Partial<DailyHaltMarkerDetail> | null {
  if (detail === null) return null;
  try {
    const d: unknown = JSON.parse(detail);
    return typeof d === 'object' && d !== null ? (d as Partial<DailyHaltMarkerDetail>) : null;
  } catch {
    return null;
  }
}

/** Journal that `detail.pool` halted on `detail.date`. Callers throttle with
 *  `haltMarkerExists` first. The throttle belongs to the alert, which decides
 *  whether to push a notification. */
export function writeDailyHaltMarker(detail: DailyHaltMarkerDetail): void {
  logAutotradeEvent({
    stage: 'config',
    action: DAILY_HALT_MARKER_ACTION,
    detail: {
      ...detail,
      dailyPnl: round2(detail.dailyPnl),
      haltLevel: round2(detail.haltLevel),
      ...(detail.stockPnl !== undefined ? { stockPnl: round2(detail.stockPnl) } : {}),
      ...(detail.optionsPnl !== undefined ? { optionsPnl: round2(detail.optionsPnl) } : {}),
    },
  });
}

/** Whether a marker for `pool` on `etDate` is already in the journal: the
 *  alert's once-per-pool-per-day throttle. Reads the newest markers only. This
 *  is only ever asked about today, and a day adds at most two rows. */
export function haltMarkerExists(pool: HaltPool, etDate: string): boolean {
  return listAutotradeEvents({ stage: 'config', actions: [DAILY_HALT_MARKER_ACTION], limit: 50 }).some((e) => {
    const d = parse(e.detail);
    return d !== null && d.pool === pool && d.date === etDate;
  });
}

/**
 * Whether the LIVE book's daily-drawdown halt tripped on `etDate`. This is
 * what the daily results row records and what the sizing review counts.
 *
 * It reads a WINDOW from that date's midnight rather than the newest rows, so a
 * correction that re-records a date weeks back still finds its marker.
 */
export function liveDrawdownHaltedOn(etDate: string): boolean {
  const since = etDateTimeToMs(etDate, '00:00');
  if (since === null) return false;
  return listAutotradeEventsInWindow({ stage: 'config', actions: [DAILY_HALT_MARKER_ACTION], since }).events.some(
    (e) => {
      const d = parse(e.detail);
      return d !== null && d.pool === 'live' && d.date === etDate;
    },
  );
}
