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

/** Journal entries, newest first. */
export function listAutotradeEvents(filter: ListEventsFilter = {}): AutotradeEventRecord[] {
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
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = db
    .prepare(`SELECT * FROM autotrade_events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Row[];
  return rows.map(map);
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
