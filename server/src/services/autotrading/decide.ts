import { Direction } from '../../indicators/screener';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { ScreenCandidate } from './screen';

// ---------------------------------------------------------------------------
// The Decision stage (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP, stage 2).
// Turns an already-screened candidate into a concrete trade plan: entry, a
// hard stop-loss, and a target. Read-only/logged-only — no risk checks, no
// orders. Filtering which candidates are worth trading is Screen's job (it
// already ran); Decision's only job is "what would this trade look like."
//
// Stop distance is ATR-based (ties the stop to the symbol's own recent
// volatility) and the target is a fixed reward:risk multiple of that stop
// distance — not tuned to hit any particular return figure, per the spec's
// "the return should be a measured output of a sound edge, not an input the
// system optimizes toward." The actual expected return is whatever backtesting
// (a later phase) measures from this rule, not something baked in here.
// ---------------------------------------------------------------------------

export type SignalSide = 'buy' | 'sell';

export interface DecisionConfig {
  direction: Direction;
  /** Stop distance = this many ATRs from entry. */
  stopAtrMultiple: number;
  /** Target distance = this many multiples of the stop distance (reward:risk). */
  targetRMultiple: number;
}

export function defaultDecisionConfig(): DecisionConfig {
  return { direction: 'long', stopAtrMultiple: 1.5, targetRMultiple: 2 };
}

export interface TradeSignal {
  symbol: string;
  side: SignalSide;
  entry: number;
  stop: number;
  target: number;
  /** (target - entry) / (entry - stop) for a long, mirrored for a short. Always
   *  equal to cfg.targetRMultiple by construction — carried on the signal so
   *  downstream consumers (risk check, journal, UI) don't need the config too. */
  rMultiple: number;
  rationale: string;
  /** The screener's 0..100 total score, carried over for sorting/display. */
  score: number;
}

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Turn one screened candidate into a trade signal, or null if a sound stop
 * can't be computed (no ATR — insufficient history — or the ATR-based stop
 * would land at or below zero). Pure: no I/O, no journaling (the caller logs).
 */
export function generateSignal(
  candidate: ScreenCandidate,
  cfg: DecisionConfig = defaultDecisionConfig(),
): TradeSignal | null {
  const { atr } = candidate.indicators;
  if (atr === null || atr <= 0) return null;

  // Rounded to cents -- stop/target become REAL broker bracket-leg prices
  // once a live entry places (liveExecute.ts's attemptLiveEntry() passes
  // them straight through as bracket.stopLossPrice/takeProfitPrice with no
  // rounding of its own). An ATR-derived distance is essentially never an
  // exact cent, so leaving these unrounded sent a sub-penny stop/target
  // price to Webull on EVERY live bracket order -- confirmed in production
  // (Webull's own "Price increment should be 0.01" rejection, blocking every
  // single live entry attempt, not just an occasional one).
  const entry = round2(candidate.price);
  const stopDistance = cfg.stopAtrMultiple * atr;
  const long = cfg.direction === 'long';
  const stop = round2(long ? entry - stopDistance : entry + stopDistance);
  if (stop <= 0) return null;

  const targetDistance = stopDistance * cfg.targetRMultiple;
  const target = round2(long ? entry + targetDistance : entry - targetDistance);

  const { gapPct, relVolume, rsi } = candidate.indicators;
  const rationale =
    `${long ? 'Long' : 'Short'} breakout: score ${candidate.total.toFixed(1)}, gap ${fmtPct(gapPct)}, ` +
    `rel vol ${relVolume === null ? 'n/a' : `${relVolume.toFixed(2)}×`}, RSI ${rsi === null ? 'n/a' : rsi.toFixed(1)} — ` +
    `entry ${entry.toFixed(2)}, stop ${stop.toFixed(2)} (${cfg.stopAtrMultiple}× ATR), ` +
    `target ${target.toFixed(2)} (${cfg.targetRMultiple}R)`;

  return {
    symbol: candidate.symbol,
    side: long ? 'buy' : 'sell',
    entry,
    stop,
    target,
    rMultiple: cfg.targetRMultiple,
    rationale,
    score: candidate.total,
  };
}

export interface DecisionResult {
  signals: TradeSignal[];
  skipped: { symbol: string; reason: string }[];
}

/** Generate signals for every screened candidate, journaling each outcome. */
export function runAutotradeDecision(
  candidates: ScreenCandidate[],
  configPatch?: Partial<DecisionConfig>,
): DecisionResult {
  const cfg = { ...defaultDecisionConfig(), ...configPatch };
  const signals: TradeSignal[] = [];
  const skipped: { symbol: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const signal = generateSignal(candidate, cfg);
    if (!signal) {
      const reason = 'insufficient volatility history (ATR) to set a sound stop-loss';
      skipped.push({ symbol: candidate.symbol, reason });
      logAutotradeEvent({ symbol: candidate.symbol, stage: 'decision', action: 'no_signal', detail: { reason } });
      continue;
    }
    signals.push(signal);
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'decision',
      action: 'signal_generated',
      detail: {
        side: signal.side,
        entry: signal.entry,
        stop: signal.stop,
        target: signal.target,
        rMultiple: signal.rMultiple,
        rationale: signal.rationale,
      },
    });
  }

  return { signals, skipped };
}
