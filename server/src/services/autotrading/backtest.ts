import { Candle, Timeframe } from '../../providers/types';
import {
  candleIndicatorsAt,
  CandleIndicatorSeries,
  computeCandleIndicatorSeries,
  lookbackReturnPct,
  ScreenerConfig,
  SymbolScore,
  scoreSymbol,
  scoreSymbolBothDirections,
} from '../../indicators/screener';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { reorderByCorrelation } from './correlationSelection';
import { regimeLabelFromProxy, backtestRegimeWeights } from './regimeWeights';
import { DecisionConfig, TradeSignal, defaultDecisionConfig, generateSignal } from './decide';
import { computeScaleIn } from './scaleIn';
import { evaluateRiskCheck, RiskCheckContext } from './riskCheck';
import { RiskProfileName, RegimeWeightPresets } from '../../db/autotradeConfig';
import { defaultAutotradeScreenerConfig, pickDirection } from './screen';
import { isExcluded } from '../../db/autotradeExclusions';
import { classifySector, buildUniverseSectorMap } from './realEstateClassifier';
import { getHistoricalBars } from './historicalData';
import { computeStreaksAndDrawdown } from '../pnl';
import { mapPool } from '../../util/async';

// ---------------------------------------------------------------------------
// The backtest simulation engine (docs/AUTOTRADING_SPEC.md — Phase 5, the
// validation gate). Replays Screen → Decision → Risk Check day-by-day over
// historical daily bars, reusing the exact same pure functions the live loop
// will eventually call (scoreSymbol, generateSignal, evaluateRiskCheck) — this
// is deliberate: the backtest must exercise the SAME rules the live system
// runs, not a reimplementation that could silently drift from them.
//
// Simulation conventions (a daily-bar backtest can only ever approximate the
// live intraday loop — these are the specific, documented approximations):
//   - A signal is generated from data through day N's CLOSE (no lookahead:
//     computeIndicators is fed history *through* N with no live "quote",
//     so it falls back entirely to day N's own bar — the same code path the
//     live loop uses outside market hours).
//   - If approved, the trade fills at day (N+1)'s OPEN — the first price
//     point genuinely available after the signal was fully known.
//   - Each day after entry, the position's stop/target are checked against
//     that day's high/low. If a single day's range would have hit BOTH, the
//     STOP is assumed to hit first — the conservative assumption, since a
//     daily bar can't reveal the actual intraday order of events.
//   - Any position still open at the end of the period is force-closed at
//     the last available close, tagged exitReason: 'end_of_period'.
//
// WHAT THIS ENGINE DOES NOT MODEL, and why it matters more than it looks
// (measured 2026-09-05). Daily bars can express a stop, a target, a
// breakeven/trailing ratchet and a hold-DAYS horizon. They cannot express any
// rule stated in SESSION MINUTES — and the live loop's dominant exit is
// exactly that. From the live journal: 31 of 37 time-exit placements were the
// STAGNATION exit, at a median hold of 91 minutes; 6 were the end-of-day
// flatten; none were maxHoldDays. Live median hold across all closed trades is
// 92 minutes.
//
// So this engine simulates a multi-day swing system, while the live loop runs
// an intraday one that mostly closes inside 90 minutes on a rule this engine
// has no way to represent. That is not a defect to fix here — a 90-minute
// window genuinely cannot be evaluated against one bar per day — it is a limit
// on what a backtest result MEANS. Tuning targetRMultiple or the stop multiple
// from this engine is answering a question about a system whose main exit is
// absent.
//
// Also unmodelled, for completeness: the re-entry cooldown, finish-line
// sizing, the end-of-day entry cutoff, and the ATR-reach entry filter. The
// level-aware exits are a separate case — deliberately live-only, so the paper
// book and the backtest stay an unmodified control group.
// ---------------------------------------------------------------------------

export const TIMEFRAME: Timeframe = 'daily';
/** Calendar-day padding before `from` so indicators (up to a 50-day MA by
 *  default) have a full warmup window on the very first simulated day. */
export const WARMUP_PADDING_DAYS = 100;

/** For the maxHoldDays check below — dayMs/entryDateMs are both UTC-midnight
 *  timestamps of a trading day, so a plain subtraction in ms needs this to
 *  compare against a day count. Exported for reuse by combinedBacktest.ts's
 *  own equity-leg maxHoldDays check. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** riskProfile's old MODERATE/AGGRESSIVE bundles — every field here used to
 *  live in riskProfiles.ts's now-removed RISK_PROFILES table, back when
 *  switching riskProfile implied all seven together. That's gone from the
 *  LIVE config (2026-07-10 — see AutotradeConfig's own doc comments: each
 *  field is independently user-configured now, and riskProfile no longer
 *  touches any of them). A backtest's `riskProfile` selector is different in
 *  kind, though — a self-contained hypothesis ("what would this profile have
 *  done"), not an ongoing account setting — so it's kept implying this same
 *  bundle unless a caller explicitly overrides an individual field below. */
const LEGACY_BACKTEST_RISK_DEFAULTS: Record<RiskProfileName, BacktestRiskParams> = {
  MODERATE: {
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxTradesPerDay: 6,
    // Never actually profile-specific (riskProfiles.ts's own header comment:
    // "both profiles always shared these") — included here anyway so
    // resolveBacktestRiskParams has exactly one bundle-lookup mechanism for
    // all nine fields, not eight from this table plus two special-cased.
    correlationLookbackDays: 30,
    correlationThreshold: 0.7,
    correlationAwareSelectionEnabled: false,
  },
  AGGRESSIVE: {
    riskPerTradePct: 1.5,
    maxDailyDrawdownPct: 5,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 4.5,
    maxCorrelatedExposurePct: 10,
    maxTradesPerDay: 10,
    correlationLookbackDays: 30,
    correlationThreshold: 0.7,
    correlationAwareSelectionEnabled: false,
  },
};

export interface BacktestRiskParams {
  riskPerTradePct: number;
  maxDailyDrawdownPct: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  maxAggregateOpenRiskPct: number;
  maxCorrelatedExposurePct: number;
  maxTradesPerDay: number;
  correlationLookbackDays: number;
  correlationThreshold: number;
  /** Correlation-aware candidate selection (2026-07-24, default off) — re-ranks
   *  the score-sorted candidates so a correlated cluster's lower-scored members
   *  are demoted behind diverse picks before the caps bind. Mirrors the live
   *  loop; default false so an unspecified backtest matches today's behavior. */
  correlationAwareSelectionEnabled: boolean;
}

/** Resolves each risk param from an explicit override on `cfg`, falling back
 *  to riskProfile's legacy bundle field-by-field — so a caller can loosen
 *  just ONE number (e.g. maxAggregateOpenRiskPct) without having to also
 *  specify the other eight. */
export function resolveBacktestRiskParams(
  cfg: Partial<BacktestRiskParams> & { riskProfile: RiskProfileName },
): BacktestRiskParams {
  const d = LEGACY_BACKTEST_RISK_DEFAULTS[cfg.riskProfile];
  return {
    riskPerTradePct: cfg.riskPerTradePct ?? d.riskPerTradePct,
    maxDailyDrawdownPct: cfg.maxDailyDrawdownPct ?? d.maxDailyDrawdownPct,
    stepDownAfterLosses: cfg.stepDownAfterLosses ?? d.stepDownAfterLosses,
    stepDownSizeCutPct: cfg.stepDownSizeCutPct ?? d.stepDownSizeCutPct,
    maxAggregateOpenRiskPct: cfg.maxAggregateOpenRiskPct ?? d.maxAggregateOpenRiskPct,
    maxCorrelatedExposurePct: cfg.maxCorrelatedExposurePct ?? d.maxCorrelatedExposurePct,
    maxTradesPerDay: cfg.maxTradesPerDay ?? d.maxTradesPerDay,
    correlationLookbackDays: cfg.correlationLookbackDays ?? d.correlationLookbackDays,
    correlationThreshold: cfg.correlationThreshold ?? d.correlationThreshold,
    correlationAwareSelectionEnabled: cfg.correlationAwareSelectionEnabled ?? d.correlationAwareSelectionEnabled,
  };
}

export interface BacktestConfig extends Partial<BacktestRiskParams> {
  symbols: string[];
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  riskProfile: RiskProfileName;
  startingEquity: number;
  /** Same cap as AutotradeConfig.maxConcurrentPositions, own value here — a
   *  backtest is a self-contained hypothetical, not coupled to the live
   *  account's current setting (mirrors startingEquity's existing convention). */
  maxConcurrentPositions: number;
  /** Force-close a position open this many CALENDAR days without a stop/
   *  target hit — mirrors AutotradeConfig.maxHoldDays for paper/live.
   *  Omitted or 0 disables it (matches every position's behavior before this
   *  existed). Own value here, not read from live config — same
   *  self-contained-hypothesis convention as maxConcurrentPositions above. */
  maxHoldDays?: number;
  /** Trailing stop / breakeven / partial profit-taking — own top-level
   *  fields, same self-contained-hypothesis convention as maxHoldDays
   *  above. All default to 0/disabled if omitted. See AutotradeConfig's own
   *  doc comment for what each one does; backtest applies the identical
   *  logic execute.ts uses for paper, against daily bars instead of a live
   *  quote (see simulateBacktest's own doc comment on why bar CLOSE, not
   *  intrabar high/low, is used for these triggers specifically). */
  breakevenTriggerRMultiple?: number;
  trailStartRMultiple?: number;
  trailStopRMultiple?: number;
  partialExitRMultiple?: number;
  partialExitPct?: number;
  addOnTriggerRMultiple?: number;
  addOnSizePct?: number;
  maxAddOns?: number;
  screenerConfig?: Partial<ScreenerConfig>;
  decisionConfig?: Partial<DecisionConfig>;
  /** 'long' (default, matches every backtest before this existed) | 'short' |
   *  'both' — mirrors AutotradeConfig.tradeDirection/screen.ts's
   *  RunScreenOptions.directionMode exactly: 'both' scores every candidate
   *  as BOTH a long and a short each simulated day (scoreSymbolBothDirections)
   *  and keeps whichever direction actually qualifies, per symbol — so a
   *  backtest can be run against the SAME direction setting before it's ever
   *  used live. Falls back to screenerConfig?.direction when omitted, same
   *  "separate option, doesn't force picking a meaningless single
   *  screenerConfig.direction" reasoning as the live/paper version. */
  directionMode?: 'long' | 'short' | 'both';
  /** Regime-conditional scoring weights (2026-07-24, off by default). When on,
   *  each simulated day is scored with the weight preset matching the proxy-
   *  derived market regime as of that day (breadth omitted — see
   *  regimeWeights.ts). Needs `regimeWeightPresets`; both default to today's
   *  fixed-weight behavior. */
  regimeAdaptiveWeightsEnabled?: boolean;
  regimeWeightPresets?: RegimeWeightPresets;
}

export interface SimulatedTrade {
  symbol: string;
  side: 'buy' | 'sell';
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  /** 'partial_exit' is the ONE case where this isn't the position's final
   *  exit — a partial-exit trade's symbol/entryDate keeps recurring in a
   *  LATER trade row (stop/target/time_exit/end_of_period) for the same
   *  logical position's remainder. Nothing links the two rows explicitly
   *  beyond that repeated symbol+entryDate — same minimal shape as every
   *  other exitReason, just used twice for one logical trade instead of
   *  once. */
  exitReason: 'stop' | 'target' | 'time_exit' | 'partial_exit' | 'end_of_period';
  quantity: number;
  pnl: number;
  rMultiple: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface BacktestReport {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  /** Symbols whose historical-bar fetch failed (bad ticker, provider error,
   *  rate limit) — reported so one bad symbol doesn't fail the whole request;
   *  every other symbol's result is still simulated normally. */
  errors: { symbol: string; message: string }[];
}

interface OpenPosition {
  symbol: string;
  side: 'buy' | 'sell';
  signalDate: string;
  entryDate: string;
  /** ms epoch of entryDate — captured once at fill time so the maxHoldDays
   *  check below is a plain subtraction against the current bar's own dayMs,
   *  not a re-parse of entryDate every day this position stays open. */
  entryDateMs: number;
  entryPrice: number;
  /** CURRENT effective stop — mutated in place by breakeven/trailing. */
  stop: number;
  target: number;
  /** Snapshot of `stop` at fill time, never mutated again — the R-multiple
   *  denominator for breakeven/trailing/partial-exit triggers, immune to how
   *  far `stop` has since ratcheted (mirrors execute.ts's own
   *  initialStopPrice). */
  initialStop: number;
  /** Best (most favorable) bar CLOSE seen since entry — long: running max;
   *  short: running min. The trailing-stop calculation ratchets against
   *  this (mirrors execute.ts's own bestPriceSinceEntry). */
  bestPrice: number;
  /** Whether the one-time partial-exit trigger has already fired for this
   *  position. */
  partialExitTaken: boolean;
  /** How many times this position has been scaled into (pyramided). */
  addOnsTaken: number;
  quantity: number;
  riskAmount: number;
  notional: number;
}

interface PendingEntry {
  symbol: string;
  signalDate: string;
  signal: TradeSignal;
  quantity: number;
  riskAmount: number;
  notional: number;
}

/** Exported for reuse by optionsBacktest.ts — a plain YYYY-MM-DD formatter,
 *  not worth a second copy. */
export function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d.getTime());
}

/**
 * Index of the last candle with `time <= asOfMs`, or -1 if none. Exported for
 * reuse by optionsBacktest.ts, which needs the identical "as of this
 * simulated day" lookup for option contract bars, not just equity ones.
 *
 * `fromIndex` (default 0, i.e. scan from the start — the original behavior,
 * unchanged for any caller that omits it) lets a caller resume from its own
 * previous result instead of rescanning from index 0 every time. Safe
 * whenever asOfMs only increases across a caller's own sequence of calls for
 * the SAME candles array (true for a backtest's day-by-day loop): since
 * candles are time-sorted, the answer for a later asOfMs can never be
 * earlier than the answer for an earlier one, so nothing before the
 * previous result needs to be re-examined.
 */
export function indexAsOf(candles: Candle[], asOfMs: number, fromIndex = 0): number {
  const start = Math.min(Math.max(fromIndex, 0), candles.length);
  let idx = start > 0 ? start - 1 : -1;
  for (let i = start; i < candles.length; i++) {
    if (candles[i].time <= asOfMs) idx = i;
    else break;
  }
  return idx;
}

/**
 * Index of the last WEEKLY candle that is fully CLOSED as of `asOfMs` —
 * added 2026-07-16 for multi-timeframe confirmation (docs/AUTOTRADING_SPEC.md
 * phase 19). `Candle.time` is a bar's own START, and indexAsOf() has no
 * concept of a bar's CLOSE — indexAsOf(weeklyCandles, asOfMs) returns the
 * week CONTAINING asOfMs (started on-or-before it), which by definition
 * hasn't finished yet as of asOfMs itself. Using that candle directly would
 * leak later-in-the-week price action into a backtest's "as of this
 * simulated day" read — the exact lookahead-bias class this file's own
 * day-by-day walk-forward design otherwise goes out of its way to avoid.
 * The fix doesn't need to know the upstream provider's week-start-day
 * convention (Monday vs. Sunday, unconfirmed for Polygon's weekly
 * aggregates) at all: the last CLOSED week is simply one index behind
 * whichever week asOfMs currently falls inside.
 */
export function closedWeeklyIndexAsOf(weeklyCandles: Candle[], asOfMs: number): number {
  const idx = indexAsOf(weeklyCandles, asOfMs);
  return idx <= 0 ? -1 : idx - 1;
}

/** Correlation, computed entirely from already-loaded history (no I/O) — the
 *  backtest analog of riskCheck.ts's provider-fetching correlatedNotional.
 *  Takes the same lightweight `{symbol, notional}[]` shape riskCheck.ts's
 *  runningPositions uses, not the full OpenPosition[], so callers can pass a
 *  running (open + already-approved-this-batch) list, not just currently-open
 *  positions. Exported for reuse by combinedBacktest.ts — the math is already
 *  100% asset-type-blind (options' own optionsBacktestCorrelatedNotional in
 *  optionsBacktest.ts is a byte-for-byte duplicate of this same function), so
 *  a combined simulation correlating EITHER instrument type's candidate
 *  against a running list mixing both reuses this one implementation rather
 *  than a third copy. */
/** `candidateSide`/`pos.side`: same opposite-side netting as riskCheck.ts's
 *  live/paper correlatedNotional() (see its own doc comment for the full
 *  reasoning) — a correlated position on the SAME side compounds risk
 *  (additive), the OPPOSITE side partially hedges it (subtracted), net
 *  floored at 0. Every caller that only ever holds one side (options) passes
 *  the same side for everything, reducing to the original always-additive
 *  sum unchanged. */
export function backtestCorrelatedNotional(
  candidateSymbol: string,
  candidateSide: 'long' | 'short',
  asOfMs: number,
  positions: { symbol: string; notional: number; side: 'long' | 'short' }[],
  historyBySymbol: Map<string, Candle[]>,
  lookbackDays: number,
  threshold: number,
): number {
  if (positions.length === 0) return 0;
  const closesUpTo = (symbol: string): number[] | null => {
    const candles = historyBySymbol.get(symbol);
    if (!candles) return null;
    const idx = indexAsOf(candles, asOfMs);
    if (idx < 1) return null;
    const start = Math.max(0, idx - lookbackDays);
    return candles.slice(start, idx + 1).map((c) => c.close);
  };

  const candidateCloses = closesUpTo(candidateSymbol);
  const candidateReturns = candidateCloses ? dailyReturns(candidateCloses) : null;
  if (!candidateReturns) return 0;

  let amount = 0;
  for (const pos of positions) {
    const posCloses = closesUpTo(pos.symbol);
    const r = posCloses ? pearsonCorrelation(candidateReturns, dailyReturns(posCloses)) : null;
    if (r !== null && Math.abs(r) >= threshold) amount += pos.side === candidateSide ? pos.notional : -pos.notional;
  }
  return Math.max(0, amount);
}

/**
 * Run the simulation over already-loaded history. Pure — no I/O — so it's
 * directly unit-testable with hand-built candle series. `historyBySymbol`
 * should include WARMUP_PADDING_DAYS or more of lookback before `cfg.from`.
 *
 * `weeklyHistoryBySymbol` (2026-07-16, multi-timeframe confirmation):
 * OPTIONAL, own parameter rather than folded into `historyBySymbol` —
 * omitted entirely (not just empty) by any caller that hasn't enabled
 * `requireWeeklyTrendAlignment`, so a backtest run that doesn't use this
 * feature pays zero extra cost, same "don't do unrequested work" posture as
 * every other call site this feature touches (screen.ts's own fetch gate).
 *
 * `benchmarkCandles` (2026-07-17, relative-strength-vs-benchmark): OPTIONAL,
 * a single series (not per-symbol like weeklyHistoryBySymbol — every
 * candidate on a given day is compared against the SAME benchmark reading),
 * omitted entirely by any caller whose screenerCfg.weights.relativeStrength
 * is 0, same don't-do-unrequested-work posture as weeklyHistoryBySymbol.
 */
export function simulateBacktest(
  historyBySymbol: Map<string, Candle[]>,
  cfg: BacktestConfig,
  weeklyHistoryBySymbol?: Map<string, Candle[]>,
  benchmarkCandles?: Candle[],
): BacktestReport {
  const riskParams = resolveBacktestRiskParams(cfg);
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const decisionCfg = { ...defaultDecisionConfig(), ...cfg.decisionConfig };
  const directionMode = cfg.directionMode ?? screenerCfg.direction;

  const fromMs = Date.parse(`${cfg.from}T00:00:00Z`);
  const toMs = Date.parse(`${cfg.to}T00:00:00Z`);

  // The trading calendar: every distinct date any symbol has a bar on,
  // within [from, to] — the walk-forward loop's day-by-day iteration.
  const dateSet = new Set<string>();
  for (const candles of historyBySymbol.values()) {
    for (const c of candles) {
      if (c.time >= fromMs && c.time <= toMs) dateSet.add(toISO(c.time));
    }
  }
  const tradingDays = Array.from(dateSet).sort();

  const trades: SimulatedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const closedPnls: number[] = []; // chronological, for computeBacktestStats' own final summary
  let equity = cfg.startingEquity;
  let openPositions: OpenPosition[] = [];
  let pendingEntries: PendingEntry[] = [];

  // Per-symbol resume point for indexAsOf, so a growing history isn't
  // rescanned from index 0 on every one of the three lookups below, every
  // day — dayMs only increases across this loop, so each symbol's answer
  // only ever advances forward.
  const indexCursor = new Map<string, number>();
  // The benchmark's own resume point — a single cursor, not a per-symbol
  // map, since benchmarkCandles is one shared series, looked up once per
  // simulated day (not once per candidate) below.
  let benchmarkIndexCursor = 0;

  // SMA/RSI/ATR over each symbol's FULL history, computed ONCE up front
  // (single O(n) pass each) rather than re-sliced-and-recomputed from
  // scratch for every one of the (up to hundreds of) simulated days below —
  // the O(days²) cost this whole precompute step exists to eliminate. Safe
  // because smaSeries/rsiSeries/atrSeries are causal (index i depends only
  // on candles[0..i]), so candleIndicatorsAt(series, idx) is mathematically
  // identical to computeCandleIndicators(candles.slice(0, idx + 1), cfg) —
  // see computeCandleIndicatorSeries's own doc comment.
  const candleIndicatorSeriesBySymbol = new Map<string, CandleIndicatorSeries>();
  for (const [symbol, candles] of historyBySymbol) {
    candleIndicatorSeriesBySymbol.set(symbol, computeCandleIndicatorSeries(candles, screenerCfg));
  }

  // The WEEKLY counterpart (2026-07-16) — same once-up-front precompute
  // pattern, just fed a weekly candle series instead of daily. Only built
  // when the caller actually supplied one (requireWeeklyTrendAlignment
  // enabled) — see simulateBacktest's own doc comment.
  const weeklyCandleIndicatorSeriesBySymbol = new Map<string, CandleIndicatorSeries>();
  if (weeklyHistoryBySymbol) {
    for (const [symbol, weeklyCandles] of weeklyHistoryBySymbol) {
      weeklyCandleIndicatorSeriesBySymbol.set(symbol, computeCandleIndicatorSeries(weeklyCandles, screenerCfg));
    }
  }

  // The running win/loss streak, maintained incrementally instead of calling
  // computeStreaksAndDrawdown(closedPnls) (an O(closedPnls.length) rescan)
  // every single day — mirrors that function's own per-element logic
  // exactly, updated at the same two points closedPnls itself is appended to.
  const streak: { type: 'win' | 'loss' | 'none'; count: number } = { type: 'none', count: 0 };
  function recordClosedPnl(pnl: number): void {
    closedPnls.push(pnl);
    const t = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'none';
    if (t === 'none') {
      streak.type = 'none';
      streak.count = 0;
    } else if (t === streak.type) {
      streak.count += 1;
    } else {
      streak.type = t;
      streak.count = 1;
    }
  }

  for (const day of tradingDays) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    let dailyPnl = 0;

    // 1) Fill yesterday's approved signals at TODAY's open, if this symbol has a bar today.
    let filledToday = 0;
    const stillPending: PendingEntry[] = [];
    for (const p of pendingEntries) {
      const candles = historyBySymbol.get(p.symbol);
      const idx = candles ? indexAsOf(candles, dayMs, indexCursor.get(p.symbol) ?? 0) : -1;
      if (idx >= 0) indexCursor.set(p.symbol, idx);
      if (idx >= 0 && candles![idx].time === dayMs) {
        openPositions.push({
          symbol: p.symbol,
          side: p.signal.side,
          signalDate: p.signalDate,
          entryDate: day,
          entryDateMs: dayMs,
          entryPrice: candles![idx].open,
          stop: p.signal.stop,
          target: p.signal.target,
          initialStop: p.signal.stop,
          bestPrice: candles![idx].open,
          partialExitTaken: false,
          addOnsTaken: 0,
          quantity: p.quantity,
          riskAmount: p.riskAmount,
          notional: p.notional,
        });
        filledToday += 1;
      } else if (idx < 0 || candles![idx].time < dayMs) {
        stillPending.push(p); // no bar yet today — keep waiting
      }
      // else: a later bar already passed this date without landing on it exactly — drop (stale).
    }
    pendingEntries = stillPending;

    // 2) Check open positions for a stop/target hit using today's high/low.
    const stillOpen: OpenPosition[] = [];
    for (const pos of openPositions) {
      const candles = historyBySymbol.get(pos.symbol);
      const idx = candles ? indexAsOf(candles, dayMs, indexCursor.get(pos.symbol) ?? 0) : -1;
      if (idx >= 0) indexCursor.set(pos.symbol, idx);
      const bar = idx >= 0 && candles![idx].time === dayMs ? candles![idx] : null;
      if (!bar) {
        stillOpen.push(pos); // no data today — re-check tomorrow
        continue;
      }
      const long = pos.side === 'buy';
      const sign = long ? 1 : -1;
      const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = long ? bar.high >= pos.target : bar.low <= pos.target;
      const maxHoldDays = cfg.maxHoldDays ?? 0;
      const timeHit = !stopHit && !targetHit && maxHoldDays > 0 && dayMs - pos.entryDateMs >= maxHoldDays * MS_PER_DAY;
      if (stopHit || targetHit || timeHit) {
        // Conservative: if both could have happened in one bar, assume the stop hit first.
        const exitReason: SimulatedTrade['exitReason'] = stopHit ? 'stop' : targetHit ? 'target' : 'time_exit';
        // A time-exit has no declared level to close at (unlike stop/target) — closes at
        // today's bar close, the same "what actually happened today" price a real
        // end-of-day force-close would realize.
        const exitPrice = stopHit ? pos.stop : targetHit ? pos.target : bar.close;
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * sign;
        trades.push({
          symbol: pos.symbol,
          side: pos.side,
          signalDate: pos.signalDate,
          entryDate: pos.entryDate,
          entryPrice: pos.entryPrice,
          exitDate: day,
          exitPrice,
          exitReason,
          quantity: pos.quantity,
          pnl,
          rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
        });
        recordClosedPnl(pnl);
        dailyPnl += pnl;
        equity += pnl;
      } else {
        // Trailing stop / breakeven / partial profit-taking — mirrors
        // execute.ts's own applyPositionManagement, against the bar's CLOSE
        // rather than intrabar high/low (unlike the stop/target check
        // above): these are dynamic R-multiple triggers, not a fixed price
        // level that can legitimately be "hit" intrabar — using the
        // intrabar extreme here would let backtest detect a trigger a real
        // paper/live check (one point-in-time quote per cycle) never could,
        // overstating this specific feature's backtested performance.
        const initialStopDistance = Math.abs(pos.entryPrice - pos.initialStop);
        if (initialStopDistance > 0) {
          const rMultiple = long
            ? (bar.close - pos.entryPrice) / initialStopDistance
            : (pos.entryPrice - bar.close) / initialStopDistance;

          let partialFiredThisBar = false;
          const partialExitRMultiple = cfg.partialExitRMultiple ?? 0;
          if (partialExitRMultiple > 0 && !pos.partialExitTaken && rMultiple >= partialExitRMultiple) {
            const closeQty = Math.floor(pos.quantity * ((cfg.partialExitPct ?? 0) / 100));
            if (closeQty > 0 && closeQty < pos.quantity) {
              const partialPnl = (bar.close - pos.entryPrice) * closeQty * sign;
              trades.push({
                symbol: pos.symbol,
                side: pos.side,
                signalDate: pos.signalDate,
                entryDate: pos.entryDate,
                entryPrice: pos.entryPrice,
                exitDate: day,
                exitPrice: bar.close,
                exitReason: 'partial_exit',
                quantity: closeQty,
                pnl: partialPnl,
                rMultiple: pos.riskAmount > 0 ? partialPnl / pos.riskAmount : 0,
              });
              recordClosedPnl(partialPnl);
              dailyPnl += partialPnl;
              equity += partialPnl;
              pos.quantity -= closeQty;
              pos.partialExitTaken = true;
              partialFiredThisBar = true;
            }
          }

          pos.bestPrice = long ? Math.max(pos.bestPrice, bar.close) : Math.min(pos.bestPrice, bar.close);

          const breakevenTriggerRMultiple = cfg.breakevenTriggerRMultiple ?? 0;
          const trailStartRMultiple = cfg.trailStartRMultiple ?? 0;
          const trailStopRMultiple = cfg.trailStopRMultiple ?? 0;
          let candidateStop = pos.stop;
          if (breakevenTriggerRMultiple > 0 && rMultiple >= breakevenTriggerRMultiple) {
            candidateStop = long ? Math.max(candidateStop, pos.entryPrice) : Math.min(candidateStop, pos.entryPrice);
          }
          if (trailStartRMultiple > 0 && trailStopRMultiple > 0 && rMultiple >= trailStartRMultiple) {
            const trailDistance = trailStopRMultiple * initialStopDistance;
            const trailingCandidate = long ? pos.bestPrice - trailDistance : pos.bestPrice + trailDistance;
            candidateStop = long
              ? Math.max(candidateStop, trailingCandidate)
              : Math.min(candidateStop, trailingCandidate);
          }
          pos.stop = candidateStop;

          // Scale into a winner (pyramiding) — mirrors execute.ts's paper loop:
          // add against the bar CLOSE, never in the same bar as a partial
          // scale-out, blending the entry and raising the stop. The added
          // shares realize their P&L at exit via the blended entryPrice. See
          // services/autotrading/scaleIn.ts.
          if (!partialFiredThisBar) {
            const add = computeScaleIn(
              {
                side: pos.side,
                entryPrice: pos.entryPrice,
                initialStopPrice: pos.initialStop,
                stopPrice: pos.stop,
                quantity: pos.quantity,
                addOnsTaken: pos.addOnsTaken,
              },
              bar.close,
              {
                addOnTriggerRMultiple: cfg.addOnTriggerRMultiple ?? 0,
                addOnSizePct: cfg.addOnSizePct ?? 0,
                maxAddOns: cfg.maxAddOns ?? 0,
              },
            );
            if (add) {
              pos.quantity = add.newQuantity;
              pos.entryPrice = add.blendedEntry;
              pos.initialStop = add.newInitialStopPrice;
              pos.stop = add.newStopPrice;
              pos.addOnsTaken += 1;
            }
          }
        }
        stillOpen.push(pos);
      }
    }
    openPositions = stillOpen;

    // 3) Screen + Decide + Risk-check for new signals, using data through today's close.
    const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;
    const openSymbols = new Set([...openPositions.map((p) => p.symbol), ...pendingEntries.map((p) => p.symbol)]);

    // The benchmark's own lookback return as of TODAY — computed ONCE per
    // day here, then reused for every candidate below (mirrors screen.ts's
    // own once-per-cycle fetch, just at day granularity instead of tick
    // granularity). Null whenever benchmarkCandles wasn't supplied, or
    // today isn't an exact bar date in it (a benchmark-only holiday/gap,
    // matching the per-symbol idx/candles[idx].time === dayMs guard below).
    const benchmarkIdx = benchmarkCandles ? indexAsOf(benchmarkCandles, dayMs, benchmarkIndexCursor) : -1;
    if (benchmarkIdx >= 0) benchmarkIndexCursor = benchmarkIdx;
    const benchmarkLookbackReturnPct =
      benchmarkCandles && benchmarkIdx >= 0 && benchmarkCandles[benchmarkIdx].time === dayMs
        ? lookbackReturnPct(benchmarkCandles, screenerCfg.relativeStrengthLookbackDays, benchmarkIdx)
        : null;

    // Regime-conditional weights (2026-07-24, off by default): score THIS day
    // with the preset matching the proxy-derived regime as of today — benchmarkIdx
    // is the proxy bar as-of today, so no lookahead. The cached indicator series
    // above is weight-independent (weights only affect scoreSymbol's final
    // aggregation), so swapping weights per day is safe. No-op when disabled or
    // when no proxy series was loaded, so an unspecified run is byte-identical.
    const dayWeights = cfg.regimeAdaptiveWeightsEnabled
      ? backtestRegimeWeights(
          screenerCfg.weights,
          cfg.regimeWeightPresets ?? null,
          benchmarkCandles ? regimeLabelFromProxy(benchmarkCandles, benchmarkIdx) : null,
        )
      : screenerCfg.weights;
    const dayScreenerCfg = dayWeights === screenerCfg.weights ? screenerCfg : { ...screenerCfg, weights: dayWeights };

    const candidates: { score: SymbolScore; signal: TradeSignal }[] = [];
    for (const [symbol, candles] of historyBySymbol) {
      if (openSymbols.has(symbol)) continue; // don't stack a second position in the same name
      const idx = indexAsOf(candles, dayMs, indexCursor.get(symbol) ?? 0);
      if (idx >= 0) indexCursor.set(symbol, idx);
      if (idx < 1 || candles[idx].time !== dayMs) continue; // needs a bar dated exactly today
      const series = candleIndicatorSeriesBySymbol.get(symbol)!;
      const cached = candleIndicatorsAt(series, idx) ?? undefined;
      // The CLOSED-week weekly indicators as of today, if the caller
      // supplied a weekly history — closedWeeklyIndexAsOf(), not indexAsOf(),
      // is deliberate here: see that function's own doc comment on the
      // lookahead-bias it exists to avoid.
      const weeklyCandles = weeklyHistoryBySymbol?.get(symbol);
      const weeklyCached = weeklyCandles
        ? (candleIndicatorsAt(
            weeklyCandleIndicatorSeriesBySymbol.get(symbol)!,
            closedWeeklyIndexAsOf(weeklyCandles, dayMs),
          ) ?? undefined)
        : undefined;
      // 'both': score this symbol as a long AND a short from the same
      // indicator computation and keep whichever direction (if either)
      // qualifies — mirrors screen.ts's runAutotradeScreen() exactly, so a
      // backtest run with directionMode:'both' simulates what the live loop
      // would actually do with tradeDirection:'both'.
      const picked =
        directionMode === 'both'
          ? pickDirection(
              scoreSymbolBothDirections(
                symbol,
                candles,
                undefined,
                dayScreenerCfg,
                cached,
                idx,
                weeklyCached,
                benchmarkLookbackReturnPct,
              ),
            )
          : (() => {
              const score = scoreSymbol(
                symbol,
                candles,
                undefined,
                { ...dayScreenerCfg, direction: directionMode },
                cached,
                idx,
                weeklyCached,
                benchmarkLookbackReturnPct,
              );
              return score.passedFilters ? { direction: directionMode, score } : null;
            })();
      if (!picked) continue;
      const signal = generateSignal(
        // relVolPace: a backtest has no universe-wide median for the bar being
        // replayed, so the pace is genuinely unknown rather than zero — levelPlan
        // treats null as "no breakout evidence" and simply caps at the wall.
        { ...picked.score, discoverySource: 'universe', direction: picked.direction, relVolPace: null },
        decisionCfg,
      );
      if (signal) candidates.push({ score: picked.score, signal });
    }
    // Deterministic tie-break on exact score ties: fall back to symbol name, not
    // Map/candle-array insertion order (which depends on real fetch-completion
    // timing in loadBacktestHistory's mapPool — reruns of an identical config
    // against identical cached data must produce identical results).
    candidates.sort((a, b) => b.score.total - a.score.total || a.score.symbol.localeCompare(b.score.symbol));

    // Correlation-aware selection (2026-07-24, default off): re-rank so a
    // correlated cluster's lower-scored members are demoted behind diverse
    // picks before the caps below bind — the same reorder the live loop
    // applies, fed from this engine's own no-lookahead daily closes (sliced up
    // to today exactly like backtestCorrelatedNotional's closesUpTo). A no-op
    // when disabled, so an unspecified backtest is byte-identical to before.
    let orderedCandidates = candidates;
    if (riskParams.correlationAwareSelectionEnabled && candidates.length > 1) {
      const returnsBySymbol = new Map<string, number[]>();
      for (const { score } of candidates) {
        const candles = historyBySymbol.get(score.symbol);
        if (!candles) continue;
        const idx = indexAsOf(candles, dayMs, indexCursor.get(score.symbol) ?? 0);
        if (idx < 1) continue;
        const start = Math.max(0, idx - riskParams.correlationLookbackDays);
        const returns = dailyReturns(candles.slice(start, idx + 1).map((c) => c.close));
        if (returns.length >= 2) returnsBySymbol.set(score.symbol.toUpperCase(), returns);
      }
      orderedCandidates = reorderByCorrelation(candidates, (c) => c.score.symbol, returnsBySymbol, {
        enabled: true,
        threshold: riskParams.correlationThreshold,
        lookbackDays: riskParams.correlationLookbackDays,
      }).ordered;
    }

    let runningRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openPositions.length;
    const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.notional,
      side: p.side === 'buy' ? 'long' : 'short',
    }));

    for (const { signal } of orderedCandidates) {
      // Threaded through runningPositions (open + already-approved-this-batch),
      // not the pre-batch openPositions snapshot — matches riskCheck.ts's
      // runAutotradeRiskCheck, which correctly counts a signal approved
      // earlier in the same batch against the next one. Using the stale
      // snapshot here would let several mutually-correlated candidates all
      // clear this cap on the same day, understating exactly the correlated-
      // cluster risk this check exists to catch.
      const correlated = backtestCorrelatedNotional(
        signal.symbol,
        signal.side === 'buy' ? 'long' : 'short',
        dayMs,
        runningPositions,
        historyBySymbol,
        riskParams.correlationLookbackDays,
        riskParams.correlationThreshold,
      );
      const ctx: RiskCheckContext = {
        equity,
        dailyPnl,
        // Trades actually filled today (step 1, above) — matches the live
        // system's getPortfolioSnapshot().tradesToday, which counts orders
        // ALREADY placed, held constant across a single risk-check batch
        // (not incremented per-approval within the batch, since nothing
        // approved today has "placed" yet — in this daily-bar model, an
        // approval today fills at tomorrow's open, not today's).
        tradesToday: filledToday,
        consecutiveLosses,
        openRisk: runningRisk,
        openPositionsCount: runningCount,
        maxConcurrentPositions: cfg.maxConcurrentPositions,
        correlatedNotional: correlated,
        ...riskParams,
        // Sector exposure cap has no backtest equivalent either (2026-07-18,
        // same scope boundary as regime sizing below) — BacktestRiskParams is
        // a deliberately separate, self-contained bundle from AutotradeConfig
        // (see this file's own header comment) and isn't growing a sector
        // dimension. candidateSector: null unconditionally skips the check
        // (see evaluateRiskCheck's own max_sector_exposure gating).
        sectorNotional: 0,
        maxSectorExposurePct: 0,
        candidateSector: null,
        // Regime-aware sizing has no backtest equivalent (2026-07-16) — same
        // documented scope boundary as maxMarketAtrPct/maxTickerAtrPct/
        // sessionBufferMinutes above: no live SPY-proxy ATR series is wired
        // into any backtest engine. null unconditionally disables the cut
        // regardless of the two threshold/magnitude values (see
        // evaluateRiskCheck's own regimeActive computation).
        marketAtrPct: null,
        regimeAtrThresholdPct: 0,
        regimeSizeCutPct: 0,
      };
      const result = evaluateRiskCheck(signal, ctx);
      if (!result.ok) continue;
      pendingEntries.push({
        symbol: signal.symbol,
        signalDate: day,
        signal,
        quantity: result.sizing.suggestedQuantity,
        riskAmount: result.approvedRiskAmount,
        notional: result.approvedNotional,
      });
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({
        symbol: signal.symbol,
        notional: result.approvedNotional,
        side: signal.side === 'buy' ? 'long' : 'short',
      });
    }

    equityCurve.push({ date: day, equity });
  }

  // Force-close anything still open at period end, at the last available close.
  for (const pos of openPositions) {
    const candles = historyBySymbol.get(pos.symbol);
    const last = candles?.length ? candles[candles.length - 1] : null;
    const exitPrice = last?.close ?? pos.entryPrice;
    const sign = pos.side === 'buy' ? 1 : -1;
    const pnl = (exitPrice - pos.entryPrice) * pos.quantity * sign;
    trades.push({
      symbol: pos.symbol,
      side: pos.side,
      signalDate: pos.signalDate,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      exitDate: cfg.to,
      exitPrice,
      exitReason: 'end_of_period',
      quantity: pos.quantity,
      pnl,
      rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
    });
    equity += pnl;
  }
  if (openPositions.length && equityCurve.length) {
    equityCurve[equityCurve.length - 1] = { date: equityCurve[equityCurve.length - 1].date, equity };
  }

  return {
    trades,
    equityCurve,
    startingEquity: cfg.startingEquity,
    finalEquity: equity,
    excludedSymbols: [],
    errors: [],
  };
}

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  avgWin: number;
  avgLoss: number;
  expectancy: number; // mean pnl per trade
  profitFactor: number | null;
  totalPnl: number;
  returnPct: number; // (finalEquity − startingEquity) / startingEquity × 100
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  maxDrawdown: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Summary stats over a completed backtest — win rate, expectancy, profit
 *  factor, R-multiple edge, drawdown/streaks. Reuses computeStreaksAndDrawdown
 *  (services/pnl.ts, the same function the live Journal's stats use) rather
 *  than reimplementing drawdown/streak math for a second trade-record shape;
 *  the rest mirrors services/pnl.ts's computeJournalStats conventions
 *  (e.g. profitFactor is null — not Infinity — when there are wins and no
 *  losses yet) so the two "how did this perform" surfaces read the same way.
 *
 *  Parameter is intentionally a structural subset of BacktestReport (not the
 *  type itself) — every field this function actually reads (trade pnl/
 *  rMultiple, starting/final equity) is already 100% asset-type-blind, so
 *  optionsBacktest.ts's OptionsBacktestReport (a differently-shaped trade
 *  record) satisfies this signature too, without a duplicate stats function. */
export function computeBacktestStats(report: {
  trades: { pnl: number; rMultiple: number }[];
  startingEquity: number;
  finalEquity: number;
}): BacktestStats {
  const { trades, startingEquity, finalEquity } = report;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const rs = trades.map((t) => t.rMultiple);
  const { maxDrawdown, longestWinStreak, longestLossStreak } = computeStreaksAndDrawdown(trades.map((t) => t.pnl));

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    expectancy: trades.length ? round2(totalPnl / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    totalPnl: round2(totalPnl),
    returnPct: startingEquity ? round2(((finalEquity - startingEquity) / startingEquity) * 100) : 0,
    avgR: rs.length ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    bestR: rs.length ? round2(Math.max(...rs)) : null,
    worstR: rs.length ? round2(Math.min(...rs)) : null,
    maxDrawdown,
    longestWinStreak,
    longestLossStreak,
  };
}

/** Real-estate pre-filter — checked ONCE upfront (not per simulated day), the
 *  same list+classifier checks Screen uses live. Pooled (mirrors screen.ts's
 *  discoverSymbols loop) since classifySector falls back to a live
 *  fundamentals fetch for any symbol outside the seeded universe — a large
 *  symbol list run sequentially would serialize one network round-trip per
 *  symbol before the (already-pooled) bar fetch below even starts. */
async function filterEligibleSymbols(
  symbols: string[],
): Promise<{ eligible: string[]; excluded: { symbol: string; reason: string }[] }> {
  const eligible: string[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  const universeSectorBySymbol = buildUniverseSectorMap();
  await mapPool(symbols, 6, async (symbol) => {
    if (isExcluded(symbol)) {
      excluded.push({ symbol, reason: 'On the real-estate exclusion list' });
      return;
    }
    const classification = await classifySector(symbol, universeSectorBySymbol);
    if (classification.outcome === 'real_estate') {
      excluded.push({
        symbol,
        reason: `Classified as real estate (${classification.sector ?? classification.industry ?? ''})`,
      });
      return;
    }
    eligible.push(symbol);
  });
  return { eligible, excluded };
}

/** Shared I/O prelude for both a plain backtest and a walk-forward run:
 *  pre-filter real estate, then fetch (or reuse cached) historical bars for
 *  every eligible symbol, padded with WARMUP_PADDING_DAYS of lookback so
 *  indicators have a full warmup window on the first simulated day. Fetches
 *  run with bounded concurrency (mirrors screen.ts's mapPool(symbols, 6, …))
 *  so a multi-symbol backtest doesn't serialize one HTTP round-trip per
 *  symbol. A single symbol's fetch failure (bad ticker, provider error, rate
 *  limit) is caught and reported per-symbol, not left to reject the whole
 *  mapPool — one bad symbol in a 10-symbol request must not discard the
 *  other nine's results (mirrors screen.ts's per-symbol errors[] handling). */
/** Exported for reuse by optionsBacktest.ts's runOptionsBacktest — the same
 *  real-estate pre-filter and equity daily-bar fetch, since options entries
 *  are gated by the same equity screen (docs/AUTOTRADING_SPEC.md, phase 9)
 *  and there's no reason to re-fetch/re-classify the same underlyings twice. */
export async function loadBacktestHistory(
  symbols: string[],
  from: string,
  to: string,
): Promise<{
  historyBySymbol: Map<string, Candle[]>;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}> {
  const { eligible, excluded } = await filterEligibleSymbols(symbols);
  const paddedFrom = addDays(from, -WARMUP_PADDING_DAYS);

  const historyBySymbol = new Map<string, Candle[]>();
  const errors: { symbol: string; message: string }[] = [];
  await mapPool(eligible, 6, async (symbol) => {
    try {
      const bars = await getHistoricalBars(symbol, TIMEFRAME, paddedFrom, to);
      if (bars.length) historyBySymbol.set(symbol.toUpperCase(), bars);
    } catch (err) {
      errors.push({ symbol, message: (err as Error).message });
    }
  });

  return { historyBySymbol, excludedSymbols: excluded, errors };
}

/**
 * WEEKLY counterpart of loadBacktestHistory (2026-07-16, multi-timeframe
 * confirmation) — no real-estate pre-filter of its own; `symbols` is meant
 * to be whatever loadBacktestHistory's OWN historyBySymbol.keys() already
 * came back as (already eligibility-checked once), not re-derived from
 * scratch. No WARMUP_PADDING_DAYS either — that padding exists so a DAILY
 * MA has a full window on the first simulated day; a weekly candle only
 * needs cfg.maShort WEEKS of lookback, comfortably covered by padding `from`
 * back one calendar year regardless of maShort's actual value (mirrors
 * screen.ts's own WEEKLY_CANDLE_LIMIT — a fixed, generous constant, not
 * sized off cfg.maShort dynamically). Errors are swallowed per-symbol (a
 * symbol simply has no weekly confirmation available, exactly like
 * `ind.weeklyMaShort === null` already means for a live/paper fetch
 * failure) rather than surfaced in a `errors` list of their own — this
 * filter fails CLOSED on missing data by design (see ScreenerFilters.
 * requireWeeklyTrendAlignment), so a fetch failure here already shows up
 * as "candidate blocked," not a silent pass needing a separate report. */
export async function loadWeeklyBacktestHistory(
  symbols: string[],
  from: string,
  to: string,
): Promise<Map<string, Candle[]>> {
  const paddedFrom = addDays(from, -365);
  const weeklyHistoryBySymbol = new Map<string, Candle[]>();
  await mapPool(symbols, 6, async (symbol) => {
    try {
      const bars = await getHistoricalBars(symbol, 'weekly', paddedFrom, to);
      if (bars.length) weeklyHistoryBySymbol.set(symbol.toUpperCase(), bars);
    } catch {
      /* no weekly confirmation available for this symbol — fails closed, see doc comment above */
    }
  });
  return weeklyHistoryBySymbol;
}

/**
 * Benchmark counterpart of loadWeeklyBacktestHistory (2026-07-17,
 * relative-strength-vs-benchmark) — a SINGLE symbol's own daily bars, not
 * per-candidate, reused by every candidate scored against it below. Same
 * WARMUP_PADDING_DAYS padding as loadBacktestHistory's own candidate
 * fetch — comfortably covers the default 20-day lookback with room to
 * spare. A fetch failure returns undefined (fails closed exactly like
 * loadWeeklyBacktestHistory: no benchmark data this run means every
 * candidate's relativeStrength component scores 0 for the whole run, not a
 * thrown error). */
export async function loadBenchmarkBacktestHistory(
  benchmarkSymbol: string,
  from: string,
  to: string,
): Promise<Candle[] | undefined> {
  const paddedFrom = addDays(from, -WARMUP_PADDING_DAYS);
  try {
    const bars = await getHistoricalBars(benchmarkSymbol, TIMEFRAME, paddedFrom, to);
    return bars.length ? bars : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Full backtest: pre-filter real estate, fetch (or reuse cached) historical
 * bars for every eligible symbol, then simulate. Async orchestration around
 * the pure simulateBacktest() core.
 */
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const weeklyHistoryBySymbol = cfg.screenerConfig?.filters?.requireWeeklyTrendAlignment
    ? await loadWeeklyBacktestHistory(Array.from(historyBySymbol.keys()), cfg.from, cfg.to)
    : undefined;
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  // The proxy (benchmark) series is needed for relative-strength scoring AND for
  // regime-adaptive weights (which derive the per-day regime from it), so load it
  // when EITHER is active.
  const benchmarkCandles =
    (cfg.screenerConfig?.weights?.relativeStrength ?? 0) || cfg.regimeAdaptiveWeightsEnabled
      ? await loadBenchmarkBacktestHistory(screenerCfg.benchmarkSymbol, cfg.from, cfg.to)
      : undefined;
  const report = simulateBacktest(historyBySymbol, cfg, weeklyHistoryBySymbol, benchmarkCandles);
  return { ...report, excludedSymbols, errors };
}

export interface WalkForwardConfig extends BacktestConfig {
  /** YYYY-MM-DD. Splits the run into in-sample [from, splitDate] (the
   *  "tuning" window) and out-of-sample (splitDate, to] (unseen data) —
   *  must fall between from and to, leaving both windows non-empty. */
  splitDate: string;
}

export interface WalkForwardReport {
  inSample: BacktestReport;
  outOfSample: BacktestReport;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

/**
 * The validation gate (docs/AUTOTRADING_SPEC.md — VALIDATION GATE): the same
 * strategy configuration replayed over the same fetched history — once on
 * [from, splitDate] (in-sample), once on (splitDate, to] (out-of-sample). A
 * strategy that only performs on the window it was tuned on is exactly what
 * this is meant to surface. Both windows start from the same startingEquity
 * (independent runs, not the out-of-sample window compounding on the
 * in-sample result) so their stats are directly comparable rather than
 * confounded by a different effective account size.
 */
export async function runWalkForwardBacktest(cfg: WalkForwardConfig): Promise<WalkForwardReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const weeklyHistoryBySymbol = cfg.screenerConfig?.filters?.requireWeeklyTrendAlignment
    ? await loadWeeklyBacktestHistory(Array.from(historyBySymbol.keys()), cfg.from, cfg.to)
    : undefined;
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const benchmarkCandles =
    (cfg.screenerConfig?.weights?.relativeStrength ?? 0) || cfg.regimeAdaptiveWeightsEnabled
      ? await loadBenchmarkBacktestHistory(screenerCfg.benchmarkSymbol, cfg.from, cfg.to)
      : undefined;
  const outOfSampleFrom = addDays(cfg.splitDate, 1);
  const inSample = simulateBacktest(
    historyBySymbol,
    { ...cfg, from: cfg.from, to: cfg.splitDate },
    weeklyHistoryBySymbol,
    benchmarkCandles,
  );
  const outOfSample = simulateBacktest(
    historyBySymbol,
    { ...cfg, from: outOfSampleFrom, to: cfg.to },
    weeklyHistoryBySymbol,
    benchmarkCandles,
  );
  return { inSample, outOfSample, excludedSymbols, errors };
}
