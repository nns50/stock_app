import { getAutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { getLastShortShadowRecord, saveShortShadowRecord, ShortShadowRecordRow } from '../../db/shortShadowRecords';
import { getProvider } from '../../providers';
import { etToday } from '../../util/marketDate';
import { isTradingSession } from '../trading/marketCalendar';
import { isAfterSessionClose } from '../trading/marketHours';
import type { ShortShadowEvidence } from './gatedSwitches';
import { buildShortShadowRecord, ShortShadowRecord, SkippedShort } from './shortShadowRecord';
import { shadowFillInputs } from './declinedEntryShadowData';

// ---------------------------------------------------------------------------
// The DB half of the short shadow record (2026-09-19): load the declined
// shorts, replay them, and — once per session, after the close — persist the
// result for the gated-switch engine.
//
// WHY. The record shipped on 2026-09-10 as a route, and the `shorts` switch
// shipped two days later with `evaluate: () => null` and a comment saying it
// would stay unevaluated "until the shadow record exposes those three numbers
// in one place". The route exposed them the whole time; nothing in the app
// read it. When the operator asked on 2026-09-18 what the evidence for shorts
// was, the answer came from a routine fetching the route — the single point of
// failure the engine exists to remove. A rule that cannot read its own
// criterion is a rule with no criterion.
//
// The route and the after-close hook share ONE loader and ONE compute path,
// so the number the operator reads and the number the switch reads are the
// same number by construction.
// ---------------------------------------------------------------------------

/** The day short-dated evidence started accruing — the window task #21's own
 *  gate is measured over. The route's default, and the hook's only window. */
export const SHORT_SHADOW_SINCE_MS = Date.parse('2026-08-27T04:00:00Z');

export interface ShortShadowReport extends ShortShadowRecord {
  since: number;
  /** Journal rows read, before the replay's own exclusions. */
  journaledRows: number;
  /** True when the journal read hit its hard ceiling, so the window is NOT
   *  complete and `journaledRows` understates it. */
  journalTruncated: boolean;
}

/**
 * Every `live_short_skipped` row since `since` that carries a scorable signal.
 * The WHOLE window (`listAutotradeEventsInWindow`), not the newest 1000 of it:
 * the route read `limit: 1000` until this moved, and the journal writes 50-90
 * of these rows a session, so a capped read would have started dropping the
 * oldest sessions of a record whose bar is a trade COUNT.
 */
export function loadSkippedShorts(since: number = SHORT_SHADOW_SINCE_MS): {
  rows: SkippedShort[];
  truncated: boolean;
} {
  const { events, truncated } = listAutotradeEventsInWindow({ actions: ['live_short_skipped'], since });
  const rows = events
    .map((e): SkippedShort | null => {
      if (!e.symbol || !e.detail) return null;
      try {
        const d = JSON.parse(e.detail) as {
          score?: number;
          entry?: number;
          stop?: number;
          liveMinSignalScore?: number;
        };
        if (typeof d.score !== 'number' || typeof d.entry !== 'number' || typeof d.stop !== 'number') return null;
        return {
          symbol: e.symbol,
          at: e.createdAt,
          score: d.score,
          entry: d.entry,
          stop: d.stop,
          // Carried through so the replay judges each row by the floor that
          // actually declined it. Without this the report silently re-scores
          // its own history every time liveMinSignalScore moves.
          ...(typeof d.liveMinSignalScore === 'number' ? { floorAtSkip: d.liveMinSignalScore } : {}),
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is SkippedShort => r !== null);
  return { rows, truncated };
}

/** The one compute path: the route's answer and the hook's record. */
export async function computeShortShadowReport(since: number = SHORT_SHADOW_SINCE_MS): Promise<ShortShadowReport> {
  const cfg = getAutotradeConfig();
  const { rows, truncated } = loadSkippedShorts(since);
  const record = await buildShortShadowRecord(getProvider(), rows, cfg, shadowFillInputs(since));
  return { since, journaledRows: rows.length, journalTruncated: truncated, ...record };
}

/** What the gated-switch snapshot carries: the three numbers, the gate's own
 *  verdict, and the session they were computed after. */
export function shortShadowEvidenceOf(row: ShortShadowRecordRow | null): ShortShadowEvidence | null {
  if (!row) return null;
  const r = row.report;
  return {
    etDate: row.etDate,
    journaledRows: r.journaledRows,
    n: r.n,
    avgR: r.avgR,
    winRatePct: r.winRatePct,
    gate: r.gate,
  };
}

/** The ET date the hook last TRIED to compute a record for. One attempt per
 *  session: the loop calls the hook on every tick from the close to midnight,
 *  and a provider outage must cost one session's refresh, not ~480 replays. */
let attemptedEtDate: string | null = null;

/** Tests only. */
export function resetShortShadowRefreshState(): void {
  attemptedEtDate = null;
}

/**
 * The loop's hook: once the bell has rung on a session, replay the declined
 * shorts and persist the record, so the gated-switch engine (which runs right
 * after this on the same tick) reads today's numbers. Null when it is not
 * after the close or the day is not a session; the existing row when today's
 * record already exists or today's attempt already failed. Provider bars are
 * fetched, so the caller awaits and catches it on its own.
 */
export async function refreshShortShadowRecordAfterClose(
  now: number = Date.now(),
): Promise<ShortShadowRecordRow | null> {
  const today = etToday(now);
  if (!isTradingSession(today) || !isAfterSessionClose(now)) return null;
  const last = getLastShortShadowRecord();
  if (last?.etDate === today || attemptedEtDate === today) return last;
  attemptedEtDate = today;
  const report = await computeShortShadowReport();
  saveShortShadowRecord(today, report, now);
  return getLastShortShadowRecord();
}
