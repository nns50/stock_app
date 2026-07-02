import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { PaperPosition } from '../../db/autotradePaperPositions';
import { RISK_PROFILES } from './riskProfiles';
import { getPaperPortfolioSnapshot } from './execute';

// ---------------------------------------------------------------------------
// Phase 7 (docs/AUTOTRADING_SPEC.md — MONITORING & KILL SWITCH): a read-only
// snapshot for the dashboard route/UI. Every "used vs limit" figure here is
// derived the same way evaluateRiskCheck() (riskCheck.ts) derives it for a
// live pre-trade decision — a read of that same math, not a second
// implementation of it, so the dashboard can never show a number the risk
// engine itself wouldn't agree with. Scoped to autotrade's own paper
// positions, matching execute.ts's resolved "own caps, not combined with the
// human's real positions" scope decision.
// ---------------------------------------------------------------------------

export interface AutotradeDashboard {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: RiskProfileName;
  /** Null when accountEquityUsd hasn't been configured — every $ cap below is
   *  0 in that case, mirroring how the risk engine itself fails closed until
   *  equity is set (see riskCheck.ts's equity_configured check). */
  equity: number | null;

  openPositions: PaperPosition[];
  openPositionsCount: number;
  maxConcurrentPositions: number;

  /** $ sum(size × stop distance) across open paper positions. */
  openRisk: number;
  /** $ cap = maxAggregateOpenRiskPct% of equity. */
  maxAggregateOpenRisk: number;

  /** Today's (ET) realized paper P&L; negative is a loss. */
  dailyPnl: number;
  /** $ level (negative) at which daily_drawdown_halt blocks new entries. */
  dailyDrawdownHaltLevel: number;

  tradesToday: number;
  maxTradesPerDay: number;

  /** Length of the current losing streak (0 if the last closed trade wasn't a loss). */
  consecutiveLosses: number;
  /** Consecutive losses at which step-down sizing activates. */
  stepDownAfterLosses: number;
}

export function getAutotradeDashboard(): AutotradeDashboard {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const equity = config.accountEquityUsd ?? 0;
  const snapshot = getPaperPortfolioSnapshot();

  return {
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    riskProfile: config.riskProfile,
    equity: config.accountEquityUsd,

    openPositions: snapshot.openPositions,
    openPositionsCount: snapshot.openPositionsCount,
    maxConcurrentPositions: profile.maxConcurrentPositions,

    openRisk: snapshot.openRisk,
    maxAggregateOpenRisk: (profile.maxAggregateOpenRiskPct / 100) * equity,

    dailyPnl: snapshot.dailyPnl,
    dailyDrawdownHaltLevel: -(profile.maxDailyDrawdownPct / 100) * equity,

    tradesToday: snapshot.tradesToday,
    maxTradesPerDay: profile.maxTradesPerDay,

    consecutiveLosses: snapshot.consecutiveLosses,
    stepDownAfterLosses: profile.stepDownAfterLosses,
  };
}
