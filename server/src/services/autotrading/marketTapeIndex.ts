import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { etToday } from '../../util/marketDate';
import { MARKET_TAPE_ACTION } from './marketTape';

// ---------------------------------------------------------------------------
// The tape scores, read back from the journal (2026-09-26; the tape plan's
// PR 7), the way marketDirectionIndex.ts reads the direction rows.
//
// The loop journals `market_tape_read` at the END of a tick (loop.ts), after
// the tick's entries, and the row carries the moment the reading it scores was
// taken as `readAt`. An entry the same tick placed went out between the two, so
// the index is keyed by `readAt`: keyed by when the row was written, a tick's
// own entries would read the previous tick's score.
// ---------------------------------------------------------------------------

/** The journaled tape scores by the ET day of the reading they score, oldest
 *  first. A null score is a tick whose market direction was unknown. */
export type TapeScoreIndex = Map<string, { at: number; score: number | null }[]>;

export function tapeScoreIndex(since: number): TapeScoreIndex {
  const out: TapeScoreIndex = new Map();
  for (const e of listAutotradeEventsInWindow({ actions: [MARKET_TAPE_ACTION], since }).events) {
    if (!e.detail) continue;
    let d: { readAt?: unknown; score?: unknown };
    try {
      d = JSON.parse(e.detail) as { readAt?: unknown; score?: unknown };
    } catch {
      continue;
    }
    const at = typeof d.readAt === 'number' && Number.isFinite(d.readAt) ? d.readAt : e.createdAt;
    const score = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;
    const day = etToday(at);
    const rows = out.get(day) ?? [];
    rows.push({ at, score });
    out.set(day, rows);
  }
  for (const rows of out.values()) rows.sort((a, b) => a.at - b.at);
  return out;
}

/** The score in force at `at` on `etDate`: the latest row whose reading was
 *  taken at or before it, never a later one and never another day's. Null when
 *  none was, or when the one in force could not be scored. */
export function tapeScoreAt(index: TapeScoreIndex, etDate: string, at: number | null): number | null {
  if (at === null) return null;
  let found: number | null = null;
  for (const r of index.get(etDate) ?? []) {
    if (r.at > at) break;
    found = r.score;
  }
  return found;
}
