import { MIN_RELIABLE_TRADES } from './significance';
import { etToday } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// The daily goal, read off the record (2026-09-07).
//
// Until now `targetDailyGainPct` came from ambition: the tune solved a risk %
// from a wished-for target under a FIXED 45% win rate, and stamped the
// give-back levels from the same number. The loop's realized edge is nothing
// like that assumption (≈ +0.05R a trade over the live record against the
// 0.35R the "expected day" basis presumes), so the stored goal and the guard
// levels sat far above the distribution of days the system actually produces
// — the whole day-level protective stack (bank, guard, finish-line trim,
// armed-day bar, day-protective stop) was inert on almost every day. The same
// disease docs/AUTOTRADING_SPEC.md found at trade level on 2026-09-03 ("the
// protective stack sat above the distribution"), one level up.
//
// This module is the pure half of the fix: it rebuilds each trading session's
// realized path from closed trades — an entry moment, an exit moment and a
// realized R per trade — and derives the REALIZED EDGE the tune and the
// dashboard compare the goal against (avg R per trade, median entries per
// session, over a window of sessions). The DB collector that feeds it lives in
// dailyTargetSweepData.ts; nothing here touches the database, so every
// counterfactual can be unit-tested on hand-built fixtures.
//
// R per trade, not dollars or % of equity, deliberately: R is a strategy fact
// (docs/OPTIONS_TUNING_PLAN.md's data-quality rule — position-derived series
// carry no deposits, withdrawals or manual trading), and it is the unit the
// auto-tune guard already judges in (significance.ts, PR #523).
// ---------------------------------------------------------------------------

/** One closed trade as the sweep sees it: when it was opened, when it was
 *  closed, and what it realized in R. Built by dailyTargetSweepData.ts from
 *  whichever book is being read; the R denominator is that book's own
 *  (initialRiskOf for the journal, riskAmount for the autotrade tables). */
export interface SweepTrade {
  /** Stable, book-prefixed id (`pos:12`, `paper:7`, …) — ties are broken on it. */
  id: string;
  entryAt: number;
  exitAt: number;
  r: number;
}

export interface SessionEvent {
  kind: 'entry' | 'exit';
  tradeId: string;
  at: number;
  /** Realized R carried by an exit; 0 on an entry. */
  r: number;
}

/** One trading session's realized path: its events in the order the loop
 *  would have seen them. A session with no events is a real 0R session. */
export interface SessionPath {
  date: string;
  events: SessionEvent[];
  /** Entries placed on this session (the trades/day the goal is judged on). */
  entries: number;
  /** Exits booked on this session. */
  exits: number;
}

export interface SessionPathsResult {
  paths: SessionPath[];
  /** Events dated on a non-session (a weekend expiry sweep, a holiday
   *  reconcile) that were attached to the previous session instead. */
  remappedEvents: number;
  /** Events dated before the first session in the window — an entry from an
   *  earlier day whose exit landed inside it, or an exit that predates the
   *  window entirely. Dropped, and counted so a shrunken sample is visible. */
  eventsOutsideWindow: number;
}

/** Both halves of the realized edge the goal is compared against, plus every
 *  count a reader needs to judge how much record stands behind the numbers. */
export interface RealizedEdge {
  /** Mean realized R per closed trade over the window; null with no trades. */
  avgR: number | null;
  /** Closed trades with a usable R inside the window. */
  rTrades: number;
  /** Median entries per session over the window (zero-entry sessions
   *  included — an idle session is still a session); null with no sessions. */
  tradesPerSession: number | null;
  /** Sessions in the window (the loop's calendar, not calendar days). */
  sessions: number;
  sessionsWithoutEntries: number;
  /** Trades the collector could not place on the timeline or score in R. */
  droppedTrades: number;
  remappedEvents: number;
  eventsOutsideWindow: number;
  /** The window that was asked for — `sessions` can be smaller when the book
   *  is younger than the lookback. */
  lookbackSessions: number;
  /** rTrades ≥ MIN_RELIABLE_TRADES AND sessions ≥ MIN_RELIABLE_SESSIONS —
   *  below either floor the numbers are reported but must not be leaned on. */
  reliable: boolean;
}

/** One floor, two units: the same 20 significance.ts and kellySuggestion use
 *  for "enough trades to lean on" is also the number of SESSIONS the daily
 *  axis needs, because a day is the sample unit of everything here. */
export const MIN_RELIABLE_SESSIONS = MIN_RELIABLE_TRADES;

export function emptyRealizedEdge(lookbackSessions: number): RealizedEdge {
  return {
    avgR: null,
    rTrades: 0,
    tradesPerSession: null,
    sessions: 0,
    sessionsWithoutEntries: 0,
    droppedTrades: 0,
    remappedEvents: 0,
    eventsOutsideWindow: 0,
    lookbackSessions,
    reliable: false,
  };
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sort key inside a session: time, then exits before entries at the same
 *  instant (the loop's own tick order — updateDailyTarget runs after the
 *  equity sync reflects prior exits and before the entry gates), then id so
 *  the order is total and a replay is deterministic. */
function compareEvents(a: SessionEvent, b: SessionEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.kind !== b.kind) return a.kind === 'exit' ? -1 : 1;
  return a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0;
}

/**
 * Place every trade's entry and exit on the session it belongs to. Sessions
 * come from the trading calendar (dailyTargetSweepData.ts asks
 * marketCalendar.sessionDatesEndingAt), so a weekend or holiday never appears
 * as a day of its own; an event dated on one is attached to the previous
 * session and counted. A trade entered on D and closed on D+1 is an entry on D
 * and R on D+1 — the goal is a per-day rule and that is how the loop would
 * have experienced it.
 */
export function buildSessionPaths(trades: SweepTrade[], sessionDates: string[]): SessionPathsResult {
  const ordered = [...sessionDates].sort();
  const index = new Map(ordered.map((d, i) => [d, i] as const));
  const paths: SessionPath[] = ordered.map((date) => ({ date, events: [], entries: 0, exits: 0 }));
  let remappedEvents = 0;
  let eventsOutsideWindow = 0;

  const place = (event: SessionEvent): void => {
    const date = etToday(event.at);
    let i = index.get(date);
    if (i === undefined) {
      // Not a session: the previous session in the window, if there is one.
      let j = ordered.length - 1;
      while (j >= 0 && ordered[j] > date) j -= 1;
      if (j < 0) {
        eventsOutsideWindow += 1;
        return;
      }
      i = j;
      remappedEvents += 1;
    }
    paths[i].events.push(event);
    if (event.kind === 'entry') paths[i].entries += 1;
    else paths[i].exits += 1;
  };

  for (const t of trades) {
    place({ kind: 'entry', tradeId: t.id, at: t.entryAt, r: 0 });
    place({ kind: 'exit', tradeId: t.id, at: t.exitAt, r: t.r });
  }
  for (const p of paths) p.events.sort(compareEvents);
  return { paths, remappedEvents, eventsOutsideWindow };
}

export interface RealizedEdgeInput {
  trades: SweepTrade[];
  sessionDates: string[];
  droppedTrades: number;
  lookbackSessions: number;
}

/**
 * The realized edge over the window: mean R over the trades that CLOSED inside
 * it, and the median entries per session (idle sessions count as 0 — an
 * idle day pulls the flow figure down, which is the conservative direction
 * for a number the goal is going to be judged against).
 *
 * For the journal book this avgR has the same numerator and denominator as
 * computeJournalStats(...).avgR (realizedPnlOf / initialRiskOf per trade), so
 * the two agree whenever every closed trade falls inside the window — pinned
 * by the route test rather than assumed.
 */
export function computeRealizedEdge(input: RealizedEdgeInput): RealizedEdge {
  const { paths, remappedEvents, eventsOutsideWindow } = buildSessionPaths(input.trades, input.sessionDates);
  const exits = paths.flatMap((p) => p.events.filter((e) => e.kind === 'exit'));
  const rTrades = exits.length;
  const avgR = rTrades ? round4(exits.reduce((s, e) => s + e.r, 0) / rTrades) : null;
  const sessions = paths.length;
  const tradesPerSession = median(paths.map((p) => p.entries));
  return {
    avgR,
    rTrades,
    tradesPerSession,
    sessions,
    sessionsWithoutEntries: paths.filter((p) => p.entries === 0).length,
    droppedTrades: input.droppedTrades,
    remappedEvents,
    eventsOutsideWindow,
    lookbackSessions: input.lookbackSessions,
    reliable: rTrades >= MIN_RELIABLE_TRADES && sessions >= MIN_RELIABLE_SESSIONS,
  };
}
