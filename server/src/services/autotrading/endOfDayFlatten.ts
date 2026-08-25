import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// End-of-day flatten (2026-08-25). Close what's still open a few minutes before
// the bell rather than carrying it overnight.
//
// The evidence, from this book's own two carried positions:
//   - CTVA was carried from 2026-08-24 and sold on the next open for -$0.91. It
//     had been +0.10R when the loop first wanted out.
//   - GRMN was carried the same night. Its exit was ordered at 09:30:18 the next
//     morning at a 293.52 limit priced off the 294.99 opening print; the stock
//     immediately fell to 289.85 and the order sat unfilled.
// Neither loss came from the trade thesis. Both came from holding through a gap
// the strategy never intended to take: this loop's edge is intraday (a
// 90-minute stagnation exit, maxHoldDays 1), so an overnight hold is unhedged
// exposure to news, earnings and the opening auction with none of the
// day-session tools that justify the position in the first place.
//
// Rule: inside the last `endOfDayFlattenMinutes` minutes of the regular
// session, every open LIVE EQUITY position is closed at a marketable limit,
// regardless of progress, hold time, or how it is doing. 0 = off.
//
// Deliberately NOT reusing the stagnation/maxHoldDays gates: this fires on
// trades that are WORKING too. A winner held into the close is still an
// overnight gap risk, and the whole point is that the decision is about the
// clock, not the trade.
//
// It also REPLACES a stale resting exit (see liveExecute's own use): a limit
// placed earlier in the day may be nowhere near the current price — exactly
// GRMN's case above — and letting it rest unfilled is how a position gets
// carried by an exit that already decided to leave.
//
// LIVE EQUITY only, consistent with the rest of the goal-protection stack.
// Options carry their own %-of-premium exits and an expiry of their own; paper
// has no overnight risk worth the churn.
// ---------------------------------------------------------------------------

export type EndOfDayFlattenConfig = Pick<AutotradeConfig, 'endOfDayFlattenMinutes'>;

const SESSION_OPEN_MIN = 9 * 60 + 30;
export const SESSION_CLOSE_MIN = 16 * 60;

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Minutes until the 16:00 ET close, or null when the regular session is not
 *  open at `now` (weekend, or outside 9:30–16:00). Holidays are not known here,
 *  the same documented limit isUsEquityMarketOpen carries — a holiday simply
 *  has no open positions to flatten and no orders will place. */
export function minutesUntilClose(now: number): number | null {
  const parts = etParts.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return null;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  if (minutes < SESSION_OPEN_MIN || minutes >= SESSION_CLOSE_MIN) return null;
  return SESSION_CLOSE_MIN - minutes;
}

export interface FlattenDecision {
  /** True while inside the flatten window. */
  active: boolean;
  /** Minutes left in the session, null outside it. */
  minutesLeft: number | null;
  detail: string;
}

/**
 * Is now inside the end-of-day flatten window? Pure — the caller supplies the
 * clock and does the closing.
 *
 * The window is INCLUSIVE of its opening minute and runs to the bell, so a
 * setting of 3 covers 15:57, 15:58 and 15:59. It deliberately does not extend
 * past 16:00: a close attempted into after-hours liquidity is how you turn a
 * small overnight gap risk into a certain spread cost.
 */
export function evaluateEndOfDayFlatten(cfg: EndOfDayFlattenConfig, now: number): FlattenDecision {
  const minutesLeft = minutesUntilClose(now);
  if (!(cfg.endOfDayFlattenMinutes > 0)) {
    return { active: false, minutesLeft, detail: 'end-of-day flatten off' };
  }
  if (minutesLeft === null) {
    return { active: false, minutesLeft, detail: 'regular session not open' };
  }
  if (minutesLeft > cfg.endOfDayFlattenMinutes) {
    return {
      active: false,
      minutesLeft,
      detail: `${minutesLeft}m to the close, flatten starts at ${cfg.endOfDayFlattenMinutes}m`,
    };
  }
  return {
    active: true,
    minutesLeft,
    detail: `${minutesLeft}m to the close — flattening rather than carrying overnight`,
  };
}
