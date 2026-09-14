import { AutotradeConfig } from '../../db/autotradeConfig';
import { webullAccountState } from '../../providers/webull/accountState';
import { buyingPowerBasis } from './buyingPowerBasis';
import { learnedOpenNotionalCeiling } from './buyingPowerRefusals';
import { etToday } from '../../util/marketDate';

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
    if (!acct.ok || !acct.state) return {};
    // ONE derivation, shared with the live sizer (2026-09-14). This used to
    // pick the day figure itself and disagreed with buyingPowerBasis on all
    // three of netting (it never subtracted exposure), precedence (it took day
    // over overnight unconditionally rather than the larger) and the learned
    // ceiling (it had none). So the warning judged a cap against a pool the
    // broker does not honour: on 2026-09-14 it would have called $10,606.79
    // fundable on a session where the broker refused $3,111.76.
    //
    // Option BP is deliberately NOT returned: the options cap tracks the equity
    // cap on purpose (see deriveDollarCaps), so there is nothing here for it to
    // warn against — and returning it would invite someone to bind a cap to a
    // figure only one derivation path can see.
    const learned = learnedOpenNotionalCeiling(cfg.liveAccountId, etToday());
    return { buyingPowerUsd: buyingPowerBasis(acct.state, cfg, learned?.ceilingUsd).usedUsd };
  } catch {
    return {};
  }
}
