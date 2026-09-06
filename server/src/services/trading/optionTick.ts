// ---------------------------------------------------------------------------
// The tick grid an option price has to land on before Webull will accept it.
//
// Webull rejects an option order outright when its price is not an exact
// multiple of the tick for that premium:
//
//   "The limit price increment is not correct. Orders placed with a premium of
//    less than $3 must be in increments of 0.05."
//
// That message is quoted from our own journal, not from a doc. It is what
// killed the only live options position this app has ever taken. SRAD opened
// 2026-08-03 at a 1.05 limit — a nickel multiple by luck — and then could not
// be closed: three exit attempts on 08-04 were rejected with that exact string,
// the position sat unmanaged for seventeen days, and on 08-21 the broker sync
// noticed it was simply gone and booked -$87 from an ESTIMATED price rather
// than a confirmed fill. Every price site in the live options path rounded to
// the cent, and priceStr() in orders.ts — the backstop that exists precisely so
// a tick-size rejection cannot reach the broker — rounds to the cent too,
// because it was written for equities, where the cent IS the grid.
//
// This is not historical. liveOptionsEnabled was re-armed 2026-09-04, and with
// optionsMaxDte 2 and a premium ceiling near $0.93 EVERY live options order is
// under $3 and therefore on the nickel grid. Seven of the thirteen options
// exit prices the paper book has produced to date (0.73, 1.06, 0.71, 0.89,
// 0.64, 0.43, 0.23) are not nickel multiples — each of those is an exit the
// broker would have refused, on a contract with at most two days to live.
//
// DIRECTION. Rounding has to preserve the intent of the marketable buffer the
// caller already applied: a BUY limit rounds UP and a SELL limit rounds DOWN,
// so snapping to the grid can only ever make an order MORE likely to fill,
// never less. The concession is bounded by one tick — at most $4 on a
// one-contract order — against the alternative that this bug already produced
// once, which was the whole position.
//
// The $0.05 grid is a subset of the $0.01 grid, so a price rounded here is
// accepted whether or not the contract's class is penny-quoted. Being wrong
// about which grid applies costs at most a tick of price; being wrong the other
// way costs the order.
// ---------------------------------------------------------------------------

/** Premium at/above which options quote in pennies rather than nickels. */
export const OPTION_PENNY_THRESHOLD_USD = 3;

/** The tick a premium of this size has to sit on. */
export function optionTickUsd(price: number): number {
  return Math.abs(price) < OPTION_PENNY_THRESHOLD_USD ? 0.05 : 0.01;
}

/** Which way to snap. 'up' for a BUY limit, 'down' for a SELL limit — always
 *  toward filling, never away from it. */
export type OptionTickDirection = 'up' | 'down';

/** `direction` for an order side, so no call site has to remember the mapping. */
export function tickDirectionForSide(side: 'buy' | 'sell'): OptionTickDirection {
  return side === 'buy' ? 'up' : 'down';
}

/**
 * `price` snapped onto the tick grid for its own size.
 *
 * TWO STAGES, and the split is the point:
 *
 *   1. Round to the nearest CENT. This is float hygiene, identical to what
 *      priceStr() has always done — 98.14816 is a broker-derived number with
 *      sub-cent noise, not an economic choice, and nudging it directionally
 *      would be inventing a price nobody asked for.
 *   2. Only if the tick is a NICKEL, snap directionally onto it. That step IS
 *      an economic choice — up to four cents of price — so it goes toward
 *      filling and never away.
 *
 * So at or above $3, where the cent already IS the grid, this function is
 * exactly the old cent rounding and every existing body is byte-identical.
 * Below $3 it is the fix.
 *
 * Non-finite input is passed through untouched: this function's job is the
 * grid, and the callers already have a validPremium() guard whose job is
 * rejecting a price that is not a number.
 */
export function roundOptionPrice(price: number, direction: OptionTickDirection): number {
  if (!Number.isFinite(price)) return price;
  const cents = Math.round(price * 100); // exact integer from here on — no epsilon needed
  const step = optionTickUsd(cents / 100) * 100; // in cents: 5 or 1
  if (step === 1) return cents / 100;
  const steps = direction === 'up' ? Math.ceil(cents / step) : Math.floor(cents / step);
  return Number(((steps * step) / 100).toFixed(2));
}

/** True when `price` is already an exact multiple of its own tick — the
 *  property the broker actually checks. */
export function isOnOptionTick(price: number): boolean {
  if (!Number.isFinite(price)) return false;
  const cents = Math.round(price * 100);
  const step = optionTickUsd(cents / 100) * 100;
  return cents % step === 0;
}
