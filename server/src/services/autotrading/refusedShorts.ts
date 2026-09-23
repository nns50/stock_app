// ---------------------------------------------------------------------------
// Shorts the BROKER refused today, per symbol (2026-09-23, shorts pre-flight).
//
// A live short can be refused for reasons no setting here can see: the stock is
// hard to borrow, no locate is available, or it is under the short-sale
// restriction (Rule 201, a stock down 10% or more on the day, where a short may
// not sell at or below the bid). The screener's short score rewards a negative
// gap and change, so the names it ranks highest as shorts are exactly the ones
// the restriction lands on.
//
// Before this, a refused short was forgotten. The intent ended `rejected`, which
// neither holds the symbol against a duplicate nor counts toward the day's
// order cap, so the next tick re-screened the name, fetched a quote, read the
// account twice and sent the same order again, every minute, until the signal
// went away. It also wrote an entry-extension row each time for an order that
// never existed.
//
// So a definite refusal of a short (never an unanswered one, which may have
// gone through) holds that symbol's SHORTS for the rest of the ET day. A long in
// the same name is not held: a borrow or the short-sale rule says nothing about
// buying it. In-memory like unplaceableSymbols.ts: a restart forgets it, which
// costs one more refused order, and the next day starts clean because a borrow
// or the restriction can lift overnight.
// ---------------------------------------------------------------------------

const refused = new Map<string, { day: string; reason: string }>();

/** Record that the broker refused a short in `symbol` on ET day `day`. */
export function markShortRefused(symbol: string, day: string, reason: string): void {
  refused.set(symbol.trim().toUpperCase(), { day, reason });
}

/** The broker's reason when a short in `symbol` was refused on `day`, else
 *  undefined. A refusal from an earlier day holds nothing. */
export function shortRefusedReason(symbol: string, day: string): string | undefined {
  const hit = refused.get(symbol.trim().toUpperCase());
  return hit && hit.day === day ? hit.reason : undefined;
}

/** Test hook: the map is module state. */
export function resetRefusedShorts(): void {
  refused.clear();
}
