// ---------------------------------------------------------------------------
// Journal a STANDING FACT once per symbol per ET day (2026-09-09, task #43).
//
// The autotrade journal is a table that only ever grows — db/index.ts says so
// outright, there is no retention, and it stood at 506,945 rows growing ~21,300
// a day. `excluded_re` ("Classified as real estate") was 155,162 of them: 31%
// of the whole journal and 24% of daily growth. A 30-minute production sample
// held 500 of those rows across 31 DISTINCT SYMBOLS — the same static
// classification re-logged on every screener tick, of every session, forever.
// The first entry says everything the 5,000th does.
//
// This is deliberately NOT retention. Deleting history is worse for a system
// whose whole point is a measurable track record; what is dropped here is
// repetition, and the fact itself still lands in the journal every day it is
// true, so "was XYZ excluded on the 4th" stays answerable. What stops being
// answerable is "how many TICKS excluded XYZ on the 4th", which is a question
// about the loop's cadence rather than about the symbol — `autotrade_last_tick`
// and the per-tick rows that remain already answer that.
//
// IN MEMORY, per process, like unplaceableSymbols.ts. A deploy mid-session
// costs one extra row per symbol, which is ~31 rows against the ~7,700 a day
// this removes. A schema and a migration to save those 31 would be the wrong
// trade.
//
// WHAT THIS IS NOT FOR. Only facts that are STANDING — true for the whole day
// by construction, so a later tick's row would be a copy of the first. A
// per-tick observation (candidate_found, signal_generated) means something
// different each time it is written and must keep being written.
// ---------------------------------------------------------------------------

/** Today's date (YYYY-MM-DD) in US/Eastern — same convention (and the same
 *  deliberate small-helper duplication) as execute.ts and liveExecute.ts. */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

let currentDay: string | null = null;
const claimed = new Set<string>();

/**
 * Claim the day's single slot for (action, symbol). TRUE the first time it is
 * asked in an ET day, FALSE every time after — so the caller writes one row.
 *
 * It MUTATES: asking is claiming. A separate "may I?" and "I did" would let a
 * caller check and then not write, which leaves the slot spent and loses the
 * day's only row — the failure mode this exists to prevent, inverted.
 *
 * The whole set is dropped when the ET day rolls, so memory is bounded by one
 * day's distinct (action, symbol) pairs rather than growing with uptime.
 */
export function claimOncePerDay(action: string, symbol: string, at: number = Date.now()): boolean {
  const today = etDateStr(at);
  if (today !== currentDay) {
    currentDay = today;
    claimed.clear();
  }
  const key = `${action}|${symbol.trim().toUpperCase()}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

/** Test hook — module state, so suites must be able to clear it. */
export function resetOncePerDayEvents(): void {
  currentDay = null;
  claimed.clear();
}
