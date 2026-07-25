// Expectancy-weighted sizing (2026-07-24). Turns each conviction grade's OWN
// realized edge into a bounded per-grade size multiplier: a grade whose closed
// trades average a positive R gets sized up, one that bleeds gets sized down,
// breakeven stays flat. So proven setups compound harder without raising the
// aggregate-risk ceiling (that veto still binds).
//
// Pure and DB-free (mirrors equityCurveDerisk.ts). Off unless
// AutotradeConfig.expectancyWeightingEnabled; each book (paper vs live) builds
// its own {grade, realizedR} list, so live sizes on live results and paper on
// paper. A grade with fewer than `minTrades` closed trades stays neutral (1×) —
// no guessed edge off a tiny sample.

const round2 = (n: number): number => Math.round(n * 100) / 100;
// Order-safe: a plain Math.max(lo, Math.min(hi, n)) returns `lo` when lo > hi,
// which for THIS clamp means an inverted min/max pair would size every grade —
// including the worst-performing one — at the min multiplier. The route rejects
// an inverted pair, but this multiplies risk directly (riskCheck.ts), so it does
// not rely on that alone.
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, Math.min(lo, hi)), Math.max(lo, hi));

export interface ExpectancySizingConfig {
  enabled: boolean;
  /** Closed trades a grade needs before its realized edge sizes anything. */
  minTrades: number;
  /** Lower clamp on the multiplier (e.g. 0.5 = never below half size). */
  minMultiplier: number;
  /** Upper clamp on the multiplier (e.g. 1.5 = never above 1.5× size). */
  maxMultiplier: number;
}

/**
 * Map each conviction grade to a sizing multiplier from its own closed-trade
 * realized R. A grade's average R shifts its multiplier around 1 (breakeven):
 * `multiplier = clamp(1 + avgR, min, max)`. Grades below the sample floor (or
 * when disabled) are absent from the map — the caller reads a missing grade as
 * 1× (neutral). Trades with no grade are ignored.
 */
export function computeGradeExpectancyMultipliers(
  trades: { grade: string | null; realizedR: number }[],
  cfg: ExpectancySizingConfig,
): Record<string, number> {
  if (!cfg.enabled) return {};
  const byGrade = new Map<string, number[]>();
  for (const t of trades) {
    if (!t.grade) continue;
    const arr = byGrade.get(t.grade);
    if (arr) arr.push(t.realizedR);
    else byGrade.set(t.grade, [t.realizedR]);
  }
  const out: Record<string, number> = {};
  for (const [grade, rs] of byGrade) {
    if (rs.length < cfg.minTrades) continue;
    const avgR = rs.reduce((a, b) => a + b, 0) / rs.length;
    out[grade] = round2(clamp(1 + avgR, cfg.minMultiplier, cfg.maxMultiplier));
  }
  return out;
}
