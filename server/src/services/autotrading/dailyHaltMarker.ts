import { listAutotradeEvents, listAutotradeEventsInWindow, logAutotradeEvent } from '../../db/autotradeEvents';
import { etDateTimeToMs } from '../../util/marketDate';
import { liveDayAgainstLine } from './liveDayCloses';

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
// Kept a leaf (the events table, a date helper and liveDayCloses, itself a
// leaf over the ledger) so the recorder can read it without importing the
// alert, whose dashboard import already depends on the recorder.
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

// ---------------------------------------------------------------------------
// A halt measured on a BOOKING ERROR, withdrawn (2026-09-23).
//
// On 2026-09-23 the live halt tripped at 10:23 on −$2,046 against a −$1,942
// line. −$384 of that was a phantom: the MRNA stock order's fill had been
// linked to the options sleeve's MRNA call, and the call was booked into the
// stock book at an estimated price. With the ledger corrected, the day's
// running total never reached the line. The marker is a fact about what the
// loop saw and stays in the journal. What changes is whether the day COUNTS as
// a halt: in the daily results row, and so in the sizing review's "two halts
// in any five sessions → revert", which would otherwise cut the size on the
// next real halt for a loss that never happened.
//
// A retraction is its own row, written only by dailyHaltRetraction.ts. It is
// never an edit to the marker, and never a verdict stored once: every reader
// below re-reads the corrected ledger (liveDayAgainstLine) and honours the
// retraction only while the day still never reaches the line. A later
// correction that puts the day back past it makes the halt count again.
// ---------------------------------------------------------------------------

/** The retraction's action. */
export const DAILY_HALT_RETRACTED_ACTION = 'daily_halt_retracted';

export interface DailyHaltRetractionDetail {
  /** Only the live halt is retracted: the paper halt is the control arm's own
   *  record and nothing sizes off it. */
  pool: 'live';
  /** ET calendar date (YYYY-MM-DD) of the halt withdrawn. */
  date: string;
  /** Why, in the operator's or the correction's words. */
  reason: string;
  /** The marker's figures, restated so the row stands on its own. */
  markerPnl: number | null;
  haltLevel: number;
  /** The corrected day as the retraction read it (liveDayAgainstLine): its
   *  lowest running total, which did NOT reach the line, and its total. */
  lowestPnl: number;
  totalPnl: number;
  stockPnl: number;
  optionsPnl: number;
  /** Closes with no booking time inside the session, placed by the worst case. */
  untimedCloses: number;
  /** When the marker was written (epoch ms). */
  markerAt: number;
}

export function writeDailyHaltRetraction(detail: DailyHaltRetractionDetail): void {
  logAutotradeEvent({
    stage: 'config',
    action: DAILY_HALT_RETRACTED_ACTION,
    detail: {
      ...detail,
      markerPnl: detail.markerPnl === null ? null : round2(detail.markerPnl),
      haltLevel: round2(detail.haltLevel),
      lowestPnl: round2(detail.lowestPnl),
      totalPnl: round2(detail.totalPnl),
      stockPnl: round2(detail.stockPnl),
      optionsPnl: round2(detail.optionsPnl),
    },
  });
}

/** The live pool's marker and retraction rows for `etDate`, read as a WINDOW
 *  from that date's midnight rather than the newest rows, so a correction that
 *  re-records a date weeks back still finds both. */
function liveHaltRows(etDate: string): {
  marker: { createdAt: number; detail: Partial<DailyHaltMarkerDetail> } | null;
  retracted: boolean;
} {
  const since = etDateTimeToMs(etDate, '00:00');
  if (since === null) return { marker: null, retracted: false };
  const { events } = listAutotradeEventsInWindow({
    stage: 'config',
    actions: [DAILY_HALT_MARKER_ACTION, DAILY_HALT_RETRACTED_ACTION],
    since,
  });
  let marker: { createdAt: number; detail: Partial<DailyHaltMarkerDetail> } | null = null;
  let retracted = false;
  for (const e of events) {
    const d = parse(e.detail);
    if (d === null || d.pool !== 'live' || d.date !== etDate) continue;
    if (e.action === DAILY_HALT_RETRACTED_ACTION) retracted = true;
    // The FIRST marker is the halt: the alert writes one per pool per day.
    else if (marker === null || e.createdAt < marker.createdAt) marker = { createdAt: e.createdAt, detail: d };
  }
  return { marker, retracted };
}

/** The live halt marker for `etDate` — when it was written and what it read —
 *  or null when the live book did not halt that day. */
export function liveHaltMarkerOn(etDate: string): { createdAt: number; detail: Partial<DailyHaltMarkerDetail> } | null {
  return liveHaltRows(etDate).marker;
}

/** Whether a retraction on file for this marker still holds: the corrected
 *  ledger, read now, shows the day never at or under the marker's line. */
function retractionHolds(etDate: string, marker: { detail: Partial<DailyHaltMarkerDetail> }): boolean {
  const level = marker.detail.haltLevel;
  if (typeof level !== 'number' || !Number.isFinite(level)) return false;
  const reading = liveDayAgainstLine(etDate, level);
  return reading !== null && !reading.reached;
}

/**
 * Whether the live halt on `etDate` is withdrawn as a booking error: a
 * retraction is on file AND the corrected ledger still bears it out. Re-read on
 * every call, so an estimate repriced after the retraction, or a loss entered
 * later, can bring the halt back. The recorder, the halt reader below and the
 * nightly scan all ask this one function.
 */
export function liveDrawdownHaltRetracted(etDate: string): boolean {
  const { marker, retracted } = liveHaltRows(etDate);
  return marker !== null && retracted && retractionHolds(etDate, marker);
}

/** Whether a retraction row exists for `etDate`, whether or not it still holds. */
export function liveHaltRetractionOnFile(etDate: string): boolean {
  return liveHaltRows(etDate).retracted;
}

/**
 * Whether the LIVE book's daily-drawdown halt tripped on `etDate`. This is
 * what the daily results row records and what the sizing review counts.
 *
 * A retraction that still holds takes the day out (see above). It reads a
 * WINDOW from that date's midnight rather than the newest rows, so a
 * correction that re-records a date weeks back still finds its marker.
 */
export function liveDrawdownHaltedOn(etDate: string): boolean {
  const { marker, retracted } = liveHaltRows(etDate);
  if (marker === null) return false;
  return !(retracted && retractionHolds(etDate, marker));
}
