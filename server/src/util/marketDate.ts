// ---------------------------------------------------------------------------
// "What day is it, for the market?" — the one answer every journal date should
// be derived from.
//
// A US trading day is an America/New_York concept, but this app deploys to a
// UTC box (docs/DEPLOY.md). `new Date().toISOString().slice(0, 10)` there is
// already TOMORROW from 20:00 ET onward — through the entire after-hours
// session and every overnight background job. Anything dated that way lands a
// fill on the wrong day: the wrong bucket in the Journal's weekday breakdown
// and /journal/today, an extra day of hold time, an exit sorted past its own
// trading session in the equity curve, and a date that is simply in the future
// relative to the session it happened in.
//
// This lived in services/expiredOptionsSweep.ts (which reasoned it out first,
// for expiry) while the order reconciler and the Webull position sync — both
// of which write real journal rows on a background schedule — each kept their
// own UTC one-liner. Shared here so there is one definition to be right.
// ---------------------------------------------------------------------------

/** Today (YYYY-MM-DD) on the US market calendar, regardless of server TZ. */
export function etToday(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Wall-clock time (HH:MM, 24h) in America/New_York for `now` — the value
 *  `positions.entry_time` expects ("optional local entry time... for
 *  time-of-day stats"), so an autotrade fill lands in the same session
 *  buckets (Open / Late AM / Midday / Power hour) a hand-logged trade does.
 *  Same reasoning as etToday above: the server runs in UTC, so a naive
 *  getHours() would put every fill 4-5 hours into the wrong session. */
export function etTimeOfDay(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // Intl may render midnight as "24:00" with hour12: false — normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}`;
}
