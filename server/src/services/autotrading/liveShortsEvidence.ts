import { AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { firstEntryOrderForPosition, getLiveOrder } from '../../db/autotradeLiveOrders';
import { getIntent, intentIdForKey } from '../../db/orders';
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

/** A live short's entry order: its intent id, client order id, and when it was
 *  placed. Null parts when no entry order is linked (a position the app did not
 *  place through its own entry path). */
interface ShortEntryOrder {
  intentId: number | null;
  clientOrderId: string | null;
  placedAt: number | null;
}

function entryOrderOf(p: Position): ShortEntryOrder {
  // The FIRST entry order (2026-09-25, second review), not the newest entry
  // row: once an add-on fills, that is the add-on's, and the short would read
  // as placed when the add-on was, not when the order the probation counted was.
  const intentId = p.sourceIntentId ?? firstEntryOrderForPosition(p.id)?.intentId ?? null;
  if (intentId === null) return { intentId: null, clientOrderId: null, placedAt: null };
  return {
    intentId,
    clientOrderId: getIntent(intentId)?.idempotencyKey ?? null,
    placedAt: getLiveOrder(intentId)?.createdAt ?? null,
  };
}

/**
 * When a short belongs to the window: when its ENTRY ORDER was placed
 * (2026-09-24, on review). The collector's entry time is HH:MM, floored to the
 * minute, while the window's stamp is milliseconds: shorts switched on at
 * 10:15:20 and a short placed at 10:15:40 read as entered at 10:15:00, before
 * the window, so a -3R loss tripped nothing. The probation counts the window's
 * shorts by the same order rows (countLiveOrdersSince), so the two agree about
 * which shorts are in it. A short with no linked order falls back to the
 * collector's time.
 */
function placedAtOf(p: Position, order: ShortEntryOrder): number {
  return order.placedAt ?? liveEntryAt(p) ?? p.createdAt;
}

/** The closed live stock shorts placed at or after `since`, with the R the
 *  goal sweep and the edge-leak scan read. A position the collector drops (no
 *  entry time, no recorded stop) is dropped here too. */
export function liveShortTradesSince(since: number, now: number = Date.now()): LiveShortTrade[] {
  const closed = listPositions({ status: 'closed' });
  const shorts = new Map(
    closed.filter(isLiveStockShort).map((p) => [`pos:${p.id}`, { p, placedAt: placedAtOf(p, entryOrderOf(p)) }]),
  );
  const { trades } = collectBook('live', undefined, now, { closed, liveOptionsClosed: [] });
  return trades
    .filter((t) => {
      const short = shorts.get(t.id);
      return short !== undefined && short.placedAt >= since;
    })
    .map((t) => ({
      id: t.id,
      symbol: shorts.get(t.id)!.p.symbol,
      entryAt: t.entryAt,
      etDate: etToday(t.entryAt),
      r: t.r,
    }))
    .sort((a, b) => a.entryAt - b.entryAt);
}

/**
 * The execution defects that belong to a live short placed at or after
 * `since`: the rows the scan's execution catalog counts as a `defect`
 * (classifyExecutionRows), stock rows only, attributed to a short by what the
 * row NAMES: the position (`positionId`), or, for a row written before the
 * fill, the short's entry order (`intentId`, `clientOrderId`). An `operator` or
 * `control` row never trips, the same as in the scan.
 *
 * NEVER BY SYMBOL (2026-09-24, on review). A symbol-and-time match picked up
 * rows that were not the short's: a correlation-data miss the paper book
 * wrote for the same name, a long's unknown outcome, a re-arm of another
 * position. Any one of them turned live shorts off for "a short-side
 * execution defect". A row that names nothing about a short is not counted.
 */
export function shortSideDefectsSince(since: number): LiveShortsEvidence['defects'] {
  const shorts = listPositions()
    .filter(isLiveStockShort)
    .map((p) => {
      const order = entryOrderOf(p);
      return { id: p.id, ...order, placedAt: placedAtOf(p, order) };
    })
    .filter((p) => p.placedAt >= since);
  if (shorts.length === 0) return [];
  const { events } = listAutotradeEventsInWindow({ actions: EXECUTION_ACTIONS.map((a) => a.action), since });
  const out: LiveShortsEvidence['defects'] = [];
  // Oldest first: the journal reads newest first, and a trip reads in order.
  const rows = classifyExecutionRows(events).sort((a, b) => a.event.createdAt - b.event.createdAt);
  for (const row of rows) {
    const e = row.event;
    if (row.nature !== 'defect' || e.action.startsWith('live_options_') || !e.symbol) continue;
    const named = namedIn(e.detail);
    const viaOrder = positionOfOrder(named);
    const owner = shorts.find(
      (p) =>
        (named.positionId !== null && p.id === named.positionId) ||
        (viaOrder !== null && p.id === viaOrder) ||
        (named.intentId !== null && p.intentId === named.intentId) ||
        (named.clientOrderId !== null && p.clientOrderId === named.clientOrderId),
    );
    if (owner) out.push({ label: row.label, symbol: e.symbol, etDate: etToday(e.createdAt) });
  }
  return out;
}

/**
 * The position an order belongs to, through the live-orders table (2026-09-25,
 * second review): an entry, an add-on or second lot (its `addonOfPositionId`),
 * or a close the app placed. A defect row names the order it is about, and
 * matching that only against the short's ENTRY order missed the rest: a time
 * exit acknowledged and then found in no list (SHOP 2026-09-22's state) names
 * its exit intent, and tripped nothing.
 */
function positionOfOrder(named: { intentId: number | null; clientOrderId: string | null }): number | null {
  const intentId = named.intentId ?? (named.clientOrderId !== null ? intentIdForKey(named.clientOrderId) : null);
  if (intentId === null) return null;
  const order = getLiveOrder(intentId);
  if (!order) return null;
  return order.positionId ?? order.addonOfPositionId ?? null;
}

/** The position and order a journal row names, when it names them. */
function namedIn(detail: string | null): {
  positionId: number | null;
  intentId: number | null;
  clientOrderId: string | null;
} {
  const none = { positionId: null, intentId: null, clientOrderId: null };
  if (!detail) return none;
  try {
    const d = JSON.parse(detail) as { positionId?: unknown; intentId?: unknown; clientOrderId?: unknown };
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
    return {
      positionId: int(d.positionId),
      intentId: int(d.intentId),
      clientOrderId: typeof d.clientOrderId === 'string' && d.clientOrderId ? d.clientOrderId : null,
    };
  } catch {
    return none;
  }
}

/** When `shorts_revert` last tripped at or after `since`: its
 *  `config_auto_applied` row, or its `config_change_proposed` row (2026-09-25,
 *  second review) — with the kill switch engaged or the switches engine off,
 *  a trip is only proposed and shorts stay on, and it must hold just the same
 *  if the evidence later drifts back under the bars. The whole window is
 *  read: a capped read of the newest rows could lose the trip behind other
 *  rules' rows. Null while it has not tripped in this window. */
export function shortsRevertedAt(since: number): number | null {
  const { events } = listAutotradeEventsInWindow({
    actions: ['config_auto_applied', 'config_change_proposed'],
    since,
  });
  let latest: number | null = null;
  for (const e of events) {
    try {
      if ((JSON.parse(e.detail ?? '{}') as { rule?: unknown }).rule !== 'shorts_revert') continue;
    } catch {
      continue;
    }
    if (latest === null || e.createdAt > latest) latest = e.createdAt;
  }
  return latest;
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
    defects: shortSideDefectsSince(since),
    replay: replay ? { n: replay.n, meanGapR: replay.meanGapR } : null,
    equityShortRedLeak: liveEquityShortRedLeak(scan),
    revertedAt: shortsRevertedAt(since),
  };
}
