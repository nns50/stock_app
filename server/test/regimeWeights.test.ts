import { describe, it, expect } from 'vitest';
import { resolveScoringWeights } from '../src/services/autotrading/regimeWeights';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { defaultScreenerConfig } from '../src/indicators/screener';

const DEFAULTS = defaultScreenerConfig().weights;

describe('resolveScoringWeights', () => {
  it('returns the fixed default weights when regime-adaptive weighting is off', () => {
    const config = defaultAutotradeConfig();
    // A non-null regime label must be ignored while the feature is off.
    expect(resolveScoringWeights(config, 'risk-off')).toEqual(DEFAULTS);
  });

  it('returns the fixed default weights when enabled but no regime label is available', () => {
    const config = { ...defaultAutotradeConfig(), regimeAdaptiveWeightsEnabled: true };
    expect(resolveScoringWeights(config, null)).toEqual(DEFAULTS);
  });

  it('applies the matching per-regime preset when enabled', () => {
    const riskOff = { ...DEFAULTS, momentum: 5, trend: 40, rsi: 30 };
    const config = {
      ...defaultAutotradeConfig(),
      regimeAdaptiveWeightsEnabled: true,
      regimeWeightPresets: {
        riskOn: { ...DEFAULTS, momentum: 45 },
        neutral: { ...DEFAULTS },
        riskOff,
      },
    };
    expect(resolveScoringWeights(config, 'risk-off')).toEqual(riskOff);
    expect(resolveScoringWeights(config, 'risk-on').momentum).toBe(45);
    expect(resolveScoringWeights(config, 'neutral')).toEqual(DEFAULTS);
  });

  it('always layers relativeStrength/sentiment from their own config fields, over the preset', () => {
    const config = {
      ...defaultAutotradeConfig(),
      regimeAdaptiveWeightsEnabled: true,
      relativeStrengthWeight: 25,
      sentimentWeight: 12,
      regimeWeightPresets: {
        // Preset tries to set rel/sentiment — must be overridden by the fields.
        riskOn: { ...DEFAULTS, relativeStrength: 99, sentiment: 99 },
        neutral: { ...DEFAULTS },
        riskOff: { ...DEFAULTS },
      },
    };
    const w = resolveScoringWeights(config, 'risk-on');
    expect(w.relativeStrength).toBe(25);
    expect(w.sentiment).toBe(12);
  });

  it('carries relativeStrength/sentiment fields through even on the disabled path', () => {
    const config = { ...defaultAutotradeConfig(), relativeStrengthWeight: 20, sentimentWeight: 8 };
    const w = resolveScoringWeights(config, null);
    expect(w.relativeStrength).toBe(20);
    expect(w.sentiment).toBe(8);
    expect(w.momentum).toBe(DEFAULTS.momentum);
  });
});
