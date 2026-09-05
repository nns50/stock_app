import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cutFactor,
  effectiveRiskPct,
  factorState,
  NEUTRAL,
  SizingFactors,
} from '../src/services/autotrading/effectiveRisk';

// ---------------------------------------------------------------------------
// The shared sizing-factor product (2026-09-05). riskCheck.ts and
// optionsRiskCheck.ts each carried their own copy of this multiplication.
// They agreed on the factors they shared and diverged on the rest, and an
// absent factor is invisible: the grade-expectancy multiplier applied to
// stocks and not to options for no recorded reason -- "simply never wired
// here" -- and nothing in the codebase could have said so.
//
// The type is the guard. Every SizingFactors field is required, so a new
// factor does not COMPILE until both books state what it does. These tests
// cover the arithmetic; the exhaustiveness is enforced by tsc, which is why
// `npm run typecheck` covering both workspaces matters here.
// ---------------------------------------------------------------------------

const none: SizingFactors = {
  stepDown: NEUTRAL,
  regime: NEUTRAL,
  equityCurveDerisk: NEUTRAL,
  expectancy: NEUTRAL,
  method: NEUTRAL,
  finishLine: NEUTRAL,
};

describe('effectiveRiskPct', () => {
  it('leaves the risk % alone when nothing is active', () => {
    expect(effectiveRiskPct(1.25, none)).toBe(1.25);
  });

  it('compounds every factor rather than taking the tightest', () => {
    // Two reasons to size down should BOTH apply. A max()/min() reading would
    // let a 50% cut swallow a 50% cut and size the position twice as large as
    // either rule intended.
    const both = effectiveRiskPct(1, { ...none, stepDown: 0.5, regime: 0.5 });
    expect(both).toBe(0.25);
    expect(both).toBeLessThan(effectiveRiskPct(1, { ...none, stepDown: 0.5 }));
  });

  it('applies every field — a factor the product forgets is a silent size bug', () => {
    // The defect this module exists to prevent, generalised: set each factor
    // to 0.5 alone and the result must halve. A field dropped from the product
    // shows up here rather than as a live position sized twice too big.
    for (const key of Object.keys(none) as (keyof SizingFactors)[]) {
      expect(effectiveRiskPct(2, { ...none, [key]: 0.5 })).toBe(1);
    }
  });

  it('never returns a negative risk %', () => {
    // A sizer multiplies by this. A negative budget flips a long into a short.
    expect(effectiveRiskPct(1, { ...none, method: -3 })).toBe(0);
    expect(effectiveRiskPct(-1, none)).toBe(0);
  });

  it('returns 0 rather than NaN when a factor is not a number', () => {
    expect(effectiveRiskPct(1, { ...none, expectancy: NaN })).toBe(0);
  });
});

describe('cutFactor', () => {
  it('is neutral when the cut is inactive, whatever the percentage says', () => {
    expect(cutFactor(false, 50)).toBe(NEUTRAL);
    expect(cutFactor(false, 100)).toBe(NEUTRAL);
  });

  it('turns an active cut % into its multiplier', () => {
    expect(cutFactor(true, 0)).toBe(1);
    expect(cutFactor(true, 40)).toBeCloseTo(0.6, 10);
    expect(cutFactor(true, 100)).toBe(0);
  });

  it('clamps out of range rather than trusting the route validator', () => {
    // The config route bounds these 0-100 today. This is the arithmetic that
    // decides how much real money enters a position, so it does not depend on
    // a validator two layers away staying that way: >100 would flip the sign
    // of the risk budget, and a negative cut would AMPLIFY risk -- the exact
    // opposite of what every caller is asking for.
    expect(cutFactor(true, 150)).toBe(0);
    expect(cutFactor(true, -50)).toBe(1);
    expect(cutFactor(true, NaN)).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// Source scan, in the spirit of configReachability.test.ts. The type system
// stops a factor from being FORGOTTEN by a book that uses SizingFactors; it
// cannot stop someone re-inlining `risk * (a ? 1 - x/100 : 1) * ...` beside it
// and going back to two copies that drift. This is the guard against that.
// ---------------------------------------------------------------------------
describe('both risk checks derive the risk % here and nowhere else', () => {
  const BOOKS = ['riskCheck.ts', 'optionsRiskCheck.ts'] as const;
  const src = (name: string) => readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', name), 'utf8');

  it.each(BOOKS)('%s calls the shared product', (name) => {
    expect(src(name)).toMatch(/computeEffectiveRiskPct\(/);
  });

  it.each(BOOKS)('%s does not multiply riskPerTradePct by hand', (name) => {
    // The exact shape both files used to carry: riskPerTradePct followed by a
    // chain of `*`. Anything matching is a second derivation of the same
    // quantity, which is what CLAUDE.md's "agree by construction" rule forbids.
    const body = src(name)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    expect(body).not.toMatch(/riskPerTradePct\s*\*/);
  });
});

// ---------------------------------------------------------------------------
// A trigger firing and a size actually changing are different facts. Found live
// on 2026-09-05: regimeAtrThresholdPct 3 with regimeSizeCutPct 0, so on a
// high-ATR day the risk check reported
//   regime_sizing: active — market ATR 3.5% exceeds 3%, sizing at 1.25% instead
//   of 1.25% (0% cut)
// Every word true and the headline wrong. Reading the FACTOR is what makes that
// impossible: a factor of exactly 1 changed nothing, whatever fired.
// ---------------------------------------------------------------------------
describe('factorState', () => {
  it('is inactive when nothing triggered, whatever the cut would have been', () => {
    expect(factorState(false, cutFactor(false, 50))).toBe('inactive');
    expect(factorState(false, cutFactor(false, 0))).toBe('inactive');
  });

  it('is active when something triggered AND the size moved', () => {
    expect(factorState(true, cutFactor(true, 50))).toBe('active');
  });

  it('separates a trigger that cut nothing — the live case', () => {
    expect(factorState(true, cutFactor(true, 0))).toBe('triggered-but-neutral');
  });

  it('reads a non-cut multiplier the same way', () => {
    // Expectancy and method arrive as multipliers rather than cut percentages.
    expect(factorState(true, 1)).toBe('triggered-but-neutral');
    expect(factorState(true, 1.12)).toBe('active');
    expect(factorState(true, 0.5)).toBe('active');
  });
});

describe('the risk checks never call a zero cut "active"', () => {
  const BOOKS = ['riskCheck.ts', 'optionsRiskCheck.ts'] as const;
  it.each(BOOKS)('%s derives its sizing status from factorState', (name) => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', name), 'utf8');
    expect(src).toMatch(/factorState\(/);
    // The old shape: a bare boolean choosing the word "active".
    expect(src).not.toMatch(/\n\s*(?:stepDownActive|regimeActive|equityCurveDeriskActive)\n\s*\?\s*`active/);
  });
});
