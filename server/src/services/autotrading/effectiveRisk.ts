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

// ---------------------------------------------------------------------------
// Assembling the factors. Split out so the finish-line trim can see the risk %
// a trade will ACTUALLY use.
//
// computeFinishLineFactor asks "would a full-size win overshoot the remaining
// gap to the bank line?" and it was handed the raw config riskPerTradePct,
// while its own answer then became the sixth multiplier beside step-down and
// the rest. So whenever any other factor was below 1 the payoff it reasoned
// about was larger than the payoff the trade would produce: it fired when it
// should not have, and cut deeper when it did — twice over, since its factor
// then multiplied with the cut it had ignored. Always in the same direction,
// under-sizing near the goal exactly after a couple of losses.
//
// preFinishLineRiskPct is the fix: the risk % the trade would take if the trim
// did not exist. The finish line reasons about that, and the result multiplies
// it. Both books assemble their factors through the same builder, so this
// cannot become a third copy of the product.
// ---------------------------------------------------------------------------

/** Every factor except the finish line — what a book knows before the trim. */
export type PreFinishLineFactors = Omit<SizingFactors, 'finishLine'>;

/** Consecutive-loss step-down is active. */
export function isStepDownActive(consecutiveLosses: number, stepDownAfterLosses: number): boolean {
  return consecutiveLosses >= stepDownAfterLosses;
}

/**
 * The high-ATR regime cut is active.
 *
 * A threshold of 0 means OFF, matching every other "0 disables" field in this
 * config. Without the `> 0` guard any market ATR% exceeds 0, so setting the
 * threshold to 0 to turn the feature off instead pinned the cut permanently ON
 * — which is exactly what happened: the equity copy of this test was fixed and
 * the options copy was missed, halving every options position while the equity
 * path correctly used the full risk %. It lives here now so there is one copy
 * to be right.
 */
export function isRegimeActive(marketAtrPct: number | null | undefined, thresholdPct: number): boolean {
  return thresholdPct > 0 && marketAtrPct != null && marketAtrPct > thresholdPct;
}

export interface PreFinishLineInputs {
  consecutiveLosses: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  marketAtrPct: number | null | undefined;
  regimeAtrThresholdPct: number;
  regimeSizeCutPct: number;
  /** Already-decided multipliers. Pass NEUTRAL where a book deliberately does
   *  not apply one — a written opt-out, not an omission. */
  equityCurveDerisk: number;
  expectancy: number;
  method: number;
}

export function preFinishLineFactors(i: PreFinishLineInputs): PreFinishLineFactors {
  return {
    stepDown: cutFactor(isStepDownActive(i.consecutiveLosses, i.stepDownAfterLosses), i.stepDownSizeCutPct),
    regime: cutFactor(isRegimeActive(i.marketAtrPct, i.regimeAtrThresholdPct), i.regimeSizeCutPct),
    equityCurveDerisk: i.equityCurveDerisk,
    expectancy: i.expectancy,
    method: i.method,
  };
}

/**
 * The risk % this trade would use if the finish-line trim did not exist — the
 * ONLY correct basis for deciding whether a win would overshoot the bank line.
 */
export function preFinishLineRiskPct(riskPerTradePct: number, f: PreFinishLineFactors): number {
  return effectiveRiskPct(riskPerTradePct, { ...f, finishLine: NEUTRAL });
}

/**
 * How a single factor should be DESCRIBED, derived from the factor itself
 * rather than from whatever triggered it.
 *
 * A trigger firing and a size actually changing are two different facts, and
 * saying "active" for the first is how a status comes to lie. Found live on
 * 2026-09-05: regimeAtrThresholdPct was 3 with regimeSizeCutPct 0, so on a
 * high-ATR day the risk check reported `regime_sizing: active — market ATR 3.5%
 * exceeds 3%, sizing at 1.25% instead of 1.25% (0% cut)`. Every word true, the
 * headline wrong: nothing was cut.
 *
 * Reading the factor is what makes this impossible to get wrong — a factor of
 * exactly 1 changed nothing, whatever fired.
 */
export type FactorState = 'inactive' | 'triggered-but-neutral' | 'active';

export function factorState(triggered: boolean, factor: number): FactorState {
  if (!triggered) return 'inactive';
  return factor === NEUTRAL ? 'triggered-but-neutral' : 'active';
}
