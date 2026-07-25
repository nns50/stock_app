import { describe, it, expect } from 'vitest';
import {
  resolveScoringWeights,
  regimeLabelFromProxy,
  backtestRegimeWeights,
} from '../src/services/autotrading/regimeWeights';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { defaultScreenerConfig } from '../src/indicators/screener';
import { Candle } from '../src/providers/types';

const DEFAULTS = defaultScreenerConfig().weights;

// A 210-bar proxy series (enough for the 200-day SMA) with a controllable trend
// and daily range, so the proxy-derived regime is deterministic.
function proxySeries(kind: 'up-calm' | 'down-stressed' | 'flat-mid'): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < 210; i++) {
    let close: number;
    let range: number;
    if (kind === 'up-calm') {
      close = 100 + i * 0.5; // steadily rising → price well above both SMAs
      range = 1; // ~<1% ATR at these prices → calm
    } else if (kind === 'down-stressed') {
      close = 205 - i * 0.5; // steadily falling → price below both SMAs
      range = 10; // large daily swings → high ATR% → stressed
    } else {
      close = 100; // flat → price ≈ both SMAs (neutral trend)
      range = 3; // ~3% ATR → neutral volatility band
    }
    bars.push({ time: i * 86_400_000, open: close, high: close + range / 2, low: close - range / 2, close, volume: 1 });
  }
  return bars;
}

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

describe('regimeLabelFromProxy (backtest proxy-derived regime)', () => {
  it('reads a rising, calm proxy as risk-on', () => {
    const s = proxySeries('up-calm');
    expect(regimeLabelFromProxy(s, s.length - 1)).toBe('risk-on');
  });

  it('reads a falling, high-volatility proxy as risk-off', () => {
    const s = proxySeries('down-stressed');
    expect(regimeLabelFromProxy(s, s.length - 1)).toBe('risk-off');
  });

  it('reads a flat, mid-volatility proxy as neutral', () => {
    const s = proxySeries('flat-mid');
    expect(regimeLabelFromProxy(s, s.length - 1)).toBe('neutral');
  });

  it('classifies from the closes UP TO asOfIdx only (no lookahead)', () => {
    // A series that falls then rises: early on (index 100, still in the decline)
    // it must not "see" the later recovery.
    const bars: Candle[] = [];
    for (let i = 0; i < 210; i++) {
      const close = i < 120 ? 205 - i * 0.5 : 145 + (i - 120) * 0.5;
      bars.push({ time: i * 86_400_000, open: close, high: close + 5, low: close - 5, close, volume: 1 });
    }
    // As of the decline, it should not read risk-on despite the later rally.
    expect(regimeLabelFromProxy(bars, 100)).not.toBe('risk-on');
  });

  it('returns null when there is no bar as of the index', () => {
    expect(regimeLabelFromProxy(proxySeries('flat-mid'), -1)).toBeNull();
  });
});

describe('backtestRegimeWeights', () => {
  const base = { ...DEFAULTS, relativeStrength: 25, sentiment: 12 };

  it('returns the base weights unchanged when presets are null (feature off)', () => {
    expect(backtestRegimeWeights(base, null, 'risk-off')).toEqual(base);
  });

  it('returns the base weights unchanged when there is no regime label', () => {
    const presets = { riskOn: DEFAULTS, neutral: DEFAULTS, riskOff: { ...DEFAULTS, momentum: 5 } };
    expect(backtestRegimeWeights(base, presets, null)).toEqual(base);
  });

  it('applies the matching preset core, keeping relativeStrength/sentiment from the base', () => {
    const riskOff = { ...DEFAULTS, momentum: 5, trend: 40 };
    const presets = { riskOn: DEFAULTS, neutral: DEFAULTS, riskOff };
    const w = backtestRegimeWeights(base, presets, 'risk-off');
    expect(w.momentum).toBe(5);
    expect(w.trend).toBe(40);
    // rel/sentiment come from the base, NOT the preset:
    expect(w.relativeStrength).toBe(25);
    expect(w.sentiment).toBe(12);
  });
});
