import { daysToExpiration } from './blackScholes';

// ---------------------------------------------------------------------------
// Exit-rules engine for OPEN option positions. Configurable take-profit %,
// stop-loss %, time-based (exit N days before expiration), and delta-drift
// (exit when |delta| leaves a band). Reports which rule — if any — is currently
// triggered, so the UI can flag positions to act on.
// ---------------------------------------------------------------------------

export interface ExitRulesConfig {
  /** Exit when unrealized return ≥ this %. */
  takeProfitPct?: number;
  /** Exit when unrealized return ≤ -this %. */
  stopLossPct?: number;
  /** Exit when days-to-expiration ≤ this. */
  timeExitDaysBeforeExpiry?: number;
  /** Exit when |delta| drops below this. */
  deltaMin?: number;
  /** Exit when |delta| rises above this. */
  deltaMax?: number;
}

export interface ExitEvaluationInput {
  entryPrice: number; // per-share premium paid/received
  currentPrice: number | null; // current per-share mark
  side: 'long' | 'short';
  expiration: string;
  currentDelta?: number | null;
}

export interface ExitTrigger {
  rule: string;
  triggered: boolean;
  detail: string;
}

export interface ExitEvaluation {
  unrealizedPct: number | null;
  dte: number;
  triggered: boolean;
  /** Highest-priority triggered rule, if any. */
  activeRule: string | null;
  triggers: ExitTrigger[];
}

export function defaultExitConfig(): ExitRulesConfig {
  return { takeProfitPct: 50, stopLossPct: 50, timeExitDaysBeforeExpiry: 7 };
}

/** Unrealized return % for the position direction. */
export function unrealizedReturnPct(entryPrice: number, currentPrice: number, side: 'long' | 'short'): number | null {
  if (!entryPrice) return null;
  const raw = ((currentPrice - entryPrice) / entryPrice) * 100;
  return side === 'long' ? raw : -raw;
}

export function evaluateExit(input: ExitEvaluationInput, cfg: ExitRulesConfig, now: Date = new Date()): ExitEvaluation {
  const dte = daysToExpiration(input.expiration, now);
  const pct =
    input.currentPrice !== null ? unrealizedReturnPct(input.entryPrice, input.currentPrice, input.side) : null;
  const absDelta =
    input.currentDelta !== undefined && input.currentDelta !== null ? Math.abs(input.currentDelta) : null;

  // Ordered by priority: risk (stop) first, then profit, then time, then drift.
  const triggers: ExitTrigger[] = [];

  if (cfg.stopLossPct !== undefined) {
    const t = pct !== null && pct <= -cfg.stopLossPct;
    triggers.push({
      rule: 'stop-loss',
      triggered: t,
      detail: `P&L ${pct === null ? '—' : pct.toFixed(1) + '%'} ≤ -${cfg.stopLossPct}%`,
    });
  }
  if (cfg.takeProfitPct !== undefined) {
    const t = pct !== null && pct >= cfg.takeProfitPct;
    triggers.push({
      rule: 'take-profit',
      triggered: t,
      detail: `P&L ${pct === null ? '—' : pct.toFixed(1) + '%'} ≥ +${cfg.takeProfitPct}%`,
    });
  }
  if (cfg.timeExitDaysBeforeExpiry !== undefined) {
    const t = dte <= cfg.timeExitDaysBeforeExpiry;
    triggers.push({
      rule: 'time-exit',
      triggered: t,
      detail: `${dte.toFixed(1)}d to expiry ≤ ${cfg.timeExitDaysBeforeExpiry}d`,
    });
  }
  if (cfg.deltaMin !== undefined || cfg.deltaMax !== undefined) {
    const below = cfg.deltaMin !== undefined && absDelta !== null && absDelta < cfg.deltaMin;
    const above = cfg.deltaMax !== undefined && absDelta !== null && absDelta > cfg.deltaMax;
    const t = Boolean(below || above);
    const band = `[${cfg.deltaMin ?? '−∞'}, ${cfg.deltaMax ?? '∞'}]`;
    triggers.push({
      rule: 'delta-drift',
      triggered: t,
      detail: `|Δ| ${absDelta === null ? '—' : absDelta.toFixed(2)} outside ${band}`,
    });
  }

  const active = triggers.find((t) => t.triggered);
  return {
    unrealizedPct: pct,
    dte,
    triggered: Boolean(active),
    activeRule: active ? active.rule : null,
    triggers,
  };
}
