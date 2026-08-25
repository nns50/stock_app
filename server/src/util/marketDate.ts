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

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Minutes America/New_York is offset from UTC at `ms` (-240 EDT, -300 EST). */
function etOffsetMinutes(ms: number): number {
  const parts = etParts.formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (asIfUtc - ms) / 60_000;
}

/**
 * The instant an ET wall-clock date + time refers to — the inverse of
 * etToday/etTimeOfDay above, for reading `positions.entry_date` +
 * `entry_time` back as a real moment (excursion.ts needs it to bound an
 * intraday holding period to the minutes actually held).
 *
 * Offset is measured AT the instant rather than assumed, then re-measured once
 * in case the first guess landed on the far side of a DST boundary — the same
 * reasoning that makes this file exist at all. Returns null for a malformed
 * date/time rather than a guessed instant.
 */
export function etDateTimeToMs(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const naiveUtc = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(naiveUtc)) return null;
  const first = naiveUtc - etOffsetMinutes(naiveUtc) * 60_000;
  const second = naiveUtc - etOffsetMinutes(first) * 60_000;
  return second;
}
