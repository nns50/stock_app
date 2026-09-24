import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { etToday } from '../../util/marketDate';
import { MARKET_DIRECTION_ACTION, MarketDirection } from './marketDirection';

// ---------------------------------------------------------------------------
// The market-direction readings, read back from the journal (moved here from
// edgeLeakScanData.ts on 2026-09-26, so the shadow records can read them
// without importing the scan: the scan already imports the re-entry record).
// ---------------------------------------------------------------------------

/** The market-direction readings the loop journaled (`market_direction_read`,
 *  one row per change — marketDirection.ts), grouped by ET date, oldest first.
 *  The reading in force at any moment is the latest row at or before it. */
export type DirectionIndex = Map<string, { at: number; direction: MarketDirection }[]>;

const MARKET_DIRECTIONS: ReadonlySet<string> = new Set(['red', 'green', 'mixed', 'unknown']);

export function directionIndex(since: number): DirectionIndex {
  const out: DirectionIndex = new Map();
  for (const e of listAutotradeEventsInWindow({ actions: [MARKET_DIRECTION_ACTION], since }).events) {
    if (!e.detail) continue;
    let direction: unknown;
    try {
      direction = (JSON.parse(e.detail) as { direction?: unknown }).direction;
    } catch {
      continue;
    }
    if (typeof direction !== 'string' || !MARKET_DIRECTIONS.has(direction)) continue;
    const day = etToday(e.createdAt);
    const rows = out.get(day) ?? [];
    rows.push({ at: e.createdAt, direction: direction as MarketDirection });
    out.set(day, rows);
  }
  for (const rows of out.values()) rows.sort((a, b) => a.at - b.at);
  return out;
}

/** The reading in force at `at` on `etDate`: the latest row at or before it,
 *  never one from a later minute and never one from another day. Null when the
 *  loop had journaled none yet that day. */
export function directionAt(index: DirectionIndex, etDate: string, at: number | null): MarketDirection | null {
  if (at === null) return null;
  let found: MarketDirection | null = null;
  for (const r of index.get(etDate) ?? []) {
    if (r.at > at) break;
    found = r.direction;
  }
  return found;
}

/** The reading in force at any moment since `since`, as one function: what a
 *  replay of the market-direction gate asks (declinedEntryShadow.ts). */
export function directionReaderSince(since: number): (at: number) => MarketDirection | null {
  const index = directionIndex(since);
  return (at) => directionAt(index, etToday(at), at);
}
