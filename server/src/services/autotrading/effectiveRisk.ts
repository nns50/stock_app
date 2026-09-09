import { ML_REGIME_LABELS, MlRegime } from '../regimeModel';

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
  /** The market-regime cut — one factor with three triggers (regimeTriggers). */
  regime: number;
  /** Same-day re-entry cut — this symbol already closed a position today. */
  repeatEntry: number;
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
    riskPerTradePct *
    f.stepDown *
    f.regime *
    f.repeatEntry *
    f.equityCurveDerisk *
    f.expectancy *
    f.method *
    f.finishLine;
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

// ---------------------------------------------------------------------------
// The regime factor has THREE triggers and ONE cut (2026-09-08, the ML regime
// overlay — docs/MARKET_REGIME_MODEL.md, docs/AUTOTRADE_RISK_SETTINGS.md):
//
//   atr    SPY's 14-day ATR% above regimeAtrThresholdPct — the 2026-07-16
//          trigger, which has never fired on this book (market ATR ran
//          0.82–1.23% across every recorded entry).
//   ml     the HMM reading is High Volatility/Bearish, with the overlay ON.
//   shock  the intraday nowcast: SPY's range so far today is at least
//          regimeShockRangeRatio × its ATR, with the overlay ON. A daily model
//          read through FRED labels the morning AFTER a shock; this is the one
//          trigger that can see day one.
//
// They are not three factors. The About page enumerates seven sizing factors and
// two market-volatility cuts multiplying each other would count one condition
// twice, so the DEEPER configured cut applies once: ATR 40% + ML 35% is a 40%
// cut, never 61%. A cut of 100 or more means "no entries in this regime" —
// the risk check turns that into a failing rule rather than a zero-share order.
//
// `effectiveRegime` is THE regime every downstream consumer reads — the at-entry
// stamp, and the later target tighten, goal scale and conviction bar — so a
// nowcast-promoted tick is stamped, tightened and scaled as High Vol by
// construction rather than by four separate derivations agreeing today. The
// loop derives it once per tick; the risk checks call this again per candidate
// from the same inputs for the sizing line. Nothing else derives a regime.
// ---------------------------------------------------------------------------

/** Everything the three triggers read. Every field is required so each
 *  context builder (four executors, two previews, three backtest engines)
 *  states its value — a backtest writes null / false / 0 and says why. */
export interface RegimeTriggerInputs {
  /** SPY's 14-day ATR% (executionGuards.getMarketAtrPct); null = unknown, no ATR trigger. */
  marketAtrPct: number | null | undefined;
  regimeAtrThresholdPct: number;
  regimeSizeCutPct: number;
  /** The HMM reading's regime when it is known and fresh (mlRegime.actionableRegime);
   *  null when unknown, stale or not read — never a guess. */
  mlRegime: MlRegime | null | undefined;
  mlRegimeEnabled: boolean;
  mlRegimeSizeCutPct: number;
  /** SPY's range so far today as a % of the previous close
   *  (executionGuards.getMarketRangePct); null = unknown, no shock trigger. */
  todayRangePct: number | null | undefined;
  /** Range ÷ ATR at or above which the tick is a shock day; 0 = off. */
  regimeShockRangeRatio: number;
}

export interface RegimeTriggers {
  atr: boolean;
  ml: boolean;
  shock: boolean;
  triggered: boolean;
  /** The deeper configured cut among the triggers that fired; 0 when none did. */
  cutPct: number;
  /** cutPct ≥ 100 with a trigger fired: no entry at all in this regime. */
  skip: boolean;
  /** The `regime` sizing factor — 0 on skip, cutFactor(triggered, cutPct) otherwise. */
  factor: number;
  /** The one regime every consumer reads (see the header). */
  effectiveRegime: MlRegime;
  /** Which triggers fired, or why none did. Carries the cut % but no sizing
   *  numbers — the risk check adds "sizing at x% instead of y%". */
  detail: string;
}

/** A configured cut %, made safe for arithmetic: NaN reads as no cut, and the
 *  range is [0, 100] whatever the validator two layers up allows. */
function asCutPct(pct: number): number {
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
}

export function regimeTriggers(i: RegimeTriggerInputs): RegimeTriggers {
  const atr = isRegimeActive(i.marketAtrPct, i.regimeAtrThresholdPct);
  const ml = i.mlRegimeEnabled && i.mlRegime === 'high_vol_bearish';
  const shock =
    i.mlRegimeEnabled &&
    i.regimeShockRangeRatio > 0 &&
    i.todayRangePct != null &&
    i.marketAtrPct != null &&
    Number.isFinite(i.todayRangePct) &&
    Number.isFinite(i.marketAtrPct) &&
    i.marketAtrPct > 0 &&
    i.todayRangePct >= i.regimeShockRangeRatio * i.marketAtrPct;
  const triggered = atr || ml || shock;
  const atrCut = atr ? asCutPct(i.regimeSizeCutPct) : 0;
  const mlCut = ml || shock ? asCutPct(i.mlRegimeSizeCutPct) : 0;
  const cutPct = Math.max(atrCut, mlCut);
  const skip = triggered && cutPct >= 100;
  const factor = skip ? 0 : cutFactor(triggered, cutPct);
  const effectiveRegime: MlRegime = ml || shock ? 'high_vol_bearish' : (i.mlRegime ?? 'unknown');
  return {
    atr,
    ml,
    shock,
    triggered,
    cutPct,
    skip,
    factor,
    effectiveRegime,
    detail: describeTriggers(i, { atr, ml, shock, atrCut, mlCut, cutPct }),
  };
}

function describeTriggers(
  i: RegimeTriggerInputs,
  t: { atr: boolean; ml: boolean; shock: boolean; atrCut: number; mlCut: number; cutPct: number },
): string {
  const atrPct = i.marketAtrPct == null ? 'unavailable' : `${i.marketAtrPct.toFixed(1)}%`;
  const highVol = ML_REGIME_LABELS.high_vol_bearish;
  const mlWord = i.mlRegime && i.mlRegime !== 'unknown' ? ML_REGIME_LABELS[i.mlRegime] : null;
  const mlNote = !i.mlRegimeEnabled
    ? 'ML regime overlay off'
    : mlWord === null
      ? 'ML regime unknown (stale or unavailable — no cut)'
      : t.ml
        ? `ML regime ${mlWord}`
        : `ML regime ${mlWord} — cuts only in ${highVol}`;
  const fired: string[] = [];
  if (t.atr) fired.push(`market ATR ${atrPct} exceeds ${i.regimeAtrThresholdPct}%`);
  if (t.ml) fired.push(mlNote);
  if (t.shock)
    fired.push(`shock day: SPY range ${i.todayRangePct!.toFixed(1)}% ≥ ${i.regimeShockRangeRatio} × ATR ${atrPct}`);
  if (fired.length === 0) {
    const parts = [`market ATR ${atrPct} (triggers above ${i.regimeAtrThresholdPct}%)`, mlNote];
    if (i.mlRegimeEnabled && i.regimeShockRangeRatio > 0 && i.todayRangePct != null && i.marketAtrPct != null) {
      parts.push(`SPY range ${i.todayRangePct.toFixed(1)}% below ${i.regimeShockRangeRatio} × ATR`);
    }
    return parts.join('; ');
  }
  const cut =
    t.atrCut > 0 && t.mlCut > 0
      ? `${t.cutPct}% cut — the deeper of ATR ${t.atrCut}% / ML ${t.mlCut}%, never both`
      : `${t.cutPct}% cut`;
  const rest: string[] = [cut];
  if (!t.atr)
    rest.push(
      i.marketAtrPct == null ? 'ATR trigger inactive (market ATR unavailable)' : `ATR trigger inactive at ${atrPct}`,
    );
  if (!t.ml && !t.shock) rest.push(mlNote);
  if (t.shock && !t.ml) rest.push(mlWord === null ? 'model reading unknown' : `model reads ${mlWord}`);
  return `${fired.join(' + ')} (${rest.join('; ')})`;
}

/**
 * What one loop tick knows about the regime, handed to every executor: the two
 * inputs the loop fetched for the triggers, and the ONE effective regime it
 * derived through regimeTriggers. An executor passes the inputs into its risk
 * check (which calls regimeTriggers again, from the same inputs, for the
 * sizing line) and stamps `effectiveRegime` on what it opens — it never
 * derives a regime of its own.
 */
export interface TickRegime {
  mlRegime: MlRegime | null;
  todayRangePct: number | null;
  effectiveRegime: MlRegime;
}

/** A caller with no tick behind it (a direct test call): nothing known. */
export const NO_TICK_REGIME: TickRegime = { mlRegime: null, todayRangePct: null, effectiveRegime: 'unknown' };

/** The label a position opened this tick is stamped with — null for unknown,
 *  never a guess. */
export function regimeStamp(t: TickRegime): MlRegime | null {
  return t.effectiveRegime === 'unknown' ? null : t.effectiveRegime;
}

/**
 * Is this a SAME-DAY re-entry into a name this book already exited today?
 *
 * Measured 2026-09-08 over 89 closed live-autotrade trades: first entries
 * n=56 +$398.98 (mean +$7.12), repeats n=33 -$121.03 (mean -$3.67). The
 * direction survives trimming; the size of it does not — 86% of the repeat
 * deficit is a single DELL trade, and dropping the worst from each side leaves
 * repeats at -$0.55 a trade. Hence a size CUT rather than a block.
 *
 * Counts EXITS today, not entries: a position opened yesterday and closed this
 * morning makes this morning's second attempt a repeat, which entry-counting
 * would miss. The cut % is not consulted here — cutFactor turns 0 into NEUTRAL
 * on its own, and folding the off-switch into the predicate is what made the
 * regime cut pin ON at a 0 threshold (see isRegimeActive above).
 */
export function isRepeatEntryActive(priorSameDayExits: number): boolean {
  return priorSameDayExits > 0;
}

export interface PreFinishLineInputs extends RegimeTriggerInputs {
  consecutiveLosses: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  /** How many times THIS symbol already closed a position today, for this book.
   *  Zero on the paper path by written opt-out — paper takes every signal so the
   *  repeat-vs-first comparison keeps a clean control arm. */
  priorSameDayExits: number;
  repeatEntrySizeCutPct: number;
  /** Already-decided multipliers. Pass NEUTRAL where a book deliberately does
   *  not apply one — a written opt-out, not an omission. */
  equityCurveDerisk: number;
  expectancy: number;
  method: number;
}

export function preFinishLineFactors(i: PreFinishLineInputs): PreFinishLineFactors {
  return {
    stepDown: cutFactor(isStepDownActive(i.consecutiveLosses, i.stepDownAfterLosses), i.stepDownSizeCutPct),
    regime: regimeTriggers(i).factor,
    repeatEntry: cutFactor(isRepeatEntryActive(i.priorSameDayExits), i.repeatEntrySizeCutPct),
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
