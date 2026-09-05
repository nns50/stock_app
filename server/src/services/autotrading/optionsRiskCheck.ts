import { computeRiskSizing, computeSpreadSizing, RiskSizingResult, SpreadSizingResult } from '../riskSizing';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { getMarketAtrPct } from './executionGuards';
import { OptionsTradeSignal } from './optionsDecide';
import {
  correlatedNotional,
  sectorNotional,
  buildSectorOf,
  getPortfolioSnapshot,
  RiskCheckContext,
  RiskCheckResult,
  RiskCheckRule,
} from './riskCheck';
import {
  cutFactor,
  factorState,
  effectiveRiskPct as computeEffectiveRiskPct,
  isRegimeActive,
  isStepDownActive,
  preFinishLineFactors,
  NEUTRAL,
} from './effectiveRisk';

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
// Not wired into the unconditional 24/7 loop tick for the 'debit_spread'
// shape's actual PAPER EXECUTION — optionsExecute.ts's attemptOptionsPaperEntry
// only knows how to open a single-contract position (the
// autotrade_options_paper_positions schema is single-contract), so a spread
// signal is risk-checked (below) exactly like a single-leg one — the combined
// budget applies to both — but is skipped with a clear reason at the final
// "open a position" step rather than mis-recorded as a single leg. Decision
// and risk-check are otherwise identical for both shapes, mirroring how
// equity's OWN risk-check started, before phase 6 gave it a real
// paper-execution consumer.
// ---------------------------------------------------------------------------

export type OptionsSizingResult = RiskSizingResult | SpreadSizingResult;

/** Same shape as RiskCheckResult, except `sizing` can be EITHER a single-leg
 *  RiskSizingResult or a SpreadSizingResult, depending on signal.kind — kept
 *  as its own type (not a change to the shared RiskCheckResult) so equity's
 *  own risk-check path, which only ever produces RiskSizingResult, needs no
 *  narrowing anywhere it's consumed. */
export interface OptionsRiskCheckResult extends Omit<RiskCheckResult, 'sizing'> {
  sizing: OptionsSizingResult;
}

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

const ZERO_SPREAD_SIZING: SpreadSizingResult = {
  maxRiskDollars: 0,
  maxLossPerSpread: 0,
  maxProfitPerSpread: 0,
  suggestedContracts: 0,
  totalMaxLoss: 0,
  totalMaxProfit: 0,
  positionPctOfAccount: 0,
  rewardRiskRatio: null,
  warnings: [],
};

// Cached formatter instead of calling n.toLocaleString(locale, options) fresh
// every time — that re-parses the options and builds a new ICU formatter on
// EVERY call (tens of microseconds each), dominant enough to matter across
// the thousands of evaluateOptionsRiskCheck calls a large options/combined
// backtest makes. Same output, reusing one Intl.NumberFormat via .format().
/** Standard equity-option contract multiplier. */
const OPTION_MULTIPLIER = 100;

/**
 * Capital an OPEN options position has deployed — NET premium paid, times
 * contracts, times the multiplier. This is the number the correlated- and
 * sector-exposure checks want, and it is NOT the position's riskAmount.
 *
 * Those checks used to read `riskAmount` for it, which was correct only by
 * coincidence: while single-leg sizing assumed the whole premium was at risk,
 * risk and cost were the same number. Sizing against the disaster stop
 * (2026-09-02) broke that identity for a single leg — riskAmount became 70% of
 * cost — and reading it as notional would have understated those positions'
 * exposure by 30%. Exported so both books compute it the same way instead of
 * each reaching for a convenient sibling field.
 *
 * `entryPrice` is the LONG leg's premium, not the net debit, so a spread must
 * subtract the credit its short leg brought in — otherwise this overstates a
 * spread's cost by the whole short premium (the fixture that caught it: long 3,
 * short 1, 2 contracts — $400 deployed, not $600). A single leg carries no
 * short leg and nets to its own premium, unchanged. A spread's max loss IS its
 * net debit, so for that shape risk and notional legitimately remain equal.
 */
export function optionsPositionNotionalUsd(p: {
  entryPrice: number;
  quantity: number;
  shortEntryPrice?: number | null;
}): number {
  return (p.entryPrice - (p.shortEntryPrice ?? 0)) * p.quantity * OPTION_MULTIPLIER;
}

const usdFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usd(n: number): string {
  return `$${usdFormatter.format(n)}`;
}

/**
 * Evaluate one already-generated options signal against the configured risk
 * caps. Pure — no I/O. `ctx` carries everything the checks need — every cap
 * is a directly user-configured AutotradeConfig field (see RiskCheckContext's
 * doc comment) — including the real portfolio state PLUS any signal (equity
 * or options) already approved earlier in the same combined batch. Sizing
 * math branches on signal.kind (single-leg premium-at-risk vs. spread
 * max-loss); every other check (drawdown halt, trade/position caps, combined
 * aggregate-risk budget, correlated exposure) is identical for both shapes.
 */
export function evaluateOptionsRiskCheck(signal: OptionsTradeSignal, ctx: RiskCheckContext): OptionsRiskCheckResult {
  const checks: RiskCheckRule[] = [];
  const check = (rule: string, passed: boolean, detail: string) => checks.push({ rule, passed, detail });
  const blocked = (
    sizing: OptionsSizingResult,
    stepDownActive: boolean,
    regimeActive: boolean,
  ): OptionsRiskCheckResult => ({
    symbol: signal.symbol,
    ok: false,
    checks,
    sizing,
    stepDownActive,
    regimeActive,
    // Equity-curve de-risk is an equity-only sizing factor; options never sets it.
    equityCurveDeriskActive: false,
    approvedRiskAmount: 0,
    approvedNotional: 0,
  });
  const zeroSizing = signal.kind === 'debit_spread' ? ZERO_SPREAD_SIZING : ZERO_SIZING;

  const equityOk = ctx.equity > 0;
  check(
    'equity_configured',
    equityOk,
    equityOk ? usd(ctx.equity) : 'account equity is not set — configure it before auto-trading can size positions',
  );
  if (!equityOk) return blocked(zeroSizing, false, false);

  // Both predicates come from effectiveRisk.ts now. The "threshold of 0 means
  // OFF" guard used to be written out twice, and the equity copy was fixed
  // while this one was missed — pinning the regime cut permanently ON here and
  // halving every options position. One copy cannot be half-fixed.
  const stepDownActive = isStepDownActive(ctx.consecutiveLosses, ctx.stepDownAfterLosses);
  const regimeActive = isRegimeActive(ctx.marketAtrPct, ctx.regimeAtrThresholdPct);
  const methodMultiplier = ctx.methodMultiplier ?? 1;
  const finishLineFactor = ctx.finishLineFactor ?? 1;
  // NOT here, deliberately as of 2026-09-05: the GRADE-expectancy multiplier
  // (expectancySizing.ts). Options entries are stamped with a grade like every
  // other autotrade entry, and that grade feeds the Journal's per-grade edge
  // report — but it does not size them.
  //
  // Recorded because it was the one asymmetry in the sizing stack with no
  // stated reason. Auditing all four books, every other difference is either
  // uniform or explained: the method lean now applies to all four, the
  // finish-line factor is live-only on both instruments (it is about the live
  // daily target), equity-curve de-risk says "options never sets it" a few
  // lines up, and the ADV participation cap is a share-volume idea options
  // replace with their own open-interest and volume floors. Grade expectancy
  // was simply never wired here.
  //
  // Left OFF rather than switched on, for two reasons. It is live money, and
  // turning on a new size multiplier is not a change to make on inference
  // about intent. And it would do nothing yet in any case: the multiplier is
  // gated on expectancyMinTrades (10) closed trades PER GRADE, and the options
  // books are nowhere near that. Worth a deliberate decision once they are —
  // the argument against is that an option's R is premium paid while the grade
  // is scored from the UNDERLYING's screener total, so the two are further
  // apart than they are for a stock.
  // Through the SAME SizingFactors the equity path uses. Both books used to
  // carry their own copy of this product, which is how the two omissions below
  // became invisible: an absent factor looks like nothing at all. Now each one
  // is a written NEUTRAL with a reason, and a new factor does not compile here
  // until this book says what it does with it.
  const effectiveRiskPct = computeEffectiveRiskPct(ctx.riskPerTradePct, {
    ...preFinishLineFactors({
      consecutiveLosses: ctx.consecutiveLosses,
      stepDownAfterLosses: ctx.stepDownAfterLosses,
      stepDownSizeCutPct: ctx.stepDownSizeCutPct,
      marketAtrPct: ctx.marketAtrPct,
      regimeAtrThresholdPct: ctx.regimeAtrThresholdPct,
      regimeSizeCutPct: ctx.regimeSizeCutPct,
      // Equity-only, as the blocked() path a few lines up already states.
      equityCurveDerisk: NEUTRAL,
      // Off by decision, not by omission — see the block above.
      expectancy: NEUTRAL,
      method: methodMultiplier,
    }),
    finishLine: finishLineFactor,
  });
  // Described from the FACTOR, not the trigger — same reasoning as the equity
  // book's copy (see factorState): a threshold firing and a size actually
  // changing are different facts.
  const stepDownState = factorState(stepDownActive, cutFactor(stepDownActive, ctx.stepDownSizeCutPct));
  const regimeState = factorState(regimeActive, cutFactor(regimeActive, ctx.regimeSizeCutPct));
  const sizingAt = `sizing at ${effectiveRiskPct}% instead of ${ctx.riskPerTradePct}%`;
  check(
    'step_down_sizing',
    true,
    stepDownState === 'active'
      ? `active — ${ctx.consecutiveLosses} consecutive losses, ${sizingAt} (${ctx.stepDownSizeCutPct}% cut)`
      : stepDownState === 'triggered-but-neutral'
        ? `triggered at ${ctx.consecutiveLosses} consecutive losses, but the configured cut is 0% — size unchanged`
        : `inactive — ${ctx.consecutiveLosses} consecutive losses (triggers at ${ctx.stepDownAfterLosses})`,
  );
  check(
    'method_sizing',
    true,
    methodMultiplier !== 1
      ? `active — this method's recent realized edge applies a ${methodMultiplier}× size multiplier`
      : 'inactive — method weighting off, or this method has no proven recent edge yet',
  );
  check(
    'finish_line_sizing',
    true,
    ctx.finishLineDetail ??
      (finishLineFactor !== 1
        ? `active — near the daily bank line, risk trimmed to ${Math.round(finishLineFactor * 100)}%`
        : 'inactive — finish-line sizing off, or the day is not near the bank line'),
  );
  check(
    'regime_sizing',
    true,
    regimeState === 'active'
      ? `active — market ATR ${ctx.marketAtrPct!.toFixed(1)}% exceeds ${ctx.regimeAtrThresholdPct}%, ${sizingAt} (${ctx.regimeSizeCutPct}% cut)`
      : regimeState === 'triggered-but-neutral'
        ? `triggered — market ATR ${ctx.marketAtrPct!.toFixed(1)}% exceeds ${ctx.regimeAtrThresholdPct}%, but the configured cut is 0% — size unchanged`
        : `inactive — market ATR ${ctx.marketAtrPct == null ? 'unavailable' : ctx.marketAtrPct.toFixed(1) + '%'} (triggers above ${ctx.regimeAtrThresholdPct}%)`,
  );

  // Sizing itself is the one place single-leg and spread genuinely differ:
  //   - single_leg: sized against the deepest premium loss the exit ladder
  //     will actually hold through — optionsDisasterStopPct, the
  //     `disaster_stop` shortDatedOptionsExit enforces on both books — by
  //     passing that price as the stop to the exact same computeRiskSizing()
  //     the equity path uses. side: 'long' means long the CONTRACT itself,
  //     regardless of call/put direction.
  //
  //     This used to pass stopPrice: 0, i.e. "the whole premium is at risk."
  //     That reads as the conservative choice and is really a unit mismatch
  //     with the exit path (CLAUDE.md: two places deriving the same quantity
  //     must agree by construction). riskPerTradePct is defined as what you
  //     lose WHEN THE STOP HITS; sizing to a 100% loss the exit path never
  //     allows meant hitting the real stop cost only 0.7x the stated appetite,
  //     and one contract is indivisible, so at $5,074.68 equity and 1.25% the
  //     $63.43 budget bought nothing priced above $0.634/share. Every options
  //     position this app had ever opened was 1 contract at 0.54-0.62.
  //
  //     A gap through the disaster stop still loses more than the budget —
  //     which is why the basis is the DISASTER stop (70%) and not the soft
  //     optionsStopLossPct (40%) that usually fires first, and not the 0.5%
  //     underlying stop that usually fires before either. The margin between
  //     70% and 100% is what absorbs slippage.
  //   - debit_spread: no price stop either — a spread's loss is structural
  //     and capped by its own construction (see optionsDecide.ts), so
  //     computeSpreadSizing() sizes by max loss per spread directly, exactly
  //     as it already does for a human-built spread on the Trade page.
  // Everything downstream (drawdown/trade/position/aggregate/correlated
  // checks) reads only the three plain numbers below, not the sizing shape
  // itself, so the rest of this function never has to branch again.
  let sizing: OptionsSizingResult;
  let riskOfPosition: number;
  let positionNotional: number;
  let qtyOk: boolean;
  let qtyDetail: string;
  if (signal.kind === 'debit_spread') {
    const spreadSizing = computeSpreadSizing({
      accountSize: ctx.equity,
      riskPct: effectiveRiskPct,
      width: signal.width,
      netPremium: signal.netDebit,
      direction: 'debit',
    });
    sizing = spreadSizing;
    // Capital tied up = max loss for a debit spread (services/riskSizing.ts's
    // own header comment) — the same reading approvedNotional gets below for
    // a single leg (premium paid).
    riskOfPosition = spreadSizing.totalMaxLoss;
    positionNotional = spreadSizing.totalMaxLoss;
    qtyOk = spreadSizing.suggestedContracts > 0;
    qtyDetail = qtyOk
      ? `${spreadSizing.suggestedContracts} spread${spreadSizing.suggestedContracts === 1 ? '' : 's'}`
      : 'risk budget is too small to size even one spread at this width/net debit';
  } else {
    // Fails SAFE to the old full-premium basis: an absent, zero, or >=100
    // disaster stop all mean "no enforced floor", so assume the whole premium.
    const disasterPct = ctx.optionsDisasterStopPct;
    const maxLossFraction = disasterPct !== undefined && disasterPct > 0 && disasterPct < 100 ? disasterPct / 100 : 1;
    const legSizing = computeRiskSizing({
      accountSize: ctx.equity,
      riskPct: effectiveRiskPct,
      entryPrice: signal.premium,
      stopPrice: Math.round(signal.premium * (1 - maxLossFraction) * 10000) / 10000,
      assetType: 'option',
      side: 'long',
    });
    sizing = legSizing;
    riskOfPosition = legSizing.riskOfPosition;
    positionNotional = legSizing.positionCost;
    qtyOk = legSizing.suggestedQuantity > 0;
    qtyDetail = qtyOk
      ? `${legSizing.suggestedQuantity} contract${legSizing.suggestedQuantity === 1 ? '' : 's'} — risking ${Math.round(maxLossFraction * 100)}% of premium`
      : `risk budget is too small to size even one contract at ${usd(signal.premium)} premium (risking ${Math.round(
          maxLossFraction * 100,
        )}% of it)`;
  }
  check('quantity', qtyOk, qtyDetail);
  if (!qtyOk) return blocked(sizing, stepDownActive, regimeActive);

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

  // The combined budget itself: ctx.openRisk already carries real equity
  // positions' risk PLUS anything (equity or options) approved earlier in
  // this exact batch — see runOptionsRiskCheck.
  const aggregateCap = (ctx.maxAggregateOpenRiskPct / 100) * ctx.equity;
  const aggregateAfter = ctx.openRisk + riskOfPosition;
  const aggregateOk = aggregateAfter <= aggregateCap;
  check(
    'max_aggregate_open_risk',
    aggregateOk,
    `${usd(aggregateAfter)} vs cap ${usd(aggregateCap)} (${ctx.maxAggregateOpenRiskPct}% of equity)`,
  );

  // Notional here is the premium paid / max loss (= approvedRiskAmount,
  // unlike a stock where notional usually exceeds its stop-risk by a wide
  // margin) — a real simplification, not a delta-adjusted/leveraged exposure
  // figure. That would more accurately reflect a long option's actual
  // directional sensitivity to a correlated move, but nothing in this
  // codebase computes one today; premium-paid/max-loss is the same
  // conservative, simple reading this file already uses for "notional"
  // elsewhere.
  const correlatedCap = (ctx.maxCorrelatedExposurePct / 100) * ctx.equity;
  const correlatedOk = ctx.correlatedNotional <= correlatedCap;
  check(
    'max_correlated_exposure',
    correlatedOk,
    `${usd(ctx.correlatedNotional)} already correlated vs cap ${usd(correlatedCap)} (${ctx.maxCorrelatedExposurePct}% of equity)`,
  );

  // Complementary to the correlation cap above — see riskCheck.ts's
  // sectorNotional() doc comment. Skipped when the candidate has no sector
  // classification, same as the equity path. Truthy check, not `!== null` —
  // see evaluateRiskCheck's own identical comment (a hand-built ctx fixture
  // predating this field gets `undefined`, not `null`).
  if (ctx.candidateSector) {
    const sectorCap = (ctx.maxSectorExposurePct / 100) * ctx.equity;
    const sectorOk = ctx.sectorNotional <= sectorCap;
    check(
      'max_sector_exposure',
      sectorOk,
      `${usd(ctx.sectorNotional)} already in ${ctx.candidateSector} vs cap ${usd(sectorCap)} (${ctx.maxSectorExposurePct}% of equity)`,
    );
  }

  const ok = checks.every((c) => c.passed);
  return {
    symbol: signal.symbol,
    ok,
    checks,
    sizing,
    stepDownActive,
    regimeActive,
    equityCurveDeriskActive: false,
    approvedRiskAmount: ok ? riskOfPosition : 0,
    approvedNotional: ok ? positionNotional : 0,
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
): Promise<OptionsRiskCheckResult[]> {
  const config = getAutotradeConfig();
  const snapshot = getPortfolioSnapshot();
  // Self-fetched, same reasoning as runAutotradeRiskCheck's own — see that
  // function's comment.
  const marketAtrPct = await getMarketAtrPct('SPY');
  const approvedEquity = equityResults.filter((r) => r.ok);

  const results: OptionsRiskCheckResult[] = [];
  let runningRisk =
    snapshot.openPositions.reduce((s, p) => s + p.riskAmount, 0) +
    approvedEquity.reduce((s, r) => s + r.approvedRiskAmount, 0);
  let runningCount = snapshot.openPositions.length + approvedEquity.length;
  // This is a manual PREVIEW endpoint (routes/autotrade.ts's /risk-check),
  // not part of the live/paper execution path (that's evaluateRiskCheck/
  // evaluateOptionsRiskCheck, called directly per-candidate — already
  // side-aware, see liveExecute.ts/execute.ts). OpenRiskItem/RiskCheckResult
  // carry no `side`, so a preview equity position's real long/short can't be
  // threaded through here without a bigger plumbing change than a preview
  // endpoint warrants — 'long' for every entry preserves this endpoint's
  // EXISTING always-additive behavior exactly (correlatedNotional()'s own
  // opposite-side netting is a no-op when everything on both sides is
  // 'long'), rather than silently guessing at real equity positions' sides.
  const runningPositions: { symbol: string; notional: number; side: 'long' }[] = [
    ...snapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.notional, side: 'long' as const })),
    ...approvedEquity.map((r) => ({ symbol: r.symbol, notional: r.approvedNotional, side: 'long' as const })),
  ];
  const sectorOf = buildSectorOf();

  for (const signal of signals) {
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      'long',
      runningPositions,
      config.correlationLookbackDays,
      config.correlationThreshold,
    );
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      'long',
      runningPositions,
      sectorOf,
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
      // Single-leg options size against the loss the exit ladder actually
      // enforces, not against a 100% wipeout it never permits. Threaded from
      // config at every options caller so the sizer and the exit path cannot
      // drift apart.
      optionsDisasterStopPct: config.optionsDisasterStopPct,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
      stepDownAfterLosses: config.stepDownAfterLosses,
      stepDownSizeCutPct: config.stepDownSizeCutPct,
      maxAggregateOpenRiskPct: config.maxAggregateOpenRiskPct,
      maxCorrelatedExposurePct: config.maxCorrelatedExposurePct,
      maxTradesPerDay: config.maxTradesPerDay,
      correlationThreshold: config.correlationThreshold,
      sectorNotional: sectorAmount,
      maxSectorExposurePct: config.maxSectorExposurePct,
      candidateSector,
      marketAtrPct,
      regimeAtrThresholdPct: config.regimeAtrThresholdPct,
      regimeSizeCutPct: config.regimeSizeCutPct,
    };
    const result = evaluateOptionsRiskCheck(signal, ctx);
    results.push(result);

    const contracts =
      'suggestedContracts' in result.sizing ? result.sizing.suggestedContracts : result.sizing.suggestedQuantity;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, contracts },
    });

    if (result.ok) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol: signal.symbol, notional: result.approvedNotional, side: 'long' });
    }
  }

  return results;
}
