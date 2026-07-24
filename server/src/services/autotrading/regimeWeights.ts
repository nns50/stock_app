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
import { RegimeLabel, classifyRegime } from '../marketRegime';
import { AutotradeConfig, RegimeWeightPresets } from '../../db/autotradeConfig';
import { Candle } from '../../providers/types';
import { sma, atr } from '../../indicators/indicators';

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

// --- Backtest support (2026-07-24) -----------------------------------------
// The backtest engines can't call the live async computeMarketRegime (it fetches
// live candles + a universe breadth scan). Instead they derive the regime per
// historical day from the proxy (SPY) series they already hold — a documented
// simplification: trend200/trend50/volatility only, BREADTH is omitted (no
// universe scan in a backtest), and trend200 reads `unknown` until 200 bars of
// proxy history exist. classifyRegime already treats every missing signal as
// unknown → 0, so the label degrades gracefully rather than faking a regime.

/**
 * The regime label as of `asOfIdx` in a proxy candle series, from the closes up
 * to and including that bar (no lookahead). null when there's no bar yet.
 * Breadth is passed as null — see the note above.
 */
export function regimeLabelFromProxy(proxyCandles: Candle[], asOfIdx: number): RegimeLabel | null {
  if (asOfIdx < 0 || asOfIdx >= proxyCandles.length) return null;
  const window = proxyCandles.slice(0, asOfIdx + 1);
  const closes = window.map((c) => c.close);
  const proxyClose = closes[closes.length - 1] ?? null;
  if (proxyClose === null) return null;
  const atrVal = atr(window, 14);
  return classifyRegime({
    proxySymbol: 'PROXY',
    proxyClose,
    proxySma50: sma(closes, 50),
    proxySma200: sma(closes, 200),
    marketAtrPct: atrVal !== null && proxyClose ? (atrVal / proxyClose) * 100 : null,
    breadthPct: null,
    breadthSampleSize: 0,
    asOf: 0,
  }).label;
}

/**
 * Backtest counterpart of resolveScoringWeights: the weight set to score with on
 * a given simulated day. `presets` null (feature off) or `regimeLabel` null ⇒
 * the run's own base weights unchanged. Otherwise the matching preset's six core
 * weights, with relativeStrength/sentiment kept from `baseWeights` — the same
 * "presets govern only the core six" rule the live path uses.
 */
export function backtestRegimeWeights(
  baseWeights: IndicatorWeights,
  presets: RegimeWeightPresets | null,
  regimeLabel: RegimeLabel | null,
): IndicatorWeights {
  if (!presets || !regimeLabel) return baseWeights;
  return {
    ...presets[REGIME_KEY[regimeLabel]],
    relativeStrength: baseWeights.relativeStrength,
    sentiment: baseWeights.sentiment,
  };
}
