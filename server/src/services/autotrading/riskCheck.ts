import { getProvider } from '../../providers';
import { listPositions, Position } from '../../db/positions';
import { realizedPnlOf, computeStreaksAndDrawdown } from '../pnl';
import { computeRiskSizing, RiskSizingResult } from '../riskSizing';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent, listAutotradeEvents } from '../../db/autotradeEvents';
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

/** Today's date (YYYY-MM-DD) in US/Eastern, NOT UTC or server-local — the
 *  same "trading day" convention execute.ts's own etDateStr() (and its
 *  options counterpart) already bucket by. Fixes a known gap flagged during
 *  Phase 6's review: this function's "today" was previously UTC-based
 *  (`toISOString()`) with a SEPARATE server-local-time boundary for
 *  tradesToday (`setHours(0,0,0,0)`) — two different, both-wrong bucketings
 *  in the same snapshot. UTC midnight falls at 7-8pm ET (squarely inside
 *  typical after-hours activity), so either one could split the same ET
 *  evening's trades/exits across two different "days." Duplicated here
 *  rather than imported from execute.ts to avoid a circular import
 *  (execute.ts already imports FROM riskCheck.ts) — the same small-pure-
 *  helper-duplication convention already used between execute.ts and
 *  optionsExecute.ts. */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
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

  const todayStr = etDateStr();
  const closedTrades = listPositions({ status: 'closed' })
    .map((p) => ({ date: lastExitDate(p), pnl: realizedPnlOf(p) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyPnl = closedTrades.filter((t) => t.date === todayStr).reduce((s, t) => s + t.pnl, 0);
  const streak = computeStreaksAndDrawdown(closedTrades.map((t) => t.pnl)).currentStreak;
  const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;

  const tradesToday = listAutotradeEvents({ stage: 'execution', limit: 1000 }).filter(
    (e) => e.action === 'order_placed' && etDateStr(e.createdAt) === todayStr,
  ).length;

  const openPositions: OpenRiskItem[] = listPositions({ status: 'open' }).map((p) => ({
    symbol: p.symbol,
    riskAmount: p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.remainingQuantity * p.multiplier : 0,
    notional: p.entryPrice * p.remainingQuantity * p.multiplier,
  }));

  return { equity, dailyPnl, tradesToday, consecutiveLosses, openPositions };
}

/** Capital (across `positions`) statistically correlated with `symbol` —
 *  |Pearson r| ≥ `threshold` over `lookbackDays` of daily returns (both
 *  directly user-configured — AutotradeConfig.correlationThreshold/
 *  correlationLookbackDays — passed explicitly rather than read here, same
 *  reasoning as every other risk-check field: this stays a pure function of
 *  its arguments, not implicitly coupled to live config). A position whose
 *  correlation can't be computed (fetch failure, too little history) is
 *  excluded from the sum, not assumed correlated — the CRITICAL
 *  aggregate-risk check independently covers the "many positions at once"
 *  gap risk this cap is layered on top of. */
/** Exported for reuse by the Phase 6 paper execution loop (execute.ts), which
 *  needs the same live-fetching correlation check against its own running
 *  paper-portfolio state — not a from-scratch reimplementation (see
 *  backtest.ts's separate offline `backtestCorrelatedNotional`, which exists
 *  only because a backtest has no live network access during simulation). */
export async function correlatedNotional(
  symbol: string,
  positions: { symbol: string; notional: number }[],
  lookbackDays: number,
  threshold: number,
): Promise<{ amount: number; correlations: { symbol: string; r: number | null }[] }> {
  if (positions.length === 0) return { amount: 0, correlations: [] };
  const provider = getProvider();
  const symbols = Array.from(new Set([symbol, ...positions.map((p) => p.symbol)]));
  const closesBySymbol = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const candles = await provider.getCandles(s, 'daily', { limit: lookbackDays + 1 });
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
    if (r !== null && Math.abs(r) >= threshold) amount += pos.notional;
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
  /** User-configured cap (AutotradeConfig.maxConcurrentPositions) — ONE
   *  combined budget shared by equity + options, not a profile preset (see
   *  riskProfiles.ts). Sourced from config the same way `equity` already is. */
  maxConcurrentPositions: number;
  correlatedNotional: number;
  /** Everything below is a directly user-configured AutotradeConfig field —
   *  all used to live in riskProfiles.ts's MODERATE/AGGRESSIVE preset table,
   *  moved out 2026-07-10 for the same reason maxConcurrentPositions was:
   *  switching riskProfile silently changing a cap the user explicitly set
   *  would be a worse surprise than leaving profile-switching alone. See
   *  AutotradeConfig's own doc comments for the full reasoning/defaults. */
  riskPerTradePct: number;
  maxDailyDrawdownPct: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  maxAggregateOpenRiskPct: number;
  maxCorrelatedExposurePct: number;
  maxTradesPerDay: number;
  /** For the max_correlated_exposure check's own display string below — the
   *  actual correlation computation already happened before this context was
   *  built (see correlatedNotional()'s own lookbackDays/threshold params). */
  correlationThreshold: number;
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
 * Evaluate one already-sized signal against the configured risk caps. Pure —
 * no I/O. `ctx` carries everything the checks need — every cap is a directly
 * user-configured AutotradeConfig field now (see RiskCheckContext's doc
 * comment), including any signals already approved earlier in the same batch
 * (see runAutotradeRiskCheck).
 */
export function evaluateRiskCheck(signal: TradeSignal, ctx: RiskCheckContext): RiskCheckResult {
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

  const stepDownActive = ctx.consecutiveLosses >= ctx.stepDownAfterLosses;
  const effectiveRiskPct = stepDownActive
    ? ctx.riskPerTradePct * (1 - ctx.stepDownSizeCutPct / 100)
    : ctx.riskPerTradePct;
  check(
    'step_down_sizing',
    true,
    stepDownActive
      ? `active — ${ctx.consecutiveLosses} consecutive losses, sizing at ${effectiveRiskPct}% instead of ${ctx.riskPerTradePct}% (${ctx.stepDownSizeCutPct}% cut)`
      : `inactive — ${ctx.consecutiveLosses} consecutive losses (triggers at ${ctx.stepDownAfterLosses})`,
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

  const dailyHaltLevel = -(ctx.maxDailyDrawdownPct / 100) * ctx.equity;
  const haltOk = ctx.dailyPnl > dailyHaltLevel;
  check(
    'daily_drawdown_halt',
    haltOk,
    `today ${usd(ctx.dailyPnl)} vs halt at ${usd(dailyHaltLevel)} (${ctx.maxDailyDrawdownPct}% of equity)`,
  );

  const tradesOk = ctx.tradesToday < ctx.maxTradesPerDay;
  check('max_trades_per_day', tradesOk, `${ctx.tradesToday} placed vs ${ctx.maxTradesPerDay}/day`);

  const positionsOk = ctx.openPositionsCount < ctx.maxConcurrentPositions;
  check('max_concurrent_positions', positionsOk, `${ctx.openPositionsCount} open vs cap ${ctx.maxConcurrentPositions}`);

  // CRITICAL: distinct from the daily halt, which only reacts to REALIZED
  // losses after trades close. This is the pre-trade check — sum(size × stop
  // distance) across ALL open + this proposed position — that blocks BEFORE
  // several positions could get stopped out together and blow past the daily
  // halt before it can even trigger.
  const aggregateCap = (ctx.maxAggregateOpenRiskPct / 100) * ctx.equity;
  const aggregateAfter = ctx.openRisk + sizing.riskOfPosition;
  const aggregateOk = aggregateAfter <= aggregateCap;
  check(
    'max_aggregate_open_risk',
    aggregateOk,
    `${usd(aggregateAfter)} vs cap ${usd(aggregateCap)} (${ctx.maxAggregateOpenRiskPct}% of equity)`,
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
  const correlatedCap = (ctx.maxCorrelatedExposurePct / 100) * ctx.equity;
  const correlatedOk = ctx.correlatedNotional <= correlatedCap;
  check(
    'max_correlated_exposure',
    correlatedOk,
    `${usd(ctx.correlatedNotional)} already correlated vs cap ${usd(correlatedCap)} (${ctx.maxCorrelatedExposurePct}% of equity, |r| ≥ ${ctx.correlationThreshold})`,
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
  const snapshot = getPortfolioSnapshot();

  const results: RiskCheckResult[] = [];
  let runningRisk = snapshot.openPositions.reduce((s, p) => s + p.riskAmount, 0);
  let runningCount = snapshot.openPositions.length;
  const runningPositions = [...snapshot.openPositions];

  for (const signal of signals) {
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      runningPositions,
      config.correlationLookbackDays,
      config.correlationThreshold,
    );
    const ctx: RiskCheckContext = {
      equity: snapshot.equity ?? 0,
      dailyPnl: snapshot.dailyPnl,
      tradesToday: snapshot.tradesToday,
      consecutiveLosses: snapshot.consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      maxConcurrentPositions: config.maxConcurrentPositions,
      correlatedNotional: correlated,
      riskPerTradePct: config.riskPerTradePct,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
      stepDownAfterLosses: config.stepDownAfterLosses,
      stepDownSizeCutPct: config.stepDownSizeCutPct,
      maxAggregateOpenRiskPct: config.maxAggregateOpenRiskPct,
      maxCorrelatedExposurePct: config.maxCorrelatedExposurePct,
      maxTradesPerDay: config.maxTradesPerDay,
      correlationThreshold: config.correlationThreshold,
    };
    const result = evaluateRiskCheck(signal, ctx);
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
