import type { DailyBaseline } from '../../db/dailyBaseline';

// ---------------------------------------------------------------------------
// THE DAY'S LOSS BUDGET — one derivation, shared (2026-09-15).
//
// `maxDailyDrawdownPct` is one rule: "stop opening live positions once the
// loop has lost this much of a day". It had THREE implementations, and on
// 2026-09-15 they disagreed by 6x on a live account.
//
//   riskCheck / optionsRiskCheck   the loop's realized day  vs  pct x
//                                  accountEquityUsd (the net-liquidation
//                                  reading of THIS TICK)
//   guardrails.daily_loss_halt     the ACCOUNT's realized day  vs
//                                  liveMaxDailyLossUsd (pct x the cap
//                                  ANCHOR equity, re-derived on a >=5% drift)
//   dailyTarget                    the loop's realized day  vs  the day's
//                                  OPENING baseline — for the +3% goal and the
//                                  give-back guard, not for this halt
//
// Both halves were wrong, and both are fixed here.
//
// THE DENOMINATOR IS THE DAY'S OPENING EQUITY, not the reading of this tick.
// A drawdown is a move measured FROM somewhere; putting the current value in
// the denominator puts the quantity being limited on both sides of the
// comparison, so the allowance chases the loss down and the effective budget
// depends on the path the day took. It also has to be the same denominator the
// GOAL uses, or the two day-level rules are percentages of different dollars.
// On 2026-09-15 they were: the +3% goal was 3% of the day's $3,694.39 baseline
// = $110.83, while the halt was 7.5% of a $591.81 tick reading = $44.39. The
// loop had to make $110.83 and would have been stopped after losing $44.39 —
// a book that cannot reach its own goal without first being halted, and no
// edge fixes that. (The $591.81 was real: an operator-held 129-contract SPY
// 0DTE put decaying from $0.29 to $0.035 took net liquidation down with it.)
//
// THE NUMERATOR IS THE LOOP'S OWN REALIZED DAY, not the account's. This is the
// same correction PR #610 made to dailyTarget on 2026-09-14 — its note says
// "a manual LOSS could halt the book just as easily" — which checked
// riskCheck's halt and found it already loop-scoped, and never looked at the
// guardrail twin, which is the TIGHTER of the two and therefore the one that
// decides. `AccountState.realizedPnlTodayUsd` is deliberately account-wide
// (the worse of broker day-minus-unrealized and EVERY journal exit dated
// today, `webull`-tagged operator rows included), which is the right input for
// a hand-placed order on the Trade page and the wrong one for the loop.
//
// What is NOT changed: the stored `liveMaxDailyLossUsd` cap. It stays the
// human path's cap, the dashboard's display and the tuner's suggestion — it
// was only ever documented as "exactly match maxDailyDrawdownPct in dollars"
// (liveCaps.ts), never as an independent second limit, so the loop losing it
// as a gate removes no ceiling `maxDailyDrawdownPct` did not already impose.
// ---------------------------------------------------------------------------

/**
 * The dollars the loop may lose in one session before live entries stop.
 *
 * Always non-negative and always a POSITIVE magnitude — callers that want a
 * signed floor negate it, so no caller has to guess this function's sign.
 */
export function dayLossBudgetUsd(maxDailyDrawdownPct: number, dayStartEquityUsd: number): number {
  if (!(maxDailyDrawdownPct > 0) || !(dayStartEquityUsd > 0)) return 0;
  return (maxDailyDrawdownPct / 100) * dayStartEquityUsd;
}

/**
 * The equity the day STARTED at — the denominator above and the one
 * `dailyTarget` measures the goal against.
 *
 * Falls back to the live reading when there is no baseline for `etDate` yet
 * (the very first tick of a day, a fresh database, a backtest), which restores
 * exactly the pre-2026-09-15 behaviour for that one tick rather than dividing
 * by zero. The fallback is explicit and passed in by the caller so that a
 * caller with no live reading either cannot silently get one.
 */
export function dayStartEquityUsd(
  baseline: DailyBaseline | null,
  etDate: string,
  currentEquityUsd: number,
): { usd: number; fromBaseline: boolean } {
  if (baseline && baseline.etDate === etDate && baseline.equityUsd > 0) {
    return { usd: baseline.equityUsd, fromBaseline: true };
  }
  return { usd: currentEquityUsd, fromBaseline: false };
}
