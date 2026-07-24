// Regime-conditional scoring weights (2026-07-24). Resolves which screener
// weight set the loop (and the manual preview) should score candidates with,
// given the current market regime.
//
// Default OFF: the resolver returns the fixed default weight set — byte-identical
// to what the loop scored with before this feature. When
// regimeAdaptiveWeightsEnabled is on and a regime label is available, it returns
// that regime's preset instead, so the strategy re-weights what it rewards to the
// environment the gauge already detects.
//
// relativeStrength / sentiment are ALWAYS layered on from their own dedicated
// config weight fields, in both the off and on paths — so those two settings are
// never silently dropped by a preset, and the presets only govern the six core
// weights (momentum, relativeVolume, rsi, volatility, gap, trend). Pure and
// DB-free so it's directly unit-testable.

import { IndicatorWeights, defaultScreenerConfig } from '../../indicators/screener';
import { RegimeLabel } from '../marketRegime';
import { AutotradeConfig } from '../../db/autotradeConfig';

/** Gauge label → the config's camelCase preset key. */
const REGIME_KEY: Record<RegimeLabel, 'riskOn' | 'neutral' | 'riskOff'> = {
  'risk-on': 'riskOn',
  neutral: 'neutral',
  'risk-off': 'riskOff',
};

/**
 * The screener weight set to score with. `regimeLabel` null (or the feature off)
 * ⇒ the fixed default weights (today's behavior). Otherwise the matching
 * per-regime preset, with relativeStrength/sentiment always taken from their own
 * config fields.
 */
export function resolveScoringWeights(config: AutotradeConfig, regimeLabel: RegimeLabel | null): IndicatorWeights {
  const base =
    config.regimeAdaptiveWeightsEnabled && regimeLabel
      ? config.regimeWeightPresets[REGIME_KEY[regimeLabel]]
      : defaultScreenerConfig().weights;
  return {
    ...base,
    relativeStrength: config.relativeStrengthWeight,
    sentiment: config.sentimentWeight,
  };
}
