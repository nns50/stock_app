import { Candle } from '../../providers/types';
import {
  candleIndicatorsAt,
  CandleIndicatorSeries,
  computeCandleIndicatorSeries,
  ScreenerConfig,
  scoreSymbol,
} from '../../indicators/screener';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { defaultAutotradeScreenerConfig } from './screen';
import {
  addDays,
  BacktestRiskParams,
  indexAsOf,
  loadBacktestHistory,
  resolveBacktestRiskParams,
  toISO,
  WARMUP_PADDING_DAYS,
  EquityPoint,
} from './backtest';
import {
  defaultAutotradeEntryConfig,
  OptionsDecisionConfig,
  OptionsSignalSide,
  SHORT_LEG_DELTA_BAND,
} from './optionsDecide';
import { evaluateOptionsRiskCheck } from './optionsRiskCheck';
import { RiskCheckContext } from './riskCheck';
import { RiskProfileName, OptionsStrategyType } from '../../db/autotradeConfig';
import { getHistoricalOptionContracts } from './optionsHistoricalData';
import { getHistoricalBars } from './historicalData';
import { OptionContractRef } from './polygonOptionsClient';
import { impliedVol, bsGreeks, yearsToExpiration, daysToExpiration } from '../../options/blackScholes';
import { computeIvContext } from '../ivRank';

// ---------------------------------------------------------------------------
// The options counterpart to backtest.ts (docs/AUTOTRADING_SPEC.md, phase 11)
// — replays phases 9-10's entry/sizing logic day-by-day over historical
// data, exactly like backtest.ts's simulateBacktest() does for equities: the
// SAME evaluateOptionsRiskCheck() (phase 10) gates every candidate, and the
// SAME entryRules.ts threshold values (defaultAutotradeEntryConfig(), phase
// 9) define what counts as a qualifying contract — not new numbers guessed
// for this phase.
//
// Six deliberate, documented scope reductions versus a maximally-faithful
// simulation (mirroring phase 9's own "first cut" framing, not silent
// shortcuts):
//
//  1. INDEPENDENT backtest, not combined with a concurrent equity backtest's
//     risk in the same run. Phase 10's evaluateOptionsRiskCheck() is reused
//     verbatim (the exact same combined-budget-capable function), just
//     seeded with no equity approvals to combine with (an empty
//     equityResults) — this is the same posture Phase 4's risk-check had
//     before Phase 6 gave it a concurrent execution consumer.
//  2. Exactly ONE reference contract is considered per underlying per day —
//     the nearest-to-spot strike among contracts in the confirmed DTE
//     window — not a full multi-strike scan via entryRules.ts's
//     scanEntries(). scanEntries()'s bid/ask-based spread check is
//     UNCONDITIONAL (no config flag can disable it), so it would reject
//     100% of backtested candidates outright (no historical bid/ask exists
//     at this tier) — reusing it here isn't possible without touching
//     shared, human-facing code. The delta-band/IV-rank/volume checks
//     entryRules.ts actually specifies are re-implemented directly below
//     against synthetically-derived data, importing the SAME threshold
//     values from defaultAutotradeEntryConfig(), not re-guessing them.
//  3. Open interest and bid-ask spread are skipped entirely (the ALREADY-
//     CONFIRMED backtest gap, docs/AUTOTRADING_SPEC.md "Resolved
//     decisions" — no tier has historical OI, and this tier has no
//     historical quotes either). Volume, delta band, DTE window, and
//     IV-rank ceiling are still enforced.
//  4. IV rank always uses computeIvContext()'s hv-estimate (realized-vol)
//     fallback — the SAME proxy the human Options page is already willing
//     to use live — rather than a genuinely-derived historical options-IV
//     series. The day's OWN implied vol is still real, computed from that
//     day's actual historical option price via Black-Scholes; only the
//     RANKING methodology (what range to rank it against) falls back to the
//     cruder proxy. This is the same category of confirmed, permanent
//     backtest-only gap as OI/spread above, extended here with the same
//     reasoning — NOT a change to the live/paper system, which still fails
//     closed without 15 real samples exactly as phase 9 shipped it.
//  5. Exit is TIME-BASED ONLY (exitRules.ts's timeExitDaysBeforeExpiry),
//     matching phase 12's OWN already-scoped "close-only, time-based"
//     automated-exit design — not the human Options page's fuller
//     stop-loss/take-profit/delta-drift default config, which is for manual
//     review, not automation.
//  6. Delta is recomputed via Black-Scholes directly (not entryRules.ts's
//     evaluateContract()) for the same reason as #2 — evaluateContract()
//     expects a live-shaped OptionContract this backtest cannot produce.
// ---------------------------------------------------------------------------

/** Same fallback used elsewhere in this codebase when no live rate is
 *  available (optionStrategy.ts's combinedGreeks/probabilityOfProfit). */
const RISK_FREE_RATE = 0.04;

export interface OptionsBacktestConfig extends Partial<BacktestRiskParams> {
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
  screenerConfig?: Partial<ScreenerConfig>;
  optionsDecisionConfig?: Partial<OptionsDecisionConfig>;
}

export interface SimulatedOptionsTrade {
  symbol: string; // underlying
  side: OptionsSignalSide;
  /** 'single_leg' (default shape, unchanged) or 'debit_spread' — a spread
   *  reuses contractTicker/strike/entryPremium/exitPremium for the LONG leg
   *  and adds the short* fields below for the short leg. */
  kind: OptionsStrategyType;
  contractTicker: string;
  strike: number;
  /** Debit spreads only. */
  shortContractTicker?: string;
  shortStrike?: number;
  expiration: string;
  signalDate: string;
  entryDate: string;
  entryPremium: number;
  /** The short leg's fill premium — debit spreads only. */
  shortEntryPremium?: number;
  exitDate: string;
  exitPremium: number;
  /** The short leg's exit premium — debit spreads only. */
  shortExitPremium?: number;
  exitReason: 'time_exit' | 'expiration' | 'end_of_period';
  contracts: number;
  pnl: number;
  rMultiple: number;
}

export interface OptionsBacktestReport {
  trades: SimulatedOptionsTrade[];
  equityCurve: EquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  /** Candidates that cleared the equity screen but never got an options
   *  signal — mirrors optionsDecide.ts's own skip transparency. */
  skipped: { symbol: string; date: string; reason: string }[];
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

/** The single reference contract for `underlying` as of `asOfDate`: nearest
 *  strike to `underlyingClose` among contracts whose DTE falls in
 *  [minDte, maxDte] and whose type matches `side`. Null if none qualify —
 *  the SAME "no expiration in window" skip reason optionsDecide.ts reports
 *  live, just evaluated against pre-fetched reference data instead of a live
 *  chain lookup. Exported for reuse by combinedBacktest.ts, which needs the
 *  identical contract-selection logic, not a reimplementation. */
export function pickReferenceContract(
  contracts: OptionContractRef[],
  side: OptionsSignalSide,
  asOfDate: string,
  underlyingClose: number,
  minDte: number,
  maxDte: number,
): OptionContractRef | null {
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  let best: OptionContractRef | null = null;
  for (const c of contracts) {
    if (c.contractType !== side) continue;
    const dte = daysToExpiration(c.expiration, asOf);
    if (dte < minDte || dte > maxDte) continue;
    if (!best || Math.abs(c.strike - underlyingClose) < Math.abs(best.strike - underlyingClose)) best = c;
  }
  return best;
}

export interface ShortLegReference {
  contract: OptionContractRef;
  /** The short leg's OWN historical closing price that day — screening-time
   *  premium, not a fill price (mirrors the long leg's own bar.close use). */
  premium: number;
  iv: number;
  delta: number;
}

/**
 * The short leg for a debit spread: the NEAREST contract, strictly further
 * out-of-the-money than `longStrike`, in the SAME expiration as the long leg,
 * whose delta falls within SHORT_LEG_DELTA_BAND — mirroring optionsDecide.ts's
 * live search (reuses the SAME exported band, not a re-guessed number),
 * simplified the same way pickReferenceContract() simplifies the long leg
 * (scope reduction #2/#6 above): no bid/ask/OI scan, delta recomputed
 * directly via Black-Scholes from that day's historical price. Scans
 * outward from the long strike, nearest first, and returns the FIRST
 * contract whose delta qualifies — same "first that passes" semantics as
 * the live scanEntries() search, not a best-of-all-candidates pick. Null if
 * none qualify (no historical price that day, IV unsolvable, or no
 * contract's delta lands in the band) — the spread is skipped for this
 * candidate/day, exactly like a live "no short-leg contract passed entry
 * rules" skip. Exported for reuse by combinedBacktest.ts.
 */
export async function pickShortLegReferenceContract(
  contracts: OptionContractRef[],
  side: OptionsSignalSide,
  longStrike: number,
  longExpiration: string,
  asOfDate: string,
  underlyingClose: number,
  getContractBars: (ticker: string) => Promise<Candle[]>,
): Promise<ShortLegReference | null> {
  const dayMs = Date.parse(`${asOfDate}T00:00:00Z`);
  const candidates = contracts
    .filter((c) => c.contractType === side && c.expiration === longExpiration)
    .filter((c) => (side === 'call' ? c.strike > longStrike : c.strike < longStrike))
    .sort((a, b) => (side === 'call' ? a.strike - b.strike : b.strike - a.strike));

  for (const c of candidates) {
    const bars = await getContractBars(c.ticker);
    const idx = indexAsOf(bars, dayMs);
    const bar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;
    if (!bar) continue;
    const T = yearsToExpiration(c.expiration, new Date(dayMs));
    const iv = impliedVol({
      type: side,
      marketPrice: bar.close,
      S: underlyingClose,
      K: c.strike,
      T,
      r: RISK_FREE_RATE,
    });
    if (iv === undefined) continue;
    const delta = bsGreeks({ type: side, S: underlyingClose, K: c.strike, T, r: RISK_FREE_RATE, sigma: iv }).delta;
    const absDelta = Math.abs(delta);
    if (absDelta < SHORT_LEG_DELTA_BAND.deltaMin || absDelta > SHORT_LEG_DELTA_BAND.deltaMax) continue;
    return { contract: c, premium: bar.close, iv, delta };
  }
  return null;
}

/** Realized P&L for a closed simulated options trade — single-leg: (exit -
 *  entry) x contracts x 100 (long the contract, no sign flip). Debit spread:
 *  the spread is one unit priced at long-minus-short, so P&L is
 *  (netValueAtExit - netDebitAtEntry) x contracts x 100 — the exact same
 *  formula optionsExecute.ts's paper-execution engine uses. Exported for
 *  reuse by combinedBacktest.ts, which builds the identical SimulatedOptionsTrade
 *  shape for its own options-side day-loop. */
export function simulatedOptionsPnl(
  kind: OptionsStrategyType,
  entryPremium: number,
  exitPremium: number,
  shortEntryPremium: number | undefined,
  shortExitPremium: number | undefined,
  contracts: number,
): number {
  if (kind === 'debit_spread') {
    const netDebitAtEntry = entryPremium - (shortEntryPremium ?? 0);
    const netValueAtExit = exitPremium - (shortExitPremium ?? 0);
    return (netValueAtExit - netDebitAtEntry) * contracts * 100;
  }
  return (exitPremium - entryPremium) * contracts * 100;
}

/** The backtest analog of riskCheck.ts's correlatedNotional / backtest.ts's
 *  own backtestCorrelatedNotional — computed entirely from already-loaded
 *  EQUITY history (no I/O), since correlation between two options positions
 *  is evaluated on their UNDERLYINGS' price co-movement, identical math to
 *  the equity backtest. Duplicated here (not imported) for the same reason
 *  backtest.ts's own version isn't shared with riskCheck.ts's live one: this
 *  file's "running positions" are options-shaped, but the correlation
 *  input/output shape ({symbol, notional}[] -> number) is identical, so the
 *  underlying math is copied, not reinvented. */
function optionsBacktestCorrelatedNotional(
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
 * Run the options simulation over already-loaded equity history and
 * pre-fetched contract reference data. Unlike backtest.ts's simulateBacktest
 * (100% pure/sync — everything it needs is pre-loaded), this is ASYNC: which
 * contract's price bars are needed depends on the underlying's own price
 * path as the simulation unfolds, so bars are fetched on demand via
 * getHistoricalBars() (already cache-or-fetch — a re-run over the same data
 * is fast) and memoized per contract ticker for the life of this one run.
 */
export async function simulateOptionsBacktest(
  historyBySymbol: Map<string, Candle[]>,
  contractsBySymbol: Map<string, OptionContractRef[]>,
  cfg: OptionsBacktestConfig,
): Promise<OptionsBacktestReport> {
  const riskParams = resolveBacktestRiskParams(cfg);
  const screenerCfg = { ...defaultAutotradeScreenerConfig(), ...cfg.screenerConfig };
  const direction = cfg.optionsDecisionConfig?.direction ?? 'long';
  const side: OptionsSignalSide = direction === 'long' ? 'call' : 'put';
  const entryCfg = { ...defaultAutotradeEntryConfig(side), ...cfg.optionsDecisionConfig?.entryConfig, side };
  const strategyType: OptionsStrategyType = cfg.optionsDecisionConfig?.strategyType ?? 'single_leg';

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

  const trades: SimulatedOptionsTrade[] = [];
  const skipped: { symbol: string; date: string; reason: string }[] = [];
  const equityCurve: EquityPoint[] = [];
  const closedPnls: number[] = [];
  let equity = cfg.startingEquity;
  let openPositions: OpenOptionPosition[] = [];
  let pendingEntries: PendingOptionEntry[] = [];

  // Running win/loss streak, maintained incrementally instead of calling
  // computeStreaksAndDrawdown(closedPnls) (an O(closedPnls.length) rescan)
  // every single day — mirrors that function's own per-element logic
  // exactly, updated at the same point closedPnls itself is appended to.
  const streak: { type: 'win' | 'loss' | 'none'; count: number } = { type: 'none', count: 0 };
  function recordStreak(pnl: number): void {
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
    let dailyPnl = 0;

    // 1) Fill yesterday's approved signals at today's contract OPEN. A debit
    // spread fills BOTH legs together or not at all — if either leg's bar
    // hasn't landed on `day` yet, the whole entry stays pending for the next
    // day (mirrors optionsExecute.ts's paper-execution atomicity).
    let filledToday = 0;
    const stillPending: PendingOptionEntry[] = [];
    for (const p of pendingEntries) {
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
        openPositions.push({
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
        filledToday += 1;
      } else {
        stillPending.push(p);
      }
    }
    pendingEntries = stillPending;

    // 2) Check already-open positions for the time-exit trigger. A position
    // that just filled TODAY (step 1) is deliberately excluded from this
    // check until the NEXT day — a date-based trigger (unlike a price gap)
    // can't meaningfully "surprise" a position on its own entry day, and a
    // contract entered right at the minDaysToExpiration boundary would
    // otherwise immediately re-trigger the timeExitDaysBeforeExpiry exit the
    // same day it opened.
    const stillOpen: OpenOptionPosition[] = [];
    for (const pos of openPositions) {
      if (pos.entryDate === day) {
        stillOpen.push(pos);
        continue;
      }
      const bars = await getContractBars(pos.contractTicker);
      const idx = indexAsOf(bars, dayMs);
      const bar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;
      if (!bar) {
        stillOpen.push(pos);
        continue;
      }
      // A spread closes BOTH legs together — the short leg's bar missing
      // that day leaves the whole position open, same as the long leg's own.
      let shortBar: Candle | null = null;
      if (pos.kind === 'debit_spread') {
        const shortBars = await getContractBars(pos.shortContractTicker!);
        const shortIdx = indexAsOf(shortBars, dayMs);
        shortBar = shortIdx >= 0 && shortBars[shortIdx].time === dayMs ? shortBars[shortIdx] : null;
        if (!shortBar) {
          stillOpen.push(pos);
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
        trades.push({
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
        closedPnls.push(pnl);
        recordStreak(pnl);
        dailyPnl += pnl;
        equity += pnl;
      } else {
        stillOpen.push(pos);
      }
    }
    openPositions = stillOpen;

    // 3) Screen equity candidates through today's close (the SAME gate
    // optionsDecide.ts's live path sits behind — an options signal only
    // ever considers a candidate the equity screener already approved).
    const consecutiveLosses = streak.type === 'loss' ? streak.count : 0;
    const openSymbols = new Set([...openPositions.map((p) => p.symbol), ...pendingEntries.map((p) => p.symbol)]);

    const candidates: { symbol: string; total: number; underlyingClose: number; history: Candle[] }[] = [];
    for (const [symbol, candles] of historyBySymbol) {
      if (openSymbols.has(symbol)) continue;
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
      candidates.push({ symbol, total: score.total, underlyingClose: candles[idx].close, history });
    }
    candidates.sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol));

    let runningRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openPositions.length;
    const runningPositions: { symbol: string; notional: number }[] = openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.notional,
    }));

    for (const candidate of candidates) {
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
        skipped.push({ symbol: candidate.symbol, date: day, reason: 'No contract within the configured DTE window' });
        continue;
      }

      const bars = await getContractBars(ref.ticker);
      const idx = indexAsOf(bars, dayMs);
      const bar = idx >= 0 && bars[idx].time === dayMs ? bars[idx] : null;
      if (!bar) {
        skipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'No historical price for the reference contract on this day',
        });
        continue;
      }
      if (bar.volume < entryCfg.minVolume) {
        skipped.push({
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
        skipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'Implied vol could not be solved from the historical price',
        });
        continue;
      }

      // hv-estimate fallback only (empty real history) — see file header, scope reduction #4.
      const ivContext = computeIvContext(iv, [], candidate.history);
      if (ivContext.ivRank === null) {
        skipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: 'Insufficient underlying price history to estimate IV rank',
        });
        continue;
      }
      if (entryCfg.ivRankMax !== undefined && ivContext.ivRank > entryCfg.ivRankMax) {
        skipped.push({
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
        skipped.push({
          symbol: candidate.symbol,
          date: day,
          reason: `|delta| ${absDelta.toFixed(2)} outside [${entryCfg.deltaMin}, ${entryCfg.deltaMax}]`,
        });
        continue;
      }

      let shortRef: ShortLegReference | null = null;
      if (strategyType === 'debit_spread') {
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
          skipped.push({
            symbol: candidate.symbol,
            date: day,
            reason: 'No short-leg contract further out-of-the-money passed the delta band',
          });
          continue;
        }
        if (shortRef.premium >= bar.close) {
          skipped.push({
            symbol: candidate.symbol,
            date: day,
            reason: 'Short leg premium >= long leg premium — not a net debit, skipped',
          });
          continue;
        }
      }

      const correlated = optionsBacktestCorrelatedNotional(
        candidate.symbol,
        dayMs,
        runningPositions,
        historyBySymbol,
        riskParams.correlationLookbackDays,
        riskParams.correlationThreshold,
      );
      const ctx: RiskCheckContext = {
        equity,
        dailyPnl,
        tradesToday: filledToday,
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
              side,
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
              rationale: `Backtest debit spread ${ref.ticker}/${shortRef.contract.ticker}`,
              score: candidate.total,
            }
          : {
              kind: 'single_leg',
              symbol: candidate.symbol,
              side,
              contractSymbol: ref.ticker,
              strike: ref.strike,
              expiration: ref.expiration,
              dte: T * 365,
              premium: bar.close,
              delta,
              ivRank: ivContext.ivRank,
              maxLossPerContract: bar.close * 100,
              rationale: `Backtest reference contract ${ref.ticker}`,
              score: candidate.total,
            },
        ctx,
      );
      if (!result.ok) {
        skipped.push({
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
      pendingEntries.push({
        symbol: candidate.symbol,
        side,
        kind: strategyType,
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
      runningPositions.push({ symbol: candidate.symbol, notional: result.approvedNotional });
    }

    equityCurve.push({ date: day, equity });
  }

  // Force-close anything still open at period end. Each leg force-closes at
  // its OWN last available bar independently (they can have slightly
  // different bar coverage), matching how the exit-check above always reads
  // each leg's own bars separately.
  for (const pos of openPositions) {
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
    trades.push({
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
    skipped,
  };
}

/**
 * Full options backtest: reuse the equity backtest's real-estate pre-filter
 * and historical-bar fetch (loadBacktestHistory), then fetch (or reuse
 * cached) each eligible underlying's option contract reference data for the
 * whole [from, to] span padded by the entry config's own maxDaysToExpiration
 * (so a contract expiring shortly after `to` — a legitimate entry near the
 * end of the window — is still discoverable), then simulate.
 */
export async function runOptionsBacktest(cfg: OptionsBacktestConfig): Promise<OptionsBacktestReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const report = await simulateOptionsBacktest(historyBySymbol, contractsBySymbol, cfg);
  return { ...report, excludedSymbols, errors };
}

export interface OptionsWalkForwardConfig extends OptionsBacktestConfig {
  /** YYYY-MM-DD — same in-sample [from, splitDate] / out-of-sample
   *  (splitDate, to] split as equities' own walk-forward gate. */
  splitDate: string;
}

export interface OptionsWalkForwardReport {
  inSample: OptionsBacktestReport;
  outOfSample: OptionsBacktestReport;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

/** The same validation-gate structure as equities' runWalkForwardBacktest:
 *  history and contract data fetched ONCE, replayed independently over two
 *  windows both starting from the same startingEquity, so their stats are
 *  directly comparable. */
export async function runOptionsWalkForwardBacktest(cfg: OptionsWalkForwardConfig): Promise<OptionsWalkForwardReport> {
  const { historyBySymbol, excludedSymbols, errors } = await loadBacktestHistory(cfg.symbols, cfg.from, cfg.to);
  const maxDte = defaultAutotradeEntryConfig('call').maxDaysToExpiration ?? 60;
  const contractsBySymbol = new Map<string, OptionContractRef[]>();
  for (const symbol of historyBySymbol.keys()) {
    const contracts = await getHistoricalOptionContracts(symbol, cfg.from, addDays(cfg.to, maxDte));
    contractsBySymbol.set(symbol, contracts);
  }
  const outOfSampleFrom = addDays(cfg.splitDate, 1);
  const inSample = await simulateOptionsBacktest(historyBySymbol, contractsBySymbol, {
    ...cfg,
    from: cfg.from,
    to: cfg.splitDate,
  });
  const outOfSample = await simulateOptionsBacktest(historyBySymbol, contractsBySymbol, {
    ...cfg,
    from: outOfSampleFrom,
    to: cfg.to,
  });
  return { inSample, outOfSample, excludedSymbols, errors };
}
