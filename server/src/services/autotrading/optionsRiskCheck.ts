import { computeRiskSizing, RiskSizingResult } from '../riskSizing';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { RISK_PROFILES, RiskProfileParams } from './riskProfiles';
import { OptionsTradeSignal } from './optionsDecide';
import {
  correlatedNotional,
  getPortfolioSnapshot,
  RiskCheckContext,
  RiskCheckResult,
  RiskCheckRule,
} from './riskCheck';

// ---------------------------------------------------------------------------
// The options counterpart to riskCheck.ts (docs/AUTOTRADING_SPEC.md, phase 10)
// — a deliberate PARALLEL implementation, not a shared/refactored core with
// evaluateRiskCheck(), mirroring this codebase's established convention for
// every other equity/options split (decide.ts vs optionsDecide.ts, execute.ts
// vs liveExecute.ts): keeps each path's tests fully isolated and avoids
// awkwardly parameterizing away what's genuinely asset-specific about sizing.
//
// The "one combined budget" the spec calls for (not separate risk pools for
// stocks vs. options) is real, not just a shared config: runOptionsRiskCheck
// seeds its running totals from the SAME real open-position snapshot equity's
// own runAutotradeRiskCheck uses, PLUS whatever an equity batch already
// approved earlier in the exact same cycle (threaded in via `equityResults`)
// — an approved options signal's risk correctly counts against the next
// equity OR options candidate's cap, and vice versa. Reuses RiskCheckContext/
// RiskCheckResult/RiskCheckRule directly (already 100% asset-type-blind
// shapes — nothing equity-specific in any of them) rather than parallel types.
//
// Not yet wired into the unconditional 24/7 loop tick, unlike optionsDecide.ts
// — there is no options EXECUTION path yet (phase 12) for this to gate, so
// (mirroring how equity's OWN risk-check started, before phase 6 gave it a
// real paper-execution consumer) this is preview-only for now, reachable via
// POST /api/autotrade/risk-check-options.
// ---------------------------------------------------------------------------

const ZERO_SIZING: RiskSizingResult = {
  maxRiskDollars: 0,
  stopDistance: 0,
  riskPerUnit: 0,
  suggestedQuantity: 0,
  positionCost: 0,
  positionPctOfAccount: 0,
  riskOfPosition: 0,
  targetPrice: null,
  targetProfit: null,
  rewardRiskRatio: null,
  warnings: [],
};

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Evaluate one already-generated options signal against the active risk
 * profile. Pure — no I/O. `ctx` carries everything the checks need, including
 * the real portfolio state PLUS any signal (equity or options) already
 * approved earlier in the same combined batch.
 */
export function evaluateOptionsRiskCheck(
  signal: OptionsTradeSignal,
  ctx: RiskCheckContext,
  profile: RiskProfileParams,
): RiskCheckResult {
  const checks: RiskCheckRule[] = [];
  const check = (rule: string, passed: boolean, detail: string) => checks.push({ rule, passed, detail });
  const blocked = (sizing: RiskSizingResult, stepDownActive: boolean): RiskCheckResult => ({
    symbol: signal.symbol,
    ok: false,
    checks,
    sizing,
    stepDownActive,
    approvedRiskAmount: 0,
    approvedNotional: 0,
  });

  const equityOk = ctx.equity > 0;
  check(
    'equity_configured',
    equityOk,
    equityOk ? usd(ctx.equity) : 'account equity is not set — configure it before auto-trading can size positions',
  );
  if (!equityOk) return blocked(ZERO_SIZING, false);

  const stepDownActive = ctx.consecutiveLosses >= profile.stepDownAfterLosses;
  const effectiveRiskPct = stepDownActive
    ? profile.riskPerTradePct * (1 - profile.stepDownSizeCutPct / 100)
    : profile.riskPerTradePct;
  check(
    'step_down_sizing',
    true,
    stepDownActive
      ? `active — ${ctx.consecutiveLosses} consecutive losses, sizing at ${effectiveRiskPct}% instead of ${profile.riskPerTradePct}% (${profile.stepDownSizeCutPct}% cut)`
      : `inactive — ${ctx.consecutiveLosses} consecutive losses (triggers at ${profile.stepDownAfterLosses})`,
  );

  // A long option's real worst case is expiring worthless — losing the
  // ENTIRE premium paid. Passing stopPrice: 0 to the exact same
  // computeRiskSizing() the equity path uses turns "stop distance" into
  // "the full premium," which IS this signal's own defined-risk structure
  // (see optionsDecide.ts's analyzeStrategy() backstop) — not a new formula.
  // side: 'long' means long the CONTRACT itself, regardless of call/put
  // direction — a long call and a long put are both "pay premium upfront,
  // risk bounded by that premium" from a sizing perspective.
  const sizing = computeRiskSizing({
    accountSize: ctx.equity,
    riskPct: effectiveRiskPct,
    entryPrice: signal.premium,
    stopPrice: 0,
    assetType: 'option',
    side: 'long',
  });

  const qtyOk = sizing.suggestedQuantity > 0;
  check(
    'quantity',
    qtyOk,
    qtyOk
      ? `${sizing.suggestedQuantity} contract${sizing.suggestedQuantity === 1 ? '' : 's'}`
      : 'risk budget is too small to size even one contract at this premium',
  );
  if (!qtyOk) return blocked(sizing, stepDownActive);

  const dailyHaltLevel = -(profile.maxDailyDrawdownPct / 100) * ctx.equity;
  const haltOk = ctx.dailyPnl > dailyHaltLevel;
  check(
    'daily_drawdown_halt',
    haltOk,
    `today ${usd(ctx.dailyPnl)} vs halt at ${usd(dailyHaltLevel)} (${profile.maxDailyDrawdownPct}% of equity)`,
  );

  const tradesOk = ctx.tradesToday < profile.maxTradesPerDay;
  check('max_trades_per_day', tradesOk, `${ctx.tradesToday} placed vs ${profile.maxTradesPerDay}/day`);

  const positionsOk = ctx.openPositionsCount < profile.maxConcurrentPositions;
  check(
    'max_concurrent_positions',
    positionsOk,
    `${ctx.openPositionsCount} open vs cap ${profile.maxConcurrentPositions}`,
  );

  // The combined budget itself: ctx.openRisk already carries real equity
  // positions' risk PLUS anything (equity or options) approved earlier in
  // this exact batch — see runOptionsRiskCheck.
  const aggregateCap = (profile.maxAggregateOpenRiskPct / 100) * ctx.equity;
  const aggregateAfter = ctx.openRisk + sizing.riskOfPosition;
  const aggregateOk = aggregateAfter <= aggregateCap;
  check(
    'max_aggregate_open_risk',
    aggregateOk,
    `${usd(aggregateAfter)} vs cap ${usd(aggregateCap)} (${profile.maxAggregateOpenRiskPct}% of equity)`,
  );

  // Notional here is the premium paid (= approvedRiskAmount for a long
  // option, unlike a stock where notional usually exceeds its stop-risk by a
  // wide margin) — a real simplification, not a delta-adjusted/leveraged
  // exposure figure. That would more accurately reflect a long option's
  // actual directional sensitivity to a correlated move, but nothing in this
  // codebase computes one today; premium-paid is the same conservative,
  // simple reading this file already uses for "notional" elsewhere.
  const correlatedCap = (profile.maxCorrelatedExposurePct / 100) * ctx.equity;
  const correlatedOk = ctx.correlatedNotional <= correlatedCap;
  check(
    'max_correlated_exposure',
    correlatedOk,
    `${usd(ctx.correlatedNotional)} already correlated vs cap ${usd(correlatedCap)} (${profile.maxCorrelatedExposurePct}% of equity)`,
  );

  const ok = checks.every((c) => c.passed);
  return {
    symbol: signal.symbol,
    ok,
    checks,
    sizing,
    stepDownActive,
    approvedRiskAmount: ok ? sizing.riskOfPosition : 0,
    approvedNotional: ok ? sizing.positionCost : 0,
  };
}

/**
 * Risk-check a batch of options signals (as produced by optionsDecide.ts),
 * sequentially — each signal's checks see the real open positions, PLUS
 * whatever an equity batch already approved this cycle (`equityResults`,
 * typically runAutotradeRiskCheck's own output — this file only reads the
 * four fields it actually needs from each, not the full RiskCheckResult
 * shape), PLUS any options signal already approved earlier in this same
 * options batch. This IS the combined budget, threaded explicitly rather than
 * assumed shared. Journals every outcome exactly like the equity risk-check
 * does (stage 'risk_check', action 'passed' | 'blocked').
 */
export async function runOptionsRiskCheck(
  signals: OptionsTradeSignal[],
  equityResults: Pick<RiskCheckResult, 'symbol' | 'ok' | 'approvedRiskAmount' | 'approvedNotional'>[] = [],
): Promise<RiskCheckResult[]> {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const snapshot = getPortfolioSnapshot();
  const approvedEquity = equityResults.filter((r) => r.ok);

  const results: RiskCheckResult[] = [];
  let runningRisk =
    snapshot.openPositions.reduce((s, p) => s + p.riskAmount, 0) +
    approvedEquity.reduce((s, r) => s + r.approvedRiskAmount, 0);
  let runningCount = snapshot.openPositions.length + approvedEquity.length;
  const runningPositions = [
    ...snapshot.openPositions,
    ...approvedEquity.map((r) => ({ symbol: r.symbol, notional: r.approvedNotional })),
  ];

  for (const signal of signals) {
    const { amount: correlated } = await correlatedNotional(signal.symbol, runningPositions);
    const ctx: RiskCheckContext = {
      equity: snapshot.equity ?? 0,
      dailyPnl: snapshot.dailyPnl,
      tradesToday: snapshot.tradesToday,
      consecutiveLosses: snapshot.consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      correlatedNotional: correlated,
    };
    const result = evaluateOptionsRiskCheck(signal, ctx, profile);
    results.push(result);

    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, contracts: result.sizing.suggestedQuantity },
    });

    if (result.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol: signal.symbol, notional: result.approvedNotional });
    }
  }

  return results;
}
