// ---------------------------------------------------------------------------
// US equity/options regular trading hours (RTH): Mon–Fri, 9:30 a.m.–4:00 p.m.
// Eastern. Used for a NON-BLOCKING "market appears closed" warning on the
// pre-trade check — options can't trade outside RTH at all, and core-session
// stock orders won't fill until the open.
//
// Heuristic by design: it does NOT know market holidays or early-close days, so
// it must only ever drive a WARNING, never a hard block. The broker remains the
// authority on whether an order can be placed.
// ---------------------------------------------------------------------------

const OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET
const CLOSE_MINUTES = 16 * 60; // 16:00 ET

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

  const hour = Number(get('hour')) % 24; // some platforms render midnight as "24"
  const minutes = hour * 60 + Number(get('minute'));
  return minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
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
