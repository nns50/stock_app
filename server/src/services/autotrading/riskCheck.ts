import { getProvider } from '../../providers';
import { listPositions, Position } from '../../db/positions';
import { realizedPnlOf, computeStreaksAndDrawdown } from '../pnl';
import { computeRiskSizing, RiskSizingResult } from '../riskSizing';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent, listAutotradeEvents } from '../../db/autotradeEvents';
import { CORRELATION_LOOKBACK_DAYS, CORRELATION_THRESHOLD, RISK_PROFILES, RiskProfileParams } from './riskProfiles';
import { TradeSignal } from './decide';

// ---------------------------------------------------------------------------
// The Risk Check stage (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP, stage 3;
// this is the safety-critical core the spec calls out for the heaviest test
// coverage). Sizes a signal by the active risk profile (with step-down after
// consecutive losses), then gates it against every profile cap — including
// the CRITICAL max-aggregate-open-risk pre-trade check and the
// statistical-correlation exposure cap. Pure evaluator + an async wrapper that
// assembles real portfolio state; no orders are placed here.
//
// Known interim scope: daily P&L and the consecutive-loss streak are computed
// from ALL closed positions in the journal (positions.ts), not auto-trading's
// own trades specifically — there's no way to distinguish the two yet, since
// nothing has executed an auto-trade (that's Phase 6). Concurrent-position
// count and aggregate open risk are deliberately account-wide regardless of
// source, mirroring how the live-trading guardrails (guardrails.ts) already
// treat "the account" as one unified thing, not per-strategy-siloed — the
// safer reading, since it can't understate real exposure.
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

function startOfTodayMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const lastExitDate = (p: Position): string =>
  p.exits.length
    ? p.exits
        .map((e) => e.exitDate)
        .sort()
        .slice(-1)[0]
    : p.entryDate;

export interface OpenRiskItem {
  symbol: string;
  /** $ = |entry - stop| × remaining qty × multiplier. 0 if no stop was logged. */
  riskAmount: number;
  /** $ = entry price × remaining qty × multiplier. */
  notional: number;
}

export interface PortfolioSnapshot {
  /** Null when accountEquityUsd hasn't been configured yet. */
  equity: number | null;
  /** Today's realized P&L across the whole journal (see interim-scope note above). */
  dailyPnl: number;
  /** Auto-trading's own order placements today (0 until Phase 6 executes any). */
  tradesToday: number;
  /** Length of the current losing streak (0 if the last closed trade wasn't a loss). */
  consecutiveLosses: number;
  openPositions: OpenRiskItem[];
}

/** Assemble current portfolio state from the journal + config. No provider/
 *  broker calls — see the file header for what's deliberately deferred. */
export function getPortfolioSnapshot(): PortfolioSnapshot {
  const equity = getAutotradeConfig().accountEquityUsd;

  const todayStr = new Date().toISOString().slice(0, 10);
  const closedTrades = listPositions({ status: 'closed' })
    .map((p) => ({ date: lastExitDate(p), pnl: realizedPnlOf(p) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyPnl = closedTrades.filter((t) => t.date === todayStr).reduce((s, t) => s + t.pnl, 0);
  const streak = computeStreaksAndDrawdown(closedTrades.map((t) => t.pnl)).currentStreak;
  const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;

  const start = startOfTodayMs();
  const tradesToday = listAutotradeEvents({ stage: 'execution', limit: 1000 }).filter(
    (e) => e.action === 'order_placed' && e.createdAt >= start,
  ).length;

  const openPositions: OpenRiskItem[] = listPositions({ status: 'open' }).map((p) => ({
    symbol: p.symbol,
    riskAmount: p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.remainingQuantity * p.multiplier : 0,
    notional: p.entryPrice * p.remainingQuantity * p.multiplier,
  }));

  return { equity, dailyPnl, tradesToday, consecutiveLosses, openPositions };
}

/** Capital (across `positions`) statistically correlated with `symbol` —
 *  |Pearson r| ≥ CORRELATION_THRESHOLD over CORRELATION_LOOKBACK_DAYS of daily
 *  returns. A position whose correlation can't be computed (fetch failure,
 *  too little history) is excluded from the sum, not assumed correlated —
 *  the CRITICAL aggregate-risk check independently covers the "many positions
 *  at once" gap risk this cap is layered on top of. */
async function correlatedNotional(
  symbol: string,
  positions: { symbol: string; notional: number }[],
): Promise<{ amount: number; correlations: { symbol: string; r: number | null }[] }> {
  if (positions.length === 0) return { amount: 0, correlations: [] };
  const provider = getProvider();
  const symbols = Array.from(new Set([symbol, ...positions.map((p) => p.symbol)]));
  const closesBySymbol = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const candles = await provider.getCandles(s, 'daily', { limit: CORRELATION_LOOKBACK_DAYS + 1 });
        closesBySymbol.set(
          s,
          candles.map((c) => c.close),
        );
      } catch {
        /* leave unset — treated as unknown correlation for this symbol below */
      }
    }),
  );

  const candidateCloses = closesBySymbol.get(symbol);
  const candidateReturns = candidateCloses ? dailyReturns(candidateCloses) : null;

  let amount = 0;
  const correlations: { symbol: string; r: number | null }[] = [];
  for (const pos of positions) {
    const posCloses = closesBySymbol.get(pos.symbol);
    const r = candidateReturns && posCloses ? pearsonCorrelation(candidateReturns, dailyReturns(posCloses)) : null;
    correlations.push({ symbol: pos.symbol, r });
    if (r !== null && Math.abs(r) >= CORRELATION_THRESHOLD) amount += pos.notional;
  }
  return { amount, correlations };
}

export interface RiskCheckContext {
  equity: number;
  dailyPnl: number;
  tradesToday: number;
  consecutiveLosses: number;
  /** Open risk PLUS any signal already approved earlier in the same batch. */
  openRisk: number;
  openPositionsCount: number;
  correlatedNotional: number;
}

export interface RiskCheckRule {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RiskCheckResult {
  symbol: string;
  ok: boolean;
  checks: RiskCheckRule[];
  sizing: RiskSizingResult;
  stepDownActive: boolean;
  /** What this trade would add to running totals if approved (0 when blocked) —
   *  the batch orchestration accumulates these across signals. */
  approvedRiskAmount: number;
  approvedNotional: number;
}

/**
 * Evaluate one already-sized signal against the active risk profile. Pure —
 * no I/O. `ctx` carries everything the checks need, including any signals
 * already approved earlier in the same batch (see runAutotradeRiskCheck).
 */
export function evaluateRiskCheck(
  signal: TradeSignal,
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

  const sizing = computeRiskSizing({
    accountSize: ctx.equity,
    riskPct: effectiveRiskPct,
    entryPrice: signal.entry,
    stopPrice: signal.stop,
    assetType: 'stock',
    side: signal.side === 'buy' ? 'long' : 'short',
  });

  const qtyOk = sizing.suggestedQuantity > 0;
  check(
    'quantity',
    qtyOk,
    qtyOk
      ? `${sizing.suggestedQuantity} shares`
      : 'risk budget is too small to size even one share at this stop distance',
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

  // CRITICAL: distinct from the daily halt, which only reacts to REALIZED
  // losses after trades close. This is the pre-trade check — sum(size × stop
  // distance) across ALL open + this proposed position — that blocks BEFORE
  // several positions could get stopped out together and blow past the daily
  // halt before it can even trigger.
  const aggregateCap = (profile.maxAggregateOpenRiskPct / 100) * ctx.equity;
  const aggregateAfter = ctx.openRisk + sizing.riskOfPosition;
  const aggregateOk = aggregateAfter <= aggregateCap;
  check(
    'max_aggregate_open_risk',
    aggregateOk,
    `${usd(aggregateAfter)} vs cap ${usd(aggregateCap)} (${profile.maxAggregateOpenRiskPct}% of equity)`,
  );

  // Unlike aggregate open risk, this does NOT add the proposed trade's own
  // notional — every symbol is trivially "correlated" with itself, so doing
  // that would block a lone, isolated first trade purely against itself
  // (position notional is typically many times the $ risk, since sizing is
  // risk-based off a stop distance — a tight stop alone can make this cap
  // look tripped with zero actual correlated concentration). This check is
  // about capital ALREADY concentrated in tickers correlated with this one;
  // the candidate's own size is what per-trade risk / aggregate open risk
  // already govern. Once approved, it's added to the running portfolio (see
  // runAutotradeRiskCheck) so it correctly counts against the NEXT candidate.
  const correlatedCap = (profile.maxCorrelatedExposurePct / 100) * ctx.equity;
  const correlatedOk = ctx.correlatedNotional <= correlatedCap;
  check(
    'max_correlated_exposure',
    correlatedOk,
    `${usd(ctx.correlatedNotional)} already correlated vs cap ${usd(correlatedCap)} (${profile.maxCorrelatedExposurePct}% of equity, |r| ≥ ${CORRELATION_THRESHOLD})`,
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
 * Risk-check a batch of signals (as produced by Decision), sequentially —
 * each signal's checks see the real open positions PLUS any signal already
 * approved earlier in this same batch. Evaluating every signal against a
 * static snapshot would let a batch of individually-fine signals jointly
 * bust a cap none of them would trip alone (the exact multi-position gap-risk
 * scenario the max-aggregate-open-risk check exists to prevent). Journals
 * every outcome (stage 'risk_check', action 'passed' | 'blocked').
 */
export async function runAutotradeRiskCheck(signals: TradeSignal[]): Promise<RiskCheckResult[]> {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const snapshot = getPortfolioSnapshot();

  const results: RiskCheckResult[] = [];
  let runningRisk = snapshot.openPositions.reduce((s, p) => s + p.riskAmount, 0);
  let runningCount = snapshot.openPositions.length;
  const runningPositions = [...snapshot.openPositions];

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
    const result = evaluateRiskCheck(signal, ctx, profile);
    results.push(result);

    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, quantity: result.sizing.suggestedQuantity },
    });

    if (result.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({
        symbol: signal.symbol,
        riskAmount: result.approvedRiskAmount,
        notional: result.approvedNotional,
      });
    }
  }

  return results;
}
