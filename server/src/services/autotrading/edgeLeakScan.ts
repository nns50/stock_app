import { computeSignificanceStats } from './significance';
import { buildSessionPaths, isActiveSession, simulateSession, SweepTrade } from './dailyTargetSweep';
import { etToday } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// The edge-leak scan (Decision 11, 2026-09-12).
//
// WHY THIS EXISTS AT ALL. Three leaks were found in this book in one week, and
// every one of them was found because a human happened to look:
//
//   - second entries on a stock that had already run gave back what the first
//     entries made (live round 1 +$342, round 2 -$185) -- pointed at by the
//     operator, from memory;
//   - the options sleeve decided its exits correctly and then never filled
//     them -- found by reading one position's tick timeline by hand;
//   - the options order cap was 14x too large, hand-frozen, and describing an
//     account that had since moved -- found while writing a plan.
//
// All three were visible in journals the app was already writing. They
// surfaced when someone looked in the right place, which is not a process. The
// scan is the answer to "why are these only found when I tell you about them":
// it walks a FIXED CATALOG of dimensions over both books, applies ONE
// statistical bar to every one of them, and reports what fails it, with the
// lever that closes it. A leak becomes visible on the day it becomes
// measurable rather than on the day someone thinks to cut the book that way.
//
// THE CONTROL ARM IS LOAD-BEARING. The paper book consumes the same signals in
// the same tick (loop.ts runs paper first), so a bucket that loses money in
// BOTH books is a property of the decision, while one that loses only in the
// live book is a property of execution -- a different finding with a different
// fix. A dimension the paper book cannot speak to (n < CONTROL_MIN_TRADES) is
// reported `unconfirmed`, never `leak`: the whole point is to stop acting on
// one book's noise.
//
// WHAT IT IS NOT. It renders no verdict beyond the bar, applies nothing, and
// changes no config: it is evidence a human (or, from PR C, a gated-switch
// rule with its own written criterion) acts on. Same posture as
// significance.ts and autoTuneEfficacy.ts, for the same reason -- telling a
// real edge from a regime shift is genuinely hard.
//
// PURE. Rows in, findings out; no DB, no clock, no market data. The DB half is
// edgeLeakScanData.ts, so the catalog and the bar stay unit-testable on
// fixtures.
// ---------------------------------------------------------------------------

export type LeakBook = 'live' | 'paper';

/** One closed trade, enriched with every attribute the catalog cuts by.
 *
 *  `r` and `pnlUsd` are NOT computed here. They are carried over from the
 *  collectors both the sweep and the daily-goal evidence already use, so the
 *  scan cannot grow a second definition of a realized R (CLAUDE.md: two places
 *  deriving the same quantity must agree by construction). */
export interface LeakTrade {
  /** The sweep's own book-prefixed id (`pos:12`, `lopt:3`, `paper:7`, …). */
  id: string;
  book: LeakBook;
  symbol: string;
  sector: string | null;
  assetKind: 'equity' | 'options';
  entryAt: number;
  exitAt: number;
  /** ET calendar date of the ENTRY — the session a trade belongs to. */
  etDate: string;
  /** Minutes past ET midnight at entry; null when the entry time is unknown. */
  entryMinuteEt: number | null;
  r: number;
  pnlUsd: number;
  /** 1, 2, 3… within this symbol on this ET date, by entry time. */
  round: number;
  score: number | null;
  exitReason: string | null;
  holdMinutes: number;
  quantity: number;
  mlRegime: string | null;
  /** 0 = Sunday … 6 = Saturday, on the ET calendar. */
  weekday: number;
  /** From the `entry_extension_shadow` journal row, when one was matched. */
  vwapExtPct: number | null;
  pctOfRange: number | null;
}

// --- the bar ---------------------------------------------------------------

/** A bucket cannot be called a leak below this many trades. 15 is under
 *  significance.ts's own MIN_RELIABLE_TRADES of 20 on purpose: this is a
 *  screen that says "go look", not a conclusion, and the paper control plus
 *  the CI carry the weight that the sample size does not. */
export const LEAK_MIN_TRADES = 15;
/** Below this, a bucket is not even a watch — it is silence. */
export const WATCH_MIN_TRADES = 10;
/** How close to the bar a bucket has to sit to be worth watching: its 95%
 *  interval within 0.05R of being entirely below zero. */
export const WATCH_MARGIN_R = 0.05;
/** The paper control needs this many trades in the SAME bucket before its
 *  agreement (or disagreement) means anything. */
export const CONTROL_MIN_TRADES = 10;

export type LeakVerdict = 'leak' | 'unconfirmed' | 'watch' | 'ok';

/** What closes a leak: a config field with the value that closes it, or a code
 *  path when no setting expresses it. `direction` matters for PR C's gated
 *  switches — only a lever that REDUCES exposure may ever be applied
 *  automatically. */
export interface LeakLever {
  kind: 'config' | 'code';
  field: string | null;
  value: number | string | boolean | null;
  direction: 'safe' | 'exposure' | 'research';
  detail: string;
}

export interface BucketStats {
  bucket: string;
  n: number;
  meanR: number | null;
  totalR: number;
  totalPnlUsd: number;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
}

export interface BucketReport extends BucketStats {
  verdict: LeakVerdict;
  /** The same bucket in the paper book — the control. Null when the paper book
   *  has no trades in it at all. */
  control: BucketStats | null;
  /** True when the control has CONTROL_MIN_TRADES+ trades and its mean agrees
   *  in sign with the live book's. */
  controlAgrees: boolean;
  lever: LeakLever | null;
  /** R left on the table over the window: -totalR, floored at 0. A leak that
   *  has cost nothing yet is still a leak, it is just not urgent. */
  severityR: number;
}

/** A bucket that failed the bar, carrying the dimension it came from so a
 *  reader (and PR C's gated switches) never has to look it up. */
export interface LeakReport extends BucketReport {
  dimension: string;
  dimensionLabel: string;
}

export interface DimensionReport {
  id: string;
  label: string;
  /** Trades that carried a value for this dimension. A bucket-less trade (no
   *  score stamped, no extension row matched) is EXCLUDED and counted, never
   *  filed under "unknown" — an unknown bucket would pool unrelated trades and
   *  then report a mean for them. */
  covered: number;
  uncovered: number;
  buckets: BucketReport[];
}

/** A thing that happened, rather than a distribution that reads badly. Any
 *  occurrence is a finding: an exit that failed, a cap that no longer matches
 *  its derivation, a tuner row on a day the tuner should be off. */
export interface ScanFinding {
  id: string;
  kind: 'execution' | 'configuration';
  /** For an execution finding: when the class was last seen, and how many
   *  sessions ago. Null on a configuration finding, which is a state rather
   *  than an occurrence. */
  lastSeenEtDate?: string | null;
  sessionsSinceLastSeen?: number | null;
  label: string;
  count: number;
  detail: string;
  lever: LeakLever | null;
}

/** One class of execution occurrence, as counted from the journal. */
export interface ExecutionOccurrence {
  action: string;
  count: number;
  detail?: string;
  /**
   * The most recent session this class occurred on, and how many sessions ago
   * that was (0 = the latest session in the window).
   *
   * A COUNT WITHOUT A DATE IS NOT ACTIONABLE, which the first production read
   * proved on 2026-09-12: the top four findings were 261 options exit
   * failures, 147 refused scale-outs, 62 blocked stop ratchets and 11 bracket
   * re-arms -- every one of them from BEFORE the fix that closed it, and every
   * one ranked as something to go and do. The window is ten sessions, so a fix
   * that landed yesterday leaves nine more evenings of the same false report,
   * which is precisely how a reader learns to skip the section.
   *
   * The scan cannot know a deploy happened, so it does not claim the class is
   * fixed. It says when the class was last seen and lets the reader judge.
   */
  lastSeenEtDate?: string | null;
  sessionsSinceLastSeen?: number | null;
}

export interface DayLevelReport {
  /** Sessions in the window that the live book placed at least one entry on. */
  activeSessions: number;
  sessions: number;
  /** The stored daily goal expressed in R at the stored risk % — the level the
   *  goal-rate below is counted at. Null when no goal is armed. */
  storedTargetR: number | null;
  goalReachedSessions: number;
  goalRatePct: number | null;
  /** The same count at 1R, the shape the sweep says this book actually
   *  produces — the honest comparison for "how far is the goal from reach". */
  oneRSessions: number;
  redSessions: number;
  meanRedSessionR: number | null;
  worstSessionR: number | null;
  /**
   * Exit reasons that produced the red sessions' losses, biggest first.
   *
   * `lastSeenEtDate` is load-bearing, not decoration: `unknown` means the exit
   * reason was not recorded, which is a gap in the RECORD rather than a way of
   * losing money — and a driver that stopped contributing weeks ago is history
   * the window is still carrying, not something to act on.
   */
  redSessionDrivers: { reason: string; totalR: number; trades: number; lastSeenEtDate: string | null }[];
}

export interface UntakenClass {
  reason: string;
  n: number;
  paperMeanR: number | null;
  paperTotalR: number;
}

export interface AttributionReport {
  /** Paper entries matched to a live entry on the same symbol and ET date
   *  within PAIR_TOLERANCE_MS. */
  pairedTrades: number;
  /** Mean (live R − paper R) over the pairs: what the live book loses to
   *  execution on the very same decision. */
  meanDiffR: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  /** Mean live ENTRY slippage over the window, in % of the limit price. */
  meanEntrySlippagePct: number | null;
  /** Paper entries with no live twin, by why the live book did not take it. */
  untaken: UntakenClass[];
}

/** How far apart two entries on the same symbol and date may be and still be
 *  the same decision. Both books are entered inside one tick, and the live
 *  entry is stamped at PLACEMENT — a minute of tolerance covers the broker
 *  round-trip without pairing two genuinely different entries hours apart. */
export const PAIR_TOLERANCE_MS = 60_000;

/** A live-book skip, as journaled, for classifying an untaken paper entry. */
export interface JournalSkip {
  symbol: string;
  at: number;
  action: string;
  /** `failedRules[0]` for a risk block, else null. */
  failedRule: string | null;
}

export interface CollectedLeakBook {
  trades: LeakTrade[];
  sessionDates: string[];
  droppedTrades: number;
}

export interface EdgeLeakScanInput {
  books: LeakBook[];
  live: CollectedLeakBook;
  paper: CollectedLeakBook;
  lookbackSessions: number;
  storedTargetR: number | null;
  execution: ExecutionOccurrence[];
  configuration: ScanFinding[];
  /** Live ENTRY slippage rows over the window, in % of the limit price. */
  entrySlippagePct: number[];
  journalSkips: JournalSkip[];
  /** Whether `journalSkips` is the complete window or was cut short. */
  journalSkipsTruncated?: boolean;
  /** Epoch ms of each batch-level `entry_window_closed` row in the window.
   *  Separate from `journalSkips` because it carries no symbol — see
   *  classifyUntaken for why that made it invisible. */
  entryWindowClosures?: number[];
  asOf: number;
  /** Injectable for tests; the route seeds it so one book produces one scan. */
  rng?: () => number;
}

export interface EdgeLeakScanResult {
  asOf: number;
  lookbackSessions: number;
  books: LeakBook[];
  leaks: LeakReport[];
  watches: LeakReport[];
  findings: ScanFinding[];
  dimensions: DimensionReport[];
  dayLevel: DayLevelReport;
  attribution: AttributionReport;
  coverage: {
    liveTrades: number;
    paperTrades: number;
    liveDropped: number;
    paperDropped: number;
    sessions: number;
    /**
     * True when the journal read that classifies untaken paper entries hit its
     * ceiling, so some skips in the window were not seen.
     *
     * It has to be on the wire. When the skip read is short, every paper entry
     * whose skip was missed lands in `no_live_row` — a bucket whose whole
     * meaning is "the journal says nothing" — and that is indistinguishable
     * from a real recording gap unless the incompleteness travels with it.
     */
    journalSkipsTruncated: boolean;
  };
}

// --- the catalog -----------------------------------------------------------

interface Dimension {
  id: string;
  label: string;
  /** Null means "this trade carries no value for this cut" — excluded and
   *  counted, never pooled into an `unknown` bucket. */
  bucketOf: (t: LeakTrade) => string | null;
  /** Buckets below this many trades are dropped before the bar runs — used by
   *  the per-symbol cut, where a two-trade name is noise by construction. */
  minBucketTrades?: number;
  lever?: (bucket: string) => LeakLever | null;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Half-hour label from ET minutes: 570 → "09:30". */
function halfHourLabel(minute: number): string {
  const slot = Math.floor(minute / 30) * 30;
  return `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`;
}

function band(value: number, edges: number[], labels: string[]): string {
  for (let i = 0; i < edges.length; i++) if (value < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

/**
 * The dimensions the book is cut by, v1.
 *
 * Adding to this list is how the rule in the playbook is honoured: when a human
 * finds a leak the scan missed, the dimension goes in here in the same PR that
 * fixes the leak, so the same class of miss cannot repeat silently.
 */
export const DIMENSIONS: Dimension[] = [
  {
    id: 'round',
    label: 'Round within symbol-day',
    bucketOf: (t) => (t.round >= 3 ? '3+' : String(t.round)),
    lever: (bucket) =>
      bucket === '1'
        ? null
        : {
            kind: 'config',
            field: 'symbolReentryCooldownMinutes',
            value: 390,
            direction: 'safe',
            detail: 'One live entry per symbol per session — a full session of cooldown refuses the repeat.',
          },
  },
  {
    id: 'entryHalfHour',
    label: 'Entry half-hour (ET)',
    bucketOf: (t) => (t.entryMinuteEt === null ? null : halfHourLabel(t.entryMinuteEt)),
  },
  {
    id: 'entryAfter13',
    label: 'Entry before/after 13:00 ET',
    bucketOf: (t) => (t.entryMinuteEt === null ? null : t.entryMinuteEt >= 13 * 60 ? 'after_13' : 'before_13'),
    lever: (bucket) =>
      bucket === 'after_13'
        ? {
            kind: 'code',
            field: 'liveNoEntryMinutesBeforeClose',
            value: null,
            direction: 'safe',
            detail:
              'An equity entry cutoff (the twin of optionsNoEntryMinutesBeforeClose) has to be BUILT before it can be set — see the playbook rule.',
          }
        : null,
  },
  {
    id: 'scoreBand',
    label: 'Entry score band',
    bucketOf: (t) => (t.score === null ? null : band(t.score, [60, 70, 80], ['<60', '60-69', '70-79', '80+'])),
    lever: (bucket) =>
      bucket === '<60' || bucket === '60-69'
        ? {
            kind: 'config',
            field: 'liveMinSignalScore',
            value: bucket === '<60' ? 60 : 70,
            direction: 'safe',
            detail: 'Raise the live-only score floor above the losing band; paper keeps trading it as the control.',
          }
        : null,
  },
  {
    id: 'vwapExtension',
    label: 'VWAP extension at entry (%)',
    bucketOf: (t) =>
      t.vwapExtPct === null ? null : band(t.vwapExtPct, [0, 0.5, 1, 2], ['<0', '0-0.5', '0.5-1', '1-2', '2+']),
  },
  {
    id: 'pctOfRange',
    label: 'Entry as % of session range',
    bucketOf: (t) =>
      t.pctOfRange === null ? null : band(t.pctOfRange, [50, 70, 85], ['<50', '50-70', '70-85', '85+']),
  },
  { id: 'exitReason', label: 'Exit reason', bucketOf: (t) => t.exitReason },
  {
    id: 'holdMinutes',
    label: 'Hold time',
    bucketOf: (t) => band(t.holdMinutes, [15, 60, 180], ['<15m', '15-60m', '1-3h', '3h+']),
  },
  { id: 'symbol', label: 'Symbol', bucketOf: (t) => t.symbol, minBucketTrades: 5 },
  { id: 'sector', label: 'Sector', bucketOf: (t) => t.sector },
  {
    id: 'weekday',
    label: 'Weekday (ET)',
    bucketOf: (t) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.weekday],
  },
  { id: 'mlRegime', label: 'ML regime at entry', bucketOf: (t) => t.mlRegime },
  {
    id: 'assetKind',
    label: 'Asset',
    bucketOf: (t) => t.assetKind,
  },
  {
    id: 'quantityBand',
    label: 'Position size (units)',
    bucketOf: (t) =>
      t.assetKind === 'options' ? null : band(t.quantity, [5, 20, 100], ['<5', '5-19', '20-99', '100+']),
  },
];

// --- the machinery ---------------------------------------------------------

function statsFor(bucket: string, trades: LeakTrade[], rng: () => number): BucketStats {
  const sig = computeSignificanceStats(
    trades.map((t) => ({ pnl: t.r })),
    { rng },
  );
  return {
    bucket,
    n: trades.length,
    meanR: sig.expectancy === null ? null : round4(sig.expectancy),
    totalR: round4(trades.reduce((s, t) => s + t.r, 0)),
    totalPnlUsd: round2(trades.reduce((s, t) => s + t.pnlUsd, 0)),
    ciLow: sig.ciLow,
    ciHigh: sig.ciHigh,
    pValue: sig.pValue,
  };
}

/**
 * ONE bar, for every dimension. Stated as plainly as it can be:
 *
 *   leak        — n >= 15, the whole 95% interval sits below zero, and the
 *                 paper control (n >= 10) agrees in sign.
 *   unconfirmed — the same, but the control cannot speak to it. Never acted on
 *                 automatically; it is a request for more paper trades.
 *   watch       — n >= 10 and the interval is within 0.05R of clearing the bar.
 *   ok          — everything else.
 *
 * The control test is on the SIGN of the mean, not on its own interval: asking
 * the control arm to be independently significant would throw away most of
 * what it knows, since it is the smaller book by construction.
 */
export function verdictFor(live: BucketStats, control: BucketStats | null): { verdict: LeakVerdict; agrees: boolean } {
  const agrees =
    control !== null && control.n >= CONTROL_MIN_TRADES && control.meanR !== null && live.meanR !== null
      ? control.meanR < 0 === live.meanR < 0
      : false;
  const controlCanSpeak = control !== null && control.n >= CONTROL_MIN_TRADES;
  const belowZero = live.ciHigh !== null && live.ciHigh < 0;
  if (live.n >= LEAK_MIN_TRADES && belowZero) {
    if (!controlCanSpeak) return { verdict: 'unconfirmed', agrees: false };
    return agrees ? { verdict: 'leak', agrees } : { verdict: 'watch', agrees };
  }
  const nearBar = live.ciHigh !== null && live.ciHigh < WATCH_MARGIN_R && live.meanR !== null && live.meanR < 0;
  if (live.n >= WATCH_MIN_TRADES && nearBar) return { verdict: 'watch', agrees };
  return { verdict: 'ok', agrees };
}

function groupBy(trades: LeakTrade[], dim: Dimension): Map<string, LeakTrade[]> {
  const out = new Map<string, LeakTrade[]>();
  for (const t of trades) {
    const b = dim.bucketOf(t);
    if (b === null) continue;
    const hit = out.get(b);
    if (hit) hit.push(t);
    else out.set(b, [t]);
  }
  return out;
}

function runDimension(dim: Dimension, live: LeakTrade[], paper: LeakTrade[], rng: () => number): DimensionReport {
  const liveBuckets = groupBy(live, dim);
  const paperBuckets = groupBy(paper, dim);
  const min = dim.minBucketTrades ?? 1;
  const buckets: BucketReport[] = [];
  let covered = 0;
  for (const [bucket, rows] of liveBuckets) {
    covered += rows.length;
    if (rows.length < min) continue;
    const stats = statsFor(bucket, rows, rng);
    const controlRows = paperBuckets.get(bucket);
    const control = controlRows ? statsFor(bucket, controlRows, rng) : null;
    const { verdict, agrees } = verdictFor(stats, control);
    buckets.push({
      ...stats,
      verdict,
      control,
      controlAgrees: agrees,
      lever: verdict === 'ok' ? null : (dim.lever?.(bucket) ?? null),
      severityR: Math.max(0, round4(-stats.totalR)),
    });
  }
  buckets.sort((a, b) => b.severityR - a.severityR || a.bucket.localeCompare(b.bucket));
  return { id: dim.id, label: dim.label, covered, uncovered: live.length - covered, buckets };
}

// --- day level -------------------------------------------------------------

const toSweepTrade = (t: LeakTrade): SweepTrade => ({ id: t.id, entryAt: t.entryAt, exitAt: t.exitAt, r: t.r });

/**
 * The day-level read: how often the goal was actually reached, how often a 1R
 * day was, and what the red days were made of.
 *
 * Counted through the sweep's own `simulateSession` under the `bank` policy —
 * the same function the daily-target sweep route uses — so "reached the goal"
 * means here exactly what it means there. No bootstrap: this is a count of
 * sessions, not an estimate.
 */
export function buildDayLevel(live: LeakTrade[], sessionDates: string[], storedTargetR: number | null): DayLevelReport {
  const { paths } = buildSessionPaths(live.map(toSweepTrade), sessionDates);
  const active = paths.filter(isActiveSession);
  const goalReached =
    storedTargetR === null || !(storedTargetR > 0)
      ? 0
      : active.filter((p) => simulateSession(p, 'bank', storedTargetR).reached).length;
  const oneR = active.filter((p) => simulateSession(p, 'bank', 1).reached).length;

  const sessionR = new Map<string, number>();
  for (const p of paths) {
    sessionR.set(
      p.date,
      p.events.filter((e) => e.kind === 'exit').reduce((s, e) => s + e.r, 0),
    );
  }
  const red = [...sessionR.entries()].filter(([, r]) => r < 0);
  const worst = [...sessionR.values()].reduce<number | null>((w, r) => (w === null || r < w ? r : w), null);

  // What produced the red days: every LOSING trade that closed on one, by exit
  // reason. The question the operator asked is "least loss on the red days",
  // and that is answerable only if the losses have names.
  const redDates = new Set(red.map(([d]) => d));
  const drivers = new Map<string, { totalR: number; trades: number; lastSeenEtDate: string | null }>();
  for (const t of live) {
    if (t.r >= 0) continue;
    const exitDate = etToday(t.exitAt);
    if (!redDates.has(exitDate)) continue;
    const key = t.exitReason ?? 'unknown';
    const hit = drivers.get(key) ?? { totalR: 0, trades: 0, lastSeenEtDate: null };
    hit.totalR = round4(hit.totalR + t.r);
    hit.trades += 1;
    // WHEN a driver last contributed, for the same reason execution findings
    // carry it (2026-09-12). On the live book that day, `unknown` was the
    // LARGEST red-day driver at -4.32R over 3 trades — worse per trade than an
    // actual stop, which reads like trades blowing through their stops. Every
    // one of those 35 rows was from 2026-07-13..08-24, before exit-reason
    // recording was fixed; none since. A forty-session window keeps showing
    // that for weeks, and Decision 9's review reads this list.
    if (hit.lastSeenEtDate === null || exitDate > hit.lastSeenEtDate) hit.lastSeenEtDate = exitDate;
    drivers.set(key, hit);
  }

  return {
    activeSessions: active.length,
    sessions: paths.length,
    storedTargetR,
    goalReachedSessions: goalReached,
    goalRatePct: active.length ? round2((goalReached / active.length) * 100) : null,
    oneRSessions: oneR,
    redSessions: red.length,
    meanRedSessionR: red.length ? round4(red.reduce((s, [, r]) => s + r, 0) / red.length) : null,
    worstSessionR: worst === null ? null : round4(worst),
    redSessionDrivers: [...drivers.entries()]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => a.totalR - b.totalR),
  };
}

// --- attribution -----------------------------------------------------------

/**
 * Where the live book loses the paper book's edge.
 *
 * Both books see the same `decision.signals` in one tick (loop.ts runs paper
 * first), so a paper entry with no live twin is a REFUSAL somewhere in the live
 * path, and a paired trade whose R differs is execution. The ~10x gap between
 * the two books' returns has never been attributed; this splits it into "we
 * didn't take it" and "we took it worse", with the reason for each refusal.
 */
export function buildAttribution(
  live: LeakTrade[],
  paper: LeakTrade[],
  skips: JournalSkip[],
  /** Epoch ms of each batch-level `entry_window_closed` row in the window —
   *  the one live refusal that names no symbol. See classifyUntaken. */
  entryWindowClosures: number[],
  entrySlippagePct: number[],
  rng: () => number,
): AttributionReport {
  const liveByKey = new Map<string, LeakTrade[]>();
  for (const t of live) {
    const key = `${t.symbol}|${t.etDate}`;
    const hit = liveByKey.get(key);
    if (hit) hit.push(t);
    else liveByKey.set(key, [t]);
  }

  const diffs: number[] = [];
  const untakenTrades: { trade: LeakTrade; reason: string }[] = [];
  const usedLiveIds = new Set<string>();
  for (const p of paper) {
    const candidates = (liveByKey.get(`${p.symbol}|${p.etDate}`) ?? []).filter(
      (l) => !usedLiveIds.has(l.id) && Math.abs(l.entryAt - p.entryAt) <= PAIR_TOLERANCE_MS,
    );
    const match = candidates.sort((a, b) => Math.abs(a.entryAt - p.entryAt) - Math.abs(b.entryAt - p.entryAt))[0];
    if (match) {
      usedLiveIds.add(match.id);
      diffs.push(match.r - p.r);
      continue;
    }
    untakenTrades.push({ trade: p, reason: classifyUntaken(p, skips, entryWindowClosures) });
  }

  const byReason = new Map<string, LeakTrade[]>();
  for (const u of untakenTrades) {
    const hit = byReason.get(u.reason);
    if (hit) hit.push(u.trade);
    else byReason.set(u.reason, [u.trade]);
  }

  const sig = computeSignificanceStats(
    diffs.map((d) => ({ pnl: d })),
    { rng },
  );
  return {
    pairedTrades: diffs.length,
    meanDiffR: sig.expectancy === null ? null : round4(sig.expectancy),
    ciLow: sig.ciLow,
    ciHigh: sig.ciHigh,
    pValue: sig.pValue,
    meanEntrySlippagePct: entrySlippagePct.length
      ? round2(entrySlippagePct.reduce((s, p) => s + p, 0) / entrySlippagePct.length)
      : null,
    untaken: [...byReason.entries()]
      .map(([reason, rows]) => ({
        reason,
        n: rows.length,
        paperMeanR: round4(rows.reduce((s, t) => s + t.r, 0) / rows.length),
        paperTotalR: round4(rows.reduce((s, t) => s + t.r, 0)),
      }))
      .sort((a, b) => b.paperTotalR - a.paperTotalR),
  };
}

/**
 * The live journal's own word for why this name was not taken, read within the
 * minute of the paper entry. `no_live_row` is the honest answer when the
 * journal says nothing — it is a gap in the record, not a cause.
 *
 * THE END-OF-DAY CUTOFF IS MATCHED BY TIME, NOT BY SYMBOL (2026-09-12).
 *
 * Every other refusal on the live entry path names the symbol it refused.
 * `entry_window_closed` cannot: `evaluateEntryCutoff` runs BEFORE the per-
 * candidate loop and refuses the whole batch at once, so the row carries a
 * count (`refused`) and no symbol at all. `collectJournalSkips` then drops it
 * (`.filter(e => e.symbol !== null)`) and the symbol match below could never
 * have hit it anyway — so every paper entry the live book declined because the
 * flatten was about to swallow it was reported as `no_live_row`, the bucket
 * that means "nothing the journal explains".
 *
 * It is the single largest untaken bucket and the one the routine watches, so a
 * deliberate, correct refusal reading as an unexplained gap points the operator
 * at loosening a gate that is doing its job. The plan's own design for this
 * classifier said "`entry_window_closed` (batch, BY TIME)"; the implementation
 * matched on symbol like everything else and lost it.
 *
 * Matched on the TICK rather than on a recomputed clock: both books decide in
 * the same tick (paper first, then live), so a batch refusal within
 * PAIR_TOLERANCE_MS of the paper entry IS the refusal that would have taken it.
 * A tick where live had no candidates at all journals nothing and stays
 * `no_live_row`, which is correct — nothing refused that name. A symbol-named
 * skip wins over the batch row when both cover the tick: it says more.
 */
function classifyUntaken(paperTrade: LeakTrade, skips: JournalSkip[], entryWindowClosures: number[]): string {
  const near = skips.filter(
    (s) => s.symbol === paperTrade.symbol && Math.abs(s.at - paperTrade.entryAt) <= PAIR_TOLERANCE_MS,
  );
  if (near.length === 0) {
    const batched = entryWindowClosures.some((at) => Math.abs(at - paperTrade.entryAt) <= PAIR_TOLERANCE_MS);
    return batched ? 'entry_window_closed' : 'no_live_row';
  }
  const risk = near.find((s) => s.action === 'live_risk_blocked' && s.failedRule);
  if (risk) return `live_risk_blocked:${risk.failedRule}`;
  return near[0].action;
}

// --- the scan --------------------------------------------------------------

/** mulberry32 — small, fast, deterministic. The scan seeds it from a constant
 *  so the same book produces the same intervals every run: a leak that appears
 *  and disappears between two reads of the same data is worse than no scan. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCAN_RNG_SEED = 20260912;

/**
 * The recency clause appended to an execution finding's detail. Deliberately
 * descriptive, never a verdict: "not seen since" is a fact, "fixed" would be a
 * guess the scan has no evidence for.
 */
export function recencySuffix(sessionsAgo: number | null, lastSeen: string | null): string {
  if (sessionsAgo === null || lastSeen === null) return '';
  if (sessionsAgo === 0) return ` — including the latest session (${lastSeen})`;
  const s = sessionsAgo === 1 ? 'session' : 'sessions';
  return ` — none since ${lastSeen}, ${sessionsAgo} ${s} ago`;
}

export function runEdgeLeakScan(input: EdgeLeakScanInput): EdgeLeakScanResult {
  const rng = input.rng ?? mulberry32(SCAN_RNG_SEED);
  const live = input.live.trades;
  const paper = input.paper.trades;
  const dimensions = DIMENSIONS.map((d) => runDimension(d, live, paper, rng));

  const all: LeakReport[] = dimensions.flatMap((d) =>
    d.buckets.map((b) => ({ ...b, dimension: d.id, dimensionLabel: d.label })),
  );
  const bySeverity = (a: LeakReport, b: LeakReport): number => b.severityR - a.severityR;

  const findings: ScanFinding[] = [
    ...input.execution.map((e): ScanFinding => ({
      id: `execution:${e.action}`,
      kind: 'execution',
      label: e.action,
      count: e.count,
      lastSeenEtDate: e.lastSeenEtDate ?? null,
      sessionsSinceLastSeen: e.sessionsSinceLastSeen ?? null,
      detail:
        (e.detail ?? `${e.count} occurrence${e.count === 1 ? '' : 's'} in the execution window`) +
        recencySuffix(e.sessionsSinceLastSeen ?? null, e.lastSeenEtDate ?? null),
      lever: {
        kind: 'code',
        field: null,
        value: null,
        direction: 'safe',
        detail: 'An execution failure is a defect to fix, not a setting to change.',
      },
    })),
    ...input.configuration,
  ];

  return {
    asOf: input.asOf,
    lookbackSessions: input.lookbackSessions,
    books: input.books,
    leaks: all.filter((b) => b.verdict === 'leak' || b.verdict === 'unconfirmed').sort(bySeverity),
    watches: all.filter((b) => b.verdict === 'watch').sort(bySeverity),
    findings,
    dimensions,
    dayLevel: buildDayLevel(live, input.live.sessionDates, input.storedTargetR),
    attribution: buildAttribution(
      live,
      paper,
      input.journalSkips,
      input.entryWindowClosures ?? [],
      input.entrySlippagePct,
      rng,
    ),
    coverage: {
      liveTrades: live.length,
      paperTrades: paper.length,
      liveDropped: input.live.droppedTrades,
      paperDropped: input.paper.droppedTrades,
      sessions: input.live.sessionDates.length,
      journalSkipsTruncated: input.journalSkipsTruncated ?? false,
    },
  };
}
