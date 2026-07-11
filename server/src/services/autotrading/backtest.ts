import { Candle, Timeframe } from '../../providers/types';
import { ScreenerConfig, SymbolScore, scoreSymbol } from '../../indicators/screener';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { DecisionConfig, TradeSignal, defaultDecisionConfig, generateSignal } from './decide';
import { evaluateRiskCheck, RiskCheckContext } from './riskCheck';
import { RiskProfileName } from '../../db/autotradeConfig';
import { defaultAutotradeScreenerConfig } from './screen';
import { isExcluded } from '../../db/autotradeExclusions';
import { classifySector } from './realEstateClassifier';
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
  screenerConfig?: Partial<ScreenerConfig>;
  decisionConfig?: Partial<DecisionConfig>;
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

/** Index of the last candle with `time <= asOfMs`, or -1 if none. Exported
 *  for reuse by optionsBacktest.ts, which needs the identical "as of this
 *  simulated day" lookup for option contract bars, not just equity ones. */
export function indexAsOf(candles: Candle[], asOfMs: number): number {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= asOfMs) idx = i;
    else break;
  }
  return idx;
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
export function backtestCorrelatedNotional(
  candidateSymbol: string,
  asOfMs: number,
  positions: { symbol: string; notional: number }[],
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
    if (r !== null && Math.abs(r) >= threshold) amount += pos.notional;
  }
  return amount;
}

/**
 * Run the simulation over already-loaded history. Pure — no I/O — so it's
 * directly unit-testable with hand-built candle series. `historyBySymbol`
 * should include WARMUP_PADDING_DAYS or more of lookback before `cfg.from`.
 */
export function simulateBacktest(historyBySymbol: Map<string, Candle[]>, cfg: BacktestConfig): BacktestReport {
  const riskParams = resolveBacktestRiskParams(cfg);
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const decisionCfg = { ...defaultDecisionConfig(), ...cfg.decisionConfig };

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
  const closedPnls: number[] = []; // chronological, for the consecutive-loss streak
  let equity = cfg.startingEquity;
  let openPositions: OpenPosition[] = [];
  let pendingEntries: PendingEntry[] = [];

  for (const day of tradingDays) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    let dailyPnl = 0;

    // 1) Fill yesterday's approved signals at TODAY's open, if this symbol has a bar today.
    let filledToday = 0;
    const stillPending: PendingEntry[] = [];
    for (const p of pendingEntries) {
      const candles = historyBySymbol.get(p.symbol);
      const idx = candles ? indexAsOf(candles, dayMs) : -1;
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
      const idx = candles ? indexAsOf(candles, dayMs) : -1;
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
        closedPnls.push(pnl);
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
              closedPnls.push(partialPnl);
              dailyPnl += partialPnl;
              equity += partialPnl;
              pos.quantity -= closeQty;
              pos.partialExitTaken = true;
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
        }
        stillOpen.push(pos);
      }
    }
    openPositions = stillOpen;

    // 3) Screen + Decide + Risk-check for new signals, using data through today's close.
    const streak = computeStreaksAndDrawdown(closedPnls).currentStreak;
    const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;
    const openSymbols = new Set([...openPositions.map((p) => p.symbol), ...pendingEntries.map((p) => p.symbol)]);

    const candidates: { score: SymbolScore; signal: TradeSignal }[] = [];
    for (const [symbol, candles] of historyBySymbol) {
      if (openSymbols.has(symbol)) continue; // don't stack a second position in the same name
      const idx = indexAsOf(candles, dayMs);
      if (idx < 1 || candles[idx].time !== dayMs) continue; // needs a bar dated exactly today
      const history = candles.slice(0, idx + 1);
      const score = scoreSymbol(symbol, history, undefined, screenerCfg);
      if (!score.passedFilters) continue;
      const signal = generateSignal({ ...score, discoverySource: 'universe' }, decisionCfg);
      if (signal) candidates.push({ score, signal });
    }
    // Deterministic tie-break on exact score ties: fall back to symbol name, not
    // Map/candle-array insertion order (which depends on real fetch-completion
    // timing in loadBacktestHistory's mapPool — reruns of an identical config
    // against identical cached data must produce identical results).
    candidates.sort((a, b) => b.score.total - a.score.total || a.score.symbol.localeCompare(b.score.symbol));

    let runningRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openPositions.length;
    const runningPositions: { symbol: string; notional: number }[] = openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.notional,
    }));

    for (const { signal } of candidates) {
      // Threaded through runningPositions (open + already-approved-this-batch),
      // not the pre-batch openPositions snapshot — matches riskCheck.ts's
      // runAutotradeRiskCheck, which correctly counts a signal approved
      // earlier in the same batch against the next one. Using the stale
      // snapshot here would let several mutually-correlated candidates all
      // clear this cap on the same day, understating exactly the correlated-
      // cluster risk this check exists to catch.
      const correlated = backtestCorrelatedNotional(
        signal.symbol,
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
      runningPositions.push({ symbol: signal.symbol, notional: result.approvedNotional });
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
  await mapPool(symbols, 6, async (symbol) => {
    if (isExcluded(symbol)) {
      excluded.push({ symbol, reason: 'On the real-estate exclusion list' });
      return;
    }
    const classification = await classifySector(symbol);
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
 * Full backtest: pre-filter real estate, fetch (or reuse cached) historical
 * bars for every eligible symbol, then simulate. Async orchestration around
 * the pure simulateBacktest() core.
 */
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const report = simulateBacktest(historyBySymbol, cfg);
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
  const outOfSampleFrom = addDays(cfg.splitDate, 1);
  const inSample = simulateBacktest(historyBySymbol, { ...cfg, from: cfg.from, to: cfg.splitDate });
  const outOfSample = simulateBacktest(historyBySymbol, { ...cfg, from: outOfSampleFrom, to: cfg.to });
  return { inSample, outOfSample, excludedSymbols, errors };
}
