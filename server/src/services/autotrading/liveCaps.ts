// ---------------------------------------------------------------------------
// Suggested starting values for autotrade's live-only guardrail caps (Phase 8
// Step A — docs/AUTOTRADING_SPEC.md's "Phase 8 live-order caps" resolved
// decision). Pure and equity/profile-derived rather than fixed numbers copied
// from the human Trade page, so a suggestion scales sensibly with account
// size instead of being an arbitrary figure disconnected from it. A pure
// suggestion only — the UI (Phase 8 Step D) offers it as a starting point;
// the stored config fields remain freely editable afterward.
// ---------------------------------------------------------------------------

import { maxOrderEquityFractionFor, liveOrderCapForTrades } from './targetTune';

export interface SuggestedLiveCaps {
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
}

/**
 * `liveMaxOrderUsd` — a fraction of equity as a single-order notional backstop.
 * This is deliberately generous: the risk engine's own %-risk-per-trade sizing
 * (computeRiskSizing, stop-distance-based) is the PRIMARY size control, so
 * this cap only needs to catch a sizing bug producing something absurd, not
 * fine-tune ordinary position sizes. The fraction comes from targetTune's own
 * band table (maxOrderEquityFractionFor) rather than a flat 0.25 of its own, so
 * clicking "Suggest from equity" after a tune can't silently replace the tune's
 * order cap with a different number.
 *
 * `liveMaxDailyLossUsd` — set to exactly match the caller's current
 * maxDailyDrawdownPct (an AutotradeConfig field — see riskCheck.ts and
 * db/autotradeConfig.ts; no longer derived from a risk-profile preset table,
 * since it moved to being directly user-configured 2026-07-10), rather than
 * an independently-guessed second number. The risk engine (riskCheck.ts)
 * already hard-blocks on it; having the guardrail layer agree exactly means
 * it's a redundant, independently-coded confirmation of the same limit, not a
 * second opinion that could conflict with the first (mirrors
 * optionStrategy.ts's analyzeStrategy() acting as a structural backstop
 * rather than a competing rule).
 *
 * `liveMaxOrdersPerDay` — maxTradesPerDay through targetTune's
 * liveOrderCapForTrades(), NOT maxTradesPerDay itself. maxTradesPerDay counts
 * ENTRIES; this cap counts every submitted intent, exits included, so the two
 * are not the same number and setting them equal made exits eat the entry
 * budget. See liveOrderCapForTrades' own comment for what that cost in
 * production. Shared with the tuner for the same reason liveMaxOrderUsd is:
 * clicking "Suggest from equity" after a tune must not silently replace the
 * tune's cap with a different one.
 */
export function suggestLiveCaps(
  equityUsd: number,
  maxDailyDrawdownPct: number,
  maxTradesPerDay: number,
  riskProfile: 'MODERATE' | 'AGGRESSIVE' = 'MODERATE',
): SuggestedLiveCaps {
  return {
    liveMaxOrderUsd: Math.round(equityUsd * maxOrderEquityFractionFor(riskProfile)),
    liveMaxDailyLossUsd: Math.round(equityUsd * (maxDailyDrawdownPct / 100)),
    liveMaxOrdersPerDay: liveOrderCapForTrades(maxTradesPerDay),
  };
}
