import { getDailyBaseline } from '../../db/dailyBaseline';
import { MethodStats, computeMethodPerformance } from './methodSizing';
import { listPositions } from '../../db/positions';
import { DailyTargetStatus, evaluateDailyTarget } from './dailyTarget';
import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { PaperPosition } from '../../db/autotradePaperPositions';
import { OptionsPaperPosition } from '../../db/autotradeOptionsPaperPositions';
import { Position } from '../../db/positions';
import { getPaperPortfolioSnapshot } from './execute';
import { getOptionsPaperPortfolioSnapshot } from './optionsExecute';
import { getLivePortfolioSnapshot, getProbationStatus, ProbationStatus } from './liveExecute';
import { LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { getLiveOptionsPortfolioSnapshot, getOptionsProbationStatus } from './liveOptionsExecute';
import { buildSectorOf } from './riskCheck';
import { computeExposure, ExposureSlice, ExposureInput } from '../exposure';
import { daysToExpiration } from '../../options/blackScholes';
import { listAutotradeEvents } from '../../db/autotradeEvents';
import { getLastTick, LastTickRecord } from '../../db/autotradeLastTick';

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

/** Unlike every other "used vs limit" figure in AutotradeDashboard, correlated
 *  exposure has no portfolio-wide instantaneous value — it's relative to a
 *  specific candidate (riskCheck.ts's correlatedNotional() compares ONE
 *  symbol against the rest of the open book). Recomputing it live here would
 *  mean either a second implementation (the header comment's whole point is
 *  to avoid that) or real network calls on every dashboard poll (the same
 *  rate-limit risk realEstateClassifier.ts's own header comment already
 *  flags for a similar per-tick live lookup). Instead, this reads the most
 *  recent risk-check event that actually ran this check — a pure journal
 *  read, zero network calls, and by construction the exact number the risk
 *  engine itself last computed. */
export interface LastCorrelatedExposureCheck {
  symbol: string;
  /** Epoch ms this risk-check ran. */
  checkedAt: number;
  passed: boolean;
  /** Parsed from the journaled detail string (see riskCheck.ts/
   *  optionsRiskCheck.ts's `max_correlated_exposure` rule) — null only if
   *  that ever fails to parse, which shouldn't happen since this app writes
   *  the string it's reading. */
  correlatedNotional: number | null;
}

export interface AutotradeDashboard {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: RiskProfileName;
  /** Null when accountEquityUsd hasn't been configured — every $ cap below is
   *  0 in that case, mirroring how the risk engine itself fails closed until
   *  equity is set (see riskCheck.ts's equity_configured check). */
  equity: number | null;

  /** Progress toward the daily-gain GOAL (services/autotrading/dailyTarget.ts):
   *  the day's starting account value, the % target on it, how far along the
   *  day is, and whether the day is already banked (new live entries halted).
   *  `active: false` when no target is set or nothing is measurable yet. */
  dailyTarget: DailyTargetStatus;

  /** Per-method recent realized performance and the sizing multiplier each
   *  method currently carries (methodSizing.ts) — the "which methods are
   *  working" ledger. Present (with multiplier 1) even when method weighting
   *  is off, so the evidence is visible before anyone acts on it. */
  methodPerformance: MethodStats[];

  /** The automated loop's most recently completed cycle — candidates
   *  screened, entries opened, exactly why it skipped, etc. Null before the
   *  loop has ever run. See db/autotradeLastTick.ts's header comment for why
   *  this is persisted rather than recomputed: it isn't derivable from
   *  current state at all (it's a record of what a PAST tick did), unlike
   *  every other figure in this dashboard. */
  lastTick: LastTickRecord | null;

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

  /** $ cap = maxCorrelatedExposurePct% of equity. See lastCorrelatedExposureCheck
   *  below for why this cap has no matching live "used" figure the way every
   *  other one here does. */
  maxCorrelatedExposure: number;
  /** Null until the loop has risk-checked at least one signal past the
   *  equity/quantity gates (see LastCorrelatedExposureCheck's doc comment). */
  lastCorrelatedExposureCheck: LastCorrelatedExposureCheck | null;

  /** $ cap = maxSectorExposurePct% of equity. UNLIKE maxCorrelatedExposure
   *  above, sector concentration genuinely IS a portfolio-wide instantaneous
   *  value (sector is a static per-symbol classification, not computed
   *  relative to a hypothetical candidate the way correlation is) — so this
   *  is a real live read of the current combined (paper + live, equity +
   *  options) autotrade book, sorted worst-first, not a "last check" journal
   *  read. Weighted by riskAmount (not notional) across all four position
   *  pools, matching this dashboard's own existing risk-based combination
   *  convention (openRisk, maxAggregateOpenRisk, etc.) rather than introducing
   *  a new notional concept. */
  sectorExposure: ExposureSlice[];
  maxSectorExposure: number;

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

interface RiskCheckRuleJson {
  rule: string;
  passed: boolean;
  detail: string;
}

/** Extracts "$8,200.00" -> 8200 from a `max_correlated_exposure` rule's
 *  detail string (see riskCheck.ts: `${usd(ctx.correlatedNotional)} already
 *  correlated vs cap ...`) — the $ figure always comes first. */
function parseCorrelatedNotional(detail: string): number | null {
  const m = /^\$([\d,]+\.\d{2})/.exec(detail);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Walks the journal newest-first for the most recent risk-check that
 *  actually reached the `max_correlated_exposure` rule — an equity-not-set
 *  or too-small-to-size-one-unit block returns before that rule runs, so the
 *  very latest event isn't guaranteed to have it (see riskCheck.ts's early
 *  `blocked()` returns). 200 is comfortably more than one tick's worth of
 *  candidates, so a `null` result genuinely means "hasn't run yet", not
 *  "search gave up too early". */
function getLastCorrelatedExposureCheck(): LastCorrelatedExposureCheck | null {
  const events = listAutotradeEvents({ stage: 'risk_check', limit: 200 });
  for (const event of events) {
    if (!event.detail) continue;
    let parsed: { checks?: RiskCheckRuleJson[] };
    try {
      parsed = JSON.parse(event.detail);
    } catch {
      continue;
    }
    const check = parsed.checks?.find((c) => c.rule === 'max_correlated_exposure');
    if (!check) continue;
    return {
      symbol: event.symbol ?? '',
      checkedAt: event.createdAt,
      passed: check.passed,
      correlatedNotional: parseCorrelatedNotional(check.detail),
    };
  }
  return null;
}

/** Current sector concentration across autotrade's WHOLE combined book (paper
 *  + live, equity + options) — see AutotradeDashboard.sectorExposure's own
 *  doc comment for why this is computed live rather than read from the
 *  journal. Equity positions carry their real side; options are always
 *  'long' (this app only ever buys premium — same convention riskCheck.ts's
 *  correlatedNotional()/sectorNotional() use). */
function computeAutotradeSectorExposure(
  paperEquity: PaperPosition[],
  paperOptions: OptionsPaperPosition[],
  liveEquity: Position[],
  liveOptions: LiveOptionsPosition[],
): ExposureSlice[] {
  const sectorOf = buildSectorOf();
  const inputs: ExposureInput[] = [
    ...paperEquity.map((p) => ({
      symbol: p.symbol,
      side: (p.side === 'buy' ? 'long' : 'short') as 'long' | 'short',
      value: p.riskAmount,
    })),
    // Position (live equity) has no stored riskAmount — same derivation
    // getPortfolioSnapshot() (riskCheck.ts) uses for its own OpenRiskItem.
    ...liveEquity.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      value: p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.remainingQuantity * p.multiplier : 0,
    })),
    ...paperOptions.map((p) => ({ symbol: p.symbol, side: 'long' as const, value: p.riskAmount })),
    ...liveOptions.map((p) => ({ symbol: p.symbol, side: 'long' as const, value: p.riskAmount })),
  ];
  return computeExposure(inputs, sectorOf).bySector;
}

export function getAutotradeDashboard(): AutotradeDashboard {
  const config = getAutotradeConfig();
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
    dailyTarget: evaluateDailyTarget(config, getDailyBaseline()),
    methodPerformance: computeMethodPerformance(
      listPositions({ status: 'closed' }).filter((p) => p.tags.includes('autotrade')),
      config,
    ),
    lastTick: getLastTick(),

    openPositions: snapshot.openPositions,
    openPositionsCount: snapshot.openPositionsCount + optionsSnapshot.openPositionsCount,
    maxConcurrentPositions: config.maxConcurrentPositions,

    openRisk: snapshot.openRisk + optionsSnapshot.openRisk,
    maxAggregateOpenRisk: (config.maxAggregateOpenRiskPct / 100) * equity,

    maxCorrelatedExposure: (config.maxCorrelatedExposurePct / 100) * equity,
    lastCorrelatedExposureCheck: getLastCorrelatedExposureCheck(),

    sectorExposure: computeAutotradeSectorExposure(
      snapshot.openPositions,
      optionsSnapshot.openPositions,
      liveSnapshot.openPositions,
      liveOptionsSnapshot.openPositions,
    ),
    maxSectorExposure: (config.maxSectorExposurePct / 100) * equity,

    dailyPnl: snapshot.dailyPnl + optionsSnapshot.dailyPnl,
    dailyDrawdownHaltLevel: -(config.maxDailyDrawdownPct / 100) * equity,

    tradesToday: snapshot.tradesToday + optionsSnapshot.tradesToday,
    maxTradesPerDay: config.maxTradesPerDay,

    consecutiveLosses: Math.max(snapshot.consecutiveLosses, optionsSnapshot.consecutiveLosses),
    stepDownAfterLosses: config.stepDownAfterLosses,

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
