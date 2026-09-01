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

/** A conviction grade stamped on an autotrade position at entry, derived from
 *  the screener's 0..100 total score. Lets realized outcomes be grouped by the
 *  system's own conviction (the Journal's byGrade report, and — behind a flag —
 *  expectancy-weighted sizing). 'A' = highest conviction. */
export type ConvictionGrade = 'A' | 'B' | 'C';

/** Bucket a screener score into a conviction grade: A at/above aMinScore, B
 *  at/above bMinScore, else C. Pure — the thresholds are AutotradeConfig fields. */
export function convictionGrade(score: number, cfg: { aMinScore: number; bMinScore: number }): ConvictionGrade {
  if (score >= cfg.aMinScore) return 'A';
  if (score >= cfg.bMinScore) return 'B';
  return 'C';
}

export interface DecisionConfig {
  /** Stop distance = this many ATRs from entry. */
  stopAtrMultiple: number;
  /** Target distance = this many multiples of the stop distance (reward:risk). */
  targetRMultiple: number;
  /** Hard ceiling on stop distance as a % of entry price. 0 = off.
   *  See clampStopDistance() below for why this exists. */
  maxStopDistancePct?: number;
}

export function defaultDecisionConfig(): DecisionConfig {
  return { stopAtrMultiple: 1.5, targetRMultiple: 2, maxStopDistancePct: 0 };
}

/**
 * Cap the ATR stop at a fixed % of entry price (2026-08-25).
 *
 * `stopAtrMultiple × ATR` uses the DAILY ATR — a full-day expected range — so a
 * 1.5x stop sits one and a half typical DAYS away from entry. That is the right
 * distance for a multi-day swing. This loop is intraday: a 90-minute stagnation
 * exit, maxHoldDays 1, and flat before the close. The two were never
 * reconciled, and the mismatch is the single root cause behind four separate
 * symptoms:
 *
 *   - Positions were tiny. Size = risk budget / stop distance, so a stop 14.6%
 *     away spends the whole budget on one share. MRNA on 2026-08-25: entry
 *     154.20, stop 131.65, $22.55 of risk PER SHARE against a $45.67 budget →
 *     1 share.
 *   - Targets were never reached. The target is targetRMultiple × the stop
 *     distance, so a 14.6% stop implies a 29% target — capped by structure to
 *     176.43, still +14.4% and unreachable inside a session.
 *   - Stops were never reached either, so exits came from the stagnation timer
 *     at ~0.1R rather than from either bracket leg.
 *   - Which makes a 3%/day goal arithmetically out of reach: 0.1R on 2.14% risk
 *     is 0.2% of equity per trade.
 *
 * What the trades actually do, measured on 5-minute bars over the minutes each
 * position was really held (the five loop trades with a recorded entry time):
 * adverse excursion 0.21%-1.50%, favorable 0.00%-1.55%. An order of magnitude
 * inside where the brackets sat.
 *
 * MRNA the same day, after its 10:36 entry: low -1.15%, high +3.42%. A 2% stop
 * survives; a 3% target is hit; and the SAME $45.67 of risk buys 14 shares
 * instead of 1 — 99% of the day's target from one trade, at no extra risk.
 *
 * Capping the stop therefore fixes the target for free, since the target is a
 * multiple of the stop distance. Note this is a CEILING, never a floor: a stock
 * whose ATR stop is already tighter keeps it.
 */
export function clampStopDistance(entry: number, stopDistance: number, maxStopDistancePct?: number): number {
  if (!maxStopDistancePct || !(maxStopDistancePct > 0) || !(entry > 0)) return stopDistance;
  return Math.min(stopDistance, entry * (maxStopDistancePct / 100));
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
  /** ~20-day average daily volume (shares) from the candidate's indicators,
   *  carried so the risk check can apply an ADV participation size cap without
   *  re-fetching. Null/absent when the screener couldn't resolve it. */
  avgVolume?: number | null;
  /** Relative-volume PACE at signal time (screen.ts), carried for the same
   *  reason avgVolume is: levelPlan needs it to judge whether a move through
   *  overhead structure has real participation behind it, and re-deriving it
   *  downstream would mean a second, differently-timed measurement of the same
   *  quantity. Null when unmeasurable. */
  relVolPace?: number | null;
}

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Turn one screened candidate into a trade signal, or null if a sound stop
 * can't be computed (no ATR — insufficient history — or the ATR-based stop
 * would land at or below zero). Pure: no I/O, no journaling (the caller logs).
 *
 * Long vs. short comes from `candidate.direction` — resolved PER-SYMBOL by
 * the screen stage (screen.ts's runAutotradeScreen, driven by
 * AutotradeConfig.tradeDirection), not a batch-wide setting here. This is
 * what lets one decision batch contain both a long signal on one symbol and
 * a short on another — DecisionConfig itself no longer carries a `direction`
 * field (removed 2026-07-14 when this became per-candidate; it would only
 * ever be stale/ignored now).
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
  const stopDistance = clampStopDistance(entry, cfg.stopAtrMultiple * atr, cfg.maxStopDistancePct);
  const long = candidate.direction === 'long';
  const stop = round2(long ? entry - stopDistance : entry + stopDistance);
  if (stop <= 0) return null;

  const targetDistance = stopDistance * cfg.targetRMultiple;
  const target = round2(long ? entry + targetDistance : entry - targetDistance);
  // A SHORT's target sits below entry, and target distance is a multiple of
  // the (ATR-based) stop distance — on a volatile low-priced name it can land
  // at or below zero, which is not a price any bracket leg can carry (the
  // broker rejects the whole order, same class as the sub-penny rejection
  // documented above). No sound plan exists for it — fail the signal like the
  // impossible-stop case rather than emit an unplaceable one.
  if (target <= 0) return null;

  const { gapPct, relVolume, rsi } = candidate.indicators;
  const rationale =
    `${long ? 'Long' : 'Short'} breakout: score ${candidate.total.toFixed(1)}, gap ${fmtPct(gapPct)}, ` +
    `rel vol ${relVolume === null ? 'n/a' : `${relVolume.toFixed(2)}×`}, RSI ${rsi === null ? 'n/a' : rsi.toFixed(1)} — ` +
    `entry ${entry.toFixed(2)}, stop ${stop.toFixed(2)} (${
      stopDistance < cfg.stopAtrMultiple * atr
        ? `capped at ${cfg.maxStopDistancePct}% of entry, under ${cfg.stopAtrMultiple}× ATR`
        : `${cfg.stopAtrMultiple}× ATR`
    }), ` +
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
    avgVolume: candidate.indicators.avgVolume,
    relVolPace: candidate.relVolPace ?? null,
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
      const reason = 'no sound stop/target from ATR (insufficient history, or a level would land at/below $0)';
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
