import { listAutotradeEvents } from '../db/autotradeEvents';
import {
  getMlRegimeReading,
  listMlRegimeReadings,
  MlRegimeParityDetail,
  MlRegimeParityVector,
  MlRegimeReadingRow,
  recordMlRegimeParity,
} from '../db/mlRegimeReadings';
import { etToday } from '../util/marketDate';
import { sessionDatesEndingAt } from './trading/marketCalendar';
import {
  actionableRegime,
  journalOncePerDay,
  ML_REGIME_CHANGED_ACTION,
  ML_REGIME_PARITY_ACTION,
  MlRegimeProbabilities,
  MlRegimeReading,
} from './mlRegime';
import { loadRegimeModel, MlRegime } from './regimeModel';

// ---------------------------------------------------------------------------
// The enabling rules, counted by the app (2026-09-10; docs/AUTOTRADING_SPEC.md
// §"Pre-committed enabling rules"). Rules 2–4 are about the READINGS the loop
// has persisted, so the app is their system of record: one object, computed
// from the rows for the last 20 sessions plus the journaled switch dates,
// served by GET /api/market/regime-ml/readiness and carried on the dashboard,
// rendered beside the overlay switch — the one place the operator would flip
// it. Rule 1 (the grid) is a human record in the decision log and is NOT
// tracked here; `ready` means rules 2–4 hold.
//
// Definitions, chosen once so the routine, the page and the doc agree:
//   * A session COUNTS when its persisted reading is actionable (known and not
//     stale — the same predicate the sizer uses), came from the model rather
//     than the dev override, and was read by the CURRENT model version — a
//     retrain restarts the count, which is what rule 4's "re-run rule 1" means.
//   * "Per week" is any 5 consecutive sessions, not a calendar week: an ISO
//     week would pass two switches on a Friday and two more on the Monday.
//   * An INERT session is one the overlay had nothing to act on — a stale or
//     unknown reading, or no row at all (the loop being down is inert too).
//     Rule 4's "5 stale sessions in a row" is read that way, the conservative
//     side. Today is skipped only while it has no row yet.
//   * A parity verdict describes the reading it compared. Agreement is
//     re-derived against the row's current data date and probabilities, so a
//     reading refreshed after its check reads as unchecked, never as agreed.
//   * Drift and an overdue retrain block readiness — stricter than the spec's
//     wording, said so in the model card.
// ---------------------------------------------------------------------------

export const READINESS_SESSIONS = 20;
export const SWITCH_LIMIT_PER_WEEK = 2;
export const SWITCH_WINDOW_SESSIONS = 5;
export const INERT_REVERT_AT = 5;
export const PARITY_TOLERANCE = 1e-6;
export const GRID_DECISION_NOTE =
  'rule 1 (the grid) is recorded by hand in docs/AUTOTRADING_SPEC.md — not tracked here';

/** One counted session still waiting for its rule-3 check, with the inputs
 *  `regime:predict` must be given to reproduce the server's reading. */
export interface MlRegimeParityCheck {
  etDate: string;
  asOf: string | null;
  previous: MlRegime | null;
  threshold: number | null;
}

export interface MlRegimeReadiness {
  today: string;
  /** The sessions the rules are counted over, oldest first. */
  windowSessions: string[];
  sessionsRequired: number;
  sessionsWithReading: number;
  switches: { total: number; maxIn5Sessions: number; limitPerWeek: number; dates: string[] };
  inertStreak: number;
  inertRevertAt: number;
  drift: boolean;
  driftSessions: number;
  parity: {
    checked: number;
    agreed: number;
    disagreed: number;
    unchecked: MlRegimeParityCheck[];
    tolerance: number;
  };
  /** Sessions in the window read from ML_REGIME_DEV_OVERRIDE — any blocks readiness. */
  overrideSessions: number;
  /** Actionable sessions in the window read by another model version — excluded. */
  otherModelSessions: number;
  modelVersion: string | null;
  retrainBy: string | null;
  retrainOverdue: boolean;
  /** Rules 2–4 hold. Rule 1 is the decision log's. */
  ready: boolean;
  blockers: string[];
  gridDecision: string;
}

export interface ReadinessModel {
  version: string | null;
  retrainBy: string | null;
}

export interface ReadinessInput {
  rows: MlRegimeReadingRow<Partial<MlRegimeReading>>[];
  /** ET dates carrying an `ml_regime_changed` journal row. */
  changedDates: string[];
  today: string;
  model: ReadinessModel | null;
}

export interface ParityVerdict {
  agrees: boolean;
  maxAbsDiff: number | null;
  reasons: string[];
}

function maxAbsDiff(
  a: MlRegimeProbabilities | null | undefined,
  b: MlRegimeProbabilities | null | undefined,
): number | null {
  if (!a || !b) return null;
  const keys: (keyof MlRegimeProbabilities)[] = ['high_vol_bearish', 'low_vol_bullish', 'sideways'];
  let worst = 0;
  for (const k of keys) {
    const d = Math.abs((a[k] ?? NaN) - (b[k] ?? NaN));
    if (!Number.isFinite(d)) return null;
    worst = Math.max(worst, d);
  }
  return worst;
}

/** Rule 3's comparison: same data date, same label, every probability within
 *  the tolerance. A server row without probabilities never agrees. */
export function compareMlRegimeParity(
  server: MlRegimeParityVector,
  submitted: MlRegimeParityVector & { probabilities: MlRegimeProbabilities },
  tolerance: number = PARITY_TOLERANCE,
): ParityVerdict {
  const reasons: string[] = [];
  if (server.asOf !== submitted.asOf) reasons.push(`asOf differs (server ${server.asOf}, submitted ${submitted.asOf})`);
  if (server.regime !== submitted.regime)
    reasons.push(`regime differs (server ${server.regime}, submitted ${submitted.regime})`);
  const diff = maxAbsDiff(server.probabilities, submitted.probabilities);
  if (diff === null) reasons.push('the server reading carries no probabilities');
  else if (diff > tolerance)
    reasons.push(`probabilities differ by up to ${diff.toExponential(2)} (tolerance ${tolerance})`);
  return { agrees: reasons.length === 0, maxAbsDiff: diff, reasons };
}

function readingOf(row: MlRegimeReadingRow<Partial<MlRegimeReading>>): MlRegimeReading {
  // The row's own label column is authoritative for the regime; the JSON
  // carries the rest. Partial readings (tests, older rows) read as not stale.
  return { ...(row.reading as MlRegimeReading), regime: row.regime };
}

function isActionable(row: MlRegimeReadingRow<Partial<MlRegimeReading>>): boolean {
  return actionableRegime(readingOf(row)) !== null;
}

/** Whether a stored verdict still describes the row it sits on. */
function verdictStillApplies(row: MlRegimeReadingRow<Partial<MlRegimeReading>>, tolerance: number): boolean {
  const d = row.parityDetail;
  if (!d || row.parityAgrees === null) return false;
  if (d.server.asOf !== row.asOf || d.server.regime !== row.regime) return false;
  const diff = maxAbsDiff(d.server.probabilities, row.reading.probabilities);
  return diff !== null && diff <= tolerance;
}

export function computeMlRegimeReadiness(input: ReadinessInput): MlRegimeReadiness {
  const { today, model } = input;
  const window = sessionDatesEndingAt(today, READINESS_SESSIONS);
  const inWindow = new Set(window);
  const rowsByDate = new Map<string, MlRegimeReadingRow<Partial<MlRegimeReading>>>();
  for (const r of input.rows) if (inWindow.has(r.etDate)) rowsByDate.set(r.etDate, r);

  const version = model?.version ?? null;
  let overrideSessions = 0;
  let otherModelSessions = 0;
  const counted: MlRegimeReadingRow<Partial<MlRegimeReading>>[] = [];
  for (const d of window) {
    const row = rowsByDate.get(d);
    if (!row) continue;
    if (row.reading.source === 'override') {
      overrideSessions += 1;
      continue;
    }
    if (!isActionable(row)) continue;
    if (version === null || row.modelVersion !== version) {
      otherModelSessions += 1;
      continue;
    }
    counted.push(row);
  }

  // Switches: each journaled row is one switch (a day that flipped A→B→A
  // journals two rows under two keys and counts twice); each lands on the
  // first session at or after its date (a weekend flip belongs to the
  // Monday), then the worst 5-session run is taken.
  const perSession = new Array<number>(window.length).fill(0);
  const switchDates: string[] = [];
  let switchTotal = 0;
  for (const d of [...input.changedDates].sort()) {
    if (window.length === 0 || d < window[0] || d > today) continue;
    const idx = window.findIndex((s) => s >= d);
    if (idx < 0) continue;
    perSession[idx] += 1;
    switchTotal += 1;
    if (!switchDates.includes(d)) switchDates.push(d);
  }
  let maxIn5Sessions = 0;
  const span = Math.min(SWITCH_WINDOW_SESSIONS, window.length);
  for (let i = 0; i + span <= window.length; i += 1) {
    let n = 0;
    for (let j = i; j < i + span; j += 1) n += perSession[j];
    maxIn5Sessions = Math.max(maxIn5Sessions, n);
  }

  // The inert streak, newest first; today is skipped only while it has no row.
  let inertStreak = 0;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const d = window[i];
    const row = rowsByDate.get(d);
    if (d === today && !row) continue;
    if (row && isActionable(row)) break;
    inertStreak += 1;
  }

  const latest = counted[counted.length - 1];
  const drift = latest?.reading.drift === true;
  const driftSessions = counted.filter((r) => r.reading.drift === true).length;

  let agreed = 0;
  let disagreed = 0;
  const unchecked: MlRegimeParityCheck[] = [];
  for (const row of counted) {
    if (verdictStillApplies(row, PARITY_TOLERANCE)) {
      if (row.parityAgrees) agreed += 1;
      else disagreed += 1;
    } else {
      unchecked.push({
        etDate: row.etDate,
        asOf: row.asOf,
        previous: row.reading.previous ?? null,
        threshold: typeof row.reading.threshold === 'number' ? row.reading.threshold : null,
      });
    }
  }

  const retrainBy = model?.retrainBy ?? null;
  const retrainOverdue = retrainBy !== null && today > retrainBy;

  const blockers: string[] = [];
  if (!model) blockers.push('no regime model is loaded');
  if (counted.length < READINESS_SESSIONS)
    blockers.push(`${counted.length} of ${READINESS_SESSIONS} sessions have a counted reading`);
  if (overrideSessions > 0)
    blockers.push(`${overrideSessions} session(s) in the window read from the dev override, not the model`);
  if (otherModelSessions > 0)
    blockers.push(
      `${otherModelSessions} session(s) were read by another model version — the count restarts at a retrain`,
    );
  if (maxIn5Sessions > SWITCH_LIMIT_PER_WEEK)
    blockers.push(
      `${maxIn5Sessions} switches within ${SWITCH_WINDOW_SESSIONS} sessions (limit ${SWITCH_LIMIT_PER_WEEK} per week)`,
    );
  if (inertStreak >= INERT_REVERT_AT)
    blockers.push(`${inertStreak} inert sessions in a row — the spec reverts the overlay to OFF at ${INERT_REVERT_AT}`);
  else if (inertStreak > 0) blockers.push(`the latest ${inertStreak} session(s) had no usable reading`);
  if (drift) blockers.push('the latest counted reading flags model drift — retrain first');
  if (retrainOverdue) blockers.push(`the model's retrain-by date ${retrainBy} has passed`);
  if (disagreed > 0) blockers.push(`${disagreed} counted session(s) disagree with regime:predict`);
  if (unchecked.length > 0) blockers.push(`${unchecked.length} counted session(s) have no parity check yet`);

  return {
    today,
    windowSessions: window,
    sessionsRequired: READINESS_SESSIONS,
    sessionsWithReading: counted.length,
    switches: { total: switchTotal, maxIn5Sessions, limitPerWeek: SWITCH_LIMIT_PER_WEEK, dates: switchDates },
    inertStreak,
    inertRevertAt: INERT_REVERT_AT,
    drift,
    driftSessions,
    parity: { checked: agreed + disagreed, agreed, disagreed, unchecked, tolerance: PARITY_TOLERANCE },
    overrideSessions,
    otherModelSessions,
    modelVersion: version,
    retrainBy,
    retrainOverdue,
    ready: blockers.length === 0,
    blockers,
    gridDecision: GRID_DECISION_NOTE,
  };
}

/** One entry per `ml_regime_changed` row dated in `[since, today]` — a date
 *  appears as often as the journal switched on it. */
function changedDatesSince(since: string, today: string): string[] {
  const [y, m, d] = since.split('-').map(Number);
  // One calendar day of slack under the ET midnight — the filter below is by
  // the row's own ET date, so the slack only widens the query.
  const sinceMs = Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (const e of listAutotradeEvents({
    stage: 'config',
    actions: [ML_REGIME_CHANGED_ACTION],
    since: sinceMs,
    limit: 1000,
  })) {
    if (!e.detail) continue;
    try {
      const date = (JSON.parse(e.detail) as { date?: string }).date;
      if (typeof date === 'string' && date >= since && date <= today) out.push(date);
    } catch {
      // A row this module cannot read is not a switch it can count.
    }
  }
  return out.sort();
}

/** The readiness object from the database — what the route and the dashboard
 *  both serve, so they cannot disagree. Reads rows only; never fetches. */
export function getMlRegimeReadiness(now: number = Date.now()): MlRegimeReadiness {
  const today = etToday(now);
  const window = sessionDatesEndingAt(today, READINESS_SESSIONS);
  const since = window[0] ?? today;
  const rows = listMlRegimeReadings<Partial<MlRegimeReading>>({ since, until: today });
  const model = loadRegimeModel();
  return computeMlRegimeReadiness({
    rows,
    changedDates: changedDatesSince(since, today),
    today,
    model: model ? { version: model.version, retrainBy: model.training.retrainBy } : null,
  });
}

export interface ParitySubmission {
  etDate: string;
  asOf: string | null;
  regime: MlRegime;
  probabilities: MlRegimeProbabilities;
}

export interface ParityResult extends ParityVerdict {
  etDate: string;
  server: MlRegimeParityDetail['server'];
  submitted: ParitySubmission;
}

/** Compare a Python reading with the persisted one for that day, store the
 *  verdict on the row and journal it once per (day, verdict). Null when no
 *  reading exists for the day — nothing to compare against. */
export function recordMlRegimeParityCheck(submitted: ParitySubmission, now: number = Date.now()): ParityResult | null {
  const row = getMlRegimeReading<Partial<MlRegimeReading>>(submitted.etDate);
  if (!row) return null;
  const server: MlRegimeParityDetail['server'] = {
    regime: row.regime,
    asOf: row.asOf,
    probabilities: row.reading.probabilities ?? null,
    previous: row.reading.previous ?? null,
    threshold: typeof row.reading.threshold === 'number' ? row.reading.threshold : null,
  };
  const verdict = compareMlRegimeParity(server, submitted);
  const detail: MlRegimeParityDetail = {
    checkedAt: now,
    submitted: { regime: submitted.regime, asOf: submitted.asOf, probabilities: submitted.probabilities },
    server,
    maxAbsDiff: verdict.maxAbsDiff,
    reasons: verdict.reasons,
  };
  recordMlRegimeParity(submitted.etDate, { agrees: verdict.agrees, detail });
  journalOncePerDay(
    ML_REGIME_PARITY_ACTION,
    submitted.etDate,
    { agrees: verdict.agrees, maxAbsDiff: verdict.maxAbsDiff, reasons: verdict.reasons },
    verdict.agrees ? 'agrees' : 'disagrees',
  );
  return { etDate: submitted.etDate, ...verdict, server, submitted };
}
