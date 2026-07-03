import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { PaperPosition } from '../../db/autotradePaperPositions';
import { Position } from '../../db/positions';
import { RISK_PROFILES } from './riskProfiles';
import { getPaperPortfolioSnapshot } from './execute';
import { getLivePortfolioSnapshot, getProbationStatus, ProbationStatus } from './liveExecute';

// ---------------------------------------------------------------------------
// Phase 7 (docs/AUTOTRADING_SPEC.md — MONITORING & KILL SWITCH): a read-only
// snapshot for the dashboard route/UI. Every "used vs limit" figure here is
// derived the same way evaluateRiskCheck() (riskCheck.ts) derives it for a
// live pre-trade decision — a read of that same math, not a second
// implementation of it, so the dashboard can never show a number the risk
// engine itself wouldn't agree with.
//
// Phase 8: live positions get their OWN "used" figures (liveOpenPositions,
// liveOpenRisk, etc.) rather than being combined with paper's — the two
// pools are independent by construction (runPaperExecution() and
// runLiveExecution() each risk-check against their own snapshot only, never
// each other's), so a combined figure here would misrepresent what's
// actually enforced. The CAP numbers themselves (maxConcurrentPositions,
// maxAggregateOpenRisk, etc.) are shared, not duplicated — both pools are
// governed by the same active risk profile.
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
  /** $ cap = maxAggregateOpenRiskPct% of equity. Shared with live — see header. */
  maxAggregateOpenRisk: number;

  /** Today's (ET) realized paper P&L; negative is a loss. */
  dailyPnl: number;
  /** $ level (negative) at which daily_drawdown_halt blocks new entries. Shared with live. */
  dailyDrawdownHaltLevel: number;

  tradesToday: number;
  maxTradesPerDay: number;

  /** Length of the current losing streak (0 if the last closed trade wasn't a loss). */
  consecutiveLosses: number;
  /** Consecutive losses at which step-down sizing activates. Shared with live. */
  stepDownAfterLosses: number;

  // --- Phase 8: live trading — own pool, shared caps (see header) -----------
  liveTradingEnabled: boolean;
  liveAccountId: string | null;
  liveOpenPositions: Position[];
  liveOpenPositionsCount: number;
  liveOpenRisk: number;
  liveDailyPnl: number;
  liveTradesToday: number;
  liveConsecutiveLosses: number;
  /** Live-only caps (liveExecute.ts's buildLiveTradingConfig() reads these
   *  directly for guardrail evaluation — surfaced here for display too). */
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
  probation: ProbationStatus;
}

export function getAutotradeDashboard(): AutotradeDashboard {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const equity = config.accountEquityUsd ?? 0;
  const snapshot = getPaperPortfolioSnapshot();
  const liveSnapshot = getLivePortfolioSnapshot();

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

    liveTradingEnabled: config.liveTradingEnabled,
    liveAccountId: config.liveAccountId,
    liveOpenPositions: liveSnapshot.openPositions,
    liveOpenPositionsCount: liveSnapshot.openPositionsCount,
    liveOpenRisk: liveSnapshot.openRisk,
    liveDailyPnl: liveSnapshot.dailyPnl,
    liveTradesToday: liveSnapshot.tradesToday,
    liveConsecutiveLosses: liveSnapshot.consecutiveLosses,
    liveMaxOrderUsd: config.liveMaxOrderUsd,
    liveMaxDailyLossUsd: config.liveMaxDailyLossUsd,
    liveMaxOrdersPerDay: config.liveMaxOrdersPerDay,
    probation: getProbationStatus(config),
  };
}
