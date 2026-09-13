import type { ScreenCandidate } from './screen';

// ---------------------------------------------------------------------------
// Which underlyings can this book actually AFFORD a short-dated contract on?
//
// Task #59, 2026-09-09. The options funnel is starved — 141 `options_blocked`
// against 2 `options_passed` on 2026-09-09 — and the binding constraint is not
// an entry rule, it is the premium ceiling (task #24). At that day's equity the
// ceiling was $0.919 per share, while META's ATM call asked $3.08, COIN's
// $2.64 and HOOD's $1.65. Those three could never have filled, at any score.
//
// That matters more than it sounds because `optionsMaxConcurrentPositions` is
// 1. The options path gets ONE slot. Spending it evaluating a candidate whose
// contract costs four times the budget is the whole day's options opportunity,
// gone — so this is not merely saved work (the way the naked-short skip in
// liveExecute.ts is), it is a different trade actually getting taken.
//
// THE CEILING IS NOT A CONSTANT AND MUST NOT BE WRITTEN DOWN AS ONE. It is an
// exact inversion of the `quantity` rule in optionsRiskCheck.ts, which sizes a
// single leg as:
//
//     maxRiskDollars = equity * riskPct / 100
//     stopDistance   = premium * f            (f = disasterStopPct / 100)
//     riskPerUnit    = stopDistance * 100     (an option contract is 100 shares)
//     contracts      = floor(maxRiskDollars / riskPerUnit)
//
// and refuses the trade when `contracts` is 0. So `contracts >= 1` iff
//
//     premium <= maxRiskDollars / (f * 100)
//
// which is maxAffordablePremiumPerShare() below, verbatim. Two places deriving
// the same quantity must agree BY CONSTRUCTION (CLAUDE.md), so
// optionsAffordability.test.ts asserts this inversion against real
// computeRiskSizing() output rather than against a copy of the arithmetic —
// if the sizer's formula changes, that test fails here.
//
// WHY THIS FILTER CAN NEVER DROP AN AFFORDABLE CANDIDATE. Two separate
// conservative choices, both deliberate:
//
//  1. The risk % it reasons about is an UPPER BOUND, not the effective one.
//     effectiveRisk.ts multiplies riskPerTradePct by seven factors. Five of
//     them only ever cut (cutFactor clamps to [0,1]) and `expectancy` is
//     NEUTRAL on this book by written opt-out, but `method` does not cut:
//     methodSizing computes clamp(1 + avgR, min, max), bounded above by
//     expectancyMaxMultiplier, so with methodWeightingEnabled the configured
//     risk % is NOT a bound and treating it as one would drop candidates the
//     sizer would have afforded. riskPctUpperBound() applies the same lean,
//     READ FROM THE CONFIG FIELD rather than restated here — this comment used
//     to quote "1.5", which the 2026-09-12 sizing change moved to 1.25 without
//     anyone touching the sentence.
//  2. The premium is ESTIMATED from the underlying's price, and the estimate
//     is deliberately low. Real ATM premium/underlying on 2026-09-09 ran
//     1.42%-1.73% for the single names (SMCI 0.60/39.08, RIOT 0.38/21.91,
//     HOOD 1.65/116.46, COIN 2.64/177.99) and 0.47% for META, whose size
//     damps it. A LOW ratio yields a HIGH price cap, so the default of 1.0%
//     sits under every single-name observation on purpose: it under-states
//     what a contract costs, and therefore over-keeps rather than over-drops.
//
// On that session's five measured contracts the default keeps RIOT and SMCI
// and drops HOOD, COIN and META — and all three of those really were priced
// above the ceiling, so nothing tradeable was lost. Over-keeping is the
// tolerable error (a kept symbol still meets the real risk check, which sees
// the true premium and refuses it properly); over-dropping would silently cost
// a trade, and optionsAffordability.test.ts asserts it does not happen.
//
// n=5. This ratio is one session's observation of five contracts, not a law,
// and it is config so it can be moved without a deploy. Ships behind
// `optionsAffordabilityFilterEnabled`, default OFF.
// ---------------------------------------------------------------------------

/** The inputs the premium ceiling is derived from. Every one of these is read
 *  from AutotradeConfig or the live account — none is a tuned constant. */
export interface AffordabilityInputs {
  /** Account equity the risk budget is a percentage of. */
  equityUsd: number;
  /** The LARGEST risk % this cycle could size at — see riskPctUpperBound().
   *  Not the effective risk %: passing the effective one would make the filter
   *  tighter than the sizer and drop tradeable candidates. */
  riskPctUpperBound: number;
  /** AutotradeConfig.optionsDisasterStopPct — what share of the premium is at
   *  risk, and therefore the divisor that turns a risk budget into a premium
   *  budget. */
  disasterStopPct: number;
}

// ---------------------------------------------------------------------------
// THE ONE CONVERSION BETWEEN "DOLLARS OF RISK" AND "PERCENT OF PREMIUM"
// (2026-09-12).
//
// An options position has two different units and it is easy to compare one
// against the other by accident:
//
//   risk dollars   what the sizer spends from the per-trade budget —
//                  `equity x effectiveRiskPct/100`, the SAME number the equity
//                  book calls 1R, and what every risk cap in riskCheck.ts and
//                  optionsRiskCheck.ts is denominated in.
//   premium        what the contract costs. Only optionsDisasterStopPct of it
//                  is at risk, so premium = risk dollars / maxLossFraction.
//
// So a rule quoted in PERCENT OF PREMIUM — the take-profit, the stop, the
// give-back arm — is NOT a multiple of R until it is divided by the loss
// fraction. At the live 60% take-profit and 70% disaster stop, a winner pays
// 0.857R, not 0.6R: a 43% understatement of the payoff if the two are
// compared directly.
//
// Both directions of the conversion live here, on top of one loss fraction,
// because the failure mode is silent. Nothing throws when a percent of premium
// is multiplied by a risk budget; the number is just wrong, always in the same
// direction, and only in the branch of code that happens to need it.
// ---------------------------------------------------------------------------

/** The share of premium the exit ladder actually puts at risk.
 *
 *  Fails SAFE: an absent, zero, or >= 100 disaster stop all mean "no enforced
 *  floor", so the whole premium is at risk (fraction 1). optionsRiskCheck.ts's
 *  single-leg sizing and the premium ceiling above both read THIS function
 *  rather than each keeping a copy of the branch — they used to keep two, with
 *  a comment on each saying the other must not diverge. */
export function optionsMaxLossFraction(disasterStopPct: number | undefined): number {
  return Number.isFinite(disasterStopPct) && disasterStopPct! > 0 && disasterStopPct! < 100
    ? disasterStopPct! / 100
    : 1;
}

/**
 * What an options winner pays per $1 of RISK — the R-multiple of a rule
 * written as a percent of premium.
 *
 * The equity book's reward multiple is already in R (`targetRMultiple`: the
 * target sits that many stop-distances away, and the sizer spends exactly one
 * stop-distance of budget). The options book's is not, and the finish-line
 * trim — which compares a payoff against dollars left to the daily bank line —
 * was handed `optionsTakeProfitPct / 100` straight, a percent of premium
 * measured against a budget denominated in risk. At 60/70 it read every
 * options winner as paying 0.6R when it pays 0.857R, so the trim stayed
 * inactive through the last third of its band and cut too little inside it:
 * a full-size options loser near the line gave back more of an almost-banked
 * day than the rule was written to allow.
 *
 * Give it the EFFECTIVE take-profit (regimeAdjustedTargets', tightened under a
 * High-Vol reading). The disaster stop is not tightened by the overlay, so the
 * ratio falls with the tighten, which is the intent.
 */
export function optionsRewardMultiple(takeProfitPct: number, disasterStopPct: number | undefined): number {
  if (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0) return 0;
  return takeProfitPct / (optionsMaxLossFraction(disasterStopPct) * 100);
}

/** The largest premium PER SHARE at which optionsRiskCheck's `quantity` rule
 *  can still size one contract. Returns 0 when no premium is affordable.
 *
 *  Fails SAFE exactly as optionsRiskCheck.ts does, through the one shared
 *  optionsMaxLossFraction() below. */
export function maxAffordablePremiumPerShare(input: AffordabilityInputs): number {
  const { equityUsd, riskPctUpperBound, disasterStopPct } = input;
  if (!Number.isFinite(equityUsd) || !Number.isFinite(riskPctUpperBound)) return 0;
  if (equityUsd <= 0 || riskPctUpperBound <= 0) return 0;
  const maxRiskDollars = (equityUsd * riskPctUpperBound) / 100;
  // * 100: an option contract is 100 shares, matching computeRiskSizing's
  // `multiplier` for assetType 'option'.
  return maxRiskDollars / (optionsMaxLossFraction(disasterStopPct) * 100);
}

/** The highest underlying price whose estimated ATM premium still fits the
 *  ceiling. Null when the ratio is unusable (<=0), which disables the filter
 *  rather than silently excluding everything — a zero ratio would otherwise
 *  divide to Infinity or drop the entire universe depending on rounding. */
export function maxAffordableUnderlyingPrice(input: AffordabilityInputs, atmPremiumRatioPct: number): number | null {
  if (!Number.isFinite(atmPremiumRatioPct) || atmPremiumRatioPct <= 0) return null;
  const ceiling = maxAffordablePremiumPerShare(input);
  if (ceiling <= 0) return null;
  return ceiling / (atmPremiumRatioPct / 100);
}

/** What the filter estimates a symbol's ATM short-dated premium to be. Linear
 *  in the underlying's price on purpose — see the header on why a low ratio is
 *  the conservative direction. */
export function estimateAtmPremiumPerShare(underlyingPrice: number, atmPremiumRatioPct: number): number {
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return 0;
  if (!Number.isFinite(atmPremiumRatioPct) || atmPremiumRatioPct <= 0) return 0;
  return underlyingPrice * (atmPremiumRatioPct / 100);
}

export interface DroppedUnderlying {
  symbol: string;
  underlyingPrice: number;
  estimatedPremiumPerShare: number;
  maxPremiumPerShare: number;
}

export interface AffordabilityFilterResult<T> {
  kept: T[];
  dropped: DroppedUnderlying[];
  /** The ceiling this pass used, so the journal can show the number rather
   *  than only the verdict. Null when the filter could not run and everything
   *  was kept. */
  maxPremiumPerShare: number | null;
  maxUnderlyingPrice: number | null;
}

/** Drop candidates whose estimated ATM premium cannot fit the per-order risk
 *  budget. A candidate with no usable price is KEPT — an unknown price is not
 *  evidence of unaffordability, and the real risk check will see the true
 *  premium anyway. */
export function filterAffordableUnderlyings<T extends Pick<ScreenCandidate, 'symbol' | 'price'>>(
  candidates: T[],
  input: AffordabilityInputs,
  atmPremiumRatioPct: number,
): AffordabilityFilterResult<T> {
  const maxPremium = maxAffordablePremiumPerShare(input);
  const maxPrice = maxAffordableUnderlyingPrice(input, atmPremiumRatioPct);
  if (maxPrice === null || maxPremium <= 0) {
    return { kept: candidates, dropped: [], maxPremiumPerShare: null, maxUnderlyingPrice: null };
  }
  const kept: T[] = [];
  const dropped: DroppedUnderlying[] = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.price) || c.price <= 0) {
      kept.push(c);
      continue;
    }
    const estimated = estimateAtmPremiumPerShare(c.price, atmPremiumRatioPct);
    if (estimated <= maxPremium) {
      kept.push(c);
    } else {
      dropped.push({
        symbol: c.symbol,
        underlyingPrice: c.price,
        estimatedPremiumPerShare: Math.round(estimated * 10000) / 10000,
        maxPremiumPerShare: Math.round(maxPremium * 10000) / 10000,
      });
    }
  }
  return {
    kept,
    dropped,
    maxPremiumPerShare: Math.round(maxPremium * 10000) / 10000,
    maxUnderlyingPrice: Math.round(maxPrice * 100) / 100,
  };
}

/** The largest risk % a cycle can size at, given the sizing leans that are
 *  allowed to scale UP. Six of effectiveRiskPct's seven factors are cuts
 *  (clamped to [0,1] by cutFactor) and cannot raise the bound; `method` can,
 *  and is clamped by expectancyMaxMultiplier — the SAME field methodSizing
 *  clamps with, read here rather than re-guessed. With method weighting off,
 *  nothing scales up and the configured risk % is already the bound. */
export function riskPctUpperBound(cfg: {
  riskPerTradePct: number;
  methodWeightingEnabled: boolean;
  expectancyMaxMultiplier: number;
}): number {
  const base = Number.isFinite(cfg.riskPerTradePct) && cfg.riskPerTradePct > 0 ? cfg.riskPerTradePct : 0;
  if (!cfg.methodWeightingEnabled) return base;
  const lean =
    Number.isFinite(cfg.expectancyMaxMultiplier) && cfg.expectancyMaxMultiplier > 1 ? cfg.expectancyMaxMultiplier : 1;
  return base * lean;
}
