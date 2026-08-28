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

// ---------------------------------------------------------------------------
// Entry cutoff before that flatten (2026-08-28).
//
// The flatten had no matching entry gate, so the loop could open a position
// the flatten would immediately close. It did: on 2026-08-28 ESTC was opened
// at 15:56:04 and flattened at 15:57:12 — 68 seconds, -$0.20 plus two spreads.
// GAP had been flattened at 15:55:05, and freeing its slot and buying power is
// what let the next candidate through a minute later.
//
// The cost is not the cents. A position opened inside the flatten window
// CANNOT reach its stop or target — the clock closes it first — so it is a
// guaranteed-waste trade that still consumes a concurrency slot and one of the
// day's `maxTradesPerDay`. It recurs on any day a position flattens and frees
// capacity behind it.
//
// DERIVED from endOfDayFlattenMinutes rather than configured separately, so the
// two cannot disagree: a cutoff set below the flatten would silently reopen
// exactly this hole. (The options path's own cutoff IS a config field because
// 210m is a strategy choice about decay; this one is a correctness guard about
// a clock the flatten already owns.)
//
// The runway on top is what separates "not doomed" from "not worth taking":
// with maxStopDistancePct 2.5 and a 2R target, a position needs a ~5% move to
// pay out, and 15 minutes is already generous for that. It also comfortably
// clears the loop's own ~1-2 minute tick, so an entry can never land inside
// the window through a slow fill.
// ---------------------------------------------------------------------------

/** Minutes of runway a new position needs BEYOND the flatten window. */
export const ENTRY_RUNWAY_MINUTES = 15;

export interface EntryCutoffDecision {
  /** True when a new entry must not be opened this close to the bell. */
  blocked: boolean;
  /** Minutes to the close, or null outside the regular session. */
  minutesLeft: number | null;
  /** The cutoff this was judged against. 0 when the flatten is off. */
  cutoffMinutes: number;
  /** For the journal; null when nothing is blocked. */
  reason: string | null;
}

/**
 * May a new LIVE EQUITY position be opened right now?
 *
 * Off entirely when the flatten is off (`endOfDayFlattenMinutes` 0) — with no
 * flatten there is no window to be swallowed by, and this gate has no opinion
 * about how late the loop trades. Outside the regular session it also declines
 * to block: entries there are the market-open guard's business, not this one's.
 */
export function evaluateEntryCutoff(cfg: EndOfDayFlattenConfig, now: number): EntryCutoffDecision {
  const cutoffMinutes = cfg.endOfDayFlattenMinutes > 0 ? cfg.endOfDayFlattenMinutes + ENTRY_RUNWAY_MINUTES : 0;
  const minutesLeft = minutesUntilClose(now);
  if (cutoffMinutes === 0 || minutesLeft === null || minutesLeft > cutoffMinutes) {
    return { blocked: false, minutesLeft, cutoffMinutes, reason: null };
  }
  return {
    blocked: true,
    minutesLeft,
    cutoffMinutes,
    reason:
      `${minutesLeft}m to the close — past the ${cutoffMinutes}m entry cutoff ` +
      `(${cfg.endOfDayFlattenMinutes}m flatten + ${ENTRY_RUNWAY_MINUTES}m runway); ` +
      `a position opened now would be flattened before it could reach its stop or target`,
  };
}

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
