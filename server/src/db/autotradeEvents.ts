import { db } from './index';
import { etToday } from '../util/marketDate';

// ---------------------------------------------------------------------------
// The auto-trading journal (docs/AUTOTRADING_SPEC.md — JOURNALING / stage 5 of
// the execution loop). Every later phase (screener, decision, risk engine,
// execution) writes through logAutotradeEvent — a single append-only path, so
// the journal can never fall out of sync with what the loop actually did.
// Modeled on db/orders.ts's order_events audit trail.
// ---------------------------------------------------------------------------

/** The execution loop's stages, plus 'config' for settings-change audit
 *  events (risk profile switches, enable/disable). 'Journaling' (the spec's
 *  5th stage) isn't its own value — this table IS the journal. */
export type AutotradeStage = 'screen' | 'decision' | 'risk_check' | 'execution' | 'config';

export interface AutotradeEventRecord {
  id: number;
  symbol: string | null;
  stage: AutotradeStage;
  action: string;
  detail: string | null;
  riskProfile: string | null;
  createdAt: number;
}

export interface LogEventInput {
  symbol?: string | null;
  stage: AutotradeStage;
  /** Open vocabulary (e.g. 'excluded_re', 'signal_generated', 'blocked_aggregate_risk',
   *  'order_placed') — validated by the route's Zod enum, not a DB CHECK; see
   *  the schema comment in db/index.ts for why. */
  action: string;
  /** Arbitrary context for this event. Objects are JSON-stringified; strings
   *  are stored as-is. */
  detail?: unknown;
  riskProfile?: string | null;
}

export interface ListEventsFilter {
  stage?: AutotradeStage;
  symbol?: string;
  /** Restrict to these action strings (e.g. the live-order outcome vocabulary).
   *  An empty array matches nothing. */
  actions?: string[];
  /** Only events at or after this epoch-ms. Without it a caller asking for
   *  history gets whatever fits under `limit` — and the journal writes ~1000
   *  rows every 8 hours, so an unfiltered read cannot see yesterday at all.
   *  Pairing this with `actions` is what makes a multi-day read possible:
   *  a handful of rows per day instead of the whole funnel. */
  since?: number;
  /** Max rows to return (default 200, capped at 1000). */
  limit?: number;
}

interface Row {
  id: number;
  symbol: string | null;
  stage: AutotradeStage;
  action: string;
  detail: string | null;
  risk_profile: string | null;
  created_at: number;
}

function map(r: Row): AutotradeEventRecord {
  return {
    id: r.id,
    symbol: r.symbol,
    stage: r.stage,
    action: r.action,
    detail: r.detail,
    riskProfile: r.risk_profile,
    createdAt: r.created_at,
  };
}

/** Append one event to the auto-trading journal. */
export function logAutotradeEvent(input: LogEventInput): AutotradeEventRecord {
  const detail =
    input.detail === undefined || input.detail === null
      ? null
      : typeof input.detail === 'string'
        ? input.detail
        : JSON.stringify(input.detail);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.symbol ? input.symbol.toUpperCase() : null,
      input.stage,
      input.action,
      detail,
      input.riskProfile ?? null,
      now,
    );
  return map(db.prepare('SELECT * FROM autotrade_events WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
}

/** The WHERE clause both readers share, so a filter can never mean one thing
 *  to the capped read and another to the windowed one. Returns null when the
 *  filter can match nothing at all. */
function whereFor(filter: ListEventsFilter): { where: string; params: unknown[] } | null {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.stage) {
    clauses.push('stage = ?');
    params.push(filter.stage);
  }
  if (filter.symbol) {
    clauses.push('symbol = ?');
    params.push(filter.symbol.toUpperCase());
  }
  if (filter.actions) {
    if (filter.actions.length === 0) return null;
    clauses.push(`action IN (${filter.actions.map(() => '?').join(',')})`);
    params.push(...filter.actions);
  }
  if (typeof filter.since === 'number' && Number.isFinite(filter.since)) {
    clauses.push('created_at >= ?');
    params.push(filter.since);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Journal entries, newest first. Capped at ROW_CAP — see
 *  `listAutotradeEventsInWindow` for the analytic read that is not. */
export function listAutotradeEvents(filter: ListEventsFilter = {}): AutotradeEventRecord[] {
  const built = whereFor(filter);
  if (built === null) return [];
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), ROW_CAP);
  const rows = db
    .prepare(`SELECT * FROM autotrade_events ${built.where} ORDER BY id DESC LIMIT ?`)
    .all(...built.params, limit) as Row[];
  return rows.map(map);
}

/**
 * The cap `listAutotradeEvents` applies no matter what a caller asks for.
 *
 * It exists because that function serves poll-path readers, where an unbounded
 * read is a latency bug waiting for a busy session. But a caller that needs a
 * WINDOW rather than a page gets silently short-changed by it, with no error
 * and no signal — and the read still looks plausible, which is the dangerous
 * part.
 */
export const ROW_CAP = 1000;

export interface WindowedEvents {
  events: AutotradeEventRecord[];
  /** True when `hardMax` was reached, so the window is NOT complete. A caller
   *  that draws conclusions from counts must say so rather than report the
   *  truncated number as the answer. */
  truncated: boolean;
}

/**
 * Every event matching the filter, not just the newest `ROW_CAP` of them.
 *
 * WHY THIS EXISTS (2026-09-12). The edge-leak scan's `collectJournalSkips`
 * asked for `limit: 1000` over a forty-session window that held **1,928** skip
 * rows. `listAutotradeEvents` silently clamps to 1000 and orders by id DESC,
 * so it returned the newest 1,000 and dropped the oldest 928 — and every paper
 * entry whose skip row fell outside that set was then classified
 * `no_live_row`, "nothing the journal explains". The scan reported 102 of
 * those, the tune advisor ranked them its top recommendation at strong
 * confidence, and the number was an artifact of a LIMIT. The cap was already
 * documented in `countAutotradeEventDays` below; three collectors written the
 * same week walked into it anyway, which is the argument for a function whose
 * name says what it does rather than a comment saying what not to do.
 *
 * `hardMax` is a backstop against a filter that matches the whole journal, not
 * a page size: reaching it sets `truncated`, which callers surface.
 */
export function listAutotradeEventsInWindow(filter: ListEventsFilter = {}, hardMax = 20_000): WindowedEvents {
  const built = whereFor(filter);
  if (built === null) return { events: [], truncated: false };
  const rows = db
    .prepare(`SELECT * FROM autotrade_events ${built.where} ORDER BY id DESC LIMIT ?`)
    .all(...built.params, hardMax) as Row[];
  return { events: rows.map(map), truncated: rows.length >= hardMax };
}

/** One (ET calendar date, action) bucket. */
export interface EventDayCount {
  /** YYYY-MM-DD on the US market calendar — NOT a UTC date. A loop tick at
   *  20:30 UTC is 16:30 ET the same day, but one at 01:00 UTC belongs to the
   *  PREVIOUS trading day, and bucketing that by UTC would file a session's
   *  own after-hours events under tomorrow. */
  date: string;
  action: string;
  count: number;
}

/**
 * Counts by ET date and action — what a multi-day read actually needs.
 *
 * listAutotradeEvents() cannot answer this. It caps at 1000 rows, and during
 * market hours the busiest actions write that many in ~3 hours, so a
 * two-week distribution is simply not reachable by paging rows. This skips
 * the cap by never materialising the rows: `detail` is the JSON blob that
 * makes an event row heavy, and this reads only action + created_at, so even
 * a month of the busiest action is a few hundred KB rather than a refusal.
 *
 * Grouping happens in JS rather than SQL because the bucket is an
 * America/New_York calendar date and SQLite has no timezone database — a
 * hardcoded `-4 hours` would be right in August and wrong in December.
 */
export function countAutotradeEventsByDay(
  filter: Pick<ListEventsFilter, 'stage' | 'symbol' | 'actions' | 'since'> = {},
): EventDayCount[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.stage) {
    clauses.push('stage = ?');
    params.push(filter.stage);
  }
  if (filter.symbol) {
    clauses.push('symbol = ?');
    params.push(filter.symbol.toUpperCase());
  }
  if (filter.actions) {
    if (filter.actions.length === 0) return [];
    clauses.push(`action IN (${filter.actions.map(() => '?').join(',')})`);
    params.push(...filter.actions);
  }
  if (typeof filter.since === 'number' && Number.isFinite(filter.since)) {
    clauses.push('created_at >= ?');
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT action, created_at FROM autotrade_events ${where}`).all(...params) as {
    action: string;
    created_at: number;
  }[];

  const buckets = new Map<string, EventDayCount>();
  for (const r of rows) {
    const date = etToday(r.created_at);
    const key = `${date}\u0000${r.action}`;
    const hit = buckets.get(key);
    if (hit) hit.count += 1;
    else buckets.set(key, { date, action: r.action, count: 1 });
  }
  // Newest day first, then biggest bucket — the order a report reads in.
  return [...buckets.values()].sort((a, b) => (a.date === b.date ? b.count - a.count : a.date < b.date ? 1 : -1));
}

/**
 * Every distinct `action` the journal has ever recorded.
 *
 * Exists so a caller can tell "this action never happened" apart from "I asked
 * for an action name that does not exist". Both come back from a filtered read
 * as an empty result, and on 2026-09-03 that ambiguity produced a wrong answer:
 * the post-close review queried `live_stop_adjusted` for months, got zero every
 * time, and read it as "the stop ratchet never fires". The success event is
 * actually named `live_stop_ratcheted` — the failure events are
 * live_stop_adjust_blocked / _failed, so the verb changes between the failure
 * and success cases and the plausible-looking name was never emitted by
 * anything. The count was zero by construction, not by measurement.
 *
 * Cheap enough to run per request (the journal is small and this is one grouped
 * scan), and it cannot drift the way a hand-maintained registry of action names
 * would.
 */
export function listKnownAutotradeEventActions(): string[] {
  const rows = db.prepare('SELECT DISTINCT action FROM autotrade_events ORDER BY action').all() as {
    action: string;
  }[];
  return rows.map((r) => r.action);
}
