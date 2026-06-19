import { defaultExitConfig, ExitRulesConfig } from '../options/exitRules';

// The "suggestion of when to exit" that rides along with an option ENTRY alert.
// It's the same exit-rules engine the open-position exit-check uses, rendered as
// a one-line plan so an entry signal always carries a pre-decided exit. Pure and
// decision-support only — the user can override it with their own written plan.

/**
 * One-line exit suggestion from the exit-rules config (take-profit %, stop-loss
 * %, time-exit days before expiry, delta band). `expiration` is woven into the
 * time-exit clause when present.
 */
export function suggestedExitText(expiration: string | null, cfg: ExitRulesConfig = defaultExitConfig()): string {
  const parts: string[] = [];
  if (cfg.takeProfitPct !== undefined) parts.push(`take profit +${cfg.takeProfitPct}%`);
  if (cfg.stopLossPct !== undefined) parts.push(`stop −${cfg.stopLossPct}%`);
  if (cfg.timeExitDaysBeforeExpiry !== undefined)
    parts.push(`time-exit ${cfg.timeExitDaysBeforeExpiry}d before ${expiration ?? 'expiry'}`);
  if (cfg.deltaMin !== undefined || cfg.deltaMax !== undefined)
    parts.push(`exit if |Δ| leaves [${cfg.deltaMin ?? '−∞'}, ${cfg.deltaMax ?? '∞'}]`);
  return parts.join(' · ');
}
