import { describe, it, expect } from 'vitest';
import { computeRiskSizing } from '../src/services/riskSizing';
import {
  AffordabilityInputs,
  estimateAtmPremiumPerShare,
  filterAffordableUnderlyings,
  maxAffordablePremiumPerShare,
  maxAffordableUnderlyingPrice,
  optionsMaxLossFraction,
  optionsRewardMultiple,
  riskPctUpperBound,
} from '../src/services/autotrading/optionsAffordability';

/** The live book on 2026-09-09, the session task #59 was measured on. */
const LIVE: AffordabilityInputs = {
  equityUsd: 5137.44,
  riskPctUpperBound: 1.25,
  disasterStopPct: 70,
};

/** optionsRiskCheck.ts sizes a single leg exactly this way — entry at the
 *  premium, stop a disaster-stop fraction below it, option multiplier — and
 *  refuses when suggestedQuantity is 0. Calling the REAL sizer (not a copy of
 *  its formula) is the whole point of these tests: if computeRiskSizing's
 *  arithmetic changes, the inversion in optionsAffordability must fail here
 *  rather than quietly disagree in production. */
function contractsFor(premium: number, input: AffordabilityInputs): number {
  const disasterPct = input.disasterStopPct;
  const maxLossFraction = disasterPct > 0 && disasterPct < 100 ? disasterPct / 100 : 1;
  return computeRiskSizing({
    accountSize: input.equityUsd,
    riskPct: input.riskPctUpperBound,
    entryPrice: premium,
    stopPrice: Math.round(premium * (1 - maxLossFraction) * 10000) / 10000,
    assetType: 'option',
    side: 'long',
  }).suggestedQuantity;
}

/** The largest premium the REAL sizer still buys a contract at, found by
 *  bisection. optionsRiskCheck rounds its stop price to 4 decimals before
 *  handing it to computeRiskSizing, so the true boundary sits within a
 *  rounding tick of the analytic one rather than exactly on it — asserting
 *  equality to the cent is the honest claim, and it is still a real
 *  cross-check because the search only ever calls the sizer. */
function empiricalCeiling(input: AffordabilityInputs): number {
  let lo = 1e-6;
  let hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (contractsFor(mid, input) >= 1) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe('maxAffordablePremiumPerShare — agrees with the sizer by construction', () => {
  it('reproduces the ceiling measured on the live book', () => {
    // (5137.44 * 1.25 / 100) / 70 — the $0.919 read off the deployed config
    // during market hours on 2026-09-09.
    expect(maxAffordablePremiumPerShare(LIVE)).toBeCloseTo(0.9174, 4);
  });

  it('lands on the boundary the real sizer actually enforces', () => {
    expect(maxAffordablePremiumPerShare(LIVE)).toBeCloseTo(empiricalCeiling(LIVE), 2);
  });

  it('holds across a range of equities, risk percentages and disaster stops', () => {
    for (const equityUsd of [1000, 2500, 5137.44, 25000]) {
      for (const riskPct of [0.5, 1.25, 1.875, 3]) {
        for (const disasterStopPct of [25, 40, 70, 100]) {
          const input = { equityUsd, riskPctUpperBound: riskPct, disasterStopPct };
          const ceiling = maxAffordablePremiumPerShare(input);
          const label = `${equityUsd}/${riskPct}/${disasterStopPct}`;
          expect(ceiling, `ceiling at ${label}`).toBeCloseTo(empiricalCeiling(input), 2);
          // Clear of the rounding tick on either side, the verdicts are firm.
          expect(contractsFor(ceiling * 0.98, input), `affordable at ${label}`).toBeGreaterThanOrEqual(1);
          expect(contractsFor(ceiling * 1.02, input), `refused at ${label}`).toBe(0);
        }
      }
    }
  });

  it('treats an absent, zero or >=100 disaster stop as the whole premium, exactly as the risk check does', () => {
    const whole = maxAffordablePremiumPerShare({ ...LIVE, disasterStopPct: 100 });
    expect(maxAffordablePremiumPerShare({ ...LIVE, disasterStopPct: 0 })).toBe(whole);
    expect(maxAffordablePremiumPerShare({ ...LIVE, disasterStopPct: 250 })).toBe(whole);
    expect(contractsFor(whole, { ...LIVE, disasterStopPct: 0 })).toBeGreaterThanOrEqual(1);
  });

  it('affords nothing when equity or risk is zero, rather than dividing to Infinity', () => {
    expect(maxAffordablePremiumPerShare({ ...LIVE, equityUsd: 0 })).toBe(0);
    expect(maxAffordablePremiumPerShare({ ...LIVE, riskPctUpperBound: 0 })).toBe(0);
    expect(maxAffordableUnderlyingPrice({ ...LIVE, equityUsd: 0 }, 1)).toBeNull();
  });
});

describe('riskPctUpperBound — the method lean can scale UP, so the config % is not a bound', () => {
  const cfg = { riskPerTradePct: 1.25, methodWeightingEnabled: true, expectancyMaxMultiplier: 1.5 };

  it('multiplies by expectancyMaxMultiplier when method weighting is on', () => {
    expect(riskPctUpperBound(cfg)).toBeCloseTo(1.875, 6);
  });

  it('is the configured percentage when method weighting is off', () => {
    expect(riskPctUpperBound({ ...cfg, methodWeightingEnabled: false })).toBe(1.25);
  });

  it('never returns less than the configured percentage — a lean below 1 is a cut, and cuts are handled elsewhere', () => {
    expect(riskPctUpperBound({ ...cfg, expectancyMaxMultiplier: 0.5 })).toBe(1.25);
  });

  it('bounds the real sizer: a premium the bound affords is never refused at the configured risk %... unless cut', () => {
    // The bound must be >= what the effective risk could reach, so a contract
    // affordable under the CONFIGURED % is always affordable under the bound.
    const bounded = maxAffordablePremiumPerShare({ ...LIVE, riskPctUpperBound: riskPctUpperBound(cfg) });
    const configured = maxAffordablePremiumPerShare({ ...LIVE, riskPctUpperBound: cfg.riskPerTradePct });
    expect(bounded).toBeGreaterThan(configured);
  });
});

describe('filterAffordableUnderlyings — the consumer-visible verdict', () => {
  // The five contracts actually priced during market hours on 2026-09-09.
  const measured = [
    { symbol: 'RIOT', price: 21.91, realPremium: 0.38 },
    { symbol: 'SMCI', price: 39.08, realPremium: 0.6 },
    { symbol: 'HOOD', price: 116.46, realPremium: 1.65 },
    { symbol: 'COIN', price: 177.99, realPremium: 2.64 },
    { symbol: 'META', price: 650.81, realPremium: 3.08 },
  ];
  const candidates = measured.map(({ symbol, price }) => ({ symbol, price }));

  it('keeps the two names that really were affordable and drops the rest', () => {
    const { kept, dropped } = filterAffordableUnderlyings(candidates, LIVE, 1);
    expect(kept.map((c) => c.symbol)).toEqual(['RIOT', 'SMCI']);
    expect(dropped.map((d) => d.symbol)).toEqual(['HOOD', 'COIN', 'META']);
  });

  it('NEVER drops a candidate whose real premium the sizer would have afforded', () => {
    // The property that makes this filter safe: every symbol it drops was one
    // the sizer would have refused anyway. Over-keeping is the tolerable
    // direction (the real risk check still refuses those); over-dropping would
    // silently cost a trade, and must never happen.
    const { dropped } = filterAffordableUnderlyings(candidates, LIVE, 1);
    for (const d of dropped) {
      const real = measured.find((m) => m.symbol === d.symbol)!.realPremium;
      expect(contractsFor(real, LIVE), `${d.symbol} was dropped but the sizer affords it`).toBe(0);
    }
  });

  it('a higher assumed ratio is stricter, a lower one more permissive', () => {
    const strict = filterAffordableUnderlyings(candidates, LIVE, 2).kept.map((c) => c.symbol);
    const loose = filterAffordableUnderlyings(candidates, LIVE, 0.4).kept.map((c) => c.symbol);
    expect(strict).toEqual(['RIOT', 'SMCI']);
    expect(loose).toEqual(['RIOT', 'SMCI', 'HOOD', 'COIN']);
  });

  it('reports the ceiling it used, not just the verdict', () => {
    const res = filterAffordableUnderlyings(candidates, LIVE, 1);
    expect(res.maxPremiumPerShare).toBeCloseTo(0.9174, 4);
    expect(res.maxUnderlyingPrice).toBeCloseTo(91.74, 2);
    expect(res.dropped[0]).toMatchObject({ symbol: 'HOOD', underlyingPrice: 116.46 });
  });

  it('keeps everything, and says so, when the ratio is unusable', () => {
    for (const ratio of [0, -1, Number.NaN]) {
      const res = filterAffordableUnderlyings(candidates, LIVE, ratio);
      expect(res.kept).toHaveLength(candidates.length);
      expect(res.dropped).toEqual([]);
      expect(res.maxPremiumPerShare).toBeNull();
      expect(res.maxUnderlyingPrice).toBeNull();
    }
  });

  it('keeps a candidate with no usable price — an unknown price is not evidence of anything', () => {
    const odd = [
      { symbol: 'NOPRICE', price: 0 },
      { symbol: 'NEGATIVE', price: -5 },
      { symbol: 'NAN', price: Number.NaN },
    ];
    const { kept, dropped } = filterAffordableUnderlyings(odd, LIVE, 1);
    expect(kept.map((c) => c.symbol)).toEqual(['NOPRICE', 'NEGATIVE', 'NAN']);
    expect(dropped).toEqual([]);
  });

  it('estimates premium linearly in the underlying price', () => {
    expect(estimateAtmPremiumPerShare(100, 1.5)).toBeCloseTo(1.5, 6);
    expect(estimateAtmPremiumPerShare(0, 1.5)).toBe(0);
    expect(estimateAtmPremiumPerShare(100, 0)).toBe(0);
  });

  it('widens on its own as the account grows — the ceiling is equity-scaled, not a constant', () => {
    const small = maxAffordableUnderlyingPrice({ ...LIVE, equityUsd: 2300 }, 1);
    const large = maxAffordableUnderlyingPrice({ ...LIVE, equityUsd: 25000 }, 1);
    expect(small).not.toBeNull();
    expect(large!).toBeGreaterThan(small!);
    // At $25k, COIN's $177.99 underlying comes into range without any config
    // change at all.
    expect(
      filterAffordableUnderlyings(candidates, { ...LIVE, equityUsd: 25000 }, 1).kept.map((c) => c.symbol),
    ).toContain('COIN');
  });
});

// ---------------------------------------------------------------------------
// optionsRewardMultiple — the finish-line trim's payoff, in the trim's units
//
// ASSERTED AT THE CONSUMER, not at the formula. computeFinishLineFactor takes
// `equity x riskPerTradePct/100` as one full unit of risk and multiplies it by
// `rewardMultiple` to get what a winner pays. So the test that matters is not
// "does the ratio equal 60/70" — it is "does the number the trim computes
// equal the dollars the real sizer and the real take-profit actually produce".
// That is the assertion the old line (`optionsTakeProfitPct / 100`) fails, and
// it fails by the whole disaster-stop fraction: 0.6R where the trade pays
// 0.857R.
// ---------------------------------------------------------------------------
describe('optionsRewardMultiple — a percent of PREMIUM is not a multiple of R', () => {
  /** What a take-profit fill really pays, in dollars, sized by the real sizer. */
  function realWinUsd(premium: number, input: AffordabilityInputs, takeProfitPct: number): number {
    const contracts = contractsFor(premium, input);
    return contracts * 100 * premium * (takeProfitPct / 100);
  }
  /** What computeFinishLineFactor believes a full-size win pays. */
  function trimWinUsd(input: AffordabilityInputs, takeProfitPct: number): number {
    const fullRiskUsd = input.equityUsd * (input.riskPctUpperBound / 100);
    return fullRiskUsd * optionsRewardMultiple(takeProfitPct, input.disasterStopPct);
  }

  it('is the take-profit over the disaster stop, not the take-profit over 100', () => {
    expect(optionsRewardMultiple(60, 70)).toBeCloseTo(0.857, 3);
    expect(optionsRewardMultiple(60, 70)).not.toBeCloseTo(0.6, 3);
  });

  it('matches what the REAL sizer plus the REAL take-profit pay, across equities and stops', () => {
    const cases: { input: AffordabilityInputs; premium: number; tp: number }[] = [
      { input: { equityUsd: 5137.44, riskPctUpperBound: 2.5, disasterStopPct: 70 }, premium: 0.9, tp: 60 },
      { input: { equityUsd: 25_000, riskPctUpperBound: 2.5, disasterStopPct: 70 }, premium: 1.47, tp: 60 },
      { input: { equityUsd: 25_000, riskPctUpperBound: 1.25, disasterStopPct: 50 }, premium: 0.5, tp: 80 },
      { input: { equityUsd: 100_000, riskPctUpperBound: 2, disasterStopPct: 40 }, premium: 2.35, tp: 100 },
    ];
    for (const { input, premium, tp } of cases) {
      const real = realWinUsd(premium, input, tp);
      // Integer contracts round the sized position DOWN, so the real payoff sits
      // at or just under the trim's continuous figure — never above it, and
      // never by more than one contract's worth of take-profit.
      const oneContract = 100 * premium * (tp / 100);
      expect(real).toBeLessThanOrEqual(trimWinUsd(input, tp) + 1e-6);
      expect(real).toBeGreaterThan(trimWinUsd(input, tp) - oneContract);
      // …and the old basis (a percent of premium, taken straight) under-states
      // the real payoff every time, by exactly the disaster-stop fraction. It
      // is not a rounding difference: it is the missing unit conversion.
      const oldBasis = input.equityUsd * (input.riskPctUpperBound / 100) * (tp / 100);
      expect(oldBasis).toBeLessThan(real);
      expect(oldBasis).toBeCloseTo(trimWinUsd(input, tp) * optionsMaxLossFraction(input.disasterStopPct), 6);
    }
  });

  it('falls back to a percent of premium exactly when the disaster stop is off', () => {
    for (const off of [undefined, 0, 100, 150, Number.NaN]) {
      expect(optionsRewardMultiple(60, off)).toBeCloseTo(0.6, 10);
      expect(optionsMaxLossFraction(off)).toBe(1);
    }
  });

  it('falls with the regime tighten, because the disaster stop does not tighten with it', () => {
    // regimeAdjustedTargets multiplies the take-profit by (1 - tighten/100).
    expect(optionsRewardMultiple(60 * 0.85, 70)).toBeCloseTo(0.729, 3);
    expect(optionsRewardMultiple(60 * 0.85, 70)).toBeLessThan(optionsRewardMultiple(60, 70));
  });

  it('is 0, never Infinity or NaN, for a take-profit that is unset or nonsense', () => {
    for (const tp of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(optionsRewardMultiple(tp, 70)).toBe(0);
    }
  });
});
