import { webullConfigured } from '../../providers/webull/account';
import { webullOptionQuotes } from '../../providers/webull/optionQuotes';
import { optionTickUsd, roundOptionPrice, validPremium } from '../trading/optionTick';

// ---------------------------------------------------------------------------
// What an options ORDER can be filled at — the sell side for a close, the buy
// side for an entry — and where the quote comes from. Shared by both books.
//
// THE SELL SIDE (2026-09-17). These helpers lived in liveOptionsExecute.ts,
// and the paper book priced its exits nowhere near them: it filled at the
// chain's midpoint, instantly, on the tick a rule fired. Over 26 paper trades
// that read +16.4% of premium per trade; priced the way this file prices a
// real order it reads +10.6%, and +8.5% without the one fill that is provably
// fictional — HOOD on 2026-09-11, booked at a 1.48 mark that the live order
// at 1.40 never got. The take-profit level and the second live slot were both
// decided on the +16.4% figure.
//
// THE BUY SIDE (2026-09-18). Entries had the mirror-image defect: both books
// re-fetched the contract from the Yahoo-sourced chain — ~15 MINUTES delayed —
// and built the buy limit from its MIDPOINT plus 5%, while the account carried
// a real-time OPRA entitlement that only the exits read. On a 0DTE contract a
// quarter of an hour is the difference between a limit that fills and one that
// rests under a market that has already left, and the sizer's premium (the
// risk) was that same stale midpoint. So an entry now resolves the contract
// through the same OPRA-first resolver the exits use and is priced from the
// ASK — what a buyer actually pays — with the buffered mark only as the
// fallback when no two-sided quote exists.
//
// So the pricing is one module and two callers per side. CLAUDE.md's rule: two
// places that derive the same quantity must agree by construction, and the way
// to guarantee that is for neither of them to derive it. This file imports
// only leaves (the tick grid, the two Webull read-only providers); the chain
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

/** How old an OPRA snapshot may be and still price an order, either side. The
 *  chain both books have always priced from is Yahoo-sourced and ~15 MINUTES
 *  delayed (providers/webull/optionQuotes.ts, docs/USER_GUIDE.md); on a 0DTE
 *  contract that is the difference between a limit that fills and one that
 *  rests on the wrong side of a market which has already left. Two minutes is
 *  generous for a snapshot that refreshes on a 4-second cache and strict enough
 *  that a frozen feed falls back to the chain rather than pricing off a stale
 *  quote. */
export const CONTRACT_QUOTE_MAX_AGE_MS = 120_000;
/** The sell side's original name for the same constant — kept so nothing that
 *  reads it has to move. */
export const EXIT_QUOTE_MAX_AGE_MS = CONTRACT_QUOTE_MAX_AGE_MS;

/** The one freshness rule for an OPRA print, shared by the order resolver
 *  below and the contract-selection overlay (optionsSelectionQuotes.ts,
 *  2026-09-19): two-sided, finite, and no older than CONTRACT_QUOTE_MAX_AGE_MS.
 *  A print without a timestamp is taken as current — the snapshot route omits
 *  `quote_time` only on a live row — and `ageMs` is undefined for it. One
 *  function so selection and pricing cannot disagree about what "fresh" means. */
export function freshTwoSidedPrint(
  q: { bid?: number; ask?: number; quoteTime?: number } | undefined,
  now: number,
  maxAgeMs: number = CONTRACT_QUOTE_MAX_AGE_MS,
): { usable: boolean; ageMs?: number } {
  if (!q) return { usable: false };
  const ageMs = q.quoteTime === undefined ? undefined : Math.max(0, now - q.quoteTime);
  const fresh = ageMs === undefined || ageMs <= maxAgeMs;
  const twoSided = q.bid !== undefined && q.ask !== undefined && Number.isFinite(q.bid) && Number.isFinite(q.ask);
  return { usable: fresh && twoSided, ageMs };
}

/** The freshest two-sided quote for one contract, and where it came from.
 *  `mark` keeps the midpoint the exit LADDER evaluates (its rule levels are
 *  defined on the mark and must not move); `bid` is what a CLOSE is priced at
 *  and `ask` what an ENTRY is priced at — the three are deliberately separate. */
export interface ResolvedContractQuote {
  bid?: number;
  ask?: number;
  mark: number;
  fromLastTrade: boolean;
  source: 'opra' | 'chain';
  quoteAgeMs?: number;
}
/** The sell side's original name for the same shape. */
export type ResolvedExitQuote = ResolvedContractQuote;

export type ExitPriceBasis = 'bid' | 'mark' | 'last';

/** Which price an ENTRY was built from: the ask a buyer actually pays, the
 *  buffered midpoint when the quote had no ask, or a last trade when that was
 *  all the paper book had (the live book refuses to open on one). */
export type EntryPriceBasis = 'ask' | 'mark' | 'last';

export interface BuyableEntryLimit {
  /** The marketable buy limit, on the tick grid; 0 when nothing was priceable
   *  and the caller must refuse. */
  limitPrice: number;
  /** The premium the order is expected to FILL at — the ask itself, or the
   *  mark when no ask was quoted. The sizer's risk and the fat-finger reference
   *  read THIS; the limit above it only guarantees the fill and is never what
   *  the contract is expected to cost. The paper book fills here. */
  fillPremium: number;
  basis: EntryPriceBasis;
}

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
 * A raw buy price snapped onto the option tick grid — the ONE place an entry
 * limit is rounded, shared by the single-leg and spread helpers below for the
 * same reason sellLimitFromRaw is the one place a close is rounded. Rounded UP
 * because this is a buy: snapping to the grid may only make the entry more
 * likely to fill. A raw price that is not a real premium (zero, negative,
 * non-finite) returns an unplaceable 0, which the caller refuses — an entry
 * is optional, so unlike the sell side nothing is clamped to a tick here.
 */
function buyLimitFromRaw(raw: number): number {
  if (!validPremium(raw)) return 0;
  return roundOptionPrice(raw, 'up');
}

/**
 * The limit price a buy-to-open goes out at, and the premium it is expected
 * to fill at.
 *
 * ASK FIRST. The ask is where the contract can actually be bought; the
 * midpoint is an average of that and a price nobody is offering to pay. The
 * buffer goes on top of the ask so a quote that ticks up between the snapshot
 * and the order still fills — a limit fills at the best price available, so
 * the buffer is never paid unless the market itself moved, exactly as before
 * when it sat on top of a midpoint that was a quarter of an hour old.
 *
 * With no ask, the buffered mark as before (basis `mark`, or `last` when the
 * caller passed a last-trade-only quote through — the paper book's case).
 *
 * Pure, and exported for its own tests.
 */
export function buyableEntryLimit(q: { ask?: number; mark: number; fromLastTrade: boolean }): BuyableEntryLimit {
  const useAsk = q.ask !== undefined && validPremium(q.ask);
  const fillPremium = useAsk ? q.ask! : q.mark;
  const raw = fillPremium * (1 + OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const basis: EntryPriceBasis = useAsk ? 'ask' : q.fromLastTrade ? 'last' : 'mark';
  return { limitPrice: buyLimitFromRaw(raw), fillPremium, basis };
}

/** The spread twin: buy the long leg at its ask, sell the short leg at its
 *  bid — the net debit a vertical can actually be opened for. Falls back to
 *  the buffered net mark. A net that is not a debit (short at or above the
 *  long) returns an unplaceable limit and the caller refuses, as before. */
export function buyableSpreadEntryLimit(q: {
  longAsk?: number;
  shortBid?: number;
  longMark: number;
  shortMark: number;
  fromLastTrade: boolean;
}): BuyableEntryLimit {
  const useAsk =
    q.longAsk !== undefined && q.shortBid !== undefined && validPremium(q.longAsk) && validPremium(q.shortBid);
  const fillPremium = useAsk ? q.longAsk! - q.shortBid! : q.longMark - q.shortMark;
  const raw = fillPremium * (1 + OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  const basis: EntryPriceBasis = useAsk ? 'ask' : q.fromLastTrade ? 'last' : 'mark';
  return { limitPrice: fillPremium > 0 ? buyLimitFromRaw(raw) : 0, fillPremium, basis };
}

/**
 * The freshest quote available for one contract: the real-time OPRA snapshot
 * when this account carries the entitlement and the print is recent, else the
 * caller's delayed chain. One resolver for both sides of an order — an entry
 * reads its ask, a close reads its bid, the ladder reads its mark.
 *
 * Never throws on the OPRA leg (webullOptionQuotes is read-only and returns
 * `ok: false` rather than raising); the chain leg keeps whatever throw the
 * caller's fetch has, so a total quote failure still journals through the
 * caller's catch.
 */
export async function resolveContractQuote(
  contractSymbol: string | null,
  chainFallback: () => Promise<ChainQuote>,
  now: number = Date.now(),
): Promise<ResolvedContractQuote> {
  if (contractSymbol && webullConfigured()) {
    const snap = await webullOptionQuotes([contractSymbol]);
    const q = snap.ok ? snap.quotes[0] : undefined;
    const print = freshTwoSidedPrint(q, now);
    if (q && print.usable && q.bid !== undefined && q.ask !== undefined) {
      return {
        bid: q.bid,
        ask: q.ask,
        mark: (q.bid + q.ask) / 2,
        fromLastTrade: false,
        source: 'opra',
        quoteAgeMs: print.ageMs,
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

/** The sell side's original name for the resolver — the exits call it this. */
export const resolveExitQuote = resolveContractQuote;
