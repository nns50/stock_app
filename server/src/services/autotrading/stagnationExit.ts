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
//   - Wall-clock minutes, evaluated ONLY while the regular session is open
//     (the caller gates on checkSessionWindow) — so a position entered late
//     Friday isn't "stagnant" at Monday's open bell purely from the weekend,
//     and no scratch is ever attempted into pre/after-market liquidity.
//   - A position with no stop (or a degenerate zero risk distance) has no R
//     to measure — never triggered, same "no guessed R" discipline as every
//     other realized-R consumer.
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
 *  the position has no stop or a degenerate zero risk distance. */
export function progressR(pos: Pick<Position, 'side' | 'entryPrice' | 'stopPrice'>, price: number): number | null {
  if (pos.stopPrice === null) return null;
  const risk = Math.abs(pos.entryPrice - pos.stopPrice);
  if (!(risk > 0) || !Number.isFinite(price) || price <= 0) return null;
  const move = pos.side === 'short' ? pos.entryPrice - price : price - pos.entryPrice;
  return Math.round((move / risk) * 100) / 100;
}

export interface StagnationDecision {
  triggered: boolean;
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
  pos: Pick<Position, 'side' | 'entryPrice' | 'stopPrice' | 'createdAt'>,
  price: number,
  cfg: StagnationConfig,
  now: number,
): StagnationDecision {
  const heldMinutes = Math.floor((now - pos.createdAt) / 60_000);
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
