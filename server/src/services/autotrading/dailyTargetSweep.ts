import { computeSignificanceStats, MIN_RELIABLE_TRADES } from './significance';
import { etToday } from '../../util/marketDate';
import { isTradingSession } from '../trading/marketCalendar';

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
  /** Events dated outside the window — before its first session (an entry
   *  from an earlier day whose exit landed inside it) or on a SESSION after
   *  its last (today's still-open day, or a narrower lookback). Dropped, and
   *  counted so a shrunken sample is visible. */
  eventsOutsideWindow: number;
}

/** Both halves of the realized edge the goal is compared against, plus every
 *  count a reader needs to judge how much record stands behind the numbers. */
export interface RealizedEdge {
  /** Mean realized R per closed trade over the window; null with no trades.
   *
   *  ATTRIBUTED TO THE ENTRY, not the exit — every trade counts once, whatever
   *  session it closed on. That is what makes `tradesPerSession × avgR` a
   *  coherent forward identity: every trade is entered on a session that has
   *  entries and is therefore ACTIVE, so both factors are drawn from the same
   *  population even though only one of them mentions sessions.
   *
   *  It therefore does NOT reconcile with PolicyOutcome.totalR, which is
   *  exit-attributed and covers active sessions only. On the live book at
   *  2026-09-09 that read avgR 0.013 × 77 trades = 1.00R beside totalR 1.65R,
   *  and the ~0.65R gap is exits landing on sessions with no entries. Both are
   *  right; they answer different questions. `totalRAllSessions` on the sweep
   *  result exists so a reader can see that rather than have to derive it —
   *  the first person to compare the two (2026-09-09) took it for a bug. */
  avgR: number | null;
  /** Closed trades with a usable R inside the window. */
  rTrades: number;
  /** Median entries per ACTIVE session — the sessions the book actually
   *  traded on; null when it traded on none. Idle sessions are reported
   *  beside it, not averaged in: the first production read (2026-09-07) had
   *  the live book trading on 14 of 40 sessions, and a median over all 40 was
   *  0 — an "expected day" of 0% that said nothing about the days it trades.
   *  The goal is a per-day stopping rule, so a day it trades is the unit. */
  tradesPerSession: number | null;
  /** Sessions in the window (the loop's calendar, not calendar days). */
  sessions: number;
  /** Sessions in the window with at least one entry. */
  activeSessions: number;
  sessionsWithoutEntries: number;
  /** Trades the collector could not place on the timeline or score in R. */
  droppedTrades: number;
  remappedEvents: number;
  eventsOutsideWindow: number;
  /** The window that was asked for — `sessions` can be smaller when the book
   *  is younger than the lookback. */
  lookbackSessions: number;
  /** rTrades ≥ MIN_RELIABLE_TRADES AND activeSessions ≥ MIN_RELIABLE_SESSIONS
   *  — below either floor the numbers are reported but must not be leaned on. */
  reliable: boolean;
}

/** One floor, two units: the same 20 significance.ts and kellySuggestion use
 *  for "enough trades to lean on" is also the number of ACTIVE sessions the
 *  daily axis needs, because a day the book traded is the sample unit of
 *  everything here — a day it did not trade is evidence of nothing. */
export const MIN_RELIABLE_SESSIONS = MIN_RELIABLE_TRADES;

export function emptyRealizedEdge(lookbackSessions: number): RealizedEdge {
  return {
    avgR: null,
    rTrades: 0,
    tradesPerSession: null,
    sessions: 0,
    activeSessions: 0,
    sessionsWithoutEntries: 0,
    droppedTrades: 0,
    remappedEvents: 0,
    eventsOutsideWindow: 0,
    lookbackSessions,
    reliable: false,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
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
      // A non-session date (weekend, holiday) belongs to the previous session
      // in the window. A SESSION that is simply not in the window — after its
      // last day, or before its first — is outside it, not the last day's.
      if (isTradingSession(date) || ordered.length === 0 || date < ordered[0]) {
        eventsOutsideWindow += 1;
        return;
      }
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

/** A session the book traded on. A session with only an exit (a trade
 *  entered the day before) is not one: no stopping rule can change it. */
export const isActiveSession = (p: SessionPath): boolean => p.entries > 0;

/**
 * The realized edge over the window: mean R over the trades that CLOSED inside
 * it, and the median entries per ACTIVE session. Idle sessions are counted
 * and shown, never averaged in — see RealizedEdge.tradesPerSession for the
 * production read that made this the rule.
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
  const active = paths.filter(isActiveSession);
  const tradesPerSession = median(active.map((p) => p.entries));
  return {
    avgR,
    rTrades,
    tradesPerSession,
    sessions,
    activeSessions: active.length,
    sessionsWithoutEntries: sessions - active.length,
    droppedTrades: input.droppedTrades,
    remappedEvents,
    eventsOutsideWindow,
    lookbackSessions: input.lookbackSessions,
    reliable: rTrades >= MIN_RELIABLE_TRADES && active.length >= MIN_RELIABLE_SESSIONS,
  };
}

// ---------------------------------------------------------------------------
// The sweep: replay every session under a stopping policy at a grid of levels
// and read off, per level, what the day-level rules would have done to the
// record. Counterfactual, not a fit — it drops or keeps whole trades, never
// resizes or re-stops them, and it sees realized R only (production banks on
// net liquidation INCLUDING unrealized P&L, so it touches every line earlier
// than this replay does — the replay is a LOWER bound on how often the stack
// engages).
// ---------------------------------------------------------------------------

/** The stopping rules a level can be replayed under:
 *   none      — the record as it happened (the baseline every delta is against)
 *   bank      — halt new entries once cumulative R reaches the level (sticky)
 *   giveBack  — the production stack: bank, plus the give-back guard armed at
 *               2/3 of the level and firing at a fade to 1/3 of it
 *   bankTrail — the Phase-2 candidate: keep entering PAST the level, halt only
 *               once the day fades back below it (guard as in giveBack) */
export type SweepPolicy = 'none' | 'bank' | 'giveBack' | 'bankTrail';
export const SWEEP_POLICIES: readonly SweepPolicy[] = ['none', 'bank', 'giveBack', 'bankTrail'];

/** The tune's own stamping ratio for the guard, on the R axis. */
export function guardLevelsForR(levelR: number): { armR: number; floorR: number } {
  return { armR: (levelR * 2) / 3, floorR: levelR / 3 };
}

export interface SessionOutcome {
  dayR: number;
  halted: boolean;
  entries: number;
  entriesDropped: number;
}

/**
 * One session under one policy at one level, in R. A trade ENTERED after the
 * halt is dropped — none of its later events count. A trade already open at
 * the halt runs to its real exit (the loop never closes on a bank; only new
 * risk stops). `reached` is sticky, as in production.
 */
export function simulateSession(path: SessionPath, policy: SweepPolicy, levelR: number): SessionOutcome {
  const { armR, floorR } = guardLevelsForR(levelR);
  let cum = 0;
  let reached = false;
  let armed = false;
  let halted = false;
  let entriesDropped = 0;
  const dropped = new Set<string>();
  for (const ev of path.events) {
    if (ev.kind === 'entry') {
      if (halted) {
        dropped.add(ev.tradeId);
        entriesDropped += 1;
      }
      continue;
    }
    if (dropped.has(ev.tradeId)) continue;
    cum += ev.r;
    if (policy === 'none') continue;
    if (cum >= levelR) reached = true;
    if (policy === 'bank') {
      if (reached) halted = true;
    } else if (policy === 'giveBack') {
      if (cum >= armR) armed = true;
      if (reached) halted = true;
      else if (armed && cum <= floorR) halted = true;
    } else {
      // bankTrail
      if (cum >= armR) armed = true;
      if (reached && cum < levelR) halted = true;
      else if (armed && !reached && cum <= floorR) halted = true;
    }
  }
  return { dayR: cum, halted, entries: path.entries, entriesDropped };
}

/** One policy's outcome over the ACTIVE sessions only — a session with no
 *  entries cannot be changed by a stopping rule, so including it would add the
 *  same constant to every policy and to the baseline. R here is attributed to
 *  the EXIT session (that is when a stopping rule sees it), which is the other
 *  basis from RealizedEdge.avgR — see its note. */
export interface PolicyOutcome {
  policy: SweepPolicy;
  sessionsHalted: number;
  entriesDropped: number;
  /** Summed over active sessions, exit-attributed. NOT avgR × rTrades. */
  totalR: number;
  meanDayR: number | null;
  medianDayR: number | null;
  worstDayR: number | null;
  /** Mean per-session difference against `none`, with its bootstrap 95% CI
   *  and sign-flip p-value (significance.ts). Null for `none` itself. */
  delta: { meanR: number; ciLowR: number; ciHighR: number; pValue: number | null; reliable: boolean } | null;
}

export interface SweepLevel {
  levelR: number;
  /** levelR × riskPerTradePct — the level as a % of equity AT FULL SIZE.
   *  Overstates a day whose trades were cut by step-down, the regime cut or
   *  probation; the R axis is the truth. Null without a risk %. */
  levelPct: number | null;
  isStoredTarget: boolean;
  policies: PolicyOutcome[];
}

export interface DailyTargetSweepResult {
  book: string;
  realized: RealizedEdge;
  riskPerTradePct: number | null;
  storedTargetPct: number | null;
  /** The stored target on the R axis (storedTargetPct / riskPerTradePct). */
  storedTargetR: number | null;
  /** The baseline every level is measured against: the record as it happened,
   *  over the ACTIVE sessions. */
  actual: PolicyOutcome;
  /** Every exit in the window, including those landing on sessions with no
   *  entries — which `actual.totalR` deliberately excludes, since no stopping
   *  rule could have touched them.
   *
   *  Present ONLY so the two are reconcilable at a glance: this equals
   *  `realized.avgR × realized.rTrades` (to rounding), while `actual.totalR`
   *  does not and was never meant to. Comparing those two and finding them
   *  0.65R apart is what prompted this field — a difference of attribution
   *  that read exactly like a defect. Not used by any policy comparison: the
   *  baseline and every level must share one session set or the deltas stop
   *  meaning anything. */
  totalRAllSessions: number;
  levels: SweepLevel[];
  /** The realized edge's own floors — ≥ 20 R-scored trades AND ≥ 20 active
   *  sessions. Below either the per-level CIs are reported but are noise;
   *  forty empty sessions would otherwise read as a reliable sweep of nothing. */
  reliable: boolean;
  tradesUsed: number;
  droppedTrades: number;
  approximatedExits: number;
  /** The window that was read (oldest first). */
  sessionDates: string[];
  /** Sessions with at least one entry — the ones every statistic above is
   *  over. A session with no entries cannot be changed by any stopping rule,
   *  so it carries no information about one; counting it as a zero-change day
   *  would only shrink the interval (26 of the live book's 40 sessions were
   *  idle on the first production read, and did exactly that). */
  activeSessions: number;
  idleSessions: number;
}

/** 0.5R … 6R in half-R steps: a 1.25%-risk book reads this as roughly 0.6% …
 *  7.5% of equity, which brackets every goal anyone has set on it. */
export const SWEEP_GRID_R: readonly number[] = Array.from({ length: 12 }, (_, i) => (i + 1) * 0.5);

export interface DailyTargetSweepInput {
  book: string;
  trades: SweepTrade[];
  sessionDates: string[];
  droppedTrades: number;
  approximatedExits: number;
  lookbackSessions: number;
  riskPerTradePct: number | null;
  storedTargetPct: number | null;
  rng?: () => number;
  resamples?: number;
}

function summarize(
  policy: SweepPolicy,
  outcomes: SessionOutcome[],
  baseline: number[] | null,
  opts: { rng?: () => number; resamples?: number },
): PolicyOutcome {
  const days = outcomes.map((o) => o.dayR);
  const sorted = [...days].sort((a, b) => a - b);
  const total = days.reduce((s, d) => s + d, 0);
  let delta: PolicyOutcome['delta'] = null;
  if (baseline !== null) {
    const stats = computeSignificanceStats(
      days.map((d, i) => ({ pnl: d - baseline[i] })),
      { rng: opts.rng, resamples: opts.resamples },
    );
    delta = {
      meanR: stats.expectancy ?? 0,
      ciLowR: stats.ciLow ?? 0,
      ciHighR: stats.ciHigh ?? 0,
      pValue: stats.pValue,
      reliable: stats.reliable,
    };
  }
  return {
    policy,
    sessionsHalted: outcomes.filter((o) => o.halted).length,
    entriesDropped: outcomes.reduce((s, o) => s + o.entriesDropped, 0),
    totalR: round2(total),
    meanDayR: days.length ? round2(total / days.length) : null,
    medianDayR: days.length
      ? round2(
          sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
        )
      : null,
    worstDayR: days.length ? round2(sorted[0]) : null,
    delta,
  };
}

export function runDailyTargetSweep(input: DailyTargetSweepInput): DailyTargetSweepResult {
  const all = buildSessionPaths(input.trades, input.sessionDates).paths;
  const paths = all.filter(isActiveSession);
  const realized = computeRealizedEdge({
    trades: input.trades,
    sessionDates: input.sessionDates,
    droppedTrades: input.droppedTrades,
    lookbackSessions: input.lookbackSessions,
  });
  const opts = { rng: input.rng, resamples: input.resamples };
  const actualOutcomes = paths.map((p) => simulateSession(p, 'none', Number.POSITIVE_INFINITY));
  // Over ALL paths, not the active ones — see totalRAllSessions.
  const totalRAllSessions = round2(
    all.flatMap((p) => p.events.filter((e) => e.kind === 'exit')).reduce((sum, e) => sum + e.r, 0),
  );
  const actualDays = actualOutcomes.map((o) => o.dayR);
  const actual = summarize('none', actualOutcomes, null, opts);

  const risk = input.riskPerTradePct !== null && input.riskPerTradePct > 0 ? input.riskPerTradePct : null;
  const storedTargetR =
    risk !== null && input.storedTargetPct !== null && input.storedTargetPct > 0
      ? round2(input.storedTargetPct / risk)
      : null;
  const grid = [...SWEEP_GRID_R];
  if (storedTargetR !== null && !grid.some((g) => Math.abs(g - storedTargetR) < 1e-9)) grid.push(storedTargetR);
  grid.sort((a, b) => a - b);

  const levels: SweepLevel[] = grid.map((levelR) => ({
    levelR,
    levelPct: risk !== null ? round2(levelR * risk) : null,
    isStoredTarget: storedTargetR !== null && Math.abs(levelR - storedTargetR) < 1e-9,
    policies: SWEEP_POLICIES.filter((p) => p !== 'none').map((policy) =>
      summarize(
        policy,
        paths.map((p) => simulateSession(p, policy, levelR)),
        actualDays,
        opts,
      ),
    ),
  }));

  return {
    book: input.book,
    realized,
    totalRAllSessions,
    riskPerTradePct: risk,
    storedTargetPct: input.storedTargetPct,
    storedTargetR,
    actual,
    levels,
    reliable: realized.reliable,
    tradesUsed: realized.rTrades,
    droppedTrades: input.droppedTrades,
    approximatedExits: input.approximatedExits,
    sessionDates: [...input.sessionDates].sort(),
    activeSessions: paths.length,
    idleSessions: all.length - paths.length,
  };
}
