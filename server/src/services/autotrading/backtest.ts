import { Candle, Timeframe } from '../../providers/types';
import { ScreenerConfig, SymbolScore, scoreSymbol } from '../../indicators/screener';
import { dailyReturns, pearsonCorrelation } from '../../indicators/indicators';
import { DecisionConfig, TradeSignal, defaultDecisionConfig, generateSignal } from './decide';
import { evaluateRiskCheck, RiskCheckContext } from './riskCheck';
import { CORRELATION_LOOKBACK_DAYS, CORRELATION_THRESHOLD, RISK_PROFILES, RiskProfileParams } from './riskProfiles';
import { RiskProfileName } from '../../db/autotradeConfig';
import { defaultAutotradeScreenerConfig } from './screen';
import { isExcluded } from '../../db/autotradeExclusions';
import { classifySector } from './realEstateClassifier';
import { getHistoricalBars } from './historicalData';
import { computeStreaksAndDrawdown } from '../pnl';

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

const TIMEFRAME: Timeframe = 'daily';
/** Calendar-day padding before `from` so indicators (up to a 50-day MA by
 *  default) have a full warmup window on the very first simulated day. */
const WARMUP_PADDING_DAYS = 100;

export interface BacktestConfig {
  symbols: string[];
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  riskProfile: RiskProfileName;
  startingEquity: number;
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
  exitReason: 'stop' | 'target' | 'end_of_period';
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
}

interface OpenPosition {
  symbol: string;
  side: 'buy' | 'sell';
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  stop: number;
  target: number;
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

function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d.getTime());
}

/** Index of the last candle with `time <= asOfMs`, or -1 if none. */
function indexAsOf(candles: Candle[], asOfMs: number): number {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= asOfMs) idx = i;
    else break;
  }
  return idx;
}

/** Correlation, computed entirely from already-loaded history (no I/O) — the
 *  backtest analog of riskCheck.ts's provider-fetching correlatedNotional. */
function backtestCorrelatedNotional(
  candidateSymbol: string,
  asOfMs: number,
  openPositions: OpenPosition[],
  historyBySymbol: Map<string, Candle[]>,
): number {
  if (openPositions.length === 0) return 0;
  const closesUpTo = (symbol: string): number[] | null => {
    const candles = historyBySymbol.get(symbol);
    if (!candles) return null;
    const idx = indexAsOf(candles, asOfMs);
    if (idx < 1) return null;
    const start = Math.max(0, idx - CORRELATION_LOOKBACK_DAYS);
    return candles.slice(start, idx + 1).map((c) => c.close);
  };

  const candidateCloses = closesUpTo(candidateSymbol);
  const candidateReturns = candidateCloses ? dailyReturns(candidateCloses) : null;
  if (!candidateReturns) return 0;

  let amount = 0;
  for (const pos of openPositions) {
    const posCloses = closesUpTo(pos.symbol);
    const r = posCloses ? pearsonCorrelation(candidateReturns, dailyReturns(posCloses)) : null;
    if (r !== null && Math.abs(r) >= CORRELATION_THRESHOLD) amount += pos.notional;
  }
  return amount;
}

/**
 * Run the simulation over already-loaded history. Pure — no I/O — so it's
 * directly unit-testable with hand-built candle series. `historyBySymbol`
 * should include WARMUP_PADDING_DAYS or more of lookback before `cfg.from`.
 */
export function simulateBacktest(historyBySymbol: Map<string, Candle[]>, cfg: BacktestConfig): BacktestReport {
  const profile: RiskProfileParams = RISK_PROFILES[cfg.riskProfile];
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
          entryPrice: candles![idx].open,
          stop: p.signal.stop,
          target: p.signal.target,
          quantity: p.quantity,
          riskAmount: p.riskAmount,
          notional: p.notional,
        });
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
      const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = long ? bar.high >= pos.target : bar.low <= pos.target;
      if (stopHit || targetHit) {
        // Conservative: if both could have happened in one bar, assume the stop hit first.
        const exitReason: SimulatedTrade['exitReason'] = stopHit ? 'stop' : 'target';
        const exitPrice = stopHit ? pos.stop : pos.target;
        const sign = long ? 1 : -1;
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
    candidates.sort((a, b) => b.score.total - a.score.total);

    let runningRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);
    let runningCount = openPositions.length;
    const runningPositions: { symbol: string; notional: number }[] = openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.notional,
    }));

    for (const { signal } of candidates) {
      const correlated = backtestCorrelatedNotional(signal.symbol, dayMs, openPositions, historyBySymbol);
      const ctx: RiskCheckContext = {
        equity,
        dailyPnl,
        tradesToday: 0, // backtest has no separate "auto-trade orders today" concept — nothing today has executed yet
        consecutiveLosses,
        openRisk: runningRisk,
        openPositionsCount: runningCount,
        correlatedNotional: correlated,
      };
      const result = evaluateRiskCheck(signal, ctx, profile);
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

  return { trades, equityCurve, startingEquity: cfg.startingEquity, finalEquity: equity, excludedSymbols: [] };
}

/** Real-estate pre-filter — checked ONCE upfront (not per simulated day), the
 *  same list+classifier checks Screen uses live. */
async function filterEligibleSymbols(
  symbols: string[],
): Promise<{ eligible: string[]; excluded: { symbol: string; reason: string }[] }> {
  const eligible: string[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  for (const symbol of symbols) {
    if (isExcluded(symbol)) {
      excluded.push({ symbol, reason: 'On the real-estate exclusion list' });
      continue;
    }
    const classification = await classifySector(symbol);
    if (classification.outcome === 'real_estate') {
      excluded.push({
        symbol,
        reason: `Classified as real estate (${classification.sector ?? classification.industry ?? ''})`,
      });
      continue;
    }
    eligible.push(symbol);
  }
  return { eligible, excluded };
}

/**
 * Full backtest: pre-filter real estate, fetch (or reuse cached) historical
 * bars for every eligible symbol, then simulate. Async orchestration around
 * the pure simulateBacktest() core.
 */
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestReport> {
  const { eligible, excluded } = await filterEligibleSymbols(cfg.symbols);
  const paddedFrom = addDays(cfg.from, -WARMUP_PADDING_DAYS);

  const historyBySymbol = new Map<string, Candle[]>();
  for (const symbol of eligible) {
    const bars = await getHistoricalBars(symbol, TIMEFRAME, paddedFrom, cfg.to);
    if (bars.length) historyBySymbol.set(symbol.toUpperCase(), bars);
  }

  const report = simulateBacktest(historyBySymbol, cfg);
  return { ...report, excludedSymbols: excluded };
}
