import { Candle } from '../../providers/types';
import {
  candleIndicatorsAt,
  CandleIndicatorSeries,
  computeCandleIndicatorSeries,
  Direction,
  lookbackReturnPct,
  ScreenerConfig,
  SymbolScore,
  scoreSymbol,
  scoreSymbolBothDirections,
} from '../../indicators/screener';
import { dailyReturns } from '../../indicators/indicators';
import { DecisionConfig, TradeSignal, defaultDecisionConfig, generateSignal } from './decide';
import { reorderByCorrelation } from './correlationSelection';
import { regimeLabelFromProxy, backtestRegimeWeights } from './regimeWeights';
import { computeScaleIn } from './scaleIn';
import { evaluateRiskCheck, RiskCheckContext } from './riskCheck';
import { evaluateOptionsRiskCheck } from './optionsRiskCheck';
import {
  AUTO_STRATEGY_IV_RANK_THRESHOLD,
  defaultAutotradeEntryConfig,
  OptionsDecisionConfig,
  OptionsSignalSide,
} from './optionsDecide';
import { RiskProfileName, OptionsStrategyType, RegimeWeightPresets } from '../../db/autotradeConfig';
import { defaultAutotradeScreenerConfig, pickDirection } from './screen';
import { getHistoricalBars } from './historicalData';
import { getHistoricalOptionContracts } from './optionsHistoricalData';
import { OptionContractRef } from './polygonOptionsClient';
import { impliedVol, bsGreeks, yearsToExpiration } from '../../options/blackScholes';
import { computeIvContext } from '../ivRank';
import { evaluateExit, unrealizedReturnPct } from '../../options/exitRules';
import {
  addDays,
  backtestCorrelatedNotional,
  BacktestRiskParams,
  closedWeeklyIndexAsOf,
  EquityPoint,
  indexAsOf,
  loadBacktestHistory,
  loadBenchmarkBacktestHistory,
  loadWeeklyBacktestHistory,
  MS_PER_DAY,
  resolveBacktestRiskParams,
  SimulatedTrade,
  toISO,
  WARMUP_PADDING_DAYS,
} from './backtest';
import {
  pickReferenceContract,
  pickShortLegReferenceContract,
  simulatedOptionsPnl,
  ShortLegReference,
  SimulatedOptionsTrade,
} from './optionsBacktest';

// ---------------------------------------------------------------------------
// A genuinely combined equity+options backtest (docs/AUTOTRADING_SPEC.md —
// phase 11's own deferral note: "an independent backtest, not combined with a
// concurrent equity backtest's risk in the same run... the same posture
// phase 4's risk-check had before phase 6 gave it a concurrent execution
// consumer"). backtest.ts's simulateBacktest() and optionsBacktest.ts's
// simulateOptionsBacktest() are each a single, self-contained loop over the
// WHOLE date range — there's no seam to pause one mid-run and let the other
// catch up without restructuring either (13+ and 20+ existing tests). This is
// a NEW, third day-loop instead: same day-by-day skeleton as both existing
// engines, reusing every PURE building block they already reuse (scoreSymbol,
// generateSignal, evaluateRiskCheck, evaluateOptionsRiskCheck,
// pickReferenceContract, the Black-Scholes helpers, backtestCorrelatedNotional)
// — but sharing ONE running risk/count/position ledger across both instrument
// types within each simulated day, exactly the property phase 10's
// evaluateOptionsRiskCheck was already built to support (it takes the running
// totals as a plain RiskCheckContext, agnostic to where they came from) and
// exactly what the live loop (phase 12) already does for real, unattended,
// paper-execution risk-checks — this backtest measures the SAME combined
// budget the live system enforces, not a looser approximation.
//
// Ordering mirrors the live loop's own (loop.ts): each day, ALL equity
// candidates are decided/risk-checked FIRST — seeded with options' own
// pre-existing open risk/positions, exactly like runPaperExecution() is
// seeded via optionsSeedForEquity() — then ALL options candidates are
// decided/risk-checked SECOND, continuing the running ledger equity's own
// batch just left off at (which by then already reflects anything equity
// approved this same day). This is "equity batch, then options batch, one
// shared ledger" — not naive per-candidate interleaving, which has no
// precedent anywhere else in this codebase.
//
// "Already open" exclusion stays PER INSTRUMENT TYPE — a symbol can carry an
// open equity position AND an open options position at once (they're
// tracked in separate tables live, matching autotradePaperPositions.ts vs.
// autotradeOptionsPaperPositions.ts) — only the shared RISK BUDGET combines.
//
// consecutiveLosses combines by MAX across the two books' own closed-trade
// streaks, not a merged chronological one — the same "erring toward a more
// conservative streak after recent losses in EITHER book" reasoning phase
// 12's combined-budget-for-real work and phase 13's dashboard already use
// verbatim, kept consistent here rather than inventing a third definition.
//
// Options-side entry logic reuses optionsBacktest.ts's own already-confirmed
// scope reductions unchanged (single reference contract per underlying per
// day, no OI/bid-ask, hv-estimate IV-rank fallback) — this file only changes
// HOW the two risk budgets combine, not what either side's entry rules
// already are. Single leg or debit spread, matching whichever
// cfg.optionsDecisionConfig?.strategyType the equity/options backtest route
// was given — reuses optionsBacktest.ts's own pickShortLegReferenceContract()/
// simulatedOptionsPnl() for the short leg's selection and P&L, not a
// reimplementation (Task #69). Options exit was originally time-based only;
// optionsStopLossPct/optionsTakeProfitPct below add a %-of-premium P&L rule
// on top (2026-07-16, same follow-up as optionsBacktest.ts's own).
// ---------------------------------------------------------------------------

const RISK_FREE_RATE = 0.04;

export interface CombinedBacktestConfig extends Partial<BacktestRiskParams> {
  symbols: string[];
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  riskProfile: RiskProfileName;
  startingEquity: number;
  /** Same cap as AutotradeConfig.maxConcurrentPositions, own value here — a
   *  backtest is a self-contained hypothetical, not coupled to the live
   *  account's current setting (mirrors startingEquity's existing convention).
   *  ONE combined budget shared by both legs, same as the live loop. */
  maxConcurrentPositions: number;
  /** Force-close an EQUITY leg position open this many CALENDAR days without
   *  a stop/target hit — mirrors backtest.ts's own maxHoldDays. Has no effect
   *  on the options leg (which already force-closes via its own separate
   *  time-exit). Omitted or 0 disables it. */
  maxHoldDays?: number;
  /** Trailing stop / breakeven / partial profit-taking for the EQUITY leg
   *  only — mirrors backtest.ts's own fields exactly (same defaults, same
   *  R-multiple-of-original-stop-distance semantics). No effect on the
   *  options leg. */
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
  optionsDecisionConfig?: Partial<OptionsDecisionConfig>;
  /** 'long' (default) | 'short' | 'both' — own value here, NOT read from live
   *  config, same self-contained-hypothesis convention as
   *  BacktestConfig.directionMode (backtest.ts) and
   *  OptionsBacktestConfig.directionMode (optionsBacktest.ts). Governs BOTH
   *  legs from the SAME per-symbol scoring pass: the equity leg resolves
   *  each candidate's side via scoreSymbolBothDirections()/pickDirection()
   *  in 'both' mode, and the options leg derives call/put from that exact
   *  same resolved direction — not a separate options-only setting, mirroring
   *  how the live loop's options decision reads ScreenCandidate.direction. */
  directionMode?: 'long' | 'short' | 'both';
  /** Own value here, NOT read from live config if omitted — same
   *  self-contained-hypothesis convention as every other backtest field.
   *  Mirrors AutotradeConfig.optionsStopLossPct/optionsTakeProfitPct
   *  (0/omitted disables each); applies to the OPTIONS leg only — the
   *  equity leg keeps its own separate breakevenTriggerRMultiple etc. above. */
  optionsStopLossPct?: number;
  optionsTakeProfitPct?: number;
  /** Trailing stop / breakeven / partial profit-taking for the OPTIONS leg
   *  only — mirrors optionsBacktest.ts's own fields exactly (same defaults,
   *  same %-of-premium-gain semantics, net debit basis for a spread). No
   *  effect on the equity leg, which keeps its own separate
   *  breakevenTriggerRMultiple etc. above. */
  optionsBreakevenTriggerPct?: number;
  optionsTrailStartPct?: number;
  optionsTrailStopPct?: number;
  optionsPartialExitTriggerPct?: number;
  optionsPartialExitPct?: number;
  /** Regime-conditional scoring weights (2026-07-24, off by default) — scores
   *  each simulated day with the preset matching the proxy-derived regime as of
   *  that day. Governs the EQUITY-leg scoring pass (which the options leg reads
   *  its direction from). Mirrors BacktestConfig; both default to fixed weights. */
  regimeAdaptiveWeightsEnabled?: boolean;
  regimeWeightPresets?: RegimeWeightPresets;
}

export interface CombinedBacktestReport {
  equityTrades: SimulatedTrade[];
  optionsTrades: SimulatedOptionsTrade[];
  /** ONE curve — the combined account value, not two separate ones. */
  equityCurve: EquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  optionsSkipped: { symbol: string; date: string; reason: string }[];
}

interface OpenEquityPosition {
  symbol: string;
  side: 'buy' | 'sell';
  signalDate: string;
  entryDate: string;
  /** ms epoch of entryDate — mirrors backtest.ts's own OpenPosition field. */
  entryDateMs: number;
  entryPrice: number;
  stop: number;
  target: number;
  /** Snapshot of `stop` at fill time, never mutated again — mirrors
   *  backtest.ts's own OpenPosition.initialStop. */
  initialStop: number;
  /** Best (most favorable) bar CLOSE seen since entry — mirrors
   *  backtest.ts's own OpenPosition.bestPrice. */
  bestPrice: number;
  partialExitTaken: boolean;
  /** How many times this position has been scaled into (pyramided). */
  addOnsTaken: number;
  quantity: number;
  riskAmount: number;
  notional: number;
}

interface PendingEquityEntry {
  symbol: string;
  signalDate: string;
  signal: TradeSignal;
  quantity: number;
  riskAmount: number;
  notional: number;
}

interface OpenOptionPosition {
  symbol: string;
  side: OptionsSignalSide;
  kind: OptionsStrategyType;
  contractTicker: string;
  strike: number;
  shortContractTicker?: string;
  shortStrike?: number;
  expiration: string;
  signalDate: string;
  entryDate: string;
  entryPremium: number;
  shortEntryPremium?: number;
  contracts: number;
  riskAmount: number;
  notional: number;
  /** Running peak of (mark − short mark) seen since entry — mirrors
   *  optionsBacktest.ts's own OpenOptionPosition.bestBasisSinceEntry; always
   *  a running MAX (options are always opened long). Seeded at entry basis. */
  bestBasisSinceEntry: number;
  /** Ratcheted minimum acceptable unrealized gain % (net debit basis, for a
   *  spread). Null until a breakeven/trailing event first fires. */
  stopFloorPct: number | null;
  partialExitTaken: boolean;
}

interface PendingOptionEntry {
  symbol: string;
  side: OptionsSignalSide;
  kind: OptionsStrategyType;
  contractTicker: string;
  strike: number;
  shortContractTicker?: string;
  shortStrike?: number;
  expiration: string;
  signalDate: string;
  contracts: number;
  riskAmount: number;
  notional: number;
}

/** Maps exitRules.ts's own kebab-case ExitTrigger.rule strings to this
 *  engine's snake_case exit reason values — same mapping convention as
 *  optionsExecute.ts's/optionsBacktest.ts's own exitReasonFor() (deliberately
 *  duplicated, not shared, matching this codebase's parallel-engine
 *  convention). */
function exitReasonFor(activeRule: string): 'stop_loss' | 'take_profit' | 'time_exit' {
  switch (activeRule) {
    case 'stop-loss':
      return 'stop_loss';
    case 'take-profit':
      return 'take_profit';
    default:
      return 'time_exit';
  }
}

/**
 * Run the combined simulation over already-loaded equity history and
 * pre-fetched contract reference data. Async (like simulateOptionsBacktest)
 * since contract price bars are fetched on demand as the simulation unfolds.
 */
export async function simulateCombinedBacktest(
  historyBySymbol: Map<string, Candle[]>,
  contractsBySymbol: Map<string, OptionContractRef[]>,
  cfg: CombinedBacktestConfig,
  weeklyHistoryBySymbol?: Map<string, Candle[]>,
  benchmarkCandles?: Candle[],
): Promise<CombinedBacktestReport> {
  const riskParams = resolveBacktestRiskParams(cfg);
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const decisionCfg = { ...defaultDecisionConfig(), ...cfg.decisionConfig };
  const directionMode = cfg.directionMode ?? 'long';
  const sideFor = (direction: Direction): OptionsSignalSide => (direction === 'long' ? 'call' : 'put');
  const entryConfigFor = (side: OptionsSignalSide) => ({
    ...defaultAutotradeEntryConfig(side),
    ...cfg.optionsDecisionConfig?.entryConfig,
    side,
  });
  // The DTE window doesn't vary by side (defaultAutotradeEntryConfig's
  // minDaysToExpiration is the same for calls and puts) — read once,
  // side-independent, for the already-open-position time-exit check below
  // (which runs before that day's candidates, and so before any side, are known).
  const exitMinDaysToExpiration = cfg.optionsDecisionConfig?.entryConfig?.minDaysToExpiration ?? 7;
  const configuredOptStrategyType: OptionsStrategyType = cfg.optionsDecisionConfig?.strategyType ?? 'single_leg';

  const fromMs = Date.parse(`${cfg.from}T00:00:00Z`);
  const toMs = Date.parse(`${cfg.to}T00:00:00Z`);

  const dateSet = new Set<string>();
  for (const candles of historyBySymbol.values()) {
    for (const c of candles) {
      if (c.time >= fromMs && c.time <= toMs) dateSet.add(toISO(c.time));
    }
  }
  const tradingDays = Array.from(dateSet).sort();

  const barsMemo = new Map<string, Candle[]>();
  const getContractBars = async (ticker: string): Promise<Candle[]> => {
    if (!barsMemo.has(ticker)) {
      const bars = await getHistoricalBars(ticker, 'daily', addDays(cfg.from, -WARMUP_PADDING_DAYS), cfg.to);
      barsMemo.set(ticker, bars);
    }
    return barsMemo.get(ticker)!;
  };

  const equityTrades: SimulatedTrade[] = [];
  const optionsTrades: SimulatedOptionsTrade[] = [];
  const optionsSkipped: { symbol: string; date: string; reason: string }[] = [];
  const equityCurve: EquityPoint[] = [];
  const equityClosedPnls: number[] = [];
  const optionsClosedPnls: number[] = [];
  let equity = cfg.startingEquity;
  let openEquity: OpenEquityPosition[] = [];
  let pendingEquity: PendingEquityEntry[] = [];
  let openOptions: OpenOptionPosition[] = [];
  let pendingOptions: PendingOptionEntry[] = [];

  // Running win/loss streaks, maintained incrementally instead of calling
  // computeStreaksAndDrawdown(...) (an O(closedPnls.length) rescan) every
  // single day — mirrors that function's own per-element logic exactly,
  // updated at the same points each closedPnls array is appended to.
  const equityStreak: { type: 'win' | 'loss' | 'none'; count: number } = { type: 'none', count: 0 };
  const optionsStreak: { type: 'win' | 'loss' | 'none'; count: number } = { type: 'none', count: 0 };
  function recordStreak(streak: { type: 'win' | 'loss' | 'none'; count: number }, pnl: number): void {
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

  // SMA/RSI/ATR over each symbol's FULL history, computed ONCE up front
  // (single O(n) pass each) instead of re-sliced-and-recomputed from scratch
  // for every simulated day below (the O(days²) cost this precompute step
  // eliminates) — see computeCandleIndicatorSeries's own doc comment for why
  // this is mathematically identical to the original per-day recompute.
  const candleIndicatorSeriesBySymbol = new Map<string, CandleIndicatorSeries>();
  for (const [symbol, candles] of historyBySymbol) {
    candleIndicatorSeriesBySymbol.set(symbol, computeCandleIndicatorSeries(candles, screenerCfg));
  }
  // WEEKLY counterpart (2026-07-16, multi-timeframe confirmation) — mirrors
  // backtest.ts's simulateBacktest() own identical precompute exactly. Only
  // built when the caller supplied a weekly history (requireWeeklyTrendAlignment
  // enabled) — see that function's own doc comment.
  const weeklyCandleIndicatorSeriesBySymbol = new Map<string, CandleIndicatorSeries>();
  if (weeklyHistoryBySymbol) {
    for (const [symbol, weeklyCandles] of weeklyHistoryBySymbol) {
      weeklyCandleIndicatorSeriesBySymbol.set(symbol, computeCandleIndicatorSeries(weeklyCandles, screenerCfg));
    }
  }
  // Per-symbol resume point for the scoring loop's own indexAsOf call below —
  // mirrors backtest.ts's identical indexCursor (dayMs only increases across
  // this loop, so each symbol's answer only ever advances forward).
  const scoringIndexCursor = new Map<string, number>();
  // The benchmark's own resume point (2026-07-17, relative-strength-vs-
  // benchmark) — a single cursor, not per-symbol, mirrors backtest.ts's
  // identical benchmarkIndexCursor.
  let benchmarkIndexCursor = 0;

  for (let dayIndex = 0; dayIndex < tradingDays.length; dayIndex++) {
    const day = tradingDays[dayIndex];
    // Yield to the event loop periodically — this simulation is entirely
    // synchronous CPU work otherwise (every "await" below resolves off an
    // already-populated in-memory memo, not real I/O), so a large request
    // would otherwise block every other request — including the live
    // autotrade loop's own tick — for the simulation's whole duration.
    if (dayIndex > 0 && dayIndex % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
    const dayMs = Date.parse(`${day}T00:00:00Z`);

    // 1) Fill yesterday's approved EQUITY entries at today's open.
    let equityFilledToday = 0;
    const stillPendingEquity: PendingEquityEntry[] = [];
    for (const p of pendingEquity) {
      const candles = historyBySymbol.get(p.symbol);
      const idx = candles ? indexAsOf(candles, dayMs) : -1;
      if (idx >= 0 && candles![idx].time === dayMs) {
        openEquity.push({
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
        equityFilledToday += 1;
      } else if (idx < 0 || candles![idx].time < dayMs) {
        stillPendingEquity.push(p);
      }
    }
    pendingEquity = stillPendingEquity;

    // 2) Check open EQUITY positions for a stop/target hit (today's high/low).
    let dailyEquityPnl = 0;
    const stillOpenEquity: OpenEquityPosition[] = [];
    for (const pos of openEquity) {
      const candles = historyBySymbol.get(pos.symbol);
      const idx = candles ? indexAsOf(candles, dayMs) : -1;
      const bar = idx >= 0 && candles![idx].time === dayMs ? candles![idx] : null;
      if (!bar) {
        stillOpenEquity.push(pos);
        continue;
      }
      const long = pos.side === 'buy';
      const sign = long ? 1 : -1;
      const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = long ? bar.high >= pos.target : bar.low <= pos.target;
      const maxHoldDays = cfg.maxHoldDays ?? 0;
      const timeHit = !stopHit && !targetHit && maxHoldDays > 0 && dayMs - pos.entryDateMs >= maxHoldDays * MS_PER_DAY;
      if (stopHit || targetHit || timeHit) {
        const exitReason: SimulatedTrade['exitReason'] = stopHit ? 'stop' : targetHit ? 'target' : 'time_exit';
        const exitPrice = stopHit ? pos.stop : targetHit ? pos.target : bar.close;
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * sign;
        equityTrades.push({
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
        equityClosedPnls.push(pnl);
        recordStreak(equityStreak, pnl);
        dailyEquityPnl += pnl;
        equity += pnl;
      } else {
        // Trailing stop / breakeven / partial profit-taking — mirrors
        // backtest.ts's own identical equity-leg logic (bar CLOSE, not
        // intrabar high/low; see its own comment for why).
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
              equityTrades.push({
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
              equityClosedPnls.push(partialPnl);
              recordStreak(equityStreak, partialPnl);
              dailyEquityPnl += partialPnl;
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

          // Scale into a winner (pyramiding) — mirrors backtest.ts's equity
          // leg: add against the bar CLOSE, never in the same bar as a partial
          // scale-out. See services/autotrading/scaleIn.ts.
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
        stillOpenEquity.push(pos);
      }
    }
    openEquity = stillOpenEquity;

    // 3) Fill yesterday's approved OPTIONS entries at today's contract open.
    // A debit spread fills BOTH legs together or not at all (see
    // optionsExecute.ts's own paper-execution atomicity).
    let optionsFilledToday = 0;
    const stillPendingOptions: PendingOptionEntry[] = [];
    for (const p of pendingOptions) {
      const bars = await getContractBars(p.contractTicker);
      const idx = indexAsOf(bars, dayMs);
      const longBar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;

      let shortBar: Candle | null = null;
      if (p.kind === 'debit_spread') {
        const shortBars = await getContractBars(p.shortContractTicker!);
        const shortIdx = indexAsOf(shortBars, dayMs);
        shortBar = shortIdx >= 0 && shortBars[shortIdx].time === dayMs ? shortBars[shortIdx] : null;
      }

      const ready = p.kind === 'debit_spread' ? longBar && shortBar : longBar;
      if (ready) {
        {
          const entryPremium = longBar!.open;
          const shortEntryPremium = shortBar?.open;
          openOptions.push({
            symbol: p.symbol,
            side: p.side,
            kind: p.kind,
            contractTicker: p.contractTicker,
            strike: p.strike,
            shortContractTicker: p.shortContractTicker,
            shortStrike: p.shortStrike,
            expiration: p.expiration,
            signalDate: p.signalDate,
            entryDate: day,
            entryPremium,
            shortEntryPremium,
            contracts: p.contracts,
            riskAmount: p.riskAmount,
            notional: p.notional,
            bestBasisSinceEntry: entryPremium - (shortEntryPremium ?? 0),
            stopFloorPct: null,
            partialExitTaken: false,
          });
        }
        optionsFilledToday += 1;
      } else {
        stillPendingOptions.push(p);
      }
    }
    pendingOptions = stillPendingOptions;

    // 4) Check open OPTIONS positions for the time-exit trigger. A spread
    // closes BOTH legs together — the short leg's bar missing that day
    // leaves the whole position open, same as the long leg's own.
    let dailyOptionsPnl = 0;
    const stillOpenOptions: OpenOptionPosition[] = [];
    for (const pos of openOptions) {
      if (pos.entryDate === day) {
        stillOpenOptions.push(pos);
        continue;
      }
      const bars = await getContractBars(pos.contractTicker);
      const idx = indexAsOf(bars, dayMs);
      const bar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;
      if (!bar) {
        stillOpenOptions.push(pos);
        continue;
      }
      let shortBar: Candle | null = null;
      if (pos.kind === 'debit_spread') {
        const shortBars = await getContractBars(pos.shortContractTicker!);
        const shortIdx = indexAsOf(shortBars, dayMs);
        shortBar = shortIdx >= 0 && shortBars[shortIdx].time === dayMs ? shortBars[shortIdx] : null;
        if (!shortBar) {
          stillOpenOptions.push(pos);
          continue;
        }
      }
      const exitPremium = bar.close;
      const shortExitPremium = shortBar?.close;
      // Stop-loss/take-profit are evaluated from the SAME bar data just
      // fetched above for the time-exit check — no new cost. Net debit
      // (long minus short premium) is the basis for a spread, at both entry
      // and now — the same basis simulatedOptionsPnl() already sizes P&L
      // from.
      const entryBasis =
        pos.kind === 'debit_spread' ? pos.entryPremium - (pos.shortEntryPremium ?? 0) : pos.entryPremium;
      const currentBasis = pos.kind === 'debit_spread' ? exitPremium - (shortExitPremium ?? 0) : exitPremium;
      // Once a breakeven/trailing event has ratcheted stopFloorPct, it
      // OVERRIDES the live cfg.optionsStopLossPct for this position — null
      // means nothing has ratcheted yet, so behavior is byte-for-byte
      // unchanged (mirrors optionsBacktest.ts's own identical logic).
      const stopLossPct = pos.stopFloorPct != null ? -pos.stopFloorPct : cfg.optionsStopLossPct || undefined;
      const ev = evaluateExit(
        { entryPrice: entryBasis, currentPrice: currentBasis, side: 'long', expiration: pos.expiration },
        {
          timeExitDaysBeforeExpiry: exitMinDaysToExpiration,
          stopLossPct,
          takeProfitPct: cfg.optionsTakeProfitPct || undefined,
        },
        new Date(dayMs),
      );
      if (ev.triggered) {
        const pnl = simulatedOptionsPnl(
          pos.kind,
          pos.entryPremium,
          exitPremium,
          pos.shortEntryPremium,
          shortExitPremium,
          pos.contracts,
        );
        optionsTrades.push({
          symbol: pos.symbol,
          side: pos.side,
          kind: pos.kind,
          contractTicker: pos.contractTicker,
          strike: pos.strike,
          shortContractTicker: pos.shortContractTicker,
          shortStrike: pos.shortStrike,
          expiration: pos.expiration,
          signalDate: pos.signalDate,
          entryDate: pos.entryDate,
          entryPremium: pos.entryPremium,
          shortEntryPremium: pos.shortEntryPremium,
          exitDate: day,
          exitPremium,
          shortExitPremium,
          exitReason: ev.activeRule === 'time-exit' && ev.dte <= 0 ? 'expiration' : exitReasonFor(ev.activeRule!),
          contracts: pos.contracts,
          pnl,
          rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
        });
        optionsClosedPnls.push(pnl);
        recordStreak(optionsStreak, pnl);
        dailyOptionsPnl += pnl;
        equity += pnl;
      } else {
        // Trailing stop / breakeven / partial profit-taking — mirrors
        // optionsBacktest.ts's own identical block (duplicated per this
        // codebase's parallel-engine convention), against the day's own bar
        // CLOSE.
        const gainPct = unrealizedReturnPct(entryBasis, currentBasis, 'long');
        if (gainPct !== null) {
          const partialExitTriggerPct = cfg.optionsPartialExitTriggerPct ?? 0;
          if (partialExitTriggerPct > 0 && !pos.partialExitTaken && gainPct >= partialExitTriggerPct) {
            const closeQty = Math.floor(pos.contracts * ((cfg.optionsPartialExitPct ?? 0) / 100));
            if (closeQty > 0 && closeQty < pos.contracts) {
              const partialPnl = simulatedOptionsPnl(
                pos.kind,
                pos.entryPremium,
                exitPremium,
                pos.shortEntryPremium,
                shortExitPremium,
                closeQty,
              );
              optionsTrades.push({
                symbol: pos.symbol,
                side: pos.side,
                kind: pos.kind,
                contractTicker: pos.contractTicker,
                strike: pos.strike,
                shortContractTicker: pos.shortContractTicker,
                shortStrike: pos.shortStrike,
                expiration: pos.expiration,
                signalDate: pos.signalDate,
                entryDate: pos.entryDate,
                entryPremium: pos.entryPremium,
                shortEntryPremium: pos.shortEntryPremium,
                exitDate: day,
                exitPremium,
                shortExitPremium,
                exitReason: 'partial_exit',
                contracts: closeQty,
                pnl: partialPnl,
                rMultiple: pos.riskAmount > 0 ? partialPnl / pos.riskAmount : 0,
              });
              optionsClosedPnls.push(partialPnl);
              recordStreak(optionsStreak, partialPnl);
              dailyOptionsPnl += partialPnl;
              equity += partialPnl;
              pos.contracts -= closeQty;
              pos.partialExitTaken = true;
            }
          }

          pos.bestBasisSinceEntry = Math.max(pos.bestBasisSinceEntry, currentBasis);
          const bestGainPct = unrealizedReturnPct(entryBasis, pos.bestBasisSinceEntry, 'long') ?? gainPct;

          const breakevenTriggerPct = cfg.optionsBreakevenTriggerPct ?? 0;
          const trailStartPct = cfg.optionsTrailStartPct ?? 0;
          const trailStopPct = cfg.optionsTrailStopPct ?? 0;
          let candidateFloor: number | null = null;
          if (breakevenTriggerPct > 0 && gainPct >= breakevenTriggerPct) {
            candidateFloor = candidateFloor === null ? 0 : Math.max(candidateFloor, 0);
          }
          if (trailStartPct > 0 && trailStopPct > 0 && gainPct >= trailStartPct) {
            const trailingCandidate = bestGainPct - trailStopPct;
            candidateFloor = candidateFloor === null ? trailingCandidate : Math.max(candidateFloor, trailingCandidate);
          }
          if (candidateFloor !== null) {
            const priorFloor = pos.stopFloorPct ?? (cfg.optionsStopLossPct ? -cfg.optionsStopLossPct : null);
            pos.stopFloorPct = priorFloor === null ? candidateFloor : Math.max(priorFloor, candidateFloor);
          }
        }
        stillOpenOptions.push(pos);
      }
    }
    openOptions = stillOpenOptions;

    // 5) Shared day-level figures. dailyPnl/tradesToday SUM across both books
    // (both contribute to the SAME account); consecutiveLosses combines by
    // MAX of each book's own streak (see file header).
    const dailyPnl = dailyEquityPnl + dailyOptionsPnl;
    const tradesToday = equityFilledToday + optionsFilledToday;
    const equityLossStreak = equityStreak.type === 'loss' ? equityStreak.count : 0;
    const optionsLossStreak = optionsStreak.type === 'loss' ? optionsStreak.count : 0;
    const consecutiveLosses = Math.max(equityLossStreak, optionsLossStreak);

    // The benchmark's own lookback return as of TODAY — computed once per
    // day, reused for every candidate below. See backtest.ts's
    // simulateBacktest() for the identical pattern/reasoning.
    const benchmarkIdx = benchmarkCandles ? indexAsOf(benchmarkCandles, dayMs, benchmarkIndexCursor) : -1;
    if (benchmarkIdx >= 0) benchmarkIndexCursor = benchmarkIdx;
    const benchmarkLookbackReturnPct =
      benchmarkCandles && benchmarkIdx >= 0 && benchmarkCandles[benchmarkIdx].time === dayMs
        ? lookbackReturnPct(benchmarkCandles, screenerCfg.relativeStrengthLookbackDays, benchmarkIdx)
        : null;

    // Regime-conditional weights (2026-07-24, off by default) — score THIS day
    // with the preset matching the proxy-derived regime as of today. Same
    // no-lookahead, weight-independent-cache reasoning as simulateBacktest; a
    // no-op when disabled or with no proxy series.
    const dayWeights = cfg.regimeAdaptiveWeightsEnabled
      ? backtestRegimeWeights(
          screenerCfg.weights,
          cfg.regimeWeightPresets ?? null,
          benchmarkCandles ? regimeLabelFromProxy(benchmarkCandles, benchmarkIdx) : null,
        )
      : screenerCfg.weights;
    const dayScreenerCfg = dayWeights === screenerCfg.weights ? screenerCfg : { ...screenerCfg, weights: dayWeights };

    // 6) Score every symbol ONCE per day (asset-agnostic) — filtered
    // separately below per instrument type's own "already open" exclusion.
    // 'both': score each symbol as a long AND a short from the same
    // indicator computation and keep whichever direction (if either)
    // qualifies — mirrors backtest.ts's/optionsBacktest.ts's own 'both'
    // handling exactly. Resolved ONCE per symbol per day and shared by both
    // legs below: the options leg derives call/put from this SAME resolved
    // direction instead of a separate options-only setting.
    const openEquitySymbols = new Set([...openEquity.map((p) => p.symbol), ...pendingEquity.map((p) => p.symbol)]);
    const openOptionsSymbols = new Set([...openOptions.map((p) => p.symbol), ...pendingOptions.map((p) => p.symbol)]);
    const scoresToday = new Map<
      string,
      { score: SymbolScore; underlyingClose: number; history: Candle[]; direction: Direction }
    >();
    for (const [symbol, candles] of historyBySymbol) {
      const idx = indexAsOf(candles, dayMs, scoringIndexCursor.get(symbol) ?? 0);
      if (idx >= 0) scoringIndexCursor.set(symbol, idx);
      if (idx < 1 || candles[idx].time !== dayMs) continue;
      // Still sliced (rather than passed as the full array) — computeIvContext
      // below needs this exact "history through today" view for its realized-
      // vol fallback; only the indicator computation itself is de-duplicated.
      const history = candles.slice(0, idx + 1);
      const series = candleIndicatorSeriesBySymbol.get(symbol)!;
      const cached = candleIndicatorsAt(series, idx) ?? undefined;
      // The CLOSED-week weekly indicators as of today — see backtest.ts's
      // simulateBacktest() for why closedWeeklyIndexAsOf(), not indexAsOf().
      const weeklyCandles = weeklyHistoryBySymbol?.get(symbol);
      const weeklyCached = weeklyCandles
        ? (candleIndicatorsAt(
            weeklyCandleIndicatorSeriesBySymbol.get(symbol)!,
            closedWeeklyIndexAsOf(weeklyCandles, dayMs),
          ) ?? undefined)
        : undefined;
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
      scoresToday.set(symbol, {
        score: picked.score,
        underlyingClose: candles[idx].close,
        history,
        direction: picked.direction,
      });
    }

    // The ONE shared ledger both legs read from and write to this day —
    // seeded from BOTH books' pre-existing open risk (mirrors
    // optionsSeedForEquity()/PaperPortfolioSeed in the live loop).
    let runningRisk =
      openEquity.reduce((s, p) => s + p.riskAmount, 0) + openOptions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openEquity.length + openOptions.length;
    // Equity keeps its real, resolved side; options positions are always
    // 'long' (see riskCheck.ts's correlatedNotional() doc comment — an
    // autotrade options position is always long-the-contract, a put for a
    // bearish read same as a call for a bullish one, never short-the-
    // contract). Both sides reduce to the exact prior always-additive
    // behavior when equity really is all long, as it always was before
    // directionMode existed.
    const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = [
      ...openEquity.map((p) => ({
        symbol: p.symbol,
        notional: p.notional,
        side: (p.side === 'buy' ? 'long' : 'short') as 'long' | 'short',
      })),
      ...openOptions.map((p) => ({ symbol: p.symbol, notional: p.notional, side: 'long' as const })),
    ];

    // 7) EQUITY decide + risk-check FIRST (same ordering as loop.ts).
    const equityCandidates = Array.from(scoresToday.entries())
      .filter(([symbol]) => !openEquitySymbols.has(symbol))
      .map(([, v]) => v)
      .sort((a, b) => b.score.total - a.score.total || a.score.symbol.localeCompare(b.score.symbol));

    // Correlation-aware selection (2026-07-24, default off): same reorder as
    // simulateBacktest / the live loop, fed from each candidate's own
    // no-lookahead `history` slice (closes through today). No-op when disabled.
    let orderedEquityCandidates = equityCandidates;
    if (riskParams.correlationAwareSelectionEnabled && equityCandidates.length > 1) {
      const returnsBySymbol = new Map<string, number[]>();
      for (const c of equityCandidates) {
        const closes = c.history.slice(-(riskParams.correlationLookbackDays + 1)).map((k) => k.close);
        const returns = dailyReturns(closes);
        if (returns.length >= 2) returnsBySymbol.set(c.score.symbol.toUpperCase(), returns);
      }
      orderedEquityCandidates = reorderByCorrelation(equityCandidates, (c) => c.score.symbol, returnsBySymbol, {
        enabled: true,
        threshold: riskParams.correlationThreshold,
        lookbackDays: riskParams.correlationLookbackDays,
      }).ordered;
    }

    for (const candidate of orderedEquityCandidates) {
      const signal = generateSignal(
        { ...candidate.score, discoverySource: 'universe', direction: candidate.direction },
        decisionCfg,
      );
      if (!signal) continue;
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
        tradesToday,
        consecutiveLosses,
        openRisk: runningRisk,
        openPositionsCount: runningCount,
        maxConcurrentPositions: cfg.maxConcurrentPositions,
        correlatedNotional: correlated,
        ...riskParams,
        // Sector exposure cap has no backtest equivalent either (2026-07-18) —
        // see backtest.ts's own identical note. null unconditionally skips it.
        sectorNotional: 0,
        maxSectorExposurePct: 0,
        candidateSector: null,
        // Regime-aware sizing has no backtest equivalent (2026-07-16) — see
        // backtest.ts's own identical note. null unconditionally disables it.
        marketAtrPct: null,
        regimeAtrThresholdPct: 0,
        regimeSizeCutPct: 0,
      };
      const result = evaluateRiskCheck(signal, ctx);
      if (!result.ok) continue;
      pendingEquity.push({
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

    // 8) OPTIONS decide + risk-check SECOND — continues the SAME ledger,
    // which by now already reflects anything equity just approved today.
    const optionsCandidates = Array.from(scoresToday.entries())
      .filter(([symbol]) => !openOptionsSymbols.has(symbol))
      .map(([symbol, v]) => ({
        symbol,
        total: v.score.total,
        underlyingClose: v.underlyingClose,
        history: v.history,
        direction: v.direction,
      }))
      .sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol));

    for (const candidate of optionsCandidates) {
      const side = sideFor(candidate.direction);
      const entryCfg = entryConfigFor(side);
      const contracts = contractsBySymbol.get(candidate.symbol) ?? [];
      const ref = pickReferenceContract(
        contracts,
        side,
        day,
        candidate.underlyingClose,
        entryCfg.minDaysToExpiration ?? 7,
        entryCfg.maxDaysToExpiration ?? 60,
      );
      if (!ref) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'No contract within the configured DTE window',
        });
        continue;
      }

      const bars = await getContractBars(ref.ticker);
      const idx = indexAsOf(bars, dayMs);
      const bar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;
      if (!bar) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'No historical price for the reference contract on this day',
        });
        continue;
      }
      if (bar.volume < entryCfg.minVolume) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: `Volume ${bar.volume} below minVolume ${entryCfg.minVolume}`,
        });
        continue;
      }

      const T = yearsToExpiration(ref.expiration, new Date(dayMs));
      const iv = impliedVol({
        type: side,
        marketPrice: bar.close,
        S: candidate.underlyingClose,
        K: ref.strike,
        T,
        r: RISK_FREE_RATE,
      });
      if (iv === undefined) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'Implied vol could not be solved from the historical price',
        });
        continue;
      }

      const ivContext = computeIvContext(iv, [], candidate.history);
      if (ivContext.ivRank === null) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'Insufficient underlying price history to estimate IV rank',
        });
        continue;
      }
      if (entryCfg.ivRankMax !== undefined && ivContext.ivRank > entryCfg.ivRankMax) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: `IV rank ${ivContext.ivRank.toFixed(0)} above ivRankMax ${entryCfg.ivRankMax}`,
        });
        continue;
      }

      const delta = bsGreeks({
        type: side,
        S: candidate.underlyingClose,
        K: ref.strike,
        T,
        r: RISK_FREE_RATE,
        sigma: iv,
      }).delta;
      const absDelta = Math.abs(delta);
      if (absDelta < entryCfg.deltaMin || absDelta > entryCfg.deltaMax) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: `|delta| ${absDelta.toFixed(2)} outside [${entryCfg.deltaMin}, ${entryCfg.deltaMax}]`,
        });
        continue;
      }

      // 'auto' resolves per-candidate-per-day here, from that day's own IV
      // rank — same threshold/rationale as the live path (optionsDecide.ts's
      // AUTO_STRATEGY_IV_RANK_THRESHOLD), so backtest and live can't drift.
      const optStrategyType: 'single_leg' | 'debit_spread' =
        configuredOptStrategyType === 'auto'
          ? ivContext.ivRank >= AUTO_STRATEGY_IV_RANK_THRESHOLD
            ? 'debit_spread'
            : 'single_leg'
          : configuredOptStrategyType;

      let shortRef: ShortLegReference | null = null;
      if (optStrategyType === 'debit_spread') {
        shortRef = await pickShortLegReferenceContract(
          contracts,
          side,
          ref.strike,
          ref.expiration,
          day,
          candidate.underlyingClose,
          getContractBars,
        );
        if (!shortRef) {
          optionsSkipped.push({
            symbol: candidate.symbol,
            date: day,
            reason: 'No short-leg contract further out-of-the-money passed the delta band',
          });
          continue;
        }
        if (shortRef.premium >= bar.close) {
          optionsSkipped.push({
            symbol: candidate.symbol,
            date: day,
            reason: 'Short leg premium >= long leg premium — not a net debit, skipped',
          });
          continue;
        }
      }

      const correlated = backtestCorrelatedNotional(
        candidate.symbol,
        'long', // options candidates are always a long-the-contract bet
        dayMs,
        runningPositions,
        historyBySymbol,
        riskParams.correlationLookbackDays,
        riskParams.correlationThreshold,
      );
      const ctx: RiskCheckContext = {
        equity,
        dailyPnl,
        tradesToday,
        consecutiveLosses,
        openRisk: runningRisk,
        openPositionsCount: runningCount,
        maxConcurrentPositions: cfg.maxConcurrentPositions,
        correlatedNotional: correlated,
        ...riskParams,
        // Sector exposure cap has no backtest equivalent either (2026-07-18) —
        // see backtest.ts's own identical note. null unconditionally skips it.
        sectorNotional: 0,
        maxSectorExposurePct: 0,
        candidateSector: null,
        // Regime-aware sizing has no backtest equivalent (2026-07-16) — see
        // backtest.ts's own identical note. null unconditionally disables it.
        marketAtrPct: null,
        regimeAtrThresholdPct: 0,
        regimeSizeCutPct: 0,
      };
      const result = evaluateOptionsRiskCheck(
        shortRef
          ? {
              kind: 'debit_spread',
              symbol: candidate.symbol,
              side: side,
              expiration: ref.expiration,
              dte: T * 365,
              ivRank: ivContext.ivRank,
              longContractSymbol: ref.ticker,
              longStrike: ref.strike,
              longPremium: bar.close,
              longDelta: delta,
              shortContractSymbol: shortRef.contract.ticker,
              shortStrike: shortRef.contract.strike,
              shortPremium: shortRef.premium,
              shortDelta: shortRef.delta,
              width: Math.abs(shortRef.contract.strike - ref.strike),
              netDebit: bar.close - shortRef.premium,
              maxLossPerContract: (bar.close - shortRef.premium) * 100,
              maxProfitPerContract:
                (Math.abs(shortRef.contract.strike - ref.strike) - (bar.close - shortRef.premium)) * 100,
              rationale: `Combined backtest debit spread ${ref.ticker}/${shortRef.contract.ticker}`,
              score: candidate.total,
            }
          : {
              kind: 'single_leg',
              symbol: candidate.symbol,
              side: side,
              contractSymbol: ref.ticker,
              strike: ref.strike,
              expiration: ref.expiration,
              dte: T * 365,
              premium: bar.close,
              delta,
              ivRank: ivContext.ivRank,
              maxLossPerContract: bar.close * 100,
              rationale: `Combined backtest reference contract ${ref.ticker}`,
              score: candidate.total,
            },
        ctx,
      );
      if (!result.ok) {
        optionsSkipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: `Risk check blocked: ${result.checks.find((c) => !c.passed)?.rule}`,
        });
        continue;
      }

      // 'suggestedContracts' for a debit spread, 'suggestedQuantity' for a
      // single leg — matches whichever kind was just built above.
      const quantity =
        'suggestedContracts' in result.sizing
          ? result.sizing.suggestedContracts
          : 'suggestedQuantity' in result.sizing
            ? result.sizing.suggestedQuantity
            : 0;
      pendingOptions.push({
        symbol: candidate.symbol,
        side: side,
        kind: optStrategyType,
        contractTicker: ref.ticker,
        strike: ref.strike,
        shortContractTicker: shortRef?.contract.ticker,
        shortStrike: shortRef?.contract.strike,
        expiration: ref.expiration,
        signalDate: day,
        contracts: quantity,
        riskAmount: result.approvedRiskAmount,
        notional: result.approvedNotional,
      });
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol: candidate.symbol, notional: result.approvedNotional, side: 'long' });
    }

    equityCurve.push({ date: day, equity });
  }

  // Force-close anything still open at period end, in both books.
  for (const pos of openEquity) {
    const candles = historyBySymbol.get(pos.symbol);
    const last = candles?.length ? candles[candles.length - 1] : null;
    const exitPrice = last?.close ?? pos.entryPrice;
    const sign = pos.side === 'buy' ? 1 : -1;
    const pnl = (exitPrice - pos.entryPrice) * pos.quantity * sign;
    equityTrades.push({
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
  for (const pos of openOptions) {
    const bars = await getContractBars(pos.contractTicker);
    const last = bars.length ? bars[bars.length - 1] : null;
    const exitPremium = last?.close ?? pos.entryPremium;

    let shortExitPremium: number | undefined;
    if (pos.kind === 'debit_spread') {
      const shortBars = await getContractBars(pos.shortContractTicker!);
      const shortLast = shortBars.length ? shortBars[shortBars.length - 1] : null;
      shortExitPremium = shortLast?.close ?? pos.shortEntryPremium;
    }

    const pnl = simulatedOptionsPnl(
      pos.kind,
      pos.entryPremium,
      exitPremium,
      pos.shortEntryPremium,
      shortExitPremium,
      pos.contracts,
    );
    optionsTrades.push({
      symbol: pos.symbol,
      side: pos.side,
      kind: pos.kind,
      contractTicker: pos.contractTicker,
      strike: pos.strike,
      shortContractTicker: pos.shortContractTicker,
      shortStrike: pos.shortStrike,
      expiration: pos.expiration,
      signalDate: pos.signalDate,
      entryDate: pos.entryDate,
      entryPremium: pos.entryPremium,
      shortEntryPremium: pos.shortEntryPremium,
      exitDate: cfg.to,
      exitPremium,
      shortExitPremium,
      exitReason: 'end_of_period',
      contracts: pos.contracts,
      pnl,
      rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
    });
    equity += pnl;
  }
  if ((openEquity.length || openOptions.length) && equityCurve.length) {
    equityCurve[equityCurve.length - 1] = { date: equityCurve[equityCurve.length - 1].date, equity };
  }

  return {
    equityTrades,
    optionsTrades,
    equityCurve,
    startingEquity: cfg.startingEquity,
    finalEquity: equity,
    excludedSymbols: [],
    errors: [],
    optionsSkipped,
  };
}

/**
 * Full combined backtest: reuse the equity backtest's real-estate pre-filter
 * and historical-bar fetch (loadBacktestHistory), fetch each eligible
 * underlying's option contract reference data (mirrors runOptionsBacktest()),
 * then simulate both together.
 */
export async function runCombinedBacktest(cfg: CombinedBacktestConfig): Promise<CombinedBacktestReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const weeklyHistoryBySymbol = cfg.screenerConfig?.filters?.requireWeeklyTrendAlignment
    ? await loadWeeklyBacktestHistory(Array.from(historyBySymbol.keys()), cfg.from, cfg.to)
    : undefined;
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const benchmarkCandles =
    (cfg.screenerConfig?.weights?.relativeStrength ?? 0) || cfg.regimeAdaptiveWeightsEnabled
      ? await loadBenchmarkBacktestHistory(screenerCfg.benchmarkSymbol, cfg.from, cfg.to)
      : undefined;
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const report = await simulateCombinedBacktest(
    historyBySymbol,
    contractsBySymbol,
    cfg,
    weeklyHistoryBySymbol,
    benchmarkCandles,
  );
  return { ...report, excludedSymbols, errors };
}

export interface CombinedWalkForwardConfig extends CombinedBacktestConfig {
  /** YYYY-MM-DD — same in-sample [from, splitDate] / out-of-sample
   *  (splitDate, to] split as the other two engines' own walk-forward gate. */
  splitDate: string;
}

export interface CombinedWalkForwardReport {
  inSample: CombinedBacktestReport;
  outOfSample: CombinedBacktestReport;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

/** Same validation-gate structure as the other two engines: history and
 *  contract data fetched ONCE, replayed independently over two windows both
 *  starting from the same startingEquity. */
export async function runCombinedWalkForwardBacktest(
  cfg: CombinedWalkForwardConfig,
): Promise<CombinedWalkForwardReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const weeklyHistoryBySymbol = cfg.screenerConfig?.filters?.requireWeeklyTrendAlignment
    ? await loadWeeklyBacktestHistory(Array.from(historyBySymbol.keys()), cfg.from, cfg.to)
    : undefined;
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const benchmarkCandles =
    (cfg.screenerConfig?.weights?.relativeStrength ?? 0) || cfg.regimeAdaptiveWeightsEnabled
      ? await loadBenchmarkBacktestHistory(screenerCfg.benchmarkSymbol, cfg.from, cfg.to)
      : undefined;
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const outOfSampleFrom = addDays(cfg.splitDate, 1);
  const inSample = await simulateCombinedBacktest(
    historyBySymbol,
    contractsBySymbol,
    { ...cfg, from: cfg.from, to: cfg.splitDate },
    weeklyHistoryBySymbol,
    benchmarkCandles,
  );
  const outOfSample = await simulateCombinedBacktest(
    historyBySymbol,
    contractsBySymbol,
    { ...cfg, from: outOfSampleFrom, to: cfg.to },
    weeklyHistoryBySymbol,
    benchmarkCandles,
  );
  return { inSample, outOfSample, excludedSymbols, errors };
}
