// Equity-curve de-risking (2026-07-24). A graduated alternative to the binary
// daily-drawdown halt: when the strategy's OWN realized equity curve turns down
// — its latest cumulative P&L below the average of its recent history — size the
// next entries smaller, and restore full size once it recovers. Classic "trade
// your equity curve like a price series with a moving-average filter."
//
// Pure and DB-free (mirrors excursionTune.ts). Off unless
// AutotradeConfig.equityCurveDeriskEnabled; the caller (each executor's
// portfolio snapshot) builds the closed-trade list for its own book — paper
// trades for the paper loop, live autotrade fills for the live loop — so each
// de-risks on its own performance, not the other's.

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export interface EquityCurveDeriskConfig {
  enabled: boolean;
  /** Trading days in the equity-curve moving average the latest point is compared to. */
  lookbackDays: number;
  /** Size cut (%) applied while the curve is below its average. */
  cutPct: number;
}

export interface EquityCurveDeriskResult {
  /** True when the curve is below its N-day average (and enabled + enough history). */
  active: boolean;
  /** Sizing multiplier: 1 = no cut, `1 − cutPct/100` while active. */
  multiplier: number;
  /** Latest cumulative realized P&L, or null when there's no history. */
  latest: number | null;
  /** N-day moving average of the cumulative curve, or null when too short. */
  average: number | null;
  /** Distinct trading days in the curve. */
  days: number;
  reason: string;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Decide whether to de-risk from a book's closed-trade P&L history. Buckets the
 * trades by day into a cumulative realized-P&L curve, then compares the latest
 * point to the moving average of the last `lookbackDays` points. Degrades to
 * inactive (multiplier 1) when disabled or when there aren't yet `lookbackDays`
 * days of history — honest, never a guessed cut off a tiny sample.
 */
export function computeEquityCurveDerisk(
  closedTrades: { date: string; pnl: number }[],
  cfg: EquityCurveDeriskConfig,
): EquityCurveDeriskResult {
  if (!cfg.enabled) {
    return { active: false, multiplier: 1, latest: null, average: null, days: 0, reason: 'disabled' };
  }

  // Bucket by day → chronological cumulative realized P&L.
  const byDay = new Map<string, number>();
  for (const t of closedTrades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnl);
  const days = [...byDay.keys()].sort();
  const cumulative: number[] = [];
  let run = 0;
  for (const d of days) {
    run += byDay.get(d) as number;
    cumulative.push(run);
  }

  const n = cumulative.length;
  if (n < cfg.lookbackDays || n < 2) {
    return {
      active: false,
      multiplier: 1,
      latest: n ? round2(cumulative[n - 1]) : null,
      average: null,
      days: n,
      reason: `insufficient history (${n} day${n === 1 ? '' : 's'}, need ${cfg.lookbackDays})`,
    };
  }

  const average = round2(mean(cumulative.slice(-cfg.lookbackDays)));
  const latest = round2(cumulative[n - 1]);
  const active = latest < average;
  return {
    active,
    multiplier: active ? clamp(round2(1 - cfg.cutPct / 100), 0, 1) : 1,
    latest,
    average,
    days: n,
    reason: active
      ? `below ${cfg.lookbackDays}-day equity average (${latest} < ${average})`
      : `at/above ${cfg.lookbackDays}-day equity average (${latest} ≥ ${average})`,
  };
}
