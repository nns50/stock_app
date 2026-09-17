import { webullConfigured } from '../../providers/webull/account';
import { webullOptionQuotes } from '../../providers/webull/optionQuotes';
import { optionTickUsd, roundOptionPrice, validPremium } from '../trading/optionTick';

// ---------------------------------------------------------------------------
// What an options close can be SOLD at, and where that number comes from —
// shared by both books (2026-09-17).
//
// These helpers lived in liveOptionsExecute.ts, and the paper book priced its
// exits nowhere near them: it filled at the chain's midpoint, instantly, on
// the tick a rule fired. Over 26 paper trades that read +16.4% of premium per
// trade; priced the way this file prices a real order it reads +10.6%, and
// +8.5% without the one fill that is provably fictional — HOOD on 2026-09-11,
// booked at a 1.48 mark that the live order at 1.40 never got. The take-profit
// level and the second live slot were both decided on the +16.4% figure.
//
// So the pricing is one module and two callers. CLAUDE.md's rule: two places
// that derive the same quantity must agree by construction, and the way to
// guarantee that is for neither of them to derive it. This file imports only
// leaves (the tick grid, the two Webull read-only providers); the chain
// fallback each book prefers is passed IN, which is what keeps the paper
// executor out of the live executor's import graph and vice versa.
// ---------------------------------------------------------------------------

/** Options bid/ask spreads run far wider, as a % of premium, than a stock's --
 *  a low-dollar OTM contract can have a spread that's already 5-10% of its
 *  own mark. Equity's own live path (MARKETABLE_LIMIT_BUFFER_PCT, 0.5%) would
 *  routinely miss a fill here, so this is 10x more generous -- while still
 *  comfortably under the default liveOptionsFatFingerPct (10%) so a fresh
 *  quote doesn't trip the guardrail that's meant to catch a STALE one. Used
 *  for BOTH entries (price above the mark to guarantee a buy) and exits
 *  (price below the mark to guarantee a sell). */
export const OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT = 5;

/** How old an OPRA snapshot may be and still price a close. The chain both
 *  books have always priced from is Yahoo-sourced and ~15 MINUTES delayed
 *  (providers/webull/optionQuotes.ts, docs/USER_GUIDE.md); on a 0DTE contract
 *  that is the difference between a sell limit that fills and one that rests
 *  above a market which has already left. Two minutes is generous for a
 *  snapshot that refreshes on a 4-second cache and strict enough that a frozen
 *  feed falls back to the chain rather than pricing off a stale bid. */
export const EXIT_QUOTE_MAX_AGE_MS = 120_000;

/** What a close can be sold at right now, and where the number came from.
 *  `mark` keeps the midpoint the exit LADDER evaluates (its rule levels are
 *  defined on the mark and must not move), while `bid` is what the ORDER is
 *  priced at — the two are deliberately separate. */
export interface ResolvedExitQuote {
  bid?: number;
  ask?: number;
  mark: number;
  fromLastTrade: boolean;
  source: 'opra' | 'chain';
  quoteAgeMs?: number;
}

export type ExitPriceBasis = 'bid' | 'mark' | 'last';

export interface SellableExitLimit {
  limitPrice: number;
  basis: ExitPriceBasis;
  /** True when the raw price rounded off the bottom of the tick grid and was
   *  clamped UP to one tick rather than refused. */
  clampedToTick: boolean;
}

/** The shape of a chain quote a caller falls back to — structurally what
 *  optionsExecute.ts's fetchContractQuote returns, declared here so this
 *  module needs nothing from it. */
export interface ChainQuote {
  price: number;
  fromLastTrade: boolean;
  bid?: number;
  ask?: number;
}

/**
 * A raw sell price snapped onto the option tick grid — the ONE place a closing
 * limit is rounded, shared by the single-leg and spread helpers below so the
 * two cannot disagree about what is placeable (optionTick.ts's own source-scan
 * guard exists to keep it that way).
 *
 * Rounded DOWN because this is a sell: snapping to the grid may only make the
 * close more likely to fill. A price that rounds off the bottom of the grid is
 * floored at one TICK rather than refused — see sellableExitLimit for why. A
 * raw price that is not a real quote (zero, negative, non-finite) has nothing
 * to clamp and returns an unplaceable 0, which the caller refuses.
 */
function sellLimitFromRaw(raw: number): { limitPrice: number; clampedToTick: boolean } {
  if (!validPremium(raw)) return { limitPrice: 0, clampedToTick: false };
  const rounded = roundOptionPrice(raw, 'down');
  if (validPremium(rounded)) return { limitPrice: rounded, clampedToTick: false };
  return { limitPrice: optionTickUsd(raw), clampedToTick: true };
}

/**
 * The limit price a sell-to-close goes out at.
 *
 * BID FIRST. A resting bid is where the contract can actually be sold; the
 * midpoint is an average of a price nobody is offering and one nobody is
 * bidding. Pricing 5% under a midpoint fails in exactly the case that matters:
 * on 2026-09-11 a HOOD 0DTE call was up 64%, the ladder said take the profit,
 * the close went out at 1.40 (5% under a 1.47 mark), and it never filled. The
 * contract expired worthless. The bid is the fix.
 *
 * THE TICK CLAMP. `roundOptionPrice` rounds a sell DOWN, so any price under
 * half a tick rounds to zero — and a zero limit was refused outright, every
 * tick, for hours ("No usable exit quote (mark 0.03) — below the $0.05 option
 * tick"). A contract worth three cents still has a nickel bid often enough to
 * matter, and an order at one tick either fills or is refused by the broker
 * once. Both are better than never trying. So a price that rounds off the
 * bottom of the grid is floored at one tick.
 *
 * The clamp needs a REAL price to clamp. A contract that marks at exactly 0,
 * or has no quote at all, is not worth one tick — it is unquoted, and there is
 * nothing to price off. Those return an invalid limit and the caller refuses,
 * leaving the position to the expiry sweep. That distinction is the whole
 * difference between the two neighbouring cases in the tests.
 *
 * Pure, and exported for its own tests.
 */
export function sellableExitLimit(q: { bid?: number; mark: number; fromLastTrade: boolean }): SellableExitLimit {
  const useBid = q.bid !== undefined && validPremium(q.bid);
  const raw = useBid ? q.bid! : q.mark * (1 - OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const basis: ExitPriceBasis = useBid ? 'bid' : q.fromLastTrade ? 'last' : 'mark';
  return { ...sellLimitFromRaw(raw), basis };
}

/** The spread twin: sell the long leg into its bid, buy the short leg back at
 *  its ask — the net a spread can actually be closed at. Falls back to the
 *  buffered net mark, and clamps a tiny-but-real net to one tick the same way.
 *  A CROSSED quote (short leg at or above the long) is a broken quote rather
 *  than a spread worth one tick, so it returns an invalid limit and the caller
 *  refuses, exactly as before. */
export function sellableSpreadExitLimit(q: {
  longBid?: number;
  shortAsk?: number;
  longMark: number;
  shortMark: number;
  fromLastTrade: boolean;
}): SellableExitLimit {
  const useBid = q.longBid !== undefined && q.shortAsk !== undefined && validPremium(q.longBid - q.shortAsk);
  const raw = useBid
    ? q.longBid! - q.shortAsk!
    : (q.longMark - q.shortMark) * (1 - OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const basis: ExitPriceBasis = useBid ? 'bid' : q.fromLastTrade ? 'last' : 'mark';
  return { ...sellLimitFromRaw(raw), basis };
}

/**
 * The freshest quote available for one contract: the real-time OPRA snapshot
 * when this account carries the entitlement and the print is recent, else the
 * caller's delayed chain.
 *
 * Never throws on the OPRA leg (webullOptionQuotes is read-only and returns
 * `ok: false` rather than raising); the chain leg keeps whatever throw the
 * caller's fetch has, so a total quote failure still journals through the
 * caller's catch.
 */
export async function resolveExitQuote(
  contractSymbol: string | null,
  chainFallback: () => Promise<ChainQuote>,
  now: number = Date.now(),
): Promise<ResolvedExitQuote> {
  if (contractSymbol && webullConfigured()) {
    const snap = await webullOptionQuotes([contractSymbol]);
    const q = snap.ok ? snap.quotes[0] : undefined;
    const ageMs = q?.quoteTime === undefined ? undefined : Math.max(0, now - q.quoteTime);
    const fresh = ageMs === undefined || ageMs <= EXIT_QUOTE_MAX_AGE_MS;
    if (q && fresh && q.bid !== undefined && q.ask !== undefined && Number.isFinite(q.bid) && Number.isFinite(q.ask)) {
      return {
        bid: q.bid,
        ask: q.ask,
        mark: (q.bid + q.ask) / 2,
        fromLastTrade: false,
        source: 'opra',
        quoteAgeMs: ageMs,
      };
    }
  }
  const chain = await chainFallback();
  return {
    bid: chain.bid,
    ask: chain.ask,
    mark: chain.price,
    fromLastTrade: chain.fromLastTrade,
    source: 'chain',
  };
}
