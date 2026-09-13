// ---------------------------------------------------------------------------
// What an entry ACTUALLY risks, derived once (2026-09-13).
//
// The sizer and the placer disagreed about the entry price, and the gap was
// real money. `riskCheck` sizes from `signal.entry` — the price the screen saw
// when it decided — and `placeOneLiveEntry` then fetches a FRESH quote several
// seconds later and prices a marketable limit through it. Nothing revisited the
// quantity in between, and the order row recorded `approvedRiskAmount`, which
// is that same stale `|signal.entry - signal.stop| x quantity`. The bracket's
// stop is placed at `signal.stop` either way, so every cent of drift between
// the two prices lands on the position as extra risk.
//
// It is one-sided, and the buffer is why: a marketable BUY limit sits ABOVE
// the quote and fills at or inside it, so a long's fill is never meaningfully
// below the price the stop was anchored to. Drift the other way costs nothing
// (the position simply risks less); drift this way is unbudgeted.
//
// Measured on the seven live rows carrying `plannedStopDistancePct` (the
// 2026-09-11 forensics column, capture-only until now), realized risk over
// planned risk:
//
//   MRNA 1.003   ACVA 1.000   HPQ 1.011   TNON 1.083
//   SWKS 1.456   DELL 1.054   MRNA 1.049      mean 1.094, and not one below 1
//
// SWKS filled 1.19% above the price its stop was hung from, so a trade sized
// for 2.5% of equity risked 3.64% of it. At the trial sizing that is most of
// the distance to a fourth of the daily halt on a single position.
//
// Two OTHER paths in liveExecute.ts had this right already — the scale-in
// add-on and the per-lot second lot both compute `|limitPrice - stop| x qty`
// — so this was three derivations of one quantity with the main entry path as
// the odd one out. CLAUDE.md's rule is that they agree BY CONSTRUCTION, which
// is what this module is for: all three now call `orderRiskAmount`, and the
// entry path sizes with `riskCappedQuantity` against the same limit price it
// is about to send.
//
// What this does NOT change: the stop, the target, and the R the book reports.
// `initialRiskOf` already measures R from the FILL, so the recorded edge was
// never flattered by this — only the size was. Re-anchoring the stop or the
// target to the fill would move exits, which is a trading decision and not a
// bug fix.
// ---------------------------------------------------------------------------

/**
 * WHICH PRICE RISK IS MEASURED AT, and why it is not the one the guardrail
 * uses.
 *
 * `guardrails.ts` values an order's NOTIONAL at its limit, because that is
 * what the broker reserves: a limit order can consume every cent of its own
 * limit. RISK is realized at the FILL, and a marketable limit fills at or
 * inside itself — on this book, 0.05% of the 0.5% buffer was consumed on
 * average (marketableLimit.ts's `meanBufferConsumedPct`, read 2026-09-12), so
 * fills land essentially at the quote.
 *
 * So the quote is the unbiased estimate of the fill, and the limit would
 * over-state risk by most of the buffer — at a 2.5% stop that is a fifth of
 * the position, given away on every entry for a fill that does not happen.
 * Two prices, two questions, said out loud here because they look
 * interchangeable and are not.
 */
export function riskBasisPrice(quote: number): number {
  return quote;
}

/**
 * The dollar risk an order of this size at this price against this stop really
 * carries.
 *
 * The single derivation the entry, the scale-in add-on and the per-lot second
 * lot all share. Each names its own price: the entry passes `riskBasisPrice`
 * of the placement quote (see above), while the two add-on paths pass their
 * limit, which is what they have always recorded — a slightly more
 * conservative basis, left alone here because loosening it would ADD exposure
 * and that is not a change this fix is entitled to make.
 */
export function orderRiskAmount(price: number, stopPrice: number, quantity: number): number {
  if (!(price > 0) || !(stopPrice > 0) || !(quantity > 0)) return 0;
  return Math.abs(price - stopPrice) * quantity;
}

/**
 * The largest whole quantity that keeps `orderRiskAmount` inside `budgetUsd`.
 *
 * Returns `undefined` for "no opinion" whenever the inputs cannot produce a
 * sane number — a zero-width or inverted stop, a missing budget — so a caller
 * that takes the MINIMUM of this and its own size degrades to exactly its
 * previous behaviour rather than to zero shares.
 */
export function riskCappedQuantity(price: number, stopPrice: number, budgetUsd: number): number | undefined {
  if (!(price > 0) || !(stopPrice > 0) || !(budgetUsd > 0)) return undefined;
  const perShare = Math.abs(price - stopPrice);
  if (!(perShare > 0)) return undefined;
  return Math.floor(budgetUsd / perShare);
}

/**
 * How far the placement price drifted from the price the sizer used, as a
 * percentage of the sizer's price, SIGNED so the sign means the same thing on
 * both sides: positive is adverse (a buy paying up, a short selling down).
 *
 * Null when either price is unusable.
 */
export function entryDriftPct(signalEntry: number, placementPrice: number, side: 'buy' | 'sell'): number | null {
  if (!(signalEntry > 0) || !(placementPrice > 0)) return null;
  const raw = ((placementPrice - signalEntry) / signalEntry) * 100;
  return Math.round((side === 'buy' ? raw : -raw) * 1000) / 1000;
}

/**
 * Realized risk over planned risk for a position that has already filled: how
 * many times its configured `riskPerTradePct` it actually put at stake.
 *
 * `plannedStopDistancePct` is a percentage of the SIGNAL's entry (the column
 * exists because that price is gone once the fill lands); the realized
 * distance is measured from the FILL, which is what the position truly risks
 * against the stop the bracket carries. 1.0 means the fill landed where the
 * sizer assumed. Null when the row cannot answer.
 */
export function riskInflationFactor(input: {
  fillPrice: number;
  stopPrice: number;
  plannedStopDistancePct: number | null | undefined;
}): number | null {
  const { fillPrice, stopPrice, plannedStopDistancePct: planned } = input;
  if (!(fillPrice > 0) || !(stopPrice > 0)) return null;
  if (planned === null || planned === undefined || !(planned > 0)) return null;
  const realizedPct = (Math.abs(fillPrice - stopPrice) / fillPrice) * 100;
  if (!(realizedPct > 0)) return null;
  return realizedPct / planned;
}
