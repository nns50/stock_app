// ---------------------------------------------------------------------------
// The ONE place riskPerTradePct is turned into the risk % a position is
// actually sized at.
//
// Four books size positions (equity paper, equity live, options paper, options
// live) through two risk checks — riskCheck.ts and optionsRiskCheck.ts — and
// both used to carry their own copy of this product. The copies agreed on the
// factors they shared and diverged on the rest, which is how the audit of
// 2026-09-05 found grade expectancy applying to stocks and not to options for
// no stated reason: it was "simply never wired here", and nothing anywhere
// could have said so.
//
// CLAUDE.md's rule is "when two places derive the same quantity, they must
// agree by construction — prefer one function both paths call over two that
// agree today". SizingFactors is that construction. Every field is REQUIRED,
// so a new sizing factor does not compile until BOTH call sites say what it
// does on their book. Deliberately excluding one is then a written line
// (`expectancy: NEUTRAL, // equity-only, see ...`) rather than an absence
// nobody can see.
//
// Every factor is a plain multiplier on the risk %, where 1 means "no effect".
// They compose by multiplication on purpose: two reasons to size down should
// both apply, not race for the tightest.
// ---------------------------------------------------------------------------

/** A factor that does nothing. Named so a deliberate opt-out reads as a
 *  decision at the call site instead of a bare `1`. */
export const NEUTRAL = 1;

/**
 * Every multiplicative sizing factor, one field each.
 *
 * Required, not optional, and that is the whole point — an optional field
 * would let a book silently omit a factor, which is exactly the failure this
 * type exists to prevent.
 */
export interface SizingFactors {
  /** Consecutive-loss step-down (riskCheck's stepDownAfterLosses). */
  stepDown: number;
  /** High-market-ATR regime cut. */
  regime: number;
  /** Equity-curve de-risking — strategy equity below its recent average. */
  equityCurveDerisk: number;
  /** Per-grade realized-edge multiplier (expectancySizing.ts). */
  expectancy: number;
  /** Per-method realized-edge multiplier (methodSizing.ts). */
  method: number;
  /** Finish-line trim near the daily bank line (finishLine.ts). */
  finishLine: number;
}

/** The factor a percentage cut applies, or NEUTRAL when the cut is inactive.
 *
 *  Clamped to [0, 1]: the config route bounds every cut % to 0-100, but this
 *  is the arithmetic that decides how much real money goes into a position, so
 *  it does not rely on a validator two layers away staying that way. A cut
 *  above 100 would otherwise flip the sign of the risk budget, and a negative
 *  one would quietly AMPLIFY risk — the opposite of what every caller of this
 *  function is asking for. */
export function cutFactor(active: boolean, cutPct: number): number {
  if (!active) return NEUTRAL;
  if (!Number.isFinite(cutPct)) return NEUTRAL;
  return Math.min(1, Math.max(0, 1 - cutPct / 100));
}

/**
 * riskPerTradePct after every sizing factor.
 *
 * Never negative: a factor set is a set of REASONS TO SIZE DOWN, and a
 * negative risk budget would flip a long into a short in any sizer that
 * multiplies by it.
 */
export function effectiveRiskPct(riskPerTradePct: number, f: SizingFactors): number {
  const product =
    riskPerTradePct * f.stepDown * f.regime * f.equityCurveDerisk * f.expectancy * f.method * f.finishLine;
  return Number.isFinite(product) ? Math.max(0, product) : 0;
}
