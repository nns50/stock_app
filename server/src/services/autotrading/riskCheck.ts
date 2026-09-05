import { getProvider } from '../../providers';
import { listPositions, Position } from '../../db/positions';
import { realizedPnlOf, initialRiskOf, computeStreaksAndDrawdown } from '../pnl';
import { computeRiskSizing, RiskSizingResult } from '../riskSizing';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent, listAutotradeEvents } from '../../db/autotradeEvents';
import { listUniverse } from '../../db/universe';
import { getMarketAtrPct } from './executionGuards';
import { computeEquityCurveDerisk } from './equityCurveDerisk';
import {
  cutFactor,
  effectiveRiskPct as computeEffectiveRiskPct,
  isRegimeActive,
  isStepDownActive,
  preFinishLineFactors,
} from './effectiveRisk';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { computeMethodMultipliers, methodOfEquitySignal } from './methodSizing';
import { fundableMaxQuantity, isTooSmallToFund, MIN_FUNDED_SIZE_FRACTION } from './buyingPowerSizing';
import { listLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { TradeSignal, convictionGrade } from './decide';

// ---------------------------------------------------------------------------
// The Risk Check stage (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP, stage 3;
// this is the safety-critical core the spec calls out for the heaviest test
// coverage). Sizes a signal by the active risk profile (with step-down after
// consecutive losses), then gates it against every profile cap — including
// the CRITICAL max-aggregate-open-risk pre-trade check and the
// statistical-correlation exposure cap. Pure evaluator + an async wrapper that
// assembles real portfolio state; no orders are placed here.
//
// getPortfolioSnapshot() below scopes daily P&L, the consecutive-loss streak,
// and open-position risk to auto-trading's OWN positions (tagged 'autotrade'
// — same filter liveExecute.ts's getLivePortfolioSnapshot() already uses),
// not every position in the journal. This used to be deliberately
// account-wide ("can't understate real exposure") back when auto-trading was
// paper-only and live execution didn't exist yet to give that philosophy a
// real, separately-enforced counterpart. Once live trading (Phase 8) shipped
// its own autotrade-scoped runLiveExecution()/getLivePortfolioSnapshot(),
// this function's account-wide reading stopped matching what actually gates
// a real order — a user's own manually-placed trades could inflate this
// preview's aggregate-risk/daily-drawdown figures well past what the live
// loop itself was seeing, making the risk-check preview block candidates the
// live loop would have approved. Scoping both to the same 'autotrade' tag
// keeps them consistent.
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

// n.toLocaleString(locale, options) re-parses the options and builds a fresh
// ICU formatter on EVERY call — tens of microseconds each, dominant enough
// that a large backtest (thousands of evaluateRiskCheck calls, several usd()
// calls apiece) spends the bulk of its time here. A single cached
// Intl.NumberFormat, reused via .format(), is the identical formatting
// algorithm minus the repeated construction cost — same output, ~40x faster.
const usdFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usd(n: number): string {
  return `$${usdFormatter.format(n)}`;
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

/** Null when neither an exit nor an entry date is known. */
const lastExitDate = (p: Position): string | null =>
  p.exits.length
    ? p.exits
        .map((e) => e.exitDate)
        .sort()
        .slice(-1)[0]
    : p.entryDate;

/** A position auto-trading itself placed, vs. one the user entered manually
 *  from the Trade page — both live in the SAME `positions` table. Duplicated
 *  from liveExecute.ts's own (unexported) isAutotradePosition rather than
 *  imported — liveExecute.ts already imports FROM this file (RiskCheckResult/
 *  evaluateRiskCheck), so importing the other way would be circular; same
 *  small-pure-helper-duplication convention as etDateStr above. */
const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

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
  /** Today's realized P&L across auto-trading's own closed positions only —
   *  a manually-placed trade never counts here (see the file header). */
  dailyPnl: number;
  /** Auto-trading's own order placements today. */
  tradesToday: number;
  /** Length of the current losing streak (0 if the last closed trade wasn't a loss). */
  consecutiveLosses: number;
  /** Equity-curve de-risk decision from this book's own realized curve (2026-07-24) —
   *  false when disabled or above the average. */
  equityCurveDeriskActive: boolean;
  /** grade → sizing multiplier from this book's realized per-grade edge
   *  (2026-07-24); empty when expectancy weighting is off. */
  gradeExpectancyMultipliers: Record<string, number>;
  /** method → sizing multiplier from this book's recent per-method edge
   *  (2026-08-21); empty when method weighting is off. */
  methodMultipliers: Record<string, number>;
  openPositions: OpenRiskItem[];
}

/** Assemble current portfolio state from the journal + config. No provider/
 *  broker calls — see the file header for what's deliberately deferred. */
export function getPortfolioSnapshot(): PortfolioSnapshot {
  const equity = getAutotradeConfig().accountEquityUsd;

  const todayStr = etDateStr();
  const closedPositions = listPositions({ status: 'closed' }).filter(isAutotradePosition);
  const closedTrades = closedPositions
    .map((p) => ({ date: lastExitDate(p), pnl: realizedPnlOf(p) }))
    // Undated trades have no place on a chronological curve — dropped rather
    // than anchored to a guessed date (see db/positions.ts on why entryDate
    // can be null at all).
    .filter((t): t is { date: string; pnl: number } => t.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyPnl = closedTrades.filter((t) => t.date === todayStr).reduce((s, t) => s + t.pnl, 0);
  const streak = computeStreaksAndDrawdown(closedTrades.map((t) => t.pnl)).currentStreak;
  const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;
  const cfg = getAutotradeConfig();
  const equityCurveDeriskActive = computeEquityCurveDerisk(closedTrades, {
    enabled: cfg.equityCurveDeriskEnabled,
    lookbackDays: cfg.equityCurveLookbackDays,
    cutPct: cfg.equityCurveDeriskCutPct,
  }).active;
  const gradeExpectancyMultipliers = computeGradeExpectancyMultipliers(
    closedPositions.flatMap((p) => {
      const risk = initialRiskOf(p);
      return risk && risk > 0 ? [{ grade: p.grade, realizedR: realizedPnlOf(p) / risk }] : [];
    }),
    {
      enabled: cfg.expectancyWeightingEnabled,
      minTrades: cfg.expectancyMinTrades,
      minMultiplier: cfg.expectancyMinMultiplier,
      maxMultiplier: cfg.expectancyMaxMultiplier,
    },
  );

  const methodMultipliers = computeMethodMultipliers(
    closedPositions,
    cfg,
    listLiveOptionsPositions({ status: 'closed' }),
  );

  const tradesToday = listAutotradeEvents({ stage: 'execution', limit: 1000 }).filter(
    (e) => e.action === 'order_placed' && etDateStr(e.createdAt) === todayStr,
  ).length;

  const openPositions: OpenRiskItem[] = listPositions({ status: 'open' })
    .filter(isAutotradePosition)
    .map((p) => ({
      symbol: p.symbol,
      riskAmount: p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.remainingQuantity * p.multiplier : 0,
      notional: p.entryPrice * p.remainingQuantity * p.multiplier,
    }));

  return {
    equity,
    dailyPnl,
    tradesToday,
    consecutiveLosses,
    equityCurveDeriskActive,
    gradeExpectancyMultipliers,
    methodMultipliers,
    openPositions,
  };
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
 *  gap risk this cap is layered on top of.
 *
 *  `candidateSide`/`pos.side` (added 2026-07-14 for the equity long+short
 *  feature): a correlated position on the SAME side as the candidate
 *  compounds risk (a long AAPL and a long MSFT both drop together in a tech
 *  selloff — additive, the original behavior). A correlated position on the
 *  OPPOSITE side partially HEDGES the candidate instead (a long AAPL and a
 *  SHORT MSFT move against each other in that same selloff — genuinely
 *  different risk, not more of the same) — subtracted, not added. The net
 *  is floored at 0: a hedge can cancel out correlated risk, it can't create
 *  negative "risk" for the cap to compare against. Every existing caller
 *  (options, paper/live equity before this feature) that only ever holds
 *  one side passes the SAME side for every position and the candidate —
 *  amount reduces to exactly the old always-additive sum, unchanged. */
/** Exported for reuse by the Phase 6 paper execution loop (execute.ts), which
 *  needs the same live-fetching correlation check against its own running
 *  paper-portfolio state — not a from-scratch reimplementation (see
 *  backtest.ts's separate offline `backtestCorrelatedNotional`, which exists
 *  only because a backtest has no live network access during simulation). */
export async function correlatedNotional(
  symbol: string,
  candidateSide: 'long' | 'short',
  positions: { symbol: string; notional: number; side: 'long' | 'short' }[],
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
    if (r !== null && Math.abs(r) >= threshold) amount += pos.side === candidateSide ? pos.notional : -pos.notional;
  }
  return { amount: Math.max(0, amount), correlations };
}

/** Builds the `sectorOf` lookup every sectorNotional() caller needs — one
 *  query, reused across a whole batch, exactly like routes/positions.ts's own
 *  `sectorBySymbol` map (the only other caller of the universe table for this
 *  purpose). Uppercased to match how symbols are actually stored/compared
 *  elsewhere (positions' own symbols aren't guaranteed to already be upper). */
export function buildSectorOf(): (symbol: string) => string | null {
  const bySymbol = new Map(listUniverse().map((u) => [u.symbol.toUpperCase(), u.sector]));
  return (symbol: string) => bySymbol.get(symbol.toUpperCase()) ?? null;
}

/** Capital (across `positions`) in the SAME universe sector as `symbol` — a
 *  cheaper, complementary cousin of correlatedNotional() above: sector is a
 *  static classification (db/universe.ts's own `sector` column, set when a
 *  symbol is added to the universe), not a live statistical computation, so
 *  this needs no candle fetch and stays fully synchronous. Two names in the
 *  same sector can carry LOW price correlation today (idiosyncratic
 *  catalysts) and still share the same macro/sector-wide risk the
 *  correlation cap alone would miss — this backstops that gap, it doesn't
 *  replace the correlation cap.
 *
 *  Same same-side-additive/opposite-side-hedge convention as
 *  correlatedNotional() (see its own doc comment): a long+long pair in the
 *  same sector compounds, a long+short pair partially hedges, floored at 0.
 *
 *  A candidate with no sector classification (sectorOf returns null) is
 *  excluded from the cap entirely — same "unknown, not assumed concentrated"
 *  reasoning correlatedNotional() uses for a candle-fetch failure — since
 *  there's nothing to compare it against. */
export function sectorNotional(
  symbol: string,
  candidateSide: 'long' | 'short',
  positions: { symbol: string; notional: number; side: 'long' | 'short' }[],
  sectorOf: (symbol: string) => string | null,
): { amount: number; sector: string | null } {
  const sector = sectorOf(symbol);
  if (sector === null) return { amount: 0, sector: null };
  let amount = 0;
  for (const pos of positions) {
    if (sectorOf(pos.symbol) !== sector) continue;
    amount += pos.side === candidateSide ? pos.notional : -pos.notional;
  }
  return { amount: Math.max(0, amount), sector };
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
  /** sectorNotional()'s own output, threaded in the same way correlatedNotional
   *  is above — the actual computation already happened before this context
   *  was built. */
  sectorNotional: number;
  maxSectorExposurePct: number;
  /** The candidate's own sector (sectorNotional()'s second return value) —
   *  null skips the max_sector_exposure check entirely (see its doc comment
   *  for why: nothing to compare an unclassified symbol against). */
  candidateSector: string | null;
  /** OPTIONS ONLY, and only for single-leg sizing (2026-09-02): the deepest
   *  premium loss the exit ladder will actually hold a position through —
   *  AutotradeConfig.optionsDisasterStopPct, enforced by
   *  shortDatedOptionsExit's `disaster_stop` on BOTH books. Sizing used to
   *  assume 100% of premium (stopPrice: 0), which is a loss the exit path
   *  never permits in an orderly market, so a position sized that way risked
   *  only riskPerTradePct x this fraction when the stop it will actually hit
   *  fires — under-sizing by 1/fraction against the user's own stated risk
   *  appetite, and at a small account it priced options out entirely (a
   *  $63.43 budget bought nothing above $0.634 of premium).
   *
   *  Optional and fails SAFE: undefined, 0, or >= 100 all fall back to the
   *  full-premium assumption, which is exactly the previous behaviour. Ignored
   *  by the equity path and by debit spreads, whose loss is structural. */
  optionsDisasterStopPct?: number;
  /** Regime-aware sizing (2026-07-16, docs/AUTOTRADING_SPEC.md phase 18).
   *  `marketAtrPct` is the SAME broad-market-proxy (SPY) ATR% reading
   *  executionGuards.ts's checkVolatility() already gates entries on — null
   *  when unknown (a fetch failure, or a caller that doesn't compute it, e.g.
   *  every backtest engine), treated as "regime cut inactive," exactly like
   *  checkVolatility() itself treats a null market reading as non-blocking.
   *  `regimeAtrThresholdPct`/`regimeSizeCutPct` are the directly
   *  user-configured AutotradeConfig fields (see their own doc comments). */
  marketAtrPct: number | null;
  regimeAtrThresholdPct: number;
  regimeSizeCutPct: number;
  /** Equity-curve de-risking (2026-07-24, services/autotrading/equityCurveDerisk.ts).
   *  Optional — only the LIVE and PAPER equity paths (which have a per-book
   *  realized equity curve) set these; every other caller (backtest engines,
   *  options) leaves them undefined, which reads as inactive, exactly like
   *  `marketAtrPct: null` scopes regime sizing out of those paths. `active` is
   *  the pre-computed "curve below its N-day average" decision (the caller's
   *  snapshot did the history math); `cutPct` is the configured size cut. */
  equityCurveDeriskActive?: boolean;
  equityCurveDeriskCutPct?: number;
  /** ADV participation cap (2026-07-24): the max % of a name's ~20-day average
   *  daily volume a single position may take. Optional — only the equity
   *  live/paper/preview paths set it (from AutotradeConfig.maxAdvParticipationPct);
   *  0 or undefined means no cap. Needs the signal's own `avgVolume` to apply;
   *  when that's unresolved the cap is skipped (reported, not blocked). */
  maxAdvParticipationPct?: number;
  /** Available buying power, when the caller knows it (the LIVE path reads it
   *  from the broker each batch). Undefined on paper and on a failed broker
   *  read, which imposes no constraint — sizing behaves exactly as it did
   *  before. See buyingPowerSizing.ts for why the sizer, not just the
   *  guardrail, has to see this. */
  buyingPowerUsd?: number;
  /** Per-order notional ceiling the guardrail will enforce (order_notional).
   *  LIVE only — paper and the preview route have no such guardrail, which is
   *  a written-down decision, not an omission: they place nothing. */
  maxOrderUsd?: number;
  /** Room left under the account exposure cap (account_exposure), i.e.
   *  maxExposureUsd − exposureUsd. LIVE only, same reason. */
  exposureHeadroomUsd?: number;
  /** Signed marketable-limit buffer % the placed order will carry, so the
   *  sizer values the order at the same price the guardrail will. LIVE only. */
  limitBufferPct?: number;
  /** Expectancy-weighted sizing multiplier (2026-07-24) for THIS candidate's
   *  conviction grade, pre-computed by the caller from the book's realized
   *  per-grade edge (services/autotrading/expectancySizing.ts). Optional — only
   *  the equity live/paper/preview paths set it; 1 or undefined = neutral. */
  expectancyMultiplier?: number;
  /** Per-METHOD sizing lean (methodSizing.ts) — 1 when method weighting is off
   *  or this signal's method has no proven recent edge. */
  methodMultiplier?: number;
  /** Finish-line sizing trim (finishLine.ts, 2026-08-22) — ≤ 1, pre-computed
   *  by the LIVE callers from the day's remaining gap to the bank line; 1 or
   *  undefined = no trim (paper, backtests, previews, or feature off). */
  finishLineFactor?: number;
  /** finishLine.ts's own explanation string for the check line below. */
  finishLineDetail?: string;
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
  /** Regime-aware sizing cut active this check (2026-07-16) — see
   *  RiskCheckContext.marketAtrPct's own doc comment. */
  regimeActive: boolean;
  /** Equity-curve de-risking cut active this check (2026-07-24). */
  equityCurveDeriskActive: boolean;
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
  const blocked = (
    sizing: RiskSizingResult,
    stepDownActive: boolean,
    regimeActive: boolean,
    equityCurveDeriskActive: boolean,
  ): RiskCheckResult => ({
    symbol: signal.symbol,
    ok: false,
    checks,
    sizing,
    stepDownActive,
    regimeActive,
    equityCurveDeriskActive,
    approvedRiskAmount: 0,
    approvedNotional: 0,
  });

  const equityOk = ctx.equity > 0;
  check(
    'equity_configured',
    equityOk,
    equityOk ? usd(ctx.equity) : 'account equity is not set — configure it before auto-trading can size positions',
  );
  if (!equityOk) return blocked(ZERO_SIZING, false, false, false);

  const stepDownActive = isStepDownActive(ctx.consecutiveLosses, ctx.stepDownAfterLosses);
  const regimeActive = isRegimeActive(ctx.marketAtrPct, ctx.regimeAtrThresholdPct);
  const equityCurveDeriskActive = ctx.equityCurveDeriskActive === true;
  const equityCurveCutPct = ctx.equityCurveDeriskCutPct ?? 0;
  const expectancyMultiplier = ctx.expectancyMultiplier ?? 1;
  const methodMultiplier = ctx.methodMultiplier ?? 1;
  const finishLineFactor = ctx.finishLineFactor ?? 1;
  // Through the shared SizingFactors, not a local product: optionsRiskCheck
  // carried its own copy of this line and they drifted (see effectiveRisk.ts).
  // Every field is required, so a new factor cannot be added to one book and
  // forgotten on the other. The caller derives finishLineFactor from
  // preFinishLineRiskPct over these same five, so the trim reasons about the
  // payoff this trade will really produce.
  const effectiveRiskPct = computeEffectiveRiskPct(ctx.riskPerTradePct, {
    ...preFinishLineFactors({
      consecutiveLosses: ctx.consecutiveLosses,
      stepDownAfterLosses: ctx.stepDownAfterLosses,
      stepDownSizeCutPct: ctx.stepDownSizeCutPct,
      marketAtrPct: ctx.marketAtrPct,
      regimeAtrThresholdPct: ctx.regimeAtrThresholdPct,
      regimeSizeCutPct: ctx.regimeSizeCutPct,
      equityCurveDerisk: cutFactor(equityCurveDeriskActive, equityCurveCutPct),
      expectancy: expectancyMultiplier,
      method: methodMultiplier,
    }),
    finishLine: finishLineFactor,
  });
  check(
    'step_down_sizing',
    true,
    stepDownActive
      ? `active — ${ctx.consecutiveLosses} consecutive losses, sizing at ${effectiveRiskPct}% instead of ${ctx.riskPerTradePct}% (${ctx.stepDownSizeCutPct}% cut)`
      : `inactive — ${ctx.consecutiveLosses} consecutive losses (triggers at ${ctx.stepDownAfterLosses})`,
  );
  check(
    'regime_sizing',
    true,
    regimeActive
      ? `active — market ATR ${ctx.marketAtrPct!.toFixed(1)}% exceeds ${ctx.regimeAtrThresholdPct}%, sizing at ${effectiveRiskPct}% instead of ${ctx.riskPerTradePct}% (${ctx.regimeSizeCutPct}% cut)`
      : `inactive — market ATR ${ctx.marketAtrPct == null ? 'unavailable' : ctx.marketAtrPct.toFixed(1) + '%'} (triggers above ${ctx.regimeAtrThresholdPct}%)`,
  );
  check(
    'equity_curve_derisk',
    true,
    equityCurveDeriskActive
      ? `active — strategy equity below its recent average, sizing at ${effectiveRiskPct}% instead of ${ctx.riskPerTradePct}% (${equityCurveCutPct}% cut)`
      : 'inactive — strategy equity at/above its recent average (or disabled)',
  );
  check(
    'expectancy_sizing',
    true,
    expectancyMultiplier !== 1
      ? `active — this grade's realized edge applies a ${expectancyMultiplier}× size multiplier`
      : 'inactive — expectancy weighting off, or this grade has no proven edge yet',
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

  // ADV participation cap (optional): never take more than maxAdvParticipationPct%
  // of the name's average daily volume, so a position stays exitable. Needs the
  // signal's own avgVolume; skipped (not blocked) when that's unresolved.
  const advCapPct = ctx.maxAdvParticipationPct ?? 0;
  const advMaxQty =
    advCapPct > 0 && signal.avgVolume != null && signal.avgVolume > 0
      ? Math.floor((advCapPct / 100) * signal.avgVolume)
      : undefined;

  // What risk alone asks for, before funding is considered — the denominator
  // for "how much of the intended trade can this account actually afford".
  const intended = computeRiskSizing({
    accountSize: ctx.equity,
    riskPct: effectiveRiskPct,
    entryPrice: signal.entry,
    stopPrice: signal.stop,
    assetType: 'stock',
    side: signal.side === 'buy' ? 'long' : 'short',
    maxQuantity: advMaxQty,
  });

  // Buying power caps the size instead of refusing the order later. Before
  // 2026-08-28 this was checked only at the guardrail, on an already-sized
  // order, so an unfundable order was built in full and then blocked — 627
  // times in one session, for zero entries.
  const bp = fundableMaxQuantity({
    buyingPowerUsd: ctx.buyingPowerUsd,
    // The other two dollar bounds guardrails.ts will apply. Passed here so the
    // order is BUILT to fit them; before 2026-09-05 only buying power reached
    // the sizer and the other two were discovered after the order existed.
    maxOrderUsd: ctx.maxOrderUsd,
    exposureHeadroomUsd: ctx.exposureHeadroomUsd,
    entryPrice: signal.entry,
    limitBufferPct: ctx.limitBufferPct,
    // A TradeSignal is always an ENTRY, so this is 'open' for a long AND for a
    // short: both consume buying power. Passing signal.side here used to let
    // every short entry through unconstrained.
    openClose: 'open',
  });
  const fundedCap =
    bp.maxQuantity === undefined
      ? advMaxQty
      : advMaxQty === undefined
        ? bp.maxQuantity
        : Math.min(advMaxQty, bp.maxQuantity);

  const sizing =
    fundedCap === advMaxQty
      ? intended
      : computeRiskSizing({
          accountSize: ctx.equity,
          riskPct: effectiveRiskPct,
          entryPrice: signal.entry,
          stopPrice: signal.stop,
          assetType: 'stock',
          side: signal.side === 'buy' ? 'long' : 'short',
          maxQuantity: fundedCap,
        });

  const bpBound = bp.maxQuantity !== undefined && sizing.suggestedQuantity < intended.suggestedQuantity;
  // A token position still costs a concurrency slot and one of the day's
  // trades; below MIN_FUNDED_SIZE_FRACTION, waiting for a candidate that fits
  // is worth more than being nominally in the market.
  const tooSmall = isTooSmallToFund(sizing.suggestedQuantity, intended.suggestedQuantity);
  check(
    'buying_power_sizing',
    !tooSmall,
    bp.maxQuantity === undefined
      ? 'inactive — no buying-power figure supplied (paper, or the broker read failed)'
      : tooSmall
        ? `only ${sizing.suggestedQuantity} of ${intended.suggestedQuantity} shares fundable from ${usd(bp.usableUsd ?? 0)} — below the ${Math.round(MIN_FUNDED_SIZE_FRACTION * 100)}% floor, skipping rather than taking a token position`
        : bpBound
          ? `sized down to ${sizing.suggestedQuantity} of ${intended.suggestedQuantity} shares to fit ${usd(bp.usableUsd ?? 0)} of buying power — risking ${usd(sizing.riskOfPosition ?? 0)} instead of the intended ${usd(intended.riskOfPosition ?? 0)}`
          : `fits — ${intended.suggestedQuantity} shares inside ${usd(bp.usableUsd ?? 0)} of buying power`,
  );

  const qtyOk = sizing.suggestedQuantity > 0;
  check(
    'quantity',
    qtyOk,
    qtyOk
      ? `${sizing.suggestedQuantity} shares`
      : bp.maxQuantity === 0
        ? `buying power ${usd(bp.usableUsd ?? 0)} will not fund a single share at ${usd(signal.entry)}`
        : 'risk budget is too small to size even one share at this stop distance',
  );
  check(
    'adv_participation_cap',
    true,
    advCapPct === 0
      ? 'inactive — no ADV participation cap set'
      : signal.avgVolume == null || signal.avgVolume <= 0
        ? `skipped — ${advCapPct}% cap set but this name's avg daily volume is unavailable`
        : `${advCapPct}% of ${Math.round(signal.avgVolume).toLocaleString()} ADV = ${advMaxQty} share cap`,
  );
  if (!qtyOk) return blocked(sizing, stepDownActive, regimeActive, equityCurveDeriskActive);

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

  // Complementary to the correlation cap above, not a replacement — see
  // sectorNotional()'s own doc comment. Skipped entirely (no rule added, not
  // a passing one) when the candidate has no sector classification, since
  // there's nothing to compare it against. Truthy check (not `!== null`)
  // deliberately also treats a MISSING field as "skip" — a hand-built
  // RiskCheckContext fixture that predates this field (test files aren't
  // type-checked, see web/tsconfig.json's own precedent) gets `undefined`,
  // not `null`, and `undefined !== null` would otherwise slip past the guard
  // and run the check against NaN-derived numbers.
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
    equityCurveDeriskActive,
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
  // Fetched fresh here (rather than threaded in as a parameter, unlike the
  // real execution paths — see loop.ts) since this is a self-contained manual
  // preview endpoint that already independently re-fetches everything else
  // (config, portfolio snapshot) rather than accepting it from a caller.
  // 'SPY' matches loop.ts's own hardcoded proxy symbol — not actually
  // user-configurable anywhere despite VolatilityFilterConfig's own field.
  const marketAtrPct = await getMarketAtrPct('SPY');

  const results: RiskCheckResult[] = [];
  let runningRisk = snapshot.openPositions.reduce((s, p) => s + p.riskAmount, 0);
  let runningCount = snapshot.openPositions.length;
  // OpenRiskItem carries no `side` — this manual preview endpoint
  // (routes/autotrade.ts's /risk-check) can't distinguish an existing
  // position's real long/short here, so every existing position is treated
  // as 'long' (preserves this endpoint's original always-additive behavior
  // for a 'buy' signal exactly; for a 'sell' signal being previewed,
  // correlatedNotional() will now correctly net against these — accurate as
  // long as the existing book actually is long, which is the same
  // assumption this endpoint already made before per-signal direction
  // existed at all). The real live/paper execution paths (liveExecute.ts /
  // execute.ts) are fully side-aware; only this preview has the gap.
  const runningPositions: (OpenRiskItem & { side: 'long' | 'short' })[] = snapshot.openPositions.map((p) => ({
    ...p,
    side: 'long',
  }));
  const sectorOf = buildSectorOf();

  for (const signal of signals) {
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
      runningPositions,
      config.correlationLookbackDays,
      config.correlationThreshold,
    );
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
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
      equityCurveDeriskActive: snapshot.equityCurveDeriskActive,
      equityCurveDeriskCutPct: config.equityCurveDeriskCutPct,
      maxAdvParticipationPct: config.maxAdvParticipationPct,
      expectancyMultiplier:
        snapshot.gradeExpectancyMultipliers[
          convictionGrade(signal.score, {
            aMinScore: config.convictionGradeAMinScore,
            bMinScore: config.convictionGradeBMinScore,
          })
        ] ?? 1,
      methodMultiplier: snapshot.methodMultipliers[methodOfEquitySignal(signal.side)] ?? 1,
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
        side: signal.side === 'buy' ? 'long' : 'short',
      });
    }
  }

  return results;
}
