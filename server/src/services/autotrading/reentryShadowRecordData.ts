import { getAutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import {
  getLastReentryShadowRecord,
  ReentryShadowRecordRow,
  saveReentryShadowRecord,
} from '../../db/reentryShadowRecords';
import { getProvider } from '../../providers';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import { isTradingSession, sessionDatesEndingAt } from '../trading/marketCalendar';
import { isAfterSessionClose } from '../trading/marketHours';
import { DEFAULT_LOOKBACK_SESSIONS, lastCompletedSessionDate } from './dailyTargetSweepData';
import { DeclinedEntry, parseDeclinedEntry } from './declinedEntry';
import { buildDeclinedEntryShadow, DeclinedEntryShadow, memoCandleSource } from './declinedEntryShadow';
import type { ReentryShadowEvidence } from './edgeLeakScan';

// ---------------------------------------------------------------------------
// The re-entry cooldown, measured nightly (2026-09-19).
//
// WHY. The operator asked whether the 390-minute live re-entry cooldown
// (Decision 8: one entry per symbol per session) could be shortened, since the
// afternoon goes quiet once the morning's names are locked out. The paper book
// — the control for every other gate — cannot answer it: paper has no cooldown
// and re-enters within minutes of its exit (58 of its 62 re-entries inside 30
// minutes), so it holds almost no examples of the delayed re-entry a shorter
// cooldown would admit. The only population that can answer is the cooldown's
// own refusals, which it journals EVERY tick — one symbol-day carries the whole
// series from one minute after the exit to the close — replayed at the first
// refusal at or past each candidate gap, under the book's own exits.
//
// The week of 09-14, read by hand before this existed: 9 refused symbol-days,
// +0.15R at the first refusal (the immediate re-entry), +0.05R at 60 minutes,
// -0.06R at 90, -0.12R at 120 (0 of 9 winners), -0.09R at 180. Nine trades is
// not a verdict in either direction. This turns the hand read into a nightly
// record the leak scan judges at its own bar.
//
// THE SAME CAVEATS AS EVERY SHADOW: not a P&L (slots and risk room ignored),
// not a fill (the signal's price, no slippage — the attribution's paired
// live-minus-paper difference is what a live entry gives up against it), and
// resolved against the trade on every intrabar collision.
// ---------------------------------------------------------------------------

export const REENTRY_SHADOW_ACTION = 'symbol_reentry_cooldown_skipped';

/** The day the cooldown went to the whole session (120 → 390, the 3% plan's
 *  Decision 8). Rows before it were refused by a two-hour cooldown — a
 *  different population, admitted at a different point in the day — so the
 *  record never reads across the boundary. */
export const REENTRY_SHADOW_SINCE_MS = Date.parse('2026-09-14T04:00:00Z');

/** The gaps replayed, in minutes since the symbol's last live exit. 0 is the
 *  first refusal — the immediate re-entry, the trade the paper book takes;
 *  each other gap is a candidate cooldown, and the scan's lever names it. */
export const REENTRY_SHADOW_GAPS: readonly number[] = [0, 60, 120, 180];

/** The window read's ceiling. The action journals every tick a name is
 *  refused — ~500 rows a session with three names cooling — so forty sessions
 *  is ~20,000 rows; the default ceiling would have flipped `journalTruncated`
 *  inside two months. Three times that, and the flag still travels. */
export const REENTRY_SHADOW_ROW_CEILING = 60_000;

export interface ReentryShadowReport {
  since: number;
  lookbackSessions: number;
  /** Journal rows read, before the replay's own exclusions. */
  journaledRows: number;
  /** True when the window read hit its ceiling, so the window is NOT
   *  complete and `journaledRows` understates it. */
  journalTruncated: boolean;
  /** Rows carrying no entry/stop/score — written before the replay fields
   *  existed — counted rather than dropped in silence. */
  unscorableRows: number;
  /** The cooldown in force when the record was computed: the number every
   *  gap below is a candidate to replace. */
  cooldownMinutes: number;
  /** One replay per gap in REENTRY_SHADOW_GAPS, each carrying the gap it was
   *  replayed at (`minMinutesSinceExit`). */
  gaps: DeclinedEntryShadow[];
}

/**
 * The window start: the last `lookbackSessions` sessions, and never before the
 * cooldown went to the whole session. The same forty-session window the
 * scan's dimensions read, so the bar (LEAK_MIN_TRADES over the window) means
 * the same thing here as there.
 */
export function reentryShadowWindowStart(
  now: number = Date.now(),
  lookbackSessions: number = DEFAULT_LOOKBACK_SESSIONS,
): number {
  const dates = sessionDatesEndingAt(lastCompletedSessionDate(now), lookbackSessions);
  const first = dates[0];
  const start = first ? (etDateTimeToMs(first, '00:00') ?? REENTRY_SHADOW_SINCE_MS) : REENTRY_SHADOW_SINCE_MS;
  return Math.max(REENTRY_SHADOW_SINCE_MS, start);
}

/** Every cooldown refusal since `since`, parsed for the replay. The WHOLE
 *  window (`listAutotradeEventsInWindow`), never the newest page of it. */
export function loadReentryRefusals(since: number): {
  rows: DeclinedEntry[];
  journaledRows: number;
  unscorableRows: number;
  truncated: boolean;
} {
  const { events, truncated } = listAutotradeEventsInWindow(
    { actions: [REENTRY_SHADOW_ACTION], since },
    REENTRY_SHADOW_ROW_CEILING,
  );
  const rows: DeclinedEntry[] = [];
  let unscorableRows = 0;
  for (const e of events) {
    const parsed = parseDeclinedEntry(e);
    if (parsed) rows.push(parsed);
    else unscorableRows += 1;
  }
  return { rows, journaledRows: events.length, unscorableRows, truncated };
}

/** The one compute path: the hook's record, and what a caller wanting a fresh
 *  reading calls. One bar fetch per symbol-day across the four gaps. */
export async function computeReentryShadowReport(
  now: number = Date.now(),
  lookbackSessions: number = DEFAULT_LOOKBACK_SESSIONS,
): Promise<ReentryShadowReport> {
  const cfg = getAutotradeConfig();
  const since = reentryShadowWindowStart(now, lookbackSessions);
  const { rows, journaledRows, unscorableRows, truncated } = loadReentryRefusals(since);
  const source = memoCandleSource(getProvider());
  const gaps: DeclinedEntryShadow[] = [];
  for (const gap of REENTRY_SHADOW_GAPS) {
    gaps.push(await buildDeclinedEntryShadow(source, rows, cfg, { minMinutesSinceExit: gap }));
  }
  return {
    since,
    lookbackSessions,
    journaledRows,
    journalTruncated: truncated,
    unscorableRows,
    cooldownMinutes: cfg.symbolReentryCooldownMinutes,
    gaps,
  };
}

/** What the leak scan's finding reads out of the stored record: each gap's
 *  replayed exit Rs, and whether the window behind them was complete. */
export function reentryShadowEvidenceOf(row: ReentryShadowRecordRow | null): ReentryShadowEvidence | null {
  if (!row) return null;
  return {
    etDate: row.etDate,
    journalTruncated: row.report.journalTruncated,
    gaps: row.report.gaps.map((g) => ({
      minMinutesSinceExit: g.minMinutesSinceExit,
      exitRs: g.trades.map((t) => t.exitR),
    })),
  };
}

/** The ET date the hook last TRIED to compute a record for. One attempt per
 *  session: the loop calls the hook on every tick from the close to midnight,
 *  and a provider outage must cost one session's refresh, not ~480 replays. */
let attemptedEtDate: string | null = null;

/** Tests only. */
export function resetReentryShadowRefreshState(): void {
  attemptedEtDate = null;
}

/**
 * The loop's hook: once the bell has rung on a session, replay the cooldown's
 * refusals at every gap and persist the record, so the next leak scan (the
 * routine's, after the close) reads today's numbers. Null when it is not after
 * the close or the day is not a session; the existing row when today's record
 * already exists or today's attempt already failed. Provider bars are fetched,
 * so the caller awaits and catches it on its own.
 */
export async function refreshReentryShadowRecordAfterClose(
  now: number = Date.now(),
): Promise<ReentryShadowRecordRow | null> {
  const today = etToday(now);
  if (!isTradingSession(today) || !isAfterSessionClose(now)) return null;
  const last = getLastReentryShadowRecord();
  if (last?.etDate === today || attemptedEtDate === today) return last;
  attemptedEtDate = today;
  const report = await computeReentryShadowReport(now);
  saveReentryShadowRecord(today, report, now);
  return getLastReentryShadowRecord();
}
