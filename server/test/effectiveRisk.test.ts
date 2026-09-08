import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cutFactor,
  effectiveRiskPct,
  factorState,
  NEUTRAL,
  NO_TICK_REGIME,
  RegimeTriggerInputs,
  regimeStamp,
  regimeTriggers,
  SizingFactors,
} from '../src/services/autotrading/effectiveRisk';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';

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

// ---------------------------------------------------------------------------
// The regime factor's three triggers (2026-09-08). Explicit values throughout,
// never the defaults, so the truth table reads without the config in view:
// ATR cut 40 / ML cut 35 on a calm 0.9% ATR morning.
// ---------------------------------------------------------------------------
const calm: RegimeTriggerInputs = {
  marketAtrPct: 0.9,
  regimeAtrThresholdPct: 3,
  regimeSizeCutPct: 40,
  mlRegime: null,
  mlRegimeEnabled: true,
  mlRegimeSizeCutPct: 35,
  todayRangePct: null,
  regimeShockRangeRatio: 0,
};

describe('regimeTriggers — three triggers, one cut', () => {
  it('ATR alone: the ATR cut (40 → 0.6); the effective regime is whatever the model read', () => {
    const t = regimeTriggers({ ...calm, marketAtrPct: 6, mlRegime: 'sideways' });
    expect(t).toMatchObject({
      atr: true,
      ml: false,
      shock: false,
      triggered: true,
      cutPct: 40,
      skip: false,
      effectiveRegime: 'sideways',
    });
    expect(t.factor).toBeCloseTo(0.6, 10);
    expect(t.detail).toMatch(/market ATR 6\.0% exceeds 3%/);
    expect(t.detail).toMatch(/40% cut/);
  });

  it('ML alone: the ML cut (35 → 0.65), the ATR trigger named inactive', () => {
    const t = regimeTriggers({ ...calm, mlRegime: 'high_vol_bearish' });
    expect(t).toMatchObject({
      atr: false,
      ml: true,
      shock: false,
      triggered: true,
      cutPct: 35,
      effectiveRegime: 'high_vol_bearish',
    });
    expect(t.factor).toBeCloseTo(0.65, 10);
    expect(t.detail).toBe('ML regime High Volatility/Bearish (35% cut; ATR trigger inactive at 0.9%)');
  });

  it('both: the DEEPER cut once — ATR 40 + ML 35 is 40, never 0.39', () => {
    const t = regimeTriggers({ ...calm, marketAtrPct: 6, mlRegime: 'high_vol_bearish' });
    expect(t.cutPct).toBe(40);
    expect(t.factor).toBeCloseTo(0.6, 10);
    expect(Math.abs(t.factor - 0.6 * 0.65)).toBeGreaterThan(0.1);
    expect(t.detail).toMatch(/deeper of ATR 40% \/ ML 35%, never both/);
    // And the other way round: ATR 40 + ML 50 is 50, not 0.3.
    const deeperMl = regimeTriggers({ ...calm, marketAtrPct: 6, mlRegime: 'high_vol_bearish', mlRegimeSizeCutPct: 50 });
    expect(deeperMl.cutPct).toBe(50);
    expect(deeperMl.factor).toBeCloseTo(0.5, 10);
  });

  it('neither: neutral, and the inactive line names both triggers', () => {
    const t = regimeTriggers({ ...calm, mlRegime: 'sideways' });
    expect(t).toMatchObject({ triggered: false, cutPct: 0, skip: false, factor: NEUTRAL, effectiveRegime: 'sideways' });
    expect(t.detail).toBe(
      'market ATR 0.9% (triggers above 3%); ML regime Sideways — cuts only in High Volatility/Bearish',
    );
  });

  it('the overlay OFF leaves only the ATR path, whatever the model reads or the tape does', () => {
    const off = regimeTriggers({
      ...calm,
      mlRegimeEnabled: false,
      mlRegime: 'high_vol_bearish',
      todayRangePct: 9,
      regimeShockRangeRatio: 1.5,
    });
    expect(off).toMatchObject({ ml: false, shock: false, triggered: false, factor: NEUTRAL });
    // The stamp still carries the model's reading when the overlay is off.
    expect(off.effectiveRegime).toBe('high_vol_bearish');
    expect(off.detail).toMatch(/overlay off/);
    const offAtr = regimeTriggers({ ...calm, mlRegimeEnabled: false, mlRegime: 'high_vol_bearish', marketAtrPct: 6 });
    expect(offAtr).toMatchObject({ atr: true, ml: false, cutPct: 40 });
  });

  it('only High Volatility/Bearish is an ML trigger; unknown, null and the calm states are not', () => {
    for (const r of ['unknown', 'sideways', 'low_vol_bullish', null, undefined] as const) {
      const t = regimeTriggers({ ...calm, mlRegime: r });
      expect(t.ml, String(r)).toBe(false);
      expect(t.factor, String(r)).toBe(NEUTRAL);
      expect(t.effectiveRegime, String(r)).toBe(r ?? 'unknown');
    }
    expect(regimeTriggers({ ...calm, mlRegime: null }).detail).toMatch(
      /ML regime unknown \(stale or unavailable — no cut\)/,
    );
  });

  it('both cuts at 0: triggered but neutral, never "active"', () => {
    const t = regimeTriggers({
      ...calm,
      marketAtrPct: 6,
      mlRegime: 'high_vol_bearish',
      regimeSizeCutPct: 0,
      mlRegimeSizeCutPct: 0,
    });
    expect(t.triggered).toBe(true);
    expect(t.factor).toBe(NEUTRAL);
    expect(factorState(t.triggered, t.factor)).toBe('triggered-but-neutral');
  });

  it('the shipped defaults: overlay off, cut 35, nowcast off — a silent change to any fails here', () => {
    const d = defaultAutotradeConfig();
    expect(d.mlRegimeEnabled).toBe(false);
    expect(d.mlRegimeSizeCutPct).toBe(35);
    expect(d.mlRegimeSwitchThreshold).toBe(0.6);
    expect(d.regimeShockRangeRatio).toBe(0);
  });

  describe('the shock nowcast', () => {
    const shockDay: RegimeTriggerInputs = {
      ...calm,
      marketAtrPct: 1,
      todayRangePct: 3.2,
      regimeShockRangeRatio: 1.5,
      mlRegime: 'sideways',
    };

    it('a range at or above ratio × ATR promotes the tick to High Vol while the model reads Sideways', () => {
      const t = regimeTriggers(shockDay);
      expect(t).toMatchObject({
        atr: false,
        ml: false,
        shock: true,
        triggered: true,
        cutPct: 35,
        effectiveRegime: 'high_vol_bearish',
      });
      expect(t.factor).toBeCloseTo(0.65, 10);
      expect(t.detail).toBe(
        'shock day: SPY range 3.2% ≥ 1.5 × ATR 1.0% (35% cut; ATR trigger inactive at 1.0%; model reads Sideways)',
      );
      expect(regimeTriggers({ ...shockDay, todayRangePct: 1.5 }).shock).toBe(true); // exactly at the line
    });

    it('a ratio of 0 never fires; nor does an ordinary range, an unknown range or an unknown ATR', () => {
      expect(regimeTriggers({ ...shockDay, regimeShockRangeRatio: 0 }).shock).toBe(false);
      expect(regimeTriggers({ ...shockDay, todayRangePct: 1.4 }).shock).toBe(false);
      expect(regimeTriggers({ ...shockDay, todayRangePct: null }).shock).toBe(false);
      expect(regimeTriggers({ ...shockDay, marketAtrPct: null }).shock).toBe(false);
      expect(regimeTriggers({ ...shockDay, marketAtrPct: 0 }).shock).toBe(false);
      const quiet = regimeTriggers({ ...shockDay, todayRangePct: 1.4 });
      expect(quiet.effectiveRegime).toBe('sideways');
      expect(quiet.detail).toMatch(/SPY range 1\.4% below 1\.5 × ATR/);
    });

    it('shock + ML is one cut, not two; the overlay off is no shock', () => {
      const both = regimeTriggers({ ...shockDay, mlRegime: 'high_vol_bearish' });
      expect(both).toMatchObject({ ml: true, shock: true, cutPct: 35 });
      expect(both.factor).toBeCloseTo(0.65, 10);
      expect(regimeTriggers({ ...shockDay, mlRegimeEnabled: false }).shock).toBe(false);
    });
  });

  describe('skip — a cut of 100', () => {
    it('is a skip with factor 0, from either cut', () => {
      const ml = regimeTriggers({ ...calm, mlRegime: 'high_vol_bearish', mlRegimeSizeCutPct: 100 });
      expect(ml).toMatchObject({ skip: true, factor: 0, cutPct: 100 });
      const atr = regimeTriggers({ ...calm, marketAtrPct: 6, regimeSizeCutPct: 100, mlRegime: 'sideways' });
      expect(atr).toMatchObject({ skip: true, factor: 0 });
    });

    it('a cut of 100 that did not trigger is nothing', () => {
      expect(regimeTriggers({ ...calm, mlRegime: 'sideways', mlRegimeSizeCutPct: 100 })).toMatchObject({
        skip: false,
        factor: NEUTRAL,
      });
    });

    it('clamps an out-of-range cut instead of trusting the validator', () => {
      expect(regimeTriggers({ ...calm, mlRegime: 'high_vol_bearish', mlRegimeSizeCutPct: 150 }).skip).toBe(true);
      expect(regimeTriggers({ ...calm, mlRegime: 'high_vol_bearish', mlRegimeSizeCutPct: -20 }).factor).toBe(NEUTRAL);
      expect(regimeTriggers({ ...calm, mlRegime: 'high_vol_bearish', mlRegimeSizeCutPct: NaN }).factor).toBe(NEUTRAL);
    });
  });
});

describe('regimeStamp', () => {
  it('stamps the effective regime, null for unknown — never a guess', () => {
    expect(regimeStamp(NO_TICK_REGIME)).toBeNull();
    expect(regimeStamp({ mlRegime: 'sideways', todayRangePct: 3.2, effectiveRegime: 'high_vol_bearish' })).toBe(
      'high_vol_bearish',
    );
  });
});

// ---------------------------------------------------------------------------
// One derivation of the regime. The type system makes every context builder
// state the five inputs; it cannot stop a book from deciding the regime by
// hand beside them. These scans can.
// ---------------------------------------------------------------------------
describe('one derivation of the regime', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', rel), 'utf8');

  it.each(['riskCheck.ts', 'optionsRiskCheck.ts'])(
    '%s sizes through regimeTriggers, never isRegimeActive directly',
    (name) => {
      const body = src(name);
      expect(body).toMatch(/regimeTriggers\(/);
      expect(body).not.toMatch(/isRegimeActive\(/);
    },
  );

  it("loop.ts derives the tick's effective regime from regimeTriggers and hands it to all four executors", () => {
    const body = src('loop.ts');
    expect(body).toMatch(/effectiveRegime: triggers\.effectiveRegime/);
    expect(body.match(/effectiveRegime:/g)).toHaveLength(1);
    expect(body.match(/\n\s+tickRegime,\n/g)).toHaveLength(4);
  });

  it.each(['execute.ts', 'optionsExecute.ts', 'liveExecute.ts', 'liveOptionsExecute.ts'])(
    '%s stamps regimeStamp(regime) and derives no regime of its own',
    (name) => {
      const body = src(name);
      expect(body).toMatch(/regimeStamp\(regime\)/);
      expect(body).not.toMatch(/regimeTriggers\(/);
    },
  );
});
