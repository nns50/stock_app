import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_TARGET_FACTOR,
  regimeAdjustedTargets,
  regimeTargetFactor,
  withRegimeAdjustedTargets,
} from '../src/services/autotrading/regimeTargets';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';

// ---------------------------------------------------------------------------
// The regime target tighten (2026-09-08): one helper, three consumers. The
// arithmetic here; the consumers (decide's target, the finish line's reward
// multiple, the options exit rules) are asserted in their own files, and the
// scans at the bottom pin that they go through THIS helper and not a copy.
// ---------------------------------------------------------------------------
const on = { mlRegimeEnabled: true, mlRegimeTargetTightenPct: 30, targetRMultiple: 2, optionsTakeProfitPct: 60 };

describe('regimeAdjustedTargets', () => {
  it('tightens both targets by the same factor in High Vol with the overlay on', () => {
    expect(regimeAdjustedTargets(on, 'high_vol_bearish')).toEqual({
      targetRMultiple: 1.4,
      optionsTakeProfitPct: 42,
      tightened: true,
      factor: 0.7,
    });
  });

  it('changes nothing with the overlay off, in a calm regime, or on an unknown/null reading', () => {
    const untouched = { targetRMultiple: 2, optionsTakeProfitPct: 60, tightened: false, factor: 1 };
    expect(regimeAdjustedTargets({ ...on, mlRegimeEnabled: false }, 'high_vol_bearish')).toEqual(untouched);
    for (const r of ['sideways', 'low_vol_bullish', 'unknown', null, undefined]) {
      expect(regimeAdjustedTargets(on, r), String(r)).toEqual(untouched);
    }
  });

  it('a tighten of 0 is no tighten; 100 (or more) is clamped to a 0.1× target, never 0R', () => {
    expect(regimeAdjustedTargets({ ...on, mlRegimeTargetTightenPct: 0 }, 'high_vol_bearish').factor).toBe(1);
    const floor = regimeAdjustedTargets({ ...on, mlRegimeTargetTightenPct: 100 }, 'high_vol_bearish');
    expect(floor.factor).toBe(MIN_TARGET_FACTOR);
    expect(floor.targetRMultiple).toBeCloseTo(0.2, 10);
    expect(regimeAdjustedTargets({ ...on, mlRegimeTargetTightenPct: 150 }, 'high_vol_bearish').factor).toBe(
      MIN_TARGET_FACTOR,
    );
    expect(regimeAdjustedTargets({ ...on, mlRegimeTargetTightenPct: NaN }, 'high_vol_bearish').factor).toBe(1);
  });

  it('a 0% options take-profit stays 0 (off) — the tighten cannot switch a rule on', () => {
    expect(regimeAdjustedTargets({ ...on, optionsTakeProfitPct: 0 }, 'high_vol_bearish').optionsTakeProfitPct).toBe(0);
  });

  it('regimeTargetFactor alone reads the same way', () => {
    expect(regimeTargetFactor(on, 'high_vol_bearish')).toBe(0.7);
    expect(regimeTargetFactor(on, 'sideways')).toBe(1);
  });

  it('the shipped default is 30, and it ships behind the (off) overlay switch', () => {
    const d = defaultAutotradeConfig();
    expect(d.mlRegimeTargetTightenPct).toBe(30);
    expect(d.mlRegimeEnabled).toBe(false);
    expect(regimeAdjustedTargets(d, 'high_vol_bearish').factor).toBe(1);
  });
});

describe('withRegimeAdjustedTargets', () => {
  it('returns a config with both targets tightened, and the SAME object when nothing is', () => {
    const cfg = { ...on, other: 'kept' };
    const tight = withRegimeAdjustedTargets(cfg, 'high_vol_bearish');
    expect(tight).toMatchObject({ targetRMultiple: 1.4, optionsTakeProfitPct: 42, other: 'kept' });
    expect(withRegimeAdjustedTargets(cfg, 'sideways')).toBe(cfg);
    expect(withRegimeAdjustedTargets({ ...cfg, mlRegimeEnabled: false }, 'high_vol_bearish').targetRMultiple).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The consumers go through the helper. A hand-rolled `cfg.targetRMultiple *
// 0.7` beside it would agree today and drift tomorrow.
// ---------------------------------------------------------------------------
describe('every consumer reads the helper', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

  it('the loop and the /decide preview build the decide target from regimeAdjustedTargets', () => {
    expect(src('services/autotrading/loop.ts')).toMatch(/targetRMultiple:\s*regimeAdjustedTargets\(/);
    expect(src('routes/autotrade.ts')).toMatch(/targetRMultiple:\s*regimeAdjustedTargets\(/);
  });

  it.each(['services/autotrading/optionsExecute.ts', 'services/autotrading/liveOptionsExecute.ts'])(
    '%s exits on the target tightened for the regime STAMPED on the position',
    (rel) => {
      const body = src(rel);
      expect(body).toMatch(/withRegimeAdjustedTargets\((cfg|freshCfg), pos\.mlRegime\)/);
      // The %-of-premium take-profit reads the tightened copy, not the raw config.
      expect(body).toMatch(/takeProfitPct:[^\n]*exitCfg\.optionsTakeProfitPct/);
      expect(body).not.toMatch(/takeProfitPct:[^\n]*:\s*(cfg|freshCfg)\.optionsTakeProfitPct/);
      // And the short-dated ladder is handed that same copy.
      expect(body).toMatch(/evaluateShortDatedExit\([\s\S]{0,400}?exitCfg,/);
    },
  );

  it.each([
    'services/autotrading/execute.ts',
    'services/autotrading/optionsExecute.ts',
    'services/autotrading/liveExecute.ts',
    'services/autotrading/liveOptionsExecute.ts',
  ])('%s stamps the factor the helper returns for the tick', (rel) => {
    expect(src(rel)).toMatch(/regimeAdjustedTargets\((config|freshCfg), regime\.effectiveRegime\)\.factor/);
  });
});
