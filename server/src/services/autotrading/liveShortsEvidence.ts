import { AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { listPositions, Position } from '../../db/positions';
import { etToday } from '../../util/marketDate';
import { collectBook, liveEntryAt } from './dailyTargetSweepData';
import type { EdgeLeakScanResult } from './edgeLeakScan';
import { classifyExecutionRows, EXECUTION_ACTIONS } from './edgeLeakScanData';
import type { LiveShortsEvidence, ShortShadowEvidence } from './gatedSwitches';
import type { LiveShortOutcome } from './shortShadowRecord';

// ---------------------------------------------------------------------------
// The live short book since shorts were last switched on (2026-09-24, the tape
// plan's PR 10): what the `shorts_revert` tripwires read.
//
// Nothing here derives a number of its own. The R is the goal sweep's and the
// scan's (collectBook), the entry moment is the collector's (liveEntryAt), a
// defect is a defect because the scan's own classifier says so
// (classifyExecutionRows), and the replay gap is the one the after-close
// refresh persisted. Each tripwire reads the book the way the rest of the app
// already reads it, so a trip can be checked against a number shown elsewhere.
// ---------------------------------------------------------------------------

/** A closed live short, oldest first. */
export interface LiveShortTrade extends LiveShortOutcome {
  /** The collector's id, `pos:<positions.id>`. */
  id: string;
  entryAt: number;
}

const isLiveStockShort = (p: Position): boolean =>
  p.assetType === 'stock' && p.side === 'short' && p.tags.includes('autotrade');

/** The closed live stock shorts entered at or after `since`, with the R the
 *  goal sweep and the edge-leak scan read. A position the collector drops (no
 *  entry time, no recorded stop) is dropped here too. */
export function liveShortTradesSince(since: number, now: number = Date.now()): LiveShortTrade[] {
  const closed = listPositions({ status: 'closed' });
  const shorts = new Map(closed.filter(isLiveStockShort).map((p) => [`pos:${p.id}`, p]));
  const { trades } = collectBook('live', undefined, now, { closed, liveOptionsClosed: [] });
  return trades
    .filter((t) => shorts.has(t.id) && t.entryAt >= since)
    .map((t) => ({
      id: t.id,
      symbol: shorts.get(t.id)!.symbol,
      entryAt: t.entryAt,
      etDate: etToday(t.entryAt),
      r: t.r,
    }))
    .sort((a, b) => a.entryAt - b.entryAt);
}

/** How far before a short's entry a row may sit and still be the entry's own
 *  (the sizing and guard rows are written just before the order goes). */
const ENTRY_LEAD_MS = 5 * 60_000;
/** How long after a short closes a row about it can still arrive: an exit
 *  correction may take until the order history ages out (seven days). */
const AFTER_CLOSE_TAIL_MS = 8 * 24 * 60 * 60_000;

/**
 * The execution defects that belong to a live short entered at or after
 * `since`: the rows the scan's execution catalog counts as a `defect`
 * (classifyExecutionRows), stock rows only, attributed to a short position by
 * the `positionId` the row names, or else by its symbol inside the short's
 * life. An `operator` or `control` row never trips, the same as in the scan.
 */
export function shortSideDefectsSince(since: number, now: number = Date.now()): LiveShortsEvidence['defects'] {
  const shorts = listPositions()
    .filter(isLiveStockShort)
    .map((p) => {
      const entryAt = liveEntryAt(p) ?? p.createdAt;
      const closedAt = p.exits.length ? Math.max(...p.exits.map((x) => x.createdAt)) : null;
      return { id: p.id, symbol: p.symbol, entryAt, until: (closedAt ?? now) + AFTER_CLOSE_TAIL_MS };
    })
    .filter((p) => p.entryAt >= since);
  if (shorts.length === 0) return [];
  const { events } = listAutotradeEventsInWindow({
    actions: EXECUTION_ACTIONS.map((a) => a.action),
    since: since - ENTRY_LEAD_MS,
  });
  const out: LiveShortsEvidence['defects'] = [];
  // Oldest first: the journal reads newest first, and a trip reads in order.
  const rows = classifyExecutionRows(events).sort((a, b) => a.event.createdAt - b.event.createdAt);
  for (const row of rows) {
    const e = row.event;
    if (row.nature !== 'defect' || e.action.startsWith('live_options_') || !e.symbol) continue;
    const positionId = positionIdOf(e.detail);
    const owner = shorts.find((p) =>
      positionId !== null
        ? p.id === positionId
        : p.symbol === e.symbol && e.createdAt >= p.entryAt - ENTRY_LEAD_MS && e.createdAt <= p.until,
    );
    if (owner) out.push({ label: row.label, symbol: e.symbol, etDate: etToday(e.createdAt) });
  }
  return out;
}

function positionIdOf(detail: string | null): number | null {
  if (!detail) return null;
  try {
    const v = (JSON.parse(detail) as { positionId?: unknown }).positionId;
    return typeof v === 'number' && Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}

/** Whether the last scan lists the live `equity_short_red` bucket among its
 *  leaks (a `leak`, or `unconfirmed` while the control cannot speak, as the
 *  scan's own leaks list does). Null when it cannot say. */
export function liveEquityShortRedLeak(scan: EdgeLeakScanResult | null): boolean | null {
  if (!scan || !scan.books.includes('live')) return null;
  const bucket = scan.dimensions
    .find((d) => d.id === 'marketTapeBySide')
    ?.buckets.find((b) => b.bucket === 'equity_short_red');
  // A bucket only paper fills (live n = 0) says nothing about the live book.
  if (!bucket || bucket.n === 0) return null;
  return bucket.verdict === 'leak' || bucket.verdict === 'unconfirmed';
}

/** The evidence the tripwires read, or null while live shorts have never been
 *  switched on. The replay is read only when it covers this very window. */
export function buildLiveShortsEvidence(
  config: AutotradeConfig,
  now: number,
  shadow: ShortShadowEvidence | null,
  scan: EdgeLeakScanResult | null,
): LiveShortsEvidence | null {
  const since = config.liveShortsEnabledAt;
  if (since === null) return null;
  const replay = shadow?.liveReplay && shadow.liveReplay.since === since ? shadow.liveReplay : null;
  return {
    since,
    sinceEtDate: etToday(since),
    trades: liveShortTradesSince(since, now).map(({ symbol, etDate, r }) => ({ symbol, etDate, r })),
    defects: shortSideDefectsSince(since, now),
    replay: replay ? { n: replay.n, meanGapR: replay.meanGapR } : null,
    equityShortRedLeak: liveEquityShortRedLeak(scan),
  };
}
