// ---------------------------------------------------------------------------
// The marketable-limit buffer, in ONE place (2026-09-12).
//
// Every live equity order is a LIMIT priced through the quote by this much —
// buys above, sells below — so it behaves like a market order without ever
// being one. A limit order therefore fills at or INSIDE its own limit, which
// makes the sign of `services/slippage.ts`'s `pct` (fill measured against the
// limit) structurally negative: it can be 0 at worst and about −buffer at
// best.
//
// That is why the number needs this constant to be read at all, and why the
// constant cannot stay private to liveExecute.ts. The playbook carried a
// pre-committed rule — "mean entry slippage above 0.5% is an execution
// finding" — against a quantity that can never be positive, so the rule could
// not fire on any book, ever. It read as a live check for two weeks.
//
// With the buffer in hand the same rows answer the question the rule was
// actually asking: how much of the buffer did the fills PAY AWAY?
//
//   consumed = buffer + pct      (pct <= 0)
//
// 0 means every fill landed at the quote and the buffer bought its
// marketability for nothing; `buffer` means every fill landed at the limit and
// the whole concession was paid. Slightly UNDER-states the concession, because
// `pct` divides by the limit rather than by the quote it was derived from —
// a quarter of a basis point at a 0.5% buffer, named here rather than papered
// over with a correction the stored rows cannot support (the quote at
// placement is not persisted).
// ---------------------------------------------------------------------------

/** How far through the quote a live equity order is priced, in percent.
 *  Applied positive for a buy and negative for a sell. */
export const MARKETABLE_LIMIT_BUFFER_PCT = 0.5;

/** The share of the buffer the fills paid away, from slippage rows measured
 *  against the limit. Null when there is nothing to average. */
export function meanBufferConsumedPct(entrySlippagePct: number[], bufferPct: number): number | null {
  if (entrySlippagePct.length === 0) return null;
  const mean = entrySlippagePct.reduce((s, p) => s + p, 0) / entrySlippagePct.length;
  return Math.round((bufferPct + mean) * 100) / 100;
}
