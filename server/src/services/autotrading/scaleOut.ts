import { Position } from '../../db/positions';
import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// Live scale-out (2026-08-25) — bank part of a winner before the timer decides
// for you.
//
// A LIVE equity position has exactly three ways out: its stop, its target, or a
// time exit (stagnation / maxHoldDays / the end-of-day flatten). The target is
// 2R and is rarely reached inside a session, so in practice most live positions
// exit on a TIMER, at whatever R they happen to be sitting at when it fires.
// The book's own record: exits landing around +0.1R, on trades that had been
// worth more earlier in the hold.
//
// partialExitRMultiple / partialExitPct have existed since 2026-07-11 but only
// ever ran in execute.ts — the PAPER path. Live positions kept a fixed
// stop/target bracket for life, so the settings read as active in the UI while
// doing nothing at all to real money. This closes that gap for live equity.
//
// THE ORDERING RULE, which is the whole safety story:
//
//   Reduce the resting bracket legs to the REMAINDER first, and only then sell
//   the scale-out quantity.
//
// Doing it the other way round is how you end up short. Sell half while the
// bracket still covers the full original quantity, and a later stop fill sells
// the full amount against a half-sized holding — for a long that leaves a
// SHORT position nobody opened, unprotected and tracked nowhere. Reducing
// first means the worst case is the opposite and benign: the shares we were
// about to sell sit briefly unbracketed, which checkLiveBracketProtection
// already reports, and the next tick retries the sell.
//
// If the leg reduction fails for any reason the scale-out is ABANDONED for this
// tick with the position still fully protected. Never the other order, never a
// partial sell against a full-size bracket.
//
// R DENOMINATOR: the initial stop, never the current one — see the comment at
// the risk calculation below. This module and stopAdjust.ts must agree by
// construction about what one R is, because the same config value now drives
// both triggers.
//
// Gated behind its own liveScaleOutEnabled flag rather than reusing
// partialExitRMultiple alone: that value is already 1.5 in production from the
// paper path, so wiring live scale-outs to it would have switched them on for
// real money the moment this deployed, with nobody choosing that.
// ---------------------------------------------------------------------------

export type ScaleOutConfig = Pick<AutotradeConfig, 'liveScaleOutEnabled' | 'partialExitRMultiple' | 'partialExitPct'>;

export interface ScaleOutDecision {
  triggered: boolean;
  /** Shares to sell now. 0 when not triggered. */
  quantity: number;
  /** Progress in R at the supplied price — null when unmeasurable. */
  rMultiple: number | null;
  detail: string;
}

const notTriggered = (detail: string, rMultiple: number | null = null): ScaleOutDecision => ({
  triggered: false,
  quantity: 0,
  rMultiple,
  detail,
});

/**
 * Should this live position bank part of itself now? Pure — the caller supplies
 * the current price and does the broker work.
 *
 * "Already scaled out" is derived, not stored: a position that is still OPEN
 * but already carries an exit can only have got there by a partial close. That
 * keeps this one-shot per position without another column to migrate and
 * without a flag that could drift from the exits it describes.
 */
export function evaluateScaleOut(
  pos: Pick<
    Position,
    'side' | 'entryPrice' | 'stopPrice' | 'initialStopPrice' | 'quantity' | 'remainingQuantity' | 'exits'
  >,
  price: number,
  cfg: ScaleOutConfig,
): ScaleOutDecision {
  if (!cfg.liveScaleOutEnabled) return notTriggered('live scale-out off');
  if (!(cfg.partialExitRMultiple > 0)) return notTriggered('no scale-out R trigger configured');
  if (!(cfg.partialExitPct > 0) || cfg.partialExitPct >= 100) {
    // 100% is not a scale-out, it is an exit — and belongs to the paths that
    // own exits, which cancel the bracket properly rather than resizing it.
    return notTriggered(`scale-out % must be between 0 and 100 (is ${cfg.partialExitPct})`);
  }
  if (pos.exits.length > 0) return notTriggered('already scaled out once');
  // R is measured against the INITIAL stop, exactly as stopAdjust.ts measures
  // it. Both must derive the denominator the same way or they disagree about
  // what "+0.25R" means. Using the CURRENT stop here was a live bug: the loop
  // ratchets stops BEFORE it scales out (deliberately — see loop.ts), so once
  // the breakeven rule fires, pos.stopPrice === entryPrice, risk is 0, and
  // every subsequent scale-out on that position returns "degenerate risk"
  // forever. It stayed invisible only because breakeven triggered at 1.0R
  // while the scale-out triggered at 0.3R, so the scale-out almost always went
  // first. Setting the two triggers to the same R surfaces it immediately.
  const stopForRisk = pos.initialStopPrice ?? pos.stopPrice;
  if (stopForRisk === null) return notTriggered('no measurable R progress (no stop on this position)');

  const risk = Math.abs(pos.entryPrice - stopForRisk);
  if (!(risk > 0) || !Number.isFinite(price) || price <= 0) {
    return notTriggered('no measurable R progress (degenerate risk or price)');
  }
  const move = pos.side === 'short' ? pos.entryPrice - price : price - pos.entryPrice;
  const rMultiple = Math.round((move / risk) * 100) / 100;
  if (rMultiple < cfg.partialExitRMultiple) {
    return notTriggered(`+${rMultiple}R, under the ${cfg.partialExitRMultiple}R scale-out trigger`, rMultiple);
  }

  const quantity = Math.floor(pos.remainingQuantity * (cfg.partialExitPct / 100));
  if (quantity <= 0) {
    // A 1-share position cannot be halved. Retried next tick in case the
    // position grows via a scale-in; never rounded up into a full exit.
    return notTriggered(`${cfg.partialExitPct}% of ${pos.remainingQuantity} rounds to nothing`, rMultiple);
  }
  if (quantity >= pos.remainingQuantity) {
    return notTriggered('scale-out would close the whole position — that is an exit, not a scale-out', rMultiple);
  }

  return {
    triggered: true,
    quantity,
    rMultiple,
    detail: `+${rMultiple}R — banking ${quantity} of ${pos.remainingQuantity} at the ${cfg.partialExitRMultiple}R trigger`,
  };
}
