import { AutotradeConfig } from '../../db/autotradeConfig';
import { webullAccountState } from '../../providers/webull/accountState';

/**
 * Best-effort live buying power for the tune preview's funding WARNING.
 *
 * It used to bound the derived per-order cap. It must not, and no longer does
 * (2026-09-05, see deriveDollarCaps): this figure is visible to the tune and
 * invisible to liveCapsReanchor, which re-derives the same caps from config
 * alone. On any day funding actually bound the cap, the tune would store the
 * smaller number, the re-anchor would re-derive the larger one, and the
 * mismatch would flag the cap hand-edited — freezing it out of re-anchoring
 * for good. The bound survives where the live figure is genuinely in hand:
 * fundableMaxQuantity, at decision time.
 *
 * So what reaches computeTargetTune is advisory — it produces a warning when
 * the cap about to be stored is above what today can actually fund.
 *
 * Fails soft on purpose. No live account, a broker error, a missing field —
 * all return {} and the preview is simply one warning shorter, rather than
 * failing a tune the operator asked for over a number that cannot change the
 * patch anyway.
 */
export async function tuneBuyingPower(cfg: AutotradeConfig): Promise<{ buyingPowerUsd?: number }> {
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
    // Option BP is deliberately NOT returned: the options cap tracks the equity
    // cap on purpose (see deriveDollarCaps), so there is nothing here for it to
    // warn against — and returning it would invite someone to bind a cap to a
    // figure only one derivation path can see.
    return capped !== undefined ? { buyingPowerUsd: capped } : {};
  } catch {
    return {};
  }
}
