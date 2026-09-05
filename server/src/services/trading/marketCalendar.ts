// ---------------------------------------------------------------------------
// US equity market calendar — full holidays and early closes.
//
// Until 2026-09-05 nothing in this app knew about either. isUsEquityMarketOpen
// excluded Saturday and Sunday and nothing else, and minutesUntilClose counted
// down to 16:00 every weekday. Both said so in their own comments, and the
// stated justification was that a holiday "has no open positions to flatten and
// no orders will place".
//
// That is true of a holiday in isolation and false in two ways that matter:
//
//   - A FULL HOLIDAY still runs the whole loop. The screener works from the
//     previous session's stale closes, signals are generated off them, and the
//     PAPER book — which needs no broker to fill — opens positions at those
//     stale prices and (since the paper flatten landed the same day) closes
//     them again at the same stale prices. A day of phantom scratches lands in
//     the very evidence track that exists to measure the strategy. The live
//     book is protected only by the broker refusing, which is a rejection, not
//     a decision.
//
//   - An EARLY CLOSE is worse. It is a normal trading morning, so positions are
//     genuinely open, and then the session ends at 13:00 while both clocks
//     still believe it runs to 16:00. The end-of-day flatten would fire at
//     15:55 — nearly three hours after the bell — cancelling a live position's
//     protective bracket and placing a replacement that cannot fill until the
//     next open. That is the inverse of what the flatten is for: it turns a
//     bracketed position into a naked overnight one.
//
// The next dates that matter were Labor Day (2026-09-07, two days after this
// was written) and the 2026-11-27 / 2026-12-24 early closes.
//
// SOURCE AND ROT. These dates are transcribed by hand and are NOT authoritative
// — the NYSE publishes the real calendar, and the exchange occasionally closes
// unscheduled (a national day of mourning). So:
//
//   - CALENDAR_THROUGH marks the last date this table is claimed to cover, and
//     a test fails once the clock passes it. A stale calendar must announce
//     itself rather than silently start treating holidays as trading days.
//   - Everything here is a SAFETY narrowing: it only ever says "closed" or
//     "closes earlier". Being wrong costs a missed session, never a trade
//     placed into a market that is shut.
// ---------------------------------------------------------------------------

/** The last ET date this table is claimed to cover. Past it, `isCalendarStale`
 *  goes true and a test fails — see the header on why that matters. */
export const CALENDAR_THROUGH = '2026-12-31';

/**
 * Full-day closures, as ET `YYYY-MM-DD`.
 *
 * 2026: New Year's Day, MLK, Washington's Birthday, Good Friday, Memorial Day,
 * Juneteenth, Independence Day (observed Friday 2026-07-03, since the 4th is a
 * Saturday), Labor Day, Thanksgiving, Christmas.
 */
export const FULL_HOLIDAYS: ReadonlySet<string> = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

/** 13:00 ET, in minutes since midnight — every US equity early close. */
export const EARLY_CLOSE_MINUTES = 13 * 60;

/**
 * Early closes, as ET `YYYY-MM-DD`. 2026: the day after Thanksgiving and
 * Christmas Eve. (There is no 2026-07-03 half-day — that date is a full
 * holiday this year because Independence Day falls on a Saturday.)
 */
export const EARLY_CLOSES: ReadonlySet<string> = new Set(['2026-11-27', '2026-12-24']);

const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `now` as an ET `YYYY-MM-DD` string — the key both tables are indexed by. */
export function etCalendarDate(now: Date | number = new Date()): string {
  return etDate.format(typeof now === 'number' ? new Date(now) : now);
}

/** A full-day exchange closure. */
export function isMarketHoliday(now: Date | number = new Date()): boolean {
  return FULL_HOLIDAYS.has(etCalendarDate(now));
}

/**
 * The minute of the ET day this session closes: 13:00 on an early close,
 * otherwise 16:00. Says nothing about whether the market is open at all —
 * ask isMarketHoliday and the weekday separately.
 */
export function sessionCloseMinute(now: Date | number = new Date()): number {
  return EARLY_CLOSES.has(etCalendarDate(now)) ? EARLY_CLOSE_MINUTES : 16 * 60;
}

/**
 * True once the clock has passed CALENDAR_THROUGH, i.e. this table no longer
 * covers today. Deliberately NOT consulted by the functions above: silently
 * changing behaviour on a stale calendar is exactly the failure mode this
 * exists to prevent. It is a signal for the test and for an operator, and the
 * conservative reading is unchanged — an unknown date is treated as a normal
 * full session, which is what the app did before this file existed.
 */
export function isCalendarStale(now: Date | number = new Date()): boolean {
  return etCalendarDate(now) > CALENDAR_THROUGH;
}
