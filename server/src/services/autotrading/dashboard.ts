import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { PaperPosition } from '../../db/autotradePaperPositions';
import { OptionsPaperPosition } from '../../db/autotradeOptionsPaperPositions';
import { Position } from '../../db/positions';
import { RISK_PROFILES } from './riskProfiles';
import { getPaperPortfolioSnapshot } from './execute';
import { getOptionsPaperPortfolioSnapshot } from './optionsExecute';
import { getLivePortfolioSnapshot, getProbationStatus, ProbationStatus } from './liveExecute';
import { LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { getLiveOptionsPortfolioSnapshot, getOptionsProbationStatus } from './liveOptionsExecute';
import { daysToExpiration } from '../../options/blackScholes';

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
// governed by the same config (maxConcurrentPositions directly; the rest via
// the active risk profile).
//
// Phase 13: options paper positions are the OPPOSITE case from live — since
// phase 12 made the equity/options combined budget real (runPaperExecution()
// and runOptionsPaperExecution() each fold the other's running totals into
// every risk-check), openPositionsCount/openRisk/dailyPnl/tradesToday/
// consecutiveLosses below are genuinely COMBINED across both books, not a
// second pool the way live's figures are — showing them separately here
// would misrepresent what's actually enforced, the same reasoning as above,
// just pointing the opposite direction. dailyPnl/tradesToday combine by sum,
// consecutiveLosses by max — mirroring execute.ts's/optionsExecute.ts's own
// combination formulas exactly (see PaperPortfolioSeed's doc comment for why
// max, not sum, for the streak).
// ---------------------------------------------------------------------------

export interface AutotradeDashboard {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: RiskProfileName;
  /** Null when accountEquityUsd hasn't been configured — every $ cap below is
   *  0 in that case, mirroring how the risk engine itself fails closed until
   *  equity is set (see riskCheck.ts's equity_configured check). */
  equity: number | null;

  /** Equity paper positions only — see openOptionsPositions below for the
   *  options side of this SAME combined pool. */
  openPositions: PaperPosition[];
  /** Combined equity + options paper count (phase 13) — checked against
   *  maxConcurrentPositions as ONE pool. openPositions.length +
   *  openOptionsPositions.length. */
  openPositionsCount: number;
  maxConcurrentPositions: number;

  /** Combined equity + options paper risk $ (phase 13) — sum(size × stop
   *  distance) across equity positions plus sum(premium paid) across options
   *  positions, checked against maxAggregateOpenRisk as ONE pool. */
  openRisk: number;
  /** $ cap = maxAggregateOpenRiskPct% of equity. Shared with live — see header. */
  maxAggregateOpenRisk: number;

  /** Combined equity + options today's (ET) realized paper P&L; negative is a loss. */
  dailyPnl: number;
  /** $ level (negative) at which daily_drawdown_halt blocks new entries. Shared with live. */
  dailyDrawdownHaltLevel: number;

  /** Combined equity + options paper entries opened today. */
  tradesToday: number;
  maxTradesPerDay: number;

  /** max(equity streak, options streak) — see header for why max, not sum. */
  consecutiveLosses: number;
  /** Consecutive losses at which step-down sizing activates. Shared with live. */
  stepDownAfterLosses: number;

  // --- Phase 13: options paper positions — folded into the SAME pool above,
  // not a second one (see header) — this array is for per-position display
  // (contract, strike, expiration, days-to-expiration), not a separate cap.
  openOptionsPositions: (OptionsPaperPosition & { dte: number })[];

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

  // --- Task #70: live options — own pool, nested under the live gate above,
  // shared caps for the CONCURRENT-POSITIONS/aggregate-risk/etc. numbers
  // (same active risk profile), but its own $ caps and probation window,
  // mirroring the "Phase 8: live trading" section's own reasoning exactly. ---
  liveOptionsEnabled: boolean;
  liveOptionsOpenPositions: LiveOptionsPosition[];
  liveOptionsOpenPositionsCount: number;
  liveOptionsOpenRisk: number;
  liveOptionsDailyPnl: number;
  liveOptionsTradesToday: number;
  liveOptionsConsecutiveLosses: number;
  liveOptionsMaxOrderUsd: number;
  liveOptionsMaxDailyLossUsd: number;
  liveOptionsMaxOrdersPerDay: number;
  liveOptionsProbation: ProbationStatus;
}

export function getAutotradeDashboard(): AutotradeDashboard {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const equity = config.accountEquityUsd ?? 0;
  const snapshot = getPaperPortfolioSnapshot();
  const optionsSnapshot = getOptionsPaperPortfolioSnapshot();
  const liveSnapshot = getLivePortfolioSnapshot();
  const liveOptionsSnapshot = getLiveOptionsPortfolioSnapshot();
  const now = new Date();

  return {
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    riskProfile: config.riskProfile,
    equity: config.accountEquityUsd,

    openPositions: snapshot.openPositions,
    openPositionsCount: snapshot.openPositionsCount + optionsSnapshot.openPositionsCount,
    maxConcurrentPositions: config.maxConcurrentPositions,

    openRisk: snapshot.openRisk + optionsSnapshot.openRisk,
    maxAggregateOpenRisk: (profile.maxAggregateOpenRiskPct / 100) * equity,

    dailyPnl: snapshot.dailyPnl + optionsSnapshot.dailyPnl,
    dailyDrawdownHaltLevel: -(profile.maxDailyDrawdownPct / 100) * equity,

    tradesToday: snapshot.tradesToday + optionsSnapshot.tradesToday,
    maxTradesPerDay: profile.maxTradesPerDay,

    consecutiveLosses: Math.max(snapshot.consecutiveLosses, optionsSnapshot.consecutiveLosses),
    stepDownAfterLosses: profile.stepDownAfterLosses,

    openOptionsPositions: optionsSnapshot.openPositions.map((p) => ({
      ...p,
      dte: daysToExpiration(p.expiration, now),
    })),

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

    liveOptionsEnabled: config.liveOptionsEnabled,
    liveOptionsOpenPositions: liveOptionsSnapshot.openPositions,
    liveOptionsOpenPositionsCount: liveOptionsSnapshot.openPositionsCount,
    liveOptionsOpenRisk: liveOptionsSnapshot.openRisk,
    liveOptionsDailyPnl: liveOptionsSnapshot.dailyPnl,
    liveOptionsTradesToday: liveOptionsSnapshot.tradesToday,
    liveOptionsConsecutiveLosses: liveOptionsSnapshot.consecutiveLosses,
    liveOptionsMaxOrderUsd: config.liveOptionsMaxOrderUsd,
    liveOptionsMaxDailyLossUsd: config.liveOptionsMaxDailyLossUsd,
    liveOptionsMaxOrdersPerDay: config.liveOptionsMaxOrdersPerDay,
    liveOptionsProbation: getOptionsProbationStatus(config),
  };
}
