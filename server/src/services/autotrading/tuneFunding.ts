import { AutotradeConfig } from '../../db/autotradeConfig';
import { webullAccountState } from '../../providers/webull/accountState';

/**
 * Best-effort live buying power for the tune's dollar caps.
 *
 * deriveDollarCaps has bounded its per-order caps by buying power since
 * 2026-08-27, but NOTHING EVER PASSED IT: its only production caller is the
 * /tune/preview route, and that route omitted the argument, so the bound was
 * plumbed and dead — the exact "shipped, validated, displayed, and never read"
 * failure CLAUDE.md's three-guard section is about, one layer down from config.
 * This module exists so the wiring itself is testable: a helper living inside
 * the route would have left the same gap unguarded one level up.
 *
 * Fails soft on purpose. No live account, a broker error, a missing field —
 * all return {} and the caps derive exactly as they did before, rather than
 * failing a tune the operator asked for over a number that only ever tightens
 * the result.
 */
export async function tuneBuyingPower(
  cfg: AutotradeConfig,
): Promise<{ buyingPowerUsd?: number; optionBuyingPowerUsd?: number }> {
  if (!cfg.liveAccountId) return {};
  try {
    const acct = await webullAccountState(cfg.liveAccountId);
    if (!acct.ok) return {};
    // Day BP, not overnight: these caps gate intraday entries, and the day
    // pool is what actually funds them (2026-08-27: $8,644.72 day vs
    // $4,322.36 overnight). liveDayBuyingPowerUsd, when set, is the
    // operator's own ceiling on that same number, so it applies here too.
    const day = acct.state?.dayBuyingPowerUsd;
    const equityBp = day !== undefined && day > 0 ? day : acct.state?.buyingPowerUsd;
    const capped =
      equityBp !== undefined && cfg.liveDayBuyingPowerUsd > 0
        ? Math.min(equityBp, cfg.liveDayBuyingPowerUsd)
        : equityBp;
    return {
      ...(capped !== undefined ? { buyingPowerUsd: capped } : {}),
      ...(acct.optionBuyingPowerUsd !== undefined ? { optionBuyingPowerUsd: acct.optionBuyingPowerUsd } : {}),
    };
  } catch {
    return {};
  }
}
