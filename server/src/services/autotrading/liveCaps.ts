import { RiskProfileName } from '../../db/autotradeConfig';
import { RISK_PROFILES } from './riskProfiles';

// ---------------------------------------------------------------------------
// Suggested starting values for autotrade's live-only guardrail caps (Phase 8
// Step A — docs/AUTOTRADING_SPEC.md's "Phase 8 live-order caps" resolved
// decision). Pure and equity/profile-derived rather than fixed numbers copied
// from the human Trade page, so a suggestion scales sensibly with account
// size instead of being an arbitrary figure disconnected from it. A pure
// suggestion only — the UI (Phase 8 Step D) offers it as a starting point;
// the stored config fields remain freely editable afterward.
// ---------------------------------------------------------------------------

export interface SuggestedLiveCaps {
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
}

/**
 * `liveMaxOrderUsd` — 25% of equity as a single-order notional backstop. This
 * is deliberately generous: the risk engine's own %-risk-per-trade sizing
 * (computeRiskSizing, stop-distance-based) is the PRIMARY size control, so
 * this cap only needs to catch a sizing bug producing something absurd, not
 * fine-tune ordinary position sizes.
 *
 * `liveMaxDailyLossUsd` / `liveMaxOrdersPerDay` — set to exactly match the
 * active risk profile's own daily-drawdown-halt % and maxTradesPerDay, rather
 * than an independently-guessed second number. The risk engine (riskCheck.ts)
 * already hard-blocks on both; having the guardrail layer agree exactly means
 * it's a redundant, independently-coded confirmation of the same limit, not a
 * second opinion that could conflict with the first (mirrors optionStrategy.ts's
 * analyzeStrategy() acting as a structural backstop rather than a competing rule).
 */
export function suggestLiveCaps(equityUsd: number, profile: RiskProfileName): SuggestedLiveCaps {
  const params = RISK_PROFILES[profile];
  return {
    liveMaxOrderUsd: Math.round(equityUsd * 0.25),
    liveMaxDailyLossUsd: Math.round(equityUsd * (params.maxDailyDrawdownPct / 100)),
    liveMaxOrdersPerDay: params.maxTradesPerDay,
  };
}
