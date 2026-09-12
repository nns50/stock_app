import type { AutotradeConfig } from '../../db/autotradeConfig';
import type { DailyGoalEvidence } from './targetTune';
import type { EdgeLeakScanResult, UntakenClass } from './edgeLeakScan';
import type { SizingReview } from './gatedSwitches';

// ---------------------------------------------------------------------------
// The tune advisor (2026-09-12, operator's ask): what to change next, ranked by
// how much of the gap to the daily goal each change would actually close.
//
// EVERYTHING HERE IS ONE EQUATION, DIFFERENTIATED. The app's own identity is
//
//     expected day % = trades/session x risk% x avg R
//
// so there are exactly three factors to move, plus the execution drag that
// stops a decided trade from becoming the R it was worth. Every recommendation
// names which factor it moves and estimates its effect in PERCENTAGE POINTS OF
// THE EXPECTED DAY through that same identity — which is what makes them
// rankable against each other instead of a list of good ideas.
//
// Most estimates will be small. That is the message, not a failure of the
// instrument: a book whose implied day is 0.1% against a 3% goal does not have
// one missing setting, it has a distribution, and a recommender that implied
// otherwise would be lying with arithmetic.
//
// A RECOMMENDATION IS NOT ONLY A SETTING. Some of what the data implies has no
// config field — an entry cutoff that does not exist yet, an exit path that
// decides correctly and fills badly. Those come back as `kind: 'code'` with
// what to build, because "tune" means the workflow, not just the knobs.
//
// AND IT IS NOT PERMISSION. Decision 7 of the 3%-goal plan pre-commits to ONE
// change set with no mid-course knob turning except the revert, precisely
// because a daily recommender invites the opposite. So anything that would
// move the trial's own settings before the 10-session review is marked
// `blocked_by_review` rather than `actionable`, with the session count that
// will unblock it. The advisor argues; the review decides.
//
// PURE. Readings in, recommendations out — the DB half assembles the inputs
// from the edge-leak scan, the goal evidence and the config, all of which are
// already collected.
// ---------------------------------------------------------------------------

/** Which term of the identity a recommendation moves. `goal` is the fourth
 *  option nobody likes: move the target instead of the book. */
export type TuneFactor = 'flow' | 'risk' | 'edge' | 'execution' | 'goal';

export type TuneStatus = 'actionable' | 'blocked_by_review' | 'needs_data';

export interface TuneAction {
  /** `config` — a field and a value. `code` — something to build; the detail
   *  IS the change. `research` — a measurement to run before either. */
  kind: 'config' | 'code' | 'research';
  field: string | null;
  from?: number | string | boolean | null;
  to?: number | string | boolean | null;
  detail: string;
  /** Whether doing this ADDS exposure. The operator's standing division:
   *  safe changes may be automated, exposure changes are theirs. */
  direction: 'safe' | 'exposure' | 'neutral';
}

export interface TuneRecommendation {
  id: string;
  factor: TuneFactor;
  title: string;
  /** The numbers behind it, in the units they were measured in. */
  evidence: string;
  /** Estimated effect on the expected day, in PERCENTAGE POINTS. Null when it
   *  cannot be estimated honestly — an execution defect's cost is real but not
   *  a number this can produce, and inventing one would rank it wrongly. */
  expectedDayPctDelta: number | null;
  /** Trades (or occurrences) the estimate rests on. */
  sampleSize: number;
  confidence: 'strong' | 'moderate' | 'thin';
  status: TuneStatus;
  statusReason: string;
  /**
   * For an execution defect: when the class last occurred and how many
   * sessions ago (0 = the latest session). Null on everything else, which is a
   * distribution rather than an occurrence.
   *
   * A field rather than a phrase inside `statusReason`, because the ranking
   * reads it — and a ranking that String.startsWith()es its way through prose
   * is one rewording away from silently reordering the list.
   */
  lastSeenEtDate: string | null;
  sessionsSinceLastSeen: number | null;
  action: TuneAction;
}

/** The gap, decomposed — the frame every recommendation is ranked inside. */
export interface GoalGap {
  targetDailyGainPct: number | null;
  impliedDailyGainPct: number | null;
  /** Percentage points between them; null when either side is unknown. */
  gapPct: number | null;
  tradesPerSession: number | null;
  riskPerTradePct: number;
  avgR: number | null;
  /** The goal on the R axis, and how often the book reached it. */
  storedTargetR: number | null;
  goalRatePct: number | null;
  goalReachedSessions: number;
  /** How often it reached 1R instead — the honest comparison for "how far is
   *  the goal from what this book produces". */
  oneRSessions: number;
  activeSessions: number;
  /**
   * The review clock: active sessions since the sizing change, against the
   * `REVIEW_SESSIONS` that Decision 7 pre-committed to.
   *
   * This is NOT `activeSessions` above — that one counts the whole lookback
   * window, most of which predates the trial. It is here as a field rather
   * than only inside a blocked recommendation's `statusReason` because it is
   * the number the daily routine reports every evening, and a reader who has
   * to find it inside a prose string only finds it on the days something
   * happens to be blocked.
   */
  activeSessionsSinceChange: number;
  reviewSessionsRequired: number;
}

export interface TuneAdvisorInput {
  config: AutotradeConfig;
  evidence: DailyGoalEvidence;
  /** The last edge-leak scan; null before one has run. */
  scan: EdgeLeakScanResult | null;
  review: SizingReview;
  asOf: number;
}

export interface TuneAdvice {
  asOf: number;
  gap: GoalGap;
  recommendations: TuneRecommendation[];
  /** Said plainly when the answer is "nothing here will get you there" — a
   *  recommender that never says so is one nobody should trust. */
  headline: string;
}

/** Below this many sessions since the sizing change, a recommendation that
 *  would move the trial's own settings is blocked rather than actionable. */
export const REVIEW_SESSIONS = 10;

/** Sample floors for the confidence label. Deliberately the same shape as the
 *  leak scan's bar, one notch lower: this ranks, it does not conclude. */
const STRONG_N = 20;
const MODERATE_N = 10;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function confidenceFor(n: number): TuneRecommendation['confidence'] {
  if (n >= STRONG_N) return 'strong';
  if (n >= MODERATE_N) return 'moderate';
  return 'thin';
}

/** The identity, applied forward: extra trades of mean R, in points of day. */
const dayPctFromTrades = (tradesPerSession: number, riskPct: number, r: number): number =>
  round3(tradesPerSession * riskPct * r);

/** The identity again: a lift in avg R across the flow already being taken. */
const dayPctFromEdge = (tradesPerSession: number, riskPct: number, dR: number): number =>
  round3(tradesPerSession * riskPct * dR);

/** Which config field, if any, governs a refusal class the live book applied.
 *  Null means the gate has no single field — the recommendation becomes a code
 *  or research action instead of pretending there is a knob. */
export function fieldForUntakenReason(reason: string): { field: string; direction: 'exposure' } | null {
  if (reason.startsWith('live_risk_blocked:')) {
    const rule = reason.slice('live_risk_blocked:'.length);
    const byRule: Record<string, string> = {
      max_concurrent_positions: 'maxConcurrentPositions',
      max_trades_per_day: 'maxTradesPerDay',
      max_aggregate_open_risk: 'maxAggregateOpenRiskPct',
      account_exposure: 'liveMaxExposurePct',
      max_sector_exposure: 'maxSectorExposurePct',
      max_correlated_exposure: 'maxCorrelatedExposurePct',
      order_notional: 'liveMaxOrderUsd',
      max_orders_per_day: 'liveMaxOrdersPerDay',
    };
    const field = byRule[rule];
    return field ? { field, direction: 'exposure' } : null;
  }
  if (reason === 'live_score_floor_skipped') return { field: 'liveMinSignalScore', direction: 'exposure' };
  if (reason === 'symbol_reentry_cooldown_skipped') {
    return { field: 'symbolReentryCooldownMinutes', direction: 'exposure' };
  }
  if (reason === 'symbol_cooldown_skipped') return { field: 'symbolCooldownDays', direction: 'exposure' };
  return null;
}

function flowRecommendations(input: TuneAdvisorInput, gap: GoalGap): TuneRecommendation[] {
  const scan = input.scan;
  if (!scan || gap.activeSessions === 0) return [];
  const riskPct = gap.riskPerTradePct;
  const out: TuneRecommendation[] = [];

  for (const u of scan.attribution.untaken) {
    // Only a class the CONTROL made money on is a candidate: refusing trades
    // that lose in paper too is the gate working, not a gap.
    if (u.paperMeanR === null || u.paperTotalR <= 0 || u.n < 5) continue;
    const perSession = u.n / gap.activeSessions;
    const delta = dayPctFromTrades(perSession, riskPct, u.paperMeanR);
    const governed = fieldForUntakenReason(u.reason);
    // `no_live_row` means "the live journal says nothing about this name at
    // that minute". That is only evidence of a recording gap if the journal
    // was read in FULL — when the skip read was cut short, the same bucket
    // fills up with entries whose skip row simply was not fetched, which is
    // exactly what happened on 2026-09-12 (1,928 skips in the window, 1,000
    // read, 102 entries reported as unexplained). An incomplete read cannot
    // support a recommendation, so it is downgraded rather than ranked.
    const unreliable = u.reason === 'no_live_row' && (scan.coverage.journalSkipsTruncated ?? false);
    const blocked = input.review.activeSessionsSinceChange < REVIEW_SESSIONS;
    out.push({
      id: `flow:${u.reason}`,
      factor: 'flow',
      title: `The live book refuses ${u.n} trades on ${humanReason(u.reason)}; paper made money on them`,
      evidence:
        `${u.n} paper entries with no live twin over ${gap.activeSessions} active sessions ` +
        `(${round2(perSession)}/session), mean ${u.paperMeanR}R, ${u.paperTotalR}R total in paper`,
      expectedDayPctDelta: delta,
      sampleSize: u.n,
      confidence: confidenceFor(u.n),
      status: unreliable ? 'needs_data' : blocked ? 'blocked_by_review' : 'actionable',
      statusReason: unreliable
        ? 'the journal skip read was truncated, so "unexplained" here may just be skips that were not fetched — not a finding until the window reads in full'
        : blocked
          ? `adds exposure mid-trial — held until the ${REVIEW_SESSIONS}-session review ` +
            `(${input.review.activeSessionsSinceChange} so far)`
          : 'the operator applies anything that adds exposure',
      // Not an occurrence — a distribution has no "last seen".
      lastSeenEtDate: null,
      sessionsSinceLastSeen: null,
      action: governed
        ? {
            kind: 'config',
            field: governed.field,
            from: (input.config as unknown as Record<string, number | string | boolean>)[governed.field] ?? null,
            to: null,
            detail: `Loosen ${governed.field} enough to admit this class — the value depends on how much of it you want back.`,
            direction: 'exposure',
          }
        : {
            kind: 'code',
            field: null,
            detail:
              `No single setting governs "${u.reason}". Closing this means a code change to the path that ` +
              'produces it, or a measurement that says which part of it is worth admitting.',
            direction: 'exposure',
          },
    });
  }
  return out;
}

function humanReason(reason: string): string {
  if (reason.startsWith('live_risk_blocked:')) return `the ${reason.slice('live_risk_blocked:'.length)} rule`;
  if (reason === 'no_live_row') return 'nothing the journal explains';
  return reason.replace(/_/g, ' ');
}

function edgeRecommendations(input: TuneAdvisorInput, gap: GoalGap): TuneRecommendation[] {
  const scan = input.scan;
  if (!scan || gap.activeSessions === 0 || gap.tradesPerSession === null) return [];
  const out: TuneRecommendation[] = [];

  for (const leak of scan.leaks) {
    // Closing a leak lifts avg R by the loss it was contributing, spread over
    // the whole flow — NOT by its own mean, which would overstate it by the
    // ratio of the bucket to the book.
    const dR = scan.coverage.liveTrades > 0 ? leak.severityR / scan.coverage.liveTrades : 0;
    const lever = leak.lever;
    out.push({
      id: `edge:${leak.dimension}:${leak.bucket}`,
      factor: 'edge',
      title: `${leak.dimensionLabel} = ${leak.bucket} is losing money`,
      evidence:
        `${leak.n} trades at ${leak.meanR}R (95% ${leak.ciLow}…${leak.ciHigh}), ` +
        `${leak.severityR}R left on the table, $${leak.totalPnlUsd}` +
        (leak.verdict === 'unconfirmed' ? ' — paper cannot confirm it yet' : ''),
      expectedDayPctDelta: dayPctFromEdge(gap.tradesPerSession, gap.riskPerTradePct, dR),
      sampleSize: leak.n,
      confidence: confidenceFor(leak.n),
      // A leak's lever CUTS, so it is not held by the review rule — the review
      // guards against widening mid-trial, not against closing a hole.
      status: leak.verdict === 'unconfirmed' ? 'needs_data' : 'actionable',
      statusReason:
        leak.verdict === 'unconfirmed'
          ? 'the paper control has too few trades in this bucket to agree or disagree'
          : 'reduces exposure — the gated-switch engine can apply this once its rule graduates',
      // Not an occurrence — a distribution has no "last seen".
      lastSeenEtDate: null,
      sessionsSinceLastSeen: null,
      action:
        lever && lever.kind === 'config' && lever.field
          ? {
              kind: 'config',
              field: lever.field,
              from: (input.config as unknown as Record<string, number | string | boolean>)[lever.field] ?? null,
              to: lever.value,
              detail: lever.detail,
              direction: lever.direction === 'exposure' ? 'exposure' : 'safe',
            }
          : {
              kind: 'code',
              field: lever?.field ?? null,
              detail: lever?.detail ?? 'No setting expresses this; it needs a change to the path that produces it.',
              direction: 'safe',
            },
    });
  }
  return out;
}

function executionRecommendations(input: TuneAdvisorInput): TuneRecommendation[] {
  const scan = input.scan;
  if (!scan) return [];
  return scan.findings
    .filter((f) => f.kind === 'execution')
    .map((f) => {
      // Recency decides whether this is work or history. The scan cannot know
      // a deploy happened, so it never claims a class is fixed — but a class
      // whose last occurrence predates the latest session is not something to
      // go and do TONIGHT, and ranking it as though it were is what teaches a
      // reader to skip the section. See the 2026-09-12 production read.
      const ago = f.sessionsSinceLastSeen ?? null;
      const current = ago === null || ago === 0;
      return {
        id: `execution:${f.id}`,
        factor: 'execution' as const,
        title: f.label,
        evidence: f.detail,
        // Deliberately null. An exit that failed cost whatever that trade would
        // have made, which is not knowable from a count — and a fabricated
        // number would rank a defect against a distribution as though the two
        // were measured the same way.
        expectedDayPctDelta: null,
        sampleSize: f.count,
        confidence: confidenceFor(f.count),
        status: 'actionable' as const,
        lastSeenEtDate: f.lastSeenEtDate ?? null,
        sessionsSinceLastSeen: ago,
        statusReason: current
          ? 'an execution defect is a fix, not a setting — it is never held by the review rule'
          : `last occurred ${f.lastSeenEtDate}, ${ago} session(s) ago — confirm it is fixed rather than dormant before spending on it`,
        action: {
          kind: 'code' as const,
          field: null,
          detail: current
            ? `Root-cause the ${f.count} occurrence(s) and fix the path. A decided trade that does not execute is edge the book already paid for.`
            : `Check whether the fix for this landed after ${f.lastSeenEtDate}. If it did, this is history the ten-session window is still carrying; if it did not, the class has simply not recurred yet and the ${f.count} occurrence(s) still need root-causing.`,
          direction: 'neutral' as const,
        },
      };
    });
}

function goalRecommendations(input: TuneAdvisorInput, gap: GoalGap): TuneRecommendation[] {
  if (gap.storedTargetR === null || gap.activeSessions === 0) return [];
  const out: TuneRecommendation[] = [];

  // The goal's HEIGHT IN R is the one lever that moves the hit rate without
  // the book changing at all: targetR = targetPct / riskPct. If the book
  // reaches 1R far more often than it reaches the stored level, say so with
  // the risk % that would put the goal there.
  const reachedAtGoal = gap.goalRatePct ?? 0;
  const reachedAt1R = round2((gap.oneRSessions / gap.activeSessions) * 100);
  if (gap.storedTargetR > 1.05 && reachedAt1R > reachedAtGoal + 10 && input.config.targetDailyGainPct !== null) {
    const riskForOneR = round2(input.config.targetDailyGainPct / 1);
    const blocked = input.review.activeSessionsSinceChange < REVIEW_SESSIONS;
    out.push({
      id: 'goal:height_in_r',
      factor: 'goal',
      title: `The goal sits at ${gap.storedTargetR}R, and this book reaches 1R far more often`,
      evidence:
        `reached the stored goal on ${gap.goalReachedSessions} of ${gap.activeSessions} (${reachedAtGoal}%) but 1R on ` +
        `${gap.oneRSessions} of ${gap.activeSessions} (${reachedAt1R}%) active sessions`,
      // Not estimable as a day-% delta: this changes how often the goal is
      // MET, not what the book earns. Saying otherwise would double-count the
      // risk change's own effect.
      expectedDayPctDelta: null,
      sampleSize: gap.activeSessions,
      confidence: confidenceFor(gap.activeSessions),
      status: blocked ? 'blocked_by_review' : 'actionable',
      statusReason: blocked
        ? `changes the trial's own sizing — held until the ${REVIEW_SESSIONS}-session review ` +
          `(${input.review.activeSessionsSinceChange} so far)`
        : 'the operator decides the goal and the risk that sets its height',
      // Not an occurrence — a distribution has no "last seen".
      lastSeenEtDate: null,
      sessionsSinceLastSeen: null,
      action: {
        kind: 'config',
        field: 'riskPerTradePct',
        from: input.config.riskPerTradePct,
        to: riskForOneR,
        detail:
          `At ${riskForOneR}% risk the ${input.config.targetDailyGainPct}% goal is 1R — the level this book ` +
          'already reaches. Raising risk does not make the book better; it lowers the bar the goal sits on, ' +
          'and it raises the size of every red day by the same factor.',
        direction: 'exposure',
      },
    });
  }
  return out;
}

function redDayRecommendations(input: TuneAdvisorInput, gap: GoalGap): TuneRecommendation[] {
  const scan = input.scan;
  if (!scan || scan.dayLevel.redSessions === 0) return [];
  const driver = scan.dayLevel.redSessionDrivers[0];
  if (!driver || driver.trades < 5) return [];
  const dR = scan.coverage.liveTrades > 0 ? Math.abs(driver.totalR) / scan.coverage.liveTrades : 0;
  return [
    {
      id: `edge:red_day_driver:${driver.reason}`,
      factor: 'edge',
      title: `Red days are driven by "${driver.reason}" exits`,
      evidence:
        `${driver.trades} losing trades exited on ${driver.reason} across ${scan.dayLevel.redSessions} red sessions, ` +
        `${driver.totalR}R in total; mean red day ${scan.dayLevel.meanRedSessionR}R, worst ${scan.dayLevel.worstSessionR}R`,
      expectedDayPctDelta:
        gap.tradesPerSession === null ? null : dayPctFromEdge(gap.tradesPerSession, gap.riskPerTradePct, dR),
      sampleSize: driver.trades,
      confidence: confidenceFor(driver.trades),
      status: 'actionable',
      statusReason: 'reducing the size of a red day never widens exposure',
      // Not an occurrence — a distribution has no "last seen".
      lastSeenEtDate: null,
      sessionsSinceLastSeen: null,
      action: {
        kind: 'research',
        field: null,
        detail:
          `Replay this exit reason against the alternatives (the exit-replay comparison) before changing it: ` +
          'the reason that CLOSES a losing trade is not always the reason that caused the loss.',
        direction: 'safe',
      },
    },
  ];
}

/**
 * Rank: the biggest estimated effect first, with the unestimable (execution
 * defects) interleaved by confidence rather than pushed to the bottom — a
 * broken exit path outranks a 0.02%/day distribution finding whatever the
 * arithmetic says about the latter.
 *
 * With one qualification learned from the first production read: a defect that
 * has NOT occurred in the latest session ranks below one that has, and below
 * the measurable findings. 261 exit failures from the session before a fix
 * shipped are not tonight's work, and leaving them at the top for the nine
 * remaining sessions of the window is how a reader learns to skip the list.
 * Still above nothing — a dormant class may simply not have recurred yet.
 */
function rank(a: TuneRecommendation, b: TuneRecommendation): number {
  const weight = (r: TuneRecommendation): number => {
    if (r.factor !== 'execution') return r.expectedDayPctDelta ?? 0;
    const stale = r.sessionsSinceLastSeen !== null && r.sessionsSinceLastSeen > 0;
    return stale ? -1000 + r.sampleSize / 1e6 : 1000 + r.sampleSize;
  };
  return weight(b) - weight(a);
}

export function buildTuneAdvice(input: TuneAdvisorInput): TuneAdvice {
  const ev = input.evidence;
  const scan = input.scan;
  const gap: GoalGap = {
    targetDailyGainPct: input.config.targetDailyGainPct,
    impliedDailyGainPct: ev.impliedDailyGainPct,
    gapPct:
      input.config.targetDailyGainPct !== null && ev.impliedDailyGainPct !== null
        ? round2(input.config.targetDailyGainPct - ev.impliedDailyGainPct)
        : null,
    tradesPerSession: ev.tradesPerSession,
    riskPerTradePct: input.config.riskPerTradePct,
    avgR: ev.avgR,
    storedTargetR: ev.storedTargetR,
    goalRatePct: ev.goalRatePct,
    oneRSessions: scan?.dayLevel.oneRSessions ?? 0,
    activeSessions: ev.activeSessionsCounted,
    goalReachedSessions: ev.goalReachedSessions,
    activeSessionsSinceChange: input.review.activeSessionsSinceChange,
    reviewSessionsRequired: REVIEW_SESSIONS,
  };

  const recommendations = [
    ...executionRecommendations(input),
    ...edgeRecommendations(input, gap),
    ...flowRecommendations(input, gap),
    ...redDayRecommendations(input, gap),
    ...goalRecommendations(input, gap),
  ].sort(rank);

  return { asOf: input.asOf, gap, recommendations, headline: headlineFor(gap, recommendations, input) };
}

/**
 * The one sentence a reader takes away. It has to be able to say "nothing
 * here closes the gap", because on this book that is usually true and a
 * recommender that always finds something worth doing trains the reader to
 * stop believing it.
 */
export function headlineFor(gap: GoalGap, recommendations: TuneRecommendation[], input: TuneAdvisorInput): string {
  if (input.scan === null) return 'No edge-leak scan has run yet — most of this reads from it.';
  if (gap.impliedDailyGainPct === null || gap.targetDailyGainPct === null) {
    return 'Not enough closed trades to place the book against its goal yet.';
  }
  const estimable = recommendations
    // A needs_data recommendation is a question, not a quantity: adding its
    // estimate to "everything measurable adds N points" would inflate the
    // number with something the advice itself says it cannot stand behind.
    .filter((r) => r.status !== 'needs_data')
    .map((r) => r.expectedDayPctDelta)
    .filter((d): d is number => d !== null)
    .reduce((a, b) => a + b, 0);
  // Only a defect seen in the LATEST session counts as "open": on 2026-09-12
  // four fixed classes were still inside the ten-session window, and a
  // headline saying four defects outranked everything would have sent the
  // reader after work that was already done.
  const open = recommendations.filter(
    (r) => r.factor === 'execution' && (r.sessionsSinceLastSeen === null || r.sessionsSinceLastSeen === 0),
  ).length;
  const dormant = recommendations.filter(
    (r) => r.factor === 'execution' && r.sessionsSinceLastSeen !== null && r.sessionsSinceLastSeen > 0,
  ).length;
  const execution = open;
  const closes = gap.gapPct !== null && gap.gapPct > 0 ? round2((estimable / gap.gapPct) * 100) : null;

  if (execution > 0 && round2(estimable) <= 0.05) {
    return (
      `${execution} execution defect(s) outrank everything measurable here: the book's implied day is ` +
      `${gap.impliedDailyGainPct}% against a ${gap.targetDailyGainPct}% goal, and no distribution finding on ` +
      'this record closes that. Fix what is broken before tuning what is merely small.'
    );
  }
  // A dormant defect is worth one clause, never the headline: it is a thing to
  // confirm fixed, not a thing to go and do.
  const dormantClause =
    dormant === 0
      ? ''
      : ` (${dormant} execution class(es) in the window but not in the latest session — confirm fixed.)`;
  if (closes === null || closes < 25) {
    return (
      `Everything measurable here adds about ${round2(estimable)} points to a ${gap.impliedDailyGainPct}% day, ` +
      `against a gap of ${gap.gapPct} points to the ${gap.targetDailyGainPct}% goal` +
      (closes === null ? '.' : ` — roughly ${closes}% of it.`) +
      ' The rest is distribution, not a setting.' +
      dormantClause
    );
  }
  return (
    `Everything measurable here adds about ${round2(estimable)} points, roughly ${closes}% of the ` +
    `${gap.gapPct}-point gap to the ${gap.targetDailyGainPct}% goal.` +
    dormantClause
  );
}

export type { UntakenClass };
