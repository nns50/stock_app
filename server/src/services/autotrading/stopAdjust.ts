import { Position } from '../../db/positions';
import { AutotradeConfig } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// Live stop ratchet (2026-08-26) — breakeven and trailing stops for LIVE equity.
//
// breakevenTriggerRMultiple, trailStartRMultiple and trailStopRMultiple have
// existed since 2026-07-11 but only ever ran in execute.ts — the PAPER path.
// A LIVE equity position kept the stop it was born with for its entire life,
// while all three settings sat in the UI reading as active. That is the same
// class of bug as the live scale-out (partialExitRMultiple, fixed 2026-08-25)
// and the live options partial/trail/breakeven fields: a setting that describes
// behaviour the live path never had.
//
// This module is the DECISION only. It is pure, and it deliberately knows
// nothing about brokers: the caller quotes the symbol, and — critically — the
// caller must move the stop AT THE BROKER before recording it locally. A live
// stop is a resting STOP_LOSS leg, not a number in our database; writing our
// number first would leave the ledger claiming protection the broker does not
// have, which is the more dangerous of the two orderings.
//
// TWO RULES THAT MAKE THIS SAFE:
//
//   1. R is measured against initialStopPrice — the stop as it was AT OPEN,
//      frozen — never the current, possibly-already-ratcheted stop. Measuring
//      against the live stop would shrink the denominator every time the stop
//      moved, so each reading would overstate progress and the trail would
//      chase itself up the chart.
//
//   2. Breakeven and trailing each merely PROPOSE a candidate, and only the
//      most favourable of {current stop, breakeven, trailing} is ever returned.
//      That single rule is what makes loosening structurally impossible — no
//      "already applied" flags to get out of step with the stop they describe,
//      and no ordering dependency between the two features.
//
// Both are lifted from applyPositionManagement()'s paper implementation
// unchanged, because the arithmetic is not what was broken — its reach was.
// Scale-in and the partial exit are NOT duplicated here: the partial already
// has its live counterpart in scaleOut.ts, and live scale-in is a separate
// feature with its own flag.
// ---------------------------------------------------------------------------

export type StopAdjustConfig = Pick<
  AutotradeConfig,
  'liveTrailingEnabled' | 'breakevenTriggerRMultiple' | 'trailStartRMultiple' | 'trailStopRMultiple'
>;

/** The position fields the decision needs — a structural subset of Position so
 *  a caller can pass a real row straight in. */
export type StopAdjustPosition = Pick<
  Position,
  'side' | 'entryPrice' | 'stopPrice' | 'initialStopPrice' | 'bestPriceSinceEntry'
>;

export interface StopAdjustDecision {
  /** True when the stop should move. */
  adjust: boolean;
  /** The stop to place at the broker. Null when not adjusting. */
  newStop: number | null;
  /** The new high/low-water mark to record, whether or not the stop moves —
   *  the trail needs this maintained every cycle, not only on the cycles it
   *  fires. Null when unmeasurable. */
  bestPrice: number | null;
  /** Progress in R at the supplied price — null when unmeasurable. */
  rMultiple: number | null;
  /** Which rule produced newStop, for the journal. */
  kind: 'breakeven' | 'trail' | null;
  detail: string;
}

const noAdjust = (
  detail: string,
  rMultiple: number | null = null,
  bestPrice: number | null = null,
): StopAdjustDecision => ({ adjust: false, newStop: null, bestPrice, rMultiple, kind: null, detail });

/** Round to the cent grid Webull enforces on every price it accepts (see
 *  providers/webull/orders.ts's priceStr) — and round the stop the SAFE way,
 *  toward the current price, so rounding can only ever tighten by a fraction
 *  of a cent, never loosen by one. */
function roundStop(price: number, side: 'long' | 'short'): number {
  return side === 'long' ? Math.ceil(price * 100) / 100 : Math.floor(price * 100) / 100;
}

/**
 * Should this live position's stop move now? Pure — the caller supplies the
 * current price and does the broker work.
 *
 * Returns `bestPrice` even when it declines to move the stop: the high-water
 * mark is bookkeeping the trail depends on, and it has to be maintained on
 * every cycle or the trail hangs off a stale peak.
 */
export function evaluateStopAdjust(pos: StopAdjustPosition, price: number, cfg: StopAdjustConfig): StopAdjustDecision {
  if (!cfg.liveTrailingEnabled) return noAdjust('live trailing off');
  if (pos.stopPrice === null) return noAdjust('no stop on this position — nothing to ratchet');
  if (pos.initialStopPrice === null) {
    // A manual/imported row, or one predating the column. Never guess the
    // denominator from the current stop: if it has already moved, every R
    // reading would be wrong in the direction that loosens nothing but fires
    // early.
    return noAdjust('no initial stop recorded — R is not measurable for this position');
  }
  if (!Number.isFinite(price) || price <= 0) return noAdjust('no usable price');

  const long = pos.side === 'long';
  const initialStopDistance = Math.abs(pos.entryPrice - pos.initialStopPrice);
  if (!(initialStopDistance > 0)) return noAdjust('degenerate initial stop distance');

  const priorBest = pos.bestPriceSinceEntry ?? pos.entryPrice;
  const bestPrice = long ? Math.max(priorBest, price) : Math.min(priorBest, price);

  const rMultiple =
    Math.round(((long ? price - pos.entryPrice : pos.entryPrice - price) / initialStopDistance) * 100) / 100;

  // Both rules propose; the most favourable wins. See rule 2 in the header.
  let candidate = pos.stopPrice;
  let kind: 'breakeven' | 'trail' | null = null;

  if (cfg.breakevenTriggerRMultiple > 0 && rMultiple >= cfg.breakevenTriggerRMultiple) {
    const be = pos.entryPrice;
    if (long ? be > candidate : be < candidate) {
      candidate = be;
      kind = 'breakeven';
    }
  }
  if (cfg.trailStartRMultiple > 0 && cfg.trailStopRMultiple > 0 && rMultiple >= cfg.trailStartRMultiple) {
    const trailDistance = cfg.trailStopRMultiple * initialStopDistance;
    const trailing = long ? bestPrice - trailDistance : bestPrice + trailDistance;
    if (long ? trailing > candidate : trailing < candidate) {
      candidate = trailing;
      kind = 'trail';
    }
  }

  if (kind === null) {
    return noAdjust(`+${rMultiple}R — no ratchet trigger reached`, rMultiple, bestPrice);
  }

  const rounded = roundStop(candidate, long ? 'long' : 'short');
  // Rounding, or a trail that has not yet caught up with a stop breakeven
  // already moved, can land on the stop we are already at. Placing a broker
  // replace for no change is pure cost and journal noise.
  if (long ? rounded <= pos.stopPrice : rounded >= pos.stopPrice) {
    return noAdjust(
      `+${rMultiple}R — ${kind} candidate ${rounded} is no better than the current stop`,
      rMultiple,
      bestPrice,
    );
  }
  // A stop through the current price would be filled the instant it is placed —
  // that is a market exit wearing a stop's clothing, and it is not what either
  // rule is asking for. Leave the stop where it is; the next tick re-evaluates.
  if (long ? rounded >= price : rounded <= price) {
    return noAdjust(
      `+${rMultiple}R — ${kind} candidate ${rounded} is through the price (${price})`,
      rMultiple,
      bestPrice,
    );
  }

  return {
    adjust: true,
    newStop: rounded,
    bestPrice,
    rMultiple,
    kind,
    detail: `+${rMultiple}R — ${kind} moves the stop ${pos.stopPrice} -> ${rounded}`,
  };
}
