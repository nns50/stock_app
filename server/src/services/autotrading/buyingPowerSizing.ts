// ---------------------------------------------------------------------------
// Size the position to what the account can actually fund (2026-08-28).
//
// The sizer worked from risk alone — riskPerTradePct over the stop distance —
// and buying power was checked only later, at the guardrail, on a fully sized
// order. So an order too large to fund was built in full and then refused. On
// 2026-08-28 that happened 627 times and produced ZERO live entries: the day's
// buying power was $2,161.18 (a $5,000 deposit had not settled) while the sizer
// kept producing $3,600-$5,378 orders.
//
// The day was not merely unlucky, it was unwinnable by construction. To risk
// 1.25% of a $5,161 account inside $2,161 of buying power needs a stop 2.98%
// away, and maxStopDistancePct is 2.5 — so no order could be both correctly
// sized and fundable. Meanwhile a ~$2,000 position was affordable all session
// and was never attempted.
//
// Buying power is not a fixed property of the account. It moves with settlement
// holds, with margin state, and with the previous day's wins and losses — so
// this cannot be a number someone edits each morning. The sizer has to read it
// and adapt, which is what this module is for.
//
// TAKING A SMALLER TRADE IS THE POINT, and it only ever reduces risk: fewer
// shares at the same stop is strictly less money at stake than the sizer
// intended. What it does NOT do is pretend the risk target was met — the caller
// journals the shortfall, so an undersized book is visible rather than being
// quietly read as a normal one.
// ---------------------------------------------------------------------------

/** Hold back a slice of buying power rather than sizing to the last cent. The
 *  guardrail values an order at its LIMIT price, which is set from a quote
 *  taken moments earlier, so sizing to exactly the available figure leaves a
 *  fundable order one tick of drift away from a broker rejection. */
const BUYING_POWER_RESERVE_PCT = 2;

/** Below this fraction of the intended size, skip the trade instead of taking
 *  it. A token position still consumes a concurrency slot and one of the day's
 *  trades, and returns almost nothing for them — at that point waiting for a
 *  candidate that fits is worth more than being nominally in the market.
 *  Chosen against the real 2026-08-28 blocks, whose fundable fractions ran
 *  0.45-0.60 and would all still have traded. */
export const MIN_FUNDED_SIZE_FRACTION = 0.25;

export interface BuyingPowerSizingInput {
  /** Available buying power. `undefined` means UNKNOWN — paper, or the broker
   *  read failed — and imposes no constraint at all, leaving sizing exactly as
   *  it was before this module existed. */
  buyingPowerUsd: number | undefined;
  /** The price the order will be valued at (the sizer's entry price). */
  entryPrice: number;
  /** Only a BUY consumes buying power; a sell frees it. Mirrors the same rule
   *  in guardrails.ts so the two cannot disagree about which orders are
   *  constrained. */
  side: 'buy' | 'sell';
}

export interface BuyingPowerSizingResult {
  /** Largest fundable whole quantity, or `undefined` for "no constraint". */
  maxQuantity: number | undefined;
  /** Buying power after the reserve — what `maxQuantity` was derived from.
   *  `undefined` whenever `maxQuantity` is. */
  usableUsd: number | undefined;
}

/**
 * The largest position this account can currently fund, in whole units.
 *
 * Returns `undefined` (no constraint) when buying power is unknown, when the
 * order does not consume it, or when the inputs cannot produce a sane number —
 * every one of those falls back to the previous behaviour rather than guessing
 * a cap, because a wrong cap here silently shrinks every order.
 */
export function buyingPowerMaxQuantity(input: BuyingPowerSizingInput): BuyingPowerSizingResult {
  const none: BuyingPowerSizingResult = { maxQuantity: undefined, usableUsd: undefined };
  const { buyingPowerUsd, entryPrice, side } = input;
  if (side !== 'buy') return none;
  if (buyingPowerUsd === undefined || !Number.isFinite(buyingPowerUsd)) return none;
  if (!(entryPrice > 0)) return none;

  const usableUsd = Math.max(0, buyingPowerUsd) * (1 - BUYING_POWER_RESERVE_PCT / 100);
  return { maxQuantity: Math.floor(usableUsd / entryPrice), usableUsd };
}

/**
 * Is the fundable size too small to be worth a slot?
 *
 * `intendedQuantity` is what risk alone asked for. False whenever there is no
 * shortfall to judge — an unconstrained or already-satisfied size is never
 * "too small".
 */
export function isTooSmallToFund(fundedQuantity: number, intendedQuantity: number): boolean {
  if (!(intendedQuantity > 0)) return false;
  if (fundedQuantity >= intendedQuantity) return false;
  return fundedQuantity < intendedQuantity * MIN_FUNDED_SIZE_FRACTION;
}
