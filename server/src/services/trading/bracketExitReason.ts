import { PositionExitReason, Side } from '../../db/positions';

/**
 * Which bracket leg explains a close that the BROKER-TRUTH SYNC had to book
 * itself.
 *
 * The sync closes a position it can no longer find at the broker, pricing the
 * exit from a live quote because it never saw the fill. Until 2026-09-10 it
 * also booked every one of those as `exitReason: 'manual'`, on the reasoning
 * that "everything reaching this point closed outside the loop's own order
 * flow". That is true of a human sale and false of the case the sync's own
 * deferral is built around: a resting BRACKET leg filled, the entry order's
 * reconcile did not catch up inside the grace window, and the sync closed it
 * at an estimate. SWKS, 2026-09-10 — 11 shares booked 'manual' at 83.845 with
 * the ratcheted stop sitting at 83.85, half a cent above. The money was right
 * and the attribution was wrong, which quietly corrupts every exit-reason
 * count the analytics draw from.
 *
 * So: when the caller KNOWS a bracket leg is what disappeared, the levels the
 * bracket was resting at are enough to say which one. This is an inference
 * from an estimated price, never an observed fill, and it stays deliberately
 * conservative — a price that is not at or beyond exactly one level comes back
 * null and the caller keeps 'manual'. Guessing a reason is worse than
 * admitting there isn't one.
 *
 * Pure. The caller supplies the "a bracket leg filled" fact; this module never
 * infers that part, because a human selling near the stop must not be
 * relabelled as a stop.
 */

/** How far off its level the estimated price may sit and still be attributed.
 *  The quote is read up to a few syncs AFTER the real fill, so it drifts; 0.1%
 *  is roughly a normal tick or two on a liquid name and covered SWKS's own
 *  half-cent miss with room to spare. */
const QUOTE_DRIFT_PCT = 0.1;

/** ...but never more than this share of the stop-to-target span, so one
 *  level's window can never reach the other and turn a target into a stop on a
 *  very tight bracket. Only meaningful when both levels are known. */
const MAX_SPAN_SHARE = 0.1;

export interface BracketLevels {
  side: Side;
  stopPrice: number | null;
  targetPrice: number | null;
}

export interface InferredExitReason {
  /** null means "not attributable" — the caller keeps 'manual'. */
  reason: Extract<PositionExitReason, 'stop' | 'target'> | null;
  /** Why, in words, for the journal and the exit note. */
  detail: string;
}

function toleranceFor(level: number, stop: number | null, target: number | null): number {
  const drift = Math.abs(level) * (QUOTE_DRIFT_PCT / 100);
  if (stop === null || target === null) return drift;
  return Math.min(drift, Math.abs(target - stop) * MAX_SPAN_SHARE);
}

export function inferBracketExitReason(pos: BracketLevels, exitPrice: number): InferredExitReason {
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    return { reason: null, detail: 'no usable exit price to compare against the bracket levels' };
  }
  const { side, stopPrice, targetPrice } = pos;
  if (stopPrice === null && targetPrice === null) {
    return { reason: null, detail: 'position carries neither a stop nor a target' };
  }

  // "At or beyond" in the direction the leg actually fills: a long's stop is
  // hit from above and its target from below, and a short is the mirror image.
  const long = side === 'long';
  const hitStop =
    stopPrice !== null &&
    (long
      ? exitPrice <= stopPrice + toleranceFor(stopPrice, stopPrice, targetPrice)
      : exitPrice >= stopPrice - toleranceFor(stopPrice, stopPrice, targetPrice));
  const hitTarget =
    targetPrice !== null &&
    (long
      ? exitPrice >= targetPrice - toleranceFor(targetPrice, stopPrice, targetPrice)
      : exitPrice <= targetPrice + toleranceFor(targetPrice, stopPrice, targetPrice));

  if (hitStop && hitTarget) {
    // A degenerate bracket (crossed or near-identical levels). Both readings
    // are defensible, which is exactly when a guess should not be made.
    return {
      reason: null,
      detail: `price ${exitPrice} is within tolerance of BOTH the stop ${stopPrice} and the target ${targetPrice} — not attributable`,
    };
  }
  if (hitStop) {
    return { reason: 'stop', detail: `estimated exit ${exitPrice} is at or through the stop ${stopPrice}` };
  }
  if (hitTarget) {
    return { reason: 'target', detail: `estimated exit ${exitPrice} is at or through the target ${targetPrice}` };
  }
  return {
    reason: null,
    detail: `price ${exitPrice} sits between the stop ${stopPrice} and the target ${targetPrice} — not attributable`,
  };
}
