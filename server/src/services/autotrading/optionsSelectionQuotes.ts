import { OptionContract, OptionsChain } from '../../providers/types';
import { OPTION_QUOTES_MAX_SYMBOLS, OptionQuote, webullOptionQuotes } from '../../providers/webull/optionQuotes';
import { CONTRACT_QUOTE_MAX_AGE_MS, freshTwoSidedPrint } from './optionsExitPricing';

// ---------------------------------------------------------------------------
// Contract SELECTION on the real-time snapshot (2026-09-19).
//
// PR #628 priced an options ENTRY from the real-time OPRA ask, and the first
// session under it showed why that was half the fix: the contract had still
// been CHOSEN on the Yahoo-sourced chain, ~15 minutes delayed. Every rule in
// options/entryRules.ts — the delta band, the spread filter, the open-interest
// and volume floors, the IV band — and the premium the risk check sizes on read
// the chain's numbers, and on the 0DTE names the sleeve trades those ran 40-70%
// away from the live print (HOOD 0.57 against 0.99, IBM 0.51 against 0.95,
// COIN 0.55 against 1.95 on 2026-09-18). The order paid the live price for a
// contract picked on a stale one.
//
// This overlays the snapshot onto the chain BEFORE the rules run: the nearest-
// the-money contracts of the signal's side (at most the snapshot call's own
// batch cap) are fetched in one call, and each fresh two-sided print replaces
// that contract's bid, ask, mark, volume, open interest, delta and IV. The
// chain stays the list of strikes and the fallback — a stale print, a one-sided
// print, no answer or an error leaves the contract (or the whole chain)
// exactly as it was, so with no OPRA answer the decision is byte-for-byte the
// previous one. No filter level, band or weight lives here. Read-only toward
// the broker and never throws on the OPRA leg.
// ---------------------------------------------------------------------------

export type SelectionQuoteSource = 'opra' | 'chain';

/** What the decision journal says about where the contract's numbers came from. */
export interface SelectionQuoteReport {
  selectionQuoteSource: SelectionQuoteSource;
  /** Contracts whose bid/ask/mark (and greeks, volume, OI when the print
   *  carried them) came from a fresh OPRA print. */
  rePricedContracts: number;
  /** Age of the OLDEST print used, in ms — the staleness bound of the
   *  selection. Null when nothing was re-priced, undefined-age prints (no
   *  timestamp on the row) do not raise it. */
  quoteAgeMs: number | null;
  /** How many contract symbols were sent to the snapshot: the nearest-the-
   *  money set, capped at OPTION_QUOTES_MAX_SYMBOLS. */
  quotesRequested: number;
}

function untouched(quotesRequested: number): SelectionQuoteReport {
  return { selectionQuoteSource: 'chain', rePricedContracts: 0, quoteAgeMs: null, quotesRequested };
}

/**
 * The contracts of one side worth a live print: the `cap` nearest the money.
 * Ordered by distance from the underlying's price when the chain carries it,
 * else by how close the chain's own |delta| sits to 0.50 (at-the-money), else
 * in chain order. Forty strikes around the money cover every delta band the
 * decision uses (long 0.30-0.60, short leg 0.15-0.25) on any listed chain, so
 * no band-dependent selection is needed here — and none that would read the
 * stale delta the overlay exists to replace. Pure; never mutates the chain.
 */
export function selectionCandidates(
  chain: OptionsChain,
  side: 'call' | 'put',
  cap: number = OPTION_QUOTES_MAX_SYMBOLS,
): OptionContract[] {
  const contracts = side === 'call' ? chain.calls : chain.puts;
  if (contracts.length <= cap) return contracts.slice();
  const ref = chain.underlyingPrice;
  const keyed = contracts.map((c, i) => {
    const distance =
      ref !== undefined && ref > 0
        ? Math.abs(c.strike - ref)
        : c.greeks?.delta !== undefined
          ? Math.abs(Math.abs(c.greeks.delta) - 0.5)
          : Number.POSITIVE_INFINITY;
    return { c, i, distance };
  });
  keyed.sort((a, b) => a.distance - b.distance || a.i - b.i);
  return keyed.slice(0, cap).map((k) => k.c);
}

/**
 * Overlay fresh two-sided prints onto contracts, by OCC symbol. A contract
 * with no print, a stale print (older than `maxAgeMs`) or a one-sided print
 * is returned as the same object; a re-priced contract is a NEW object with
 * the print's bid, ask, mark (= midpoint), and — only when the print carries
 * them — last, volume, open interest and greeks (delta, iv, gamma, theta,
 * vega; `computed` cleared, since these are provider-supplied). Pure.
 */
export function overlayLiveQuotes(
  contracts: OptionContract[],
  quotes: OptionQuote[],
  now: number,
  maxAgeMs: number = CONTRACT_QUOTE_MAX_AGE_MS,
): { contracts: OptionContract[]; rePriced: number; oldestAgeMs: number | null } {
  const bySymbol = new Map<string, OptionQuote>();
  for (const q of quotes) if (q.symbol) bySymbol.set(q.symbol.toUpperCase(), q);
  let rePriced = 0;
  let oldestAgeMs: number | null = null;
  const out = contracts.map((c) => {
    const q = bySymbol.get(c.symbol.toUpperCase());
    const print = freshTwoSidedPrint(q, now, maxAgeMs);
    if (!q || !print.usable || q.bid === undefined || q.ask === undefined) return c;
    rePriced += 1;
    if (print.ageMs !== undefined)
      oldestAgeMs = oldestAgeMs === null ? print.ageMs : Math.max(oldestAgeMs, print.ageMs);
    const greeks = { ...(c.greeks ?? {}) };
    if (q.delta !== undefined) greeks.delta = q.delta;
    if (q.iv !== undefined) greeks.iv = q.iv;
    if (q.gamma !== undefined) greeks.gamma = q.gamma;
    if (q.theta !== undefined) greeks.theta = q.theta;
    if (q.vega !== undefined) greeks.vega = q.vega;
    if (q.delta !== undefined || q.iv !== undefined) greeks.computed = false;
    return {
      ...c,
      bid: q.bid,
      ask: q.ask,
      mark: (q.bid + q.ask) / 2,
      ...(q.last !== undefined ? { last: q.last } : {}),
      ...(q.volume !== undefined ? { volume: q.volume } : {}),
      ...(q.openInterest !== undefined ? { openInterest: q.openInterest } : {}),
      greeks,
    };
  });
  return { contracts: out, rePriced, oldestAgeMs };
}

/**
 * The one call the decision makes: fetch the snapshot for the side's nearest-
 * the-money contracts and return the chain with those contracts re-priced,
 * plus the report the journal carries. Returns the SAME chain object, with a
 * 'chain' report, whenever nothing was re-priced — no Webull keys, no OPRA
 * entitlement, an error, or nothing fresh — so the caller's behaviour without
 * a snapshot is exactly what it was before this existed.
 */
export async function overlaySelectionQuotes(
  chain: OptionsChain,
  side: 'call' | 'put',
  now: number = Date.now(),
): Promise<{ chain: OptionsChain; report: SelectionQuoteReport }> {
  const candidates = selectionCandidates(chain, side);
  if (!candidates.length) return { chain, report: untouched(0) };
  let quotes: OptionQuote[];
  try {
    const snap = await webullOptionQuotes(candidates.map((c) => c.symbol));
    if (!snap.ok) return { chain, report: untouched(candidates.length) };
    quotes = snap.quotes;
  } catch {
    return { chain, report: untouched(candidates.length) };
  }
  const sideContracts = side === 'call' ? chain.calls : chain.puts;
  const { contracts, rePriced, oldestAgeMs } = overlayLiveQuotes(sideContracts, quotes, now);
  if (!rePriced) return { chain, report: untouched(candidates.length) };
  return {
    chain: { ...chain, ...(side === 'call' ? { calls: contracts } : { puts: contracts }) },
    report: {
      selectionQuoteSource: 'opra',
      rePricedContracts: rePriced,
      quoteAgeMs: oldestAgeMs,
      quotesRequested: candidates.length,
    },
  };
}
