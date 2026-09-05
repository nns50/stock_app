// ---------------------------------------------------------------------------
// Size the position to what the account can actually fund (2026-08-28).
//
// BROADENED 2026-09-05 from buying power alone to EVERY dollar bound the
// guardrail enforces. The original fix taught the sizer about buying power and
// stopped there, but guardrails.ts blocks an entry on three separate dollar
// tests — order_notional, buying_power and account_exposure — and the sizer
// only knew about the middle one. So the build-then-refuse loop this module
// exists to end simply moved to the other two. From the live journal, the four
// sessions AFTER the buying-power fix produced 23 live_entry_blocked events, 18
// of them account_exposure, and the misses were tiny: DELL over its cap by
// $10.84, SNDK by $60, DG by $120 — sizes a bound sizer would have trimmed by
// one or two shares. DG was refused six times in eleven minutes (17:16 through
// 17:27) for the same ~$120, each attempt costing a broker round-trip and
// entering nothing.
//
// It is the invariant from CLAUDE.md: when two places derive the same
// quantity they must agree BY CONSTRUCTION. The exposure cap had already been
// raised once (2026-08-27, "two correctly-sized positions summed to $2,284
// against a $2,283.61 cap and the second was refused by 39 cents") — raising
// the ceiling treats the symptom, because the sizer still aims wherever it
// likes and the guardrail still judges after the fact.
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
  /** Per-order notional ceiling — guardrails.ts's `order_notional` test, which
   *  compares against TradingConfig.maxOrderUsd. `undefined` (paper, preview)
   *  imposes nothing. */
  maxOrderUsd?: number;
  /** Room left under the account exposure cap: maxExposureUsd − exposureUsd,
   *  i.e. guardrails.ts's `account_exposure` test rearranged so the sizer can
   *  aim at it instead of being judged by it. `undefined` imposes nothing. */
  exposureHeadroomUsd?: number;
  /** The price the order will be valued at (the sizer's entry price). */
  entryPrice: number;
  /** The signed marketable-limit buffer, in percent, that the placed order
   *  will carry (MARKETABLE_LIMIT_BUFFER_PCT, positive for a buy and negative
   *  for a short). Supplied so the sizer values the order the way the
   *  GUARDRAIL will — at its limit price, not the raw signal entry. Without
   *  it the two disagreed by the buffer on every order, which is most of the
   *  distance in a $10.84 miss. Omitted (paper, preview) means value at
   *  entryPrice, exactly as before.
   *
   *  Residual drift remains and is deliberate: the real limit comes from a
   *  quote taken at placement, not from signal.entry, so the two prices still
   *  differ by whatever the symbol moved in between. That is what the reserve
   *  below absorbs. */
  limitBufferPct?: number;
  /** Whether this order OPENS exposure or closes it.
   *
   *  Opening consumes buying power and closing frees it — regardless of side.
   *  This used to key on `side`, constraining buys and waving every sell
   *  through as "a sell frees cash". True of closing a long, FALSE of opening a
   *  short: a naked short consumes margin like any other opening order. The
   *  distinction never mattered while liveAllowNakedShort was off, and would
   *  have become live money the moment it was switched on — riskCheck sizes
   *  ENTRIES, so a `sell` reaching it is a short entry, never a close.
   *  Mirrors guardrails.ts, which keys on the same field. */
  openClose: 'open' | 'close';
}

export interface BuyingPowerSizingResult {
  /** Largest fundable whole quantity, or `undefined` for "no constraint". */
  maxQuantity: number | undefined;
  /** The binding dollar bound after the reserve — what `maxQuantity` was
   *  derived from. `undefined` whenever `maxQuantity` is. */
  usableUsd: number | undefined;
  /** Which bound actually bound, for the journal. `undefined` when none did. */
  boundBy?: 'buying_power' | 'order_notional' | 'account_exposure';
}

/**
 * The largest position this account can currently open, in whole units, under
 * EVERY dollar bound the guardrail will apply — buying power, the per-order
 * notional cap, and the room left under the account exposure cap.
 *
 * Returns `undefined` (no constraint) when no bound is known, when the order
 * does not consume any of them, or when the inputs cannot produce a sane
 * number — every one of those falls back to the previous behaviour rather than
 * guessing a cap, because a wrong cap here silently shrinks every order.
 *
 * The tightest bound wins and is reported in `boundBy`, so a shrunk order says
 * WHICH ceiling shrank it rather than leaving that to be inferred.
 */
export function fundableMaxQuantity(input: BuyingPowerSizingInput): BuyingPowerSizingResult {
  const none: BuyingPowerSizingResult = { maxQuantity: undefined, usableUsd: undefined };
  const { buyingPowerUsd, maxOrderUsd, exposureHeadroomUsd, entryPrice, limitBufferPct, openClose } = input;
  if (openClose !== 'open') return none;
  if (!(entryPrice > 0)) return none;

  // Value the order at the price the GUARDRAIL will use: the marketable limit,
  // not the raw entry. A buy's limit sits above the quote, so it makes the
  // order dearer and the fundable size smaller; a short's sits below.
  const valuation = limitBufferPct !== undefined ? entryPrice * (1 + limitBufferPct / 100) : entryPrice;
  if (!(valuation > 0)) return none;

  const reserve = 1 - BUYING_POWER_RESERVE_PCT / 100;
  const bounds: [number | undefined, NonNullable<BuyingPowerSizingResult['boundBy']>][] = [
    [buyingPowerUsd, 'buying_power'],
    [maxOrderUsd, 'order_notional'],
    [exposureHeadroomUsd, 'account_exposure'],
  ];

  let usableUsd: number | undefined;
  let boundBy: BuyingPowerSizingResult['boundBy'];
  for (const [raw, label] of bounds) {
    if (raw === undefined || !Number.isFinite(raw)) continue;
    // Clamped at 0, not skipped: an account already AT its exposure cap has
    // genuinely zero headroom, and treating that as "unknown" would size the
    // order as if the cap did not exist — the very failure being fixed.
    const room = Math.max(0, raw) * reserve;
    if (usableUsd === undefined || room < usableUsd) {
      usableUsd = room;
      boundBy = label;
    }
  }
  if (usableUsd === undefined) return none;

  return { maxQuantity: Math.floor(usableUsd / valuation), usableUsd, boundBy };
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
