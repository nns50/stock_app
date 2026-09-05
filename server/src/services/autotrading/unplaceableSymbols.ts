// ---------------------------------------------------------------------------
// Symbols the BROKER cannot trade, learned from the broker (2026-09-05).
//
// Webull's market-data side and its trading side do not accept the same
// symbols. `BF.B` and `BRK.B` quote perfectly — verified live: BRK.B came back
// at 506.03 with a full book — so they screen, score, pass every filter, get
// risk-checked and reach placement. The order API then refuses them outright:
//
//   Parameter error, invalid market,symbol,instrument_type, value: US,BF.B,EQUITY
//
// Both are in the 528-name universe today, and that happened 18 times in July.
// Each attempt costs a full pipeline plus a broker round-trip, and creates an
// order intent — so it also spends one of the day's maxOrdersPerDay allowance
// on a trade that could never happen.
//
// WHY THIS IS LEARNED RATHER THAN PRE-FILTERED. The obvious fix is to rewrite
// `BF.B` into whatever Webull wants. The vendor docs do not say: the instrument
// endpoints show only AAPL and TSLA, and nothing documents class shares. The
// candidates are BF-B, BF/B and BFB, and guessing wrong does not fail safely —
// it could place a real order for a DIFFERENT instrument. So this records what
// the broker actually said and stops asking, rather than inventing a mapping.
//
// IN-MEMORY, per process, deliberately. Re-learning after a deploy costs one
// refused order, which is the same price the first discovery costs; that is
// cheaper than a schema and a migration, and it means a symbol that Webull
// starts supporting is picked up again on the next restart rather than being
// blocklisted forever by a row nobody remembers writing.
// ---------------------------------------------------------------------------

const unplaceable = new Map<string, string>();

/** Does this broker rejection name THIS symbol as unparseable?
 *
 *  Deliberately narrow. A generic "Parameter error" is not enough — the symbol
 *  itself has to appear in the message, which Webull's own text does
 *  ("value: US,BF.B,EQUITY"). Without that, one malformed unrelated field
 *  would blocklist a perfectly tradable name. */
export function isUnparseableSymbolError(symbol: string, error: string | undefined): boolean {
  if (!error) return false;
  const s = symbol.trim().toUpperCase();
  if (s === '') return false;
  const e = error.toUpperCase();
  return /INVALID MARKET,\s*SYMBOL/.test(e) && e.includes(s);
}

/** Record that the broker cannot parse this symbol. */
export function markUnplaceableSymbol(symbol: string, reason: string): void {
  unplaceable.set(symbol.trim().toUpperCase(), reason);
}

/** The recorded reason, or undefined when the symbol is fine as far as we know. */
export function unplaceableReason(symbol: string): string | undefined {
  return unplaceable.get(symbol.trim().toUpperCase());
}

/** Everything learned so far, for the journal and for tests. */
export function listUnplaceableSymbols(): { symbol: string; reason: string }[] {
  return [...unplaceable.entries()].map(([symbol, reason]) => ({ symbol, reason }));
}

/** Test hook — the map is module state, so suites must be able to clear it. */
export function resetUnplaceableSymbols(): void {
  unplaceable.clear();
}
