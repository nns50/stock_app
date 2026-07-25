import { db } from './index';

// ---------------------------------------------------------------------------
// A user-maintained list of scheduled market-wide catalyst date-times (FOMC,
// CPI, jobs reports, ...) — see docs/AUTOTRADING_SPEC.md's macro-event
// blackout entry. There's no economic-calendar data feed anywhere in this
// app, so unlike the earnings blackout (a real per-symbol date already
// fetched from Yahoo), this is entirely hand-maintained: add/remove your own
// entries from the Fed's/BLS's own published calendars. Starts empty.
// ---------------------------------------------------------------------------

export interface MacroEventRecord {
  id: number;
  label: string;
  /** Epoch ms of the scheduled event. */
  eventAt: number;
  createdAt: number;
}

interface Row {
  id: number;
  label: string;
  event_at: number;
  created_at: number;
}

function map(r: Row): MacroEventRecord {
  return { id: r.id, label: r.label, eventAt: r.event_at, createdAt: r.created_at };
}

/** All scheduled events, soonest first. */
export function listMacroEvents(): MacroEventRecord[] {
  return (db.prepare('SELECT * FROM macro_events ORDER BY event_at ASC').all() as Row[]).map(map);
}

export function addMacroEvent(label: string, eventAt: number): MacroEventRecord {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO macro_events (label, event_at, created_at) VALUES (?, ?, ?)')
    .run(label, eventAt, now);
  return map(db.prepare('SELECT * FROM macro_events WHERE id = ?').get(info.lastInsertRowid) as Row);
}

/** Returns false if `id` wasn't on the list. */
export function removeMacroEvent(id: number): boolean {
  return db.prepare('DELETE FROM macro_events WHERE id = ?').run(id).changes > 0;
}
