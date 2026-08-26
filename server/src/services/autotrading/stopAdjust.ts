import { Position } from '../../db/positions';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { DailyTargetStatus } from './dailyTarget';

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
  | 'liveTrailingEnabled'
  | 'breakevenTriggerRMultiple'
  | 'trailStartRMultiple'
  | 'trailStopRMultiple'
  | 'dayProtectiveStopEnabled'
  | 'giveBackFloorPct'
>;

// --- The day-protective stop (2026-08-26) ----------------------------------
// Observed on the first target-hitting day: at ~+2.7%, needing 0.3% more to
// bank, the loop opened a full-size position with a 2R target ~4.9% away. It
// won, and the day finished +5.96%. But price the OTHER branch: a stop-out
// there costs ~2% and drops the day to ~0.7% — BELOW the 1% give-back floor,
// so the guard would only halt AFTER the damage. Three quarters of a banked
// day risked to earn a tenth of one.
//
// The obvious fix is a breakeven stop once the day is armed. It is also the
// wrong one, because it is not free: a stop at entry scratches every trade
// that dips and recovers, and those are winners you paid for.
//
// So this asks a narrower question — not "can I lock in a profit" but "can
// this ONE trade still cost me the day?" It moves the stop no further than the
// price at which a stop-out leaves the day exactly at its give-back floor, and
// only when the current stop would breach that floor. When the existing stop
// is already safe it does NOTHING, which is most of the time. That is what
// keeps the cost near zero: it intervenes only in the case that motivated it.
//
// Worked against the real trade: ANF, entry 145.11, stop 141.33, 9 shares,
// day at ~+1.6% ($2,137) with a 1% floor ($2,124). A stop-out loses $34 and
// lands the day at 0% — under the floor. The day-protective stop sits at
// 143.72, still $1.39 below entry, so the trade keeps room to breathe. ANF
// never traded below 145.11 before running to its target, so this would not
// have scratched it.
//
// Deliberately NOT breakeven, and deliberately floored by minimum room: a stop
// parked a cent under the price is a market order with extra steps.
// ---------------------------------------------------------------------------

/** Never place a day-protective stop closer than this fraction of the
 *  position's ORIGINAL stop distance. Below roughly a quarter of the original
 *  risk the stop sits inside ordinary intraday noise, and the protection it
 *  buys costs more in scratches than the day it is guarding. */
export const DAY_PROTECTIVE_MIN_ROOM_R = 0.25;

/** The position fields the decision needs — a structural subset of Position so
 *  a caller can pass a real row straight in. */
export type StopAdjustPosition = Pick<
  Position,
  'side' | 'entryPrice' | 'stopPrice' | 'initialStopPrice' | 'bestPriceSinceEntry' | 'remainingQuantity'
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
  kind: 'breakeven' | 'trail' | 'day_protective' | null;
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
 * The stop price at which a stop-out would leave the day exactly at its
 * give-back floor — or null when the rule does not apply.
 *
 * Null (does nothing) whenever: the feature is off, no floor is configured,
 * the day has no measurable equity, the guard has not ARMED, the position's
 * size is unknown, the day is already at or under the floor (nothing left to
 * protect — the guard itself handles that), the current stop is ALREADY safe,
 * or the required stop would sit closer to the price than
 * DAY_PROTECTIVE_MIN_ROOM_R of the original risk.
 *
 * That last guard is the one that keeps this cheap: rather than squeezing a
 * position into a stop it cannot survive, the rule declines and leaves the
 * original stop alone. Protecting the day is not worth converting a live
 * trade into a coin flip on the next tick.
 */
function dayProtectiveStop(
  pos: StopAdjustPosition,
  cfg: StopAdjustConfig,
  dt: DailyTargetStatus | undefined,
  initialStopDistance: number,
): number | null {
  if (!cfg.dayProtectiveStopEnabled) return null;
  if (cfg.giveBackFloorPct === null || !(cfg.giveBackFloorPct > 0)) return null;
  if (!dt || !dt.active || !dt.giveBackArmed) return null;
  if (dt.baselineEquityUsd === undefined || dt.currentEquityUsd === undefined) return null;

  const qty = pos.remainingQuantity;
  if (!(qty > 0)) return null;

  const floorEquity = dt.baselineEquityUsd * (1 + cfg.giveBackFloorPct / 100);
  // Headroom: how much this position may lose before the day breaches its
  // floor. Non-positive means the day is already at or below it, which is the
  // give-back guard's business, not this rule's.
  const headroomUsd = dt.currentEquityUsd - floorEquity;
  if (!(headroomUsd > 0)) return null;

  const perShare = headroomUsd / qty;
  const long = pos.side === 'long';
  const required = long ? pos.entryPrice - perShare : pos.entryPrice + perShare;

  // Already safe: the stop we hold cannot breach the floor, so leave it be.
  // This is the common case, and the reason the rule is near-free.
  if (pos.stopPrice !== null && (long ? pos.stopPrice >= required : pos.stopPrice <= required)) return null;

  // Too tight to be a stop rather than an exit.
  const minRoom = DAY_PROTECTIVE_MIN_ROOM_R * initialStopDistance;
  const roomLeft = long ? pos.entryPrice - required : required - pos.entryPrice;
  if (roomLeft < minRoom) return null;

  return required;
}

/**
 * Should this live position's stop move now? Pure — the caller supplies the
 * current price and does the broker work.
 *
 * Returns `bestPrice` even when it declines to move the stop: the high-water
 * mark is bookkeeping the trail depends on, and it has to be maintained on
 * every cycle or the trail hangs off a stale peak.
 */
export function evaluateStopAdjust(
  pos: StopAdjustPosition,
  price: number,
  cfg: StopAdjustConfig,
  /** The day as it stands. Omitted by callers that have no daily goal, which
   *  simply leaves the day-protective rule out of the running. */
  dailyTarget?: DailyTargetStatus,
): StopAdjustDecision {
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
  let kind: 'breakeven' | 'trail' | 'day_protective' | null = null;

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

  // The day-protective candidate. Only while the guard is ARMED (a day worth
  // protecting), and only when the stop as it stands would drop the day under
  // its floor. See the module header for why this is not a breakeven stop.
  const dpFloor = dayProtectiveStop(pos, cfg, dailyTarget, initialStopDistance);
  if (dpFloor !== null && (long ? dpFloor > candidate : dpFloor < candidate)) {
    candidate = dpFloor;
    kind = 'day_protective';
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
