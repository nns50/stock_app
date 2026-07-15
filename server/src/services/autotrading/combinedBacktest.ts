import { Candle } from '../../providers/types';
import {
  candleIndicatorsAt,
  CandleIndicatorSeries,
  computeCandleIndicatorSeries,
  ScreenerConfig,
  SymbolScore,
  scoreSymbol,
} from '../../indicators/screener';
import { DecisionConfig, TradeSignal, defaultDecisionConfig, generateSignal } from './decide';
import { evaluateRiskCheck, RiskCheckContext } from './riskCheck';
import { evaluateOptionsRiskCheck } from './optionsRiskCheck';
import { defaultAutotradeEntryConfig, OptionsDecisionConfig, OptionsSignalSide } from './optionsDecide';
import { RiskProfileName, OptionsStrategyType } from '../../db/autotradeConfig';
import { defaultAutotradeScreenerConfig } from './screen';
import { getHistoricalBars } from './historicalData';
import { getHistoricalOptionContracts } from './optionsHistoricalData';
import { OptionContractRef } from './polygonOptionsClient';
import { impliedVol, bsGreeks, yearsToExpiration, daysToExpiration } from '../../options/blackScholes';
import { computeIvContext } from '../ivRank';
import {
  addDays,
  backtestCorrelatedNotional,
  BacktestRiskParams,
  EquityPoint,
  indexAsOf,
  loadBacktestHistory,
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
// day, no OI/bid-ask, hv-estimate IV-rank fallback, time-based exit only) —
// this file only changes HOW the two risk budgets combine, not what either
// side's entry/exit rules already are. Single leg or debit spread, matching
// whichever cfg.optionsDecisionConfig?.strategyType the equity/options
// backtest route was given — reuses optionsBacktest.ts's own
// pickShortLegReferenceContract()/simulatedOptionsPnl() for the short leg's
// selection and P&L, not a reimplementation (Task #69).
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
  screenerConfig?: Partial<ScreenerConfig>;
  decisionConfig?: Partial<DecisionConfig>;
  optionsDecisionConfig?: Partial<OptionsDecisionConfig>;
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

/**
 * Run the combined simulation over already-loaded equity history and
 * pre-fetched contract reference data. Async (like simulateOptionsBacktest)
 * since contract price bars are fetched on demand as the simulation unfolds.
 */
export async function simulateCombinedBacktest(
  historyBySymbol: Map<string, Candle[]>,
  contractsBySymbol: Map<string, OptionContractRef[]>,
  cfg: CombinedBacktestConfig,
): Promise<CombinedBacktestReport> {
  const riskParams = resolveBacktestRiskParams(cfg);
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const decisionCfg = { ...defaultDecisionConfig(), ...cfg.decisionConfig };
  const optDirection = cfg.optionsDecisionConfig?.direction ?? 'long';
  const optSide: OptionsSignalSide = optDirection === 'long' ? 'call' : 'put';
  const entryCfg = {
    ...defaultAutotradeEntryConfig(optSide),
    ...cfg.optionsDecisionConfig?.entryConfig,
    side: optSide,
  };
  const optStrategyType: OptionsStrategyType = cfg.optionsDecisionConfig?.strategyType ?? 'single_leg';

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
  // Per-symbol resume point for the scoring loop's own indexAsOf call below —
  // mirrors backtest.ts's identical indexCursor (dayMs only increases across
  // this loop, so each symbol's answer only ever advances forward).
  const scoringIndexCursor = new Map<string, number>();

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
          entryPremium: longBar!.open,
          shortEntryPremium: shortBar?.open,
          contracts: p.contracts,
          riskAmount: p.riskAmount,
          notional: p.notional,
        });
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
      const dte = daysToExpiration(pos.expiration, new Date(dayMs));
      if (dte <= (entryCfg.minDaysToExpiration ?? 7) || dte <= 0) {
        const exitPremium = bar.close;
        const shortExitPremium = shortBar?.close;
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
          exitReason: dte <= 0 ? 'expiration' : 'time_exit',
          contracts: pos.contracts,
          pnl,
          rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
        });
        optionsClosedPnls.push(pnl);
        recordStreak(optionsStreak, pnl);
        dailyOptionsPnl += pnl;
        equity += pnl;
      } else {
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

    // 6) Score every symbol ONCE per day (asset-agnostic) — filtered
    // separately below per instrument type's own "already open" exclusion.
    const openEquitySymbols = new Set([...openEquity.map((p) => p.symbol), ...pendingEquity.map((p) => p.symbol)]);
    const openOptionsSymbols = new Set([...openOptions.map((p) => p.symbol), ...pendingOptions.map((p) => p.symbol)]);
    const scoresToday = new Map<string, { score: SymbolScore; underlyingClose: number; history: Candle[] }>();
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
      const score = scoreSymbol(symbol, candles, undefined, screenerCfg, cached, idx);
      if (!score.passedFilters) continue;
      scoresToday.set(symbol, { score, underlyingClose: candles[idx].close, history });
    }

    // The ONE shared ledger both legs read from and write to this day —
    // seeded from BOTH books' pre-existing open risk (mirrors
    // optionsSeedForEquity()/PaperPortfolioSeed in the live loop).
    let runningRisk =
      openEquity.reduce((s, p) => s + p.riskAmount, 0) + openOptions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openEquity.length + openOptions.length;
    // Equity keeps its real side (this combined engine doesn't yet support
    // directionMode:'both' -- that lands together with options call/put
    // direction-awareness, since both currently read the SAME single
    // scoresToday scoring pass above); options positions are always 'long'
    // (see riskCheck.ts's correlatedNotional() doc comment). Both sides
    // reduce to the exact prior always-additive behavior when equity really
    // is all long, as it always has been up to now.
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
      .map(([, v]) => v.score)
      .sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol));

    for (const score of equityCandidates) {
      const signal = generateSignal(
        { ...score, discoverySource: 'universe', direction: screenerCfg.direction },
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
      .map(([symbol, v]) => ({ symbol, total: v.score.total, underlyingClose: v.underlyingClose, history: v.history }))
      .sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol));

    for (const candidate of optionsCandidates) {
      const contracts = contractsBySymbol.get(candidate.symbol) ?? [];
      const ref = pickReferenceContract(
        contracts,
        optSide,
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
        type: optSide,
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
        type: optSide,
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

      let shortRef: ShortLegReference | null = null;
      if (optStrategyType === 'debit_spread') {
        shortRef = await pickShortLegReferenceContract(
          contracts,
          optSide,
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
      };
      const result = evaluateOptionsRiskCheck(
        shortRef
          ? {
              kind: 'debit_spread',
              symbol: candidate.symbol,
              side: optSide,
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
              side: optSide,
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
        side: optSide,
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
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const report = await simulateCombinedBacktest(historyBySymbol, contractsBySymbol, cfg);
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
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const outOfSampleFrom = addDays(cfg.splitDate, 1);
  const inSample = await simulateCombinedBacktest(historyBySymbol, contractsBySymbol, {
    ...cfg,
    from: cfg.from,
    to: cfg.splitDate,
  });
  const outOfSample = await simulateCombinedBacktest(historyBySymbol, contractsBySymbol, {
    ...cfg,
    from: outOfSampleFrom,
    to: cfg.to,
  });
  return { inSample, outOfSample, excludedSymbols, errors };
}
