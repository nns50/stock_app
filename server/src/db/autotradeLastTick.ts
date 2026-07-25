import { db } from './index';
import type { LoopTickSummary } from '../services/autotrading/loop';

// ---------------------------------------------------------------------------
// The automated loop's most recently completed tick (docs/AUTOTRADING_SPEC.md
// — MONITORING & KILL SWITCH). runAutotradeLoopTick() computes a full
// LoopTickSummary every 60s — candidates screened, signals generated, entries
// opened, exactly why it skipped this cycle — and previously discarded it the
// instant it was returned, so "why isn't anything trading" was only
// answerable by reading Recent Activity's full journal. Persisted here
// instead: a singleton upsert, same shape as db/autotradeConfig.ts's own
// config row, overwritten every tick (this is a snapshot of the LATEST
// cycle, not a history — the journal already IS the history).
// ---------------------------------------------------------------------------

export interface LastTickRecord {
  summary: LoopTickSummary;
  /** Epoch ms the tick that produced this summary finished. */
  ranAt: number;
}

interface Row {
  summary: string;
  updated_at: number;
}

/** The most recently completed tick's diagnostics, or null before the loop
 *  has ever run (fresh install, or it hasn't fired yet). */
export function getLastTick(): LastTickRecord | null {
  const row = db.prepare('SELECT summary, updated_at FROM autotrade_last_tick WHERE id = 1').get() as Row | undefined;
  if (!row) return null;
  try {
    return { summary: JSON.parse(row.summary) as LoopTickSummary, ranAt: row.updated_at };
  } catch {
    return null;
  }
}

/** Overwrite the persisted "last tick" snapshot (singleton upsert). */
export function saveLastTick(summary: LoopTickSummary): void {
  db.prepare(
    `INSERT INTO autotrade_last_tick (id, summary, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(summary), Date.now());
}
