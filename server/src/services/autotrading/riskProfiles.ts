import { RiskProfileName } from '../../db/autotradeConfig';

// ---------------------------------------------------------------------------
// The risk profile parameter tables (docs/AUTOTRADING_SPEC.md — RISK PROFILES).
// Values are the spec's, verbatim — not tuned, not guessed.
// ---------------------------------------------------------------------------

export interface RiskProfileParams {
  /** % of account equity risked per trade. */
  riskPerTradePct: number;
  /** % daily drawdown (of equity) that halts new entries for the day. */
  maxDailyDrawdownPct: number;
  /** Consecutive losing trades that trigger step-down sizing. */
  stepDownAfterLosses: number;
  /** % cut to risk-per-trade once step-down is active. */
  stepDownSizeCutPct: number;
  /** % of equity — sum(size × stop distance) across open + proposed positions. */
  maxAggregateOpenRiskPct: number;
  /** % of equity — capital (not risk) in statistically-correlated tickers. */
  maxCorrelatedExposurePct: number;
  maxTradesPerDay: number;
}

// maxConcurrentPositions used to live here (2 for MODERATE, 3 for AGGRESSIVE)
// but is now a directly user-configurable field on AutotradeConfig instead —
// see RiskCheckContext.maxConcurrentPositions — since switching risk profile
// silently changing a position-count cap the user had explicitly set would be
// a surprising side effect, not a preset the user asked to bundle in.
export const RISK_PROFILES: Record<RiskProfileName, RiskProfileParams> = {
  MODERATE: {
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxTradesPerDay: 6,
  },
  AGGRESSIVE: {
    riskPerTradePct: 1.5,
    maxDailyDrawdownPct: 5,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 4.5,
    maxCorrelatedExposurePct: 10,
    maxTradesPerDay: 10,
  },
};

/**
 * Statistical-correlation exposure cap parameters (the window/threshold the
 * spec's resolved decisions explicitly deferred to this phase). Same for both
 * profiles — only the capital cap itself (maxCorrelatedExposurePct) differs.
 * 30 trading days (~6 weeks) is long enough to be statistically meaningful,
 * short enough to reflect the current correlation regime; |r| ≥ 0.7 is the
 * standard "strong correlation" convention. Both are tunable defaults, not
 * laws of physics — revisit if backtesting (a later phase) suggests otherwise.
 */
export const CORRELATION_LOOKBACK_DAYS = 30;
export const CORRELATION_THRESHOLD = 0.7;
