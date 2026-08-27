// ---------------------------------------------------------------------------
// Deposits and withdrawals are not returns (2026-08-27).
//
// The daily target measures the day's gain as synced equity against a baseline
// snapshotted at the day's first tick. That is deliberate and stays: the goal
// is on the ACCOUNT'S value, manual trading included (see dailyTarget.ts's
// header). But an external cash flow moves account value without earning it,
// and the target counted it as gain.
//
// On 2026-08-27 a $5,000 deposit landed against a $2,228.83 baseline. The day
// read +131.56%, banked itself, and halted live entries — on a session whose
// actual autotrade P&L was -$8.32. Every %-of-equity figure derived from the
// baseline was wrong for the rest of the day too.
//
// The fix is to move the BASELINE by the flow, not to change the axis: after a
// $5,000 deposit the account genuinely has $5,000 more to earn its percentage
// on, so the base it is a percentage OF is what changed. Gain % is continuous
// across the flow, which is the property that was missing.
//
// THE TWO ERRORS ARE NOT SYMMETRIC, and that drives the whole design:
//
//   * Calling a real GAIN a deposit would re-baseline a genuine winning day,
//     so it never banks and the loop keeps opening risk into a day it should
//     have stopped. That ADDS risk.
//   * Calling a real DEPOSIT a gain banks the day early. That REMOVES risk and
//     wastes a session — bad, but bounded, and it is the failure we already had.
//
// So this declares a flow only when TWO independent signals agree, because
// either one alone has a plausible false positive:
//
//   1. The equity guard has just ACCEPTED a sustained out-of-band jump — its
//      own definition of "a real balance change, not a glitch". Alone, this
//      cannot tell a deposit from a windfall trading gain.
//   2. The broker's own day P&L does NOT account for the move. Alone, this
//      misfires whenever equity and day-P&L are measured over slightly
//      different windows (a pre-market gap being the obvious case).
//
// A deposit satisfies both. A 25% trading gain fails (2), because the broker's
// day P&L is exactly where such a gain shows up. A pre-market marking
// difference fails (1), because it is neither large nor sustained.
// ---------------------------------------------------------------------------

/** Ignore a residual smaller than this share of the baseline: marks, fees and
 *  rounding never line up to the cent, and adjusting for noise would make the
 *  baseline wander. Any cash flow worth making clears it comfortably. */
const MIN_FLOW_PCT_OF_BASELINE = 1;
/** …with an absolute floor, so a tiny account cannot make the percentage
 *  threshold meaninglessly small. */
const MIN_FLOW_USD = 25;

export interface ExternalCashFlow {
  /** Signed: positive is a deposit, negative a withdrawal. */
  flowUsd: number;
  /** The baseline the day should have been measured against all along. */
  adjustedBaselineUsd: number;
  /** For the journal. */
  reason: string;
}

export interface CashFlowInput {
  /** The day's current baseline (autotrade_daily_baseline.equity_usd). */
  baselineUsd: number;
  /** Equity just accepted by the sync. */
  currentEquityUsd: number;
  /** The broker's own P&L for the session, when it reported one. Undefined
   *  disables detection entirely — with no independent account of the move
   *  there is no second signal, and guessing would risk the dangerous error. */
  brokerDayPnlUsd: number | undefined;
}

/**
 * Should the day's baseline absorb an external cash flow?
 *
 * Call ONLY on a tick where the equity guard accepted a sustained out-of-band
 * reading — that is signal (1), and this function supplies signal (2). Returns
 * null when no flow should be declared, which is the overwhelmingly common
 * case and must leave the baseline untouched.
 */
export function detectExternalCashFlow(input: CashFlowInput): ExternalCashFlow | null {
  const { baselineUsd, currentEquityUsd, brokerDayPnlUsd } = input;
  if (brokerDayPnlUsd === undefined) return null;
  if (!(baselineUsd > 0) || !(currentEquityUsd > 0)) return null;

  // What equity SHOULD be if every dollar of the move came from trading.
  const explainedUsd = baselineUsd + brokerDayPnlUsd;
  const flowUsd = currentEquityUsd - explainedUsd;

  const threshold = Math.max(MIN_FLOW_USD, baselineUsd * (MIN_FLOW_PCT_OF_BASELINE / 100));
  if (Math.abs(flowUsd) < threshold) return null;

  const adjustedBaselineUsd = baselineUsd + flowUsd;
  // A withdrawal larger than the base would leave nothing to measure against;
  // refuse rather than write a zero or negative baseline.
  if (!(adjustedBaselineUsd > 0)) return null;

  const kind = flowUsd > 0 ? 'deposit' : 'withdrawal';
  return {
    flowUsd,
    adjustedBaselineUsd,
    reason:
      `${kind} of ${Math.abs(flowUsd).toFixed(2)} detected: equity ${currentEquityUsd.toFixed(2)} against a ` +
      `baseline of ${baselineUsd.toFixed(2)} plus a broker day P&L of ${brokerDayPnlUsd.toFixed(2)} — ` +
      `re-basing to ${adjustedBaselineUsd.toFixed(2)} so the flow is not counted as gain`,
  };
}
