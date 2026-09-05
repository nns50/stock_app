// ---------------------------------------------------------------------------
// US equity/options regular trading hours (RTH): Mon–Fri, 9:30 a.m.–4:00 p.m.
// Eastern. Used for a NON-BLOCKING "market appears closed" warning on the
// pre-trade check — options can't trade outside RTH at all, and core-session
// stock orders won't fill until the open.
//
// It knows market holidays and early closes as of 2026-09-05 (marketCalendar.ts)
// — it did not before, which meant Labor Day looked like an ordinary Monday and
// a 13:00 half-day looked like it ran to 16:00. The calendar is hand-maintained
// and announces its own expiry, so this remains a best-effort read and the
// broker is still the authority on whether an order can actually be placed.
//
// Every calendar answer only ever NARROWS the session, so a stale or wrong
// entry costs a missed morning, never an order into a shut market.
// ---------------------------------------------------------------------------

import { isMarketHoliday, sessionCloseMinute } from './marketCalendar';

const OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET

/** Whether US regular trading hours are (heuristically) open at `now`. */
export function isUsEquityMarketOpen(now: Date = new Date()): boolean {
  // Read wall-clock weekday + time in America/New_York (handles EST/EDT for us).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  // A full holiday is a weekday the exchange simply does not open.
  if (isMarketHoliday(now)) return false;

  const hour = Number(get('hour')) % 24; // some platforms render midnight as "24"
  const minutes = hour * 60 + Number(get('minute'));
  // Early closes end at 13:00; every other session at 16:00.
  return minutes >= OPEN_MINUTES && minutes < sessionCloseMinute(now);
}

/**
 * The `marketOpen` flag to feed the guardrails for THIS order. Only meaningful
 * for orders that target regular hours: every option, and any core-session
 * stock order. For an explicitly extended/overnight stock order the trader has
 * opted into off-hours, so we return `undefined` (no warning).
 */
export function marketOpenContext(
  intent: { assetKind: 'stock' | 'option'; session?: 'core' | 'extended' | 'overnight' },
  now: Date = new Date(),
): boolean | undefined {
  const rthOrder = intent.assetKind === 'option' || (intent.session ?? 'core') === 'core';
  return rthOrder ? isUsEquityMarketOpen(now) : undefined;
}
