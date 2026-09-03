import { Position } from '../../db/positions';
import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// Intraday stagnation exit (2026-08-22). The journal's own evidence: on the
// most recent full-book day, 995 of 1,000 risk-check events were blocked by
// max_concurrent_positions — two positions sat in the account's two slots for
// hours while every fresh candidate bounced off the cap. With maxHoldDays
// previously 0 (the day-granularity time exit OFF), a position that went
// nowhere held indefinitely until its bracket resolved.
//
// Rule: a live equity position that has made LESS than `stagnationExitMinR`
// of R progress after `stagnationExitMinutes` wall-clock minutes is scratched
// (closed at market via the existing time-exit path), freeing its slot and
// its slice of the aggregate-risk budget for fresh signals. Capital velocity
// is the one lever that raises shots-per-day WITHOUT loosening any risk cap.
//
// Progress is measured in R — (price − entry) / (entry − stop), sign-adjusted
// for shorts — because "going nowhere" is relative to the trade's own risk
// geometry, not a fixed % move. A position below the threshold includes one
// drifting NEGATIVE: a slow bleeder is recycled too, before it finds the stop.
//
// Deliberately conservative edges:
//   - SESSION minutes, not wall-clock. Corrected 2026-08-24 after the operator
//     asked what happens to a position held overnight: the original counted
//     raw elapsed time, so a 15:50 entry got ten real minutes of market before
//     judgement, and ANY overnight hold arrived at the next open reading ~1,230
//     minutes — instantly past the bar and scratched on the opening print. The
//     surrounding comment claimed session-gating prevented exactly that; it did
//     not. Gating only stopped EVALUATION while the market was shut, never the
//     clock. Now only minutes the market was actually open count, so "90
//     minutes" means 90 minutes of real trading wherever the entry falls, and
//     an overnight position resumes its deadline where it left off instead of
//     starting the day already condemned.
//   - Still evaluated only while the session is open (the caller gates on
//     checkSessionWindow), so no scratch is ever attempted into pre/after-hours
//     liquidity.
//   - A position with no stop (or a degenerate zero risk distance) has no R
//     to measure — never triggered, same "no guessed R" discipline as every
//     other realized-R consumer. "No stop" means neither the initial nor the
//     current one is usable; a stop that has merely RATCHETED is still fully
//     measurable, against the frozen initial distance. See progressR.
//   - 0 minutes = feature off. The known cost, accepted with eyes open: this
//     will sometimes scratch a slow winner (the book's winners pay ~4:1, so
//     the audit trail matters) — every trigger journals heldMinutes and the
//     progress R so the scratches can be audited for exactly that.
//
// LIVE equity only, like the rest of the goal-protection stack: options carry
// theta (a stagnant long option is already paying for its slot and has its
// own %-of-premium exits), and paper has no slot-scarcity problem worth the
// churn. Pure decision here; liveExecute's checkLiveEquityTimeExits threads
// in the quote and places the actual close.
// ---------------------------------------------------------------------------

export type StagnationConfig = Pick<AutotradeConfig, 'stagnationExitMinutes' | 'stagnationExitMinR'>;

/** Realized-so-far progress of an open position in R, at `price`. Null when
 *  the position has no stop at all or a degenerate zero risk distance.
 *
 *  The denominator is the INITIAL stop, never the current one. execute.ts's
 *  applyPositionManagement has said so since the paper ratchet shipped, and
 *  this module did not follow it: measuring against a stop that the ratchet
 *  moves means the risk unit shrinks as the stop tightens, and at breakeven it
 *  hits ZERO — so `risk > 0` fails, progress reads null, and evaluateStagnation
 *  answers "no measurable R progress" and never scratches that position again.
 *  A breakeven-ratcheted position would then hold its slot until the end-of-day
 *  flatten, which is precisely the slot starvation this module exists to end.
 *
 *  Latent until 2026-09-03: breakeven triggered at 1.0R, which 17% of trades
 *  reached. At the recalibrated 0.25R it is ~50%, so this would have silently
 *  disabled the stagnation exit on half the book from the next session on. */
export function progressR(
  pos: Pick<Position, 'side' | 'entryPrice' | 'stopPrice' | 'initialStopPrice'>,
  price: number,
): number | null {
  const stop = pos.initialStopPrice ?? pos.stopPrice;
  if (stop === null) return null;
  const risk = Math.abs(pos.entryPrice - stop);
  if (!(risk > 0) || !Number.isFinite(price) || price <= 0) return null;
  const move = pos.side === 'short' ? pos.entryPrice - price : price - pos.entryPrice;
  return Math.round((move / risk) * 100) / 100;
}

const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;
const SESSION_MINUTES_PER_DAY = SESSION_CLOSE_MIN - SESSION_OPEN_MIN; // 390
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
/** Minutes since ET midnight, plus whether that ET day is a weekday. */
function etDayInfo(ms: number): { minutes: number; weekday: boolean } {
  const parts = etParts.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday');
  return {
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
    weekday: day !== 'Sat' && day !== 'Sun',
  };
}

/**
 * Minutes the REGULAR SESSION was open between `from` and `to` — the honest
 * measure of how long a position has had to prove itself. Walks ET day by day
 * and intersects each weekday's 9:30–16:00 with the interval, so overnight
 * gaps, weekends and after-hours contribute nothing.
 *
 * Holidays are NOT known here (the same documented heuristic limit
 * isUsEquityMarketOpen carries): a market holiday inside the span is counted
 * as a full session, which can only ever make a position look STALER than it
 * is. That errs toward scratching a dead trade slightly early rather than
 * holding a genuinely stagnant one longer, and the cost is bounded at one
 * session per holiday.
 */
export function sessionMinutesBetween(from: number, to: number): number {
  if (!(to > from)) return 0;
  // Bounded walk: a position older than a few weeks contributes its full
  // sessions anyway, and maxHoldDays retires it long before this matters.
  let total = 0;
  for (let cursor = from; cursor < to;) {
    const { minutes: startMin, weekday } = etDayInfo(cursor);
    // Where this ET day's session ends, in ms from `cursor`.
    const endOfDayMs = cursor + (24 * 60 - startMin) * 60_000;
    const dayEnd = Math.min(to, endOfDayMs);
    if (weekday) {
      const spanEndMin = startMin + Math.round((dayEnd - cursor) / 60_000);
      const overlap = Math.min(spanEndMin, SESSION_CLOSE_MIN) - Math.max(startMin, SESSION_OPEN_MIN);
      if (overlap > 0) total += Math.min(overlap, SESSION_MINUTES_PER_DAY);
    }
    cursor = dayEnd === to ? to : endOfDayMs;
    // Defensive: a pathological clock must not spin this loop forever.
    if (to - from > 400 * MS_PER_DAY) break;
  }
  return Math.floor(total);
}

export interface StagnationDecision {
  triggered: boolean;
  /** Minutes the market was OPEN since entry — not raw elapsed time. */
  heldMinutes: number;
  /** Progress in R at the supplied price — null when unmeasurable. */
  progress: number | null;
  detail: string;
}

/**
 * Should this position be scratched as stagnant? Pure — the caller supplies
 * the current price and clock, and has already checked the session is open.
 */
export function evaluateStagnation(
  pos: Pick<Position, 'side' | 'entryPrice' | 'stopPrice' | 'initialStopPrice' | 'createdAt'>,
  price: number,
  cfg: StagnationConfig,
  now: number,
): StagnationDecision {
  const heldMinutes = sessionMinutesBetween(pos.createdAt, now);
  if (!(cfg.stagnationExitMinutes > 0)) {
    return { triggered: false, heldMinutes, progress: null, detail: 'stagnation exit off' };
  }
  if (heldMinutes < cfg.stagnationExitMinutes) {
    return {
      triggered: false,
      heldMinutes,
      progress: null,
      detail: `held ${heldMinutes}m of ${cfg.stagnationExitMinutes}m`,
    };
  }
  const progress = progressR(pos, price);
  if (progress === null) {
    return {
      triggered: false,
      heldMinutes,
      progress,
      detail: 'no measurable R progress (no stop on this position) — never scratched on a guess',
    };
  }
  if (progress >= cfg.stagnationExitMinR) {
    return {
      triggered: false,
      heldMinutes,
      progress,
      detail: `+${progress}R after ${heldMinutes}m — working, ≥ the ${cfg.stagnationExitMinR}R stagnation bar`,
    };
  }
  return {
    triggered: true,
    heldMinutes,
    progress,
    detail: `${progress}R after ${heldMinutes}m (< ${cfg.stagnationExitMinR}R) — recycling the slot for fresh signals`,
  };
}
