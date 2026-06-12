import { Candle, Quote } from '../providers/types';
import {
  atrSeries,
  distanceFromMa,
  gapPercent,
  latest,
  meanOfLast,
  percentChange,
  relativeVolume,
  rsiSeries,
  smaSeries,
} from './indicators';

// ---------------------------------------------------------------------------
// Transparent, configurable scoring engine.
//
// Design goals (from the spec): "No black boxes — every score must be
// explainable from its components." So each indicator produces a normalized
// 0..100 sub-score, multiplied by its weight; the total is the weighted average
// (also 0..100). The full breakdown (raw value, sub-score, weight, contribution,
// and a human note) travels with every result.
// ---------------------------------------------------------------------------

export type Direction = 'long' | 'short';

export type IndicatorKey = 'momentum' | 'relativeVolume' | 'rsi' | 'volatility' | 'gap' | 'trend';

export type IndicatorWeights = Record<IndicatorKey, number>;

export interface ScreenerFilters {
  minPrice?: number;
  maxPrice?: number;
  minAvgVolume?: number;
  minRelVol?: number;
  rsiMin?: number;
  rsiMax?: number;
  /** Require price to align with the chosen direction relative to its MAs. */
  requireTrendAlignment?: boolean;
}

export interface ScreenerConfig {
  direction: Direction;
  weights: IndicatorWeights;
  maShort: number;
  maLong: number;
  rsiPeriod: number;
  atrPeriod: number;
  /** % move that maps to a full momentum sub-score. */
  momentumScale: number;
  /** Relative volume that maps to a full rel-vol sub-score. */
  relVolTarget: number;
  /** RSI value that scores best for a LONG; mirrored for SHORT. */
  rsiSweetSpot: number;
  /** Half-width of the RSI "tent" scoring function. */
  rsiWidth: number;
  /** ATR% that maps to a full volatility sub-score. */
  atrPctScale: number;
  /** Gap% (in the trade direction) that maps to a full gap sub-score. */
  gapScale: number;
  filters: ScreenerFilters;
}

export interface IndicatorSnapshot {
  price: number;
  changePct: number | null;
  maShort: number | null;
  maLong: number | null;
  distShortPct: number | null;
  distLongPct: number | null;
  rsi: number | null;
  atr: number | null;
  atrPct: number | null;
  relVolume: number | null;
  avgVolume: number | null;
  volume: number | null;
  gapPct: number | null;
}

export interface ComponentScore {
  key: IndicatorKey;
  label: string;
  value: number | null;
  display: string;
  score: number; // 0..100
  weight: number;
  contribution: number; // score * weight (pre-normalization)
  note: string;
}

export interface SymbolScore {
  symbol: string;
  price: number;
  total: number; // 0..100 weighted average
  passedFilters: boolean;
  filterReasons: string[];
  components: ComponentScore[];
  indicators: IndicatorSnapshot;
}

export function defaultScreenerConfig(): ScreenerConfig {
  return {
    direction: 'long',
    weights: { momentum: 30, relativeVolume: 20, rsi: 15, volatility: 10, gap: 10, trend: 15 },
    maShort: 20,
    maLong: 50,
    rsiPeriod: 14,
    atrPeriod: 14,
    momentumScale: 5,
    relVolTarget: 2,
    rsiSweetSpot: 60,
    rsiWidth: 25,
    atrPctScale: 5,
    gapScale: 3,
    filters: { minPrice: 1, minAvgVolume: 200_000 },
  };
}

/** Merge a partial (from an API request / preset) onto the defaults. */
export function resolveScreenerConfig(partial?: Partial<ScreenerConfig>): ScreenerConfig {
  const base = defaultScreenerConfig();
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    weights: { ...base.weights, ...(partial.weights ?? {}) },
    filters: { ...base.filters, ...(partial.filters ?? {}) },
  };
}

// --- normalization helpers -------------------------------------------------

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear map of `value` in [from..to] -> [0..100], clamped. */
function scale01(value: number, from: number, to: number): number {
  if (to === from) return 0;
  return clamp(((value - from) / (to - from)) * 100);
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  return v === null ? '—' : v.toFixed(digits);
}

/** Build the indicator snapshot from candles + (optional) live quote. */
export function computeIndicators(
  candles: Candle[],
  quote: Quote | undefined,
  cfg: ScreenerConfig,
): IndicatorSnapshot | null {
  if (candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = quote?.last ?? last.close;

  const maShort = latest(smaSeries(closes, cfg.maShort));
  const maLong = latest(smaSeries(closes, cfg.maLong));
  const rsiVal = latest(rsiSeries(closes, cfg.rsiPeriod));
  const atrVal = latest(atrSeries(candles, cfg.atrPeriod));

  const changePct = quote?.changePct ?? percentChange(last.close, prev.close);
  const avgVolume = quote?.avgVolume ?? meanOfLast(volumes.slice(0, -1), 20) ?? meanOfLast(volumes, 20);
  const volume = quote?.volume ?? last.volume;
  const relVol = avgVolume ? relativeVolume(volume, avgVolume) : null;
  const openForGap = quote?.open ?? last.open;
  const gap = gapPercent(openForGap, prev.close);

  return {
    price,
    changePct,
    maShort,
    maLong,
    distShortPct: distanceFromMa(price, maShort),
    distLongPct: distanceFromMa(price, maLong),
    rsi: rsiVal,
    atr: atrVal,
    atrPct: atrVal !== null && price ? (atrVal / price) * 100 : null,
    relVolume: relVol,
    avgVolume,
    volume,
    gapPct: gap,
  };
}

// --- per-component scoring (direction-aware) -------------------------------

function scoreMomentum(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  const sign = cfg.direction === 'long' ? 1 : -1;
  const parts: number[] = [];
  const descr: string[] = [];
  if (ind.changePct !== null) {
    parts.push(scale01(sign * ind.changePct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`Δ ${fmtPct(ind.changePct)}`);
  }
  if (ind.distShortPct !== null) {
    parts.push(scale01(sign * ind.distShortPct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`${cfg.maShort}MA ${fmtPct(ind.distShortPct)}`);
  }
  if (ind.distLongPct !== null) {
    parts.push(scale01(sign * ind.distLongPct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`${cfg.maLong}MA ${fmtPct(ind.distLongPct)}`);
  }
  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { score, note: `${cfg.direction} momentum from ${descr.join(', ') || 'n/a'}` };
}

function scoreRelVol(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.relVolume === null) return { score: 0, note: 'no volume data' };
  const score = scale01(ind.relVolume, 0.5, cfg.relVolTarget);
  return { score, note: `${ind.relVolume.toFixed(2)}× avg volume (target ${cfg.relVolTarget}×)` };
}

function scoreRsi(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.rsi === null) return { score: 0, note: 'no RSI (insufficient history)' };
  const sweet = cfg.direction === 'long' ? cfg.rsiSweetSpot : 100 - cfg.rsiSweetSpot;
  const score = clamp((1 - Math.abs(ind.rsi - sweet) / cfg.rsiWidth) * 100);
  return { score, note: `RSI ${ind.rsi.toFixed(1)} vs sweet spot ${sweet} (±${cfg.rsiWidth})` };
}

function scoreVolatility(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.atrPct === null) return { score: 0, note: 'no ATR (insufficient history)' };
  const score = scale01(ind.atrPct, 0, cfg.atrPctScale);
  return { score, note: `ATR ${ind.atrPct.toFixed(2)}% of price (more range scores higher, capped)` };
}

function scoreGap(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.gapPct === null) return { score: 0, note: 'no gap data' };
  const sign = cfg.direction === 'long' ? 1 : -1;
  const score = scale01(sign * ind.gapPct, 0, cfg.gapScale);
  return { score, note: `gap ${fmtPct(ind.gapPct)} (${cfg.direction}-favorable gaps score higher)` };
}

function scoreTrend(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.maShort === null || ind.maLong === null) {
    return { score: 0, note: 'no MAs (insufficient history)' };
  }
  const long = cfg.direction === 'long';
  const conds = [
    long ? ind.price > ind.maShort : ind.price < ind.maShort,
    long ? ind.price > ind.maLong : ind.price < ind.maLong,
    long ? ind.maShort > ind.maLong : ind.maShort < ind.maLong,
  ];
  const passed = conds.filter(Boolean).length;
  const score = (passed / conds.length) * 100;
  return {
    score,
    note: `${passed}/3 trend conditions met (price vs ${cfg.maShort}/${cfg.maLong}MA, MA alignment)`,
  };
}

// --- main entry ------------------------------------------------------------

const LABELS: Record<IndicatorKey, string> = {
  momentum: 'Momentum',
  relativeVolume: 'Rel. Volume',
  rsi: 'RSI',
  volatility: 'Volatility (ATR%)',
  gap: 'Gap',
  trend: 'Trend',
};

/** Score a single symbol; returns the full transparent breakdown. */
export function scoreSymbol(
  symbol: string,
  candles: Candle[],
  quote: Quote | undefined,
  cfg: ScreenerConfig,
): SymbolScore {
  const ind = computeIndicators(candles, quote, cfg);
  if (!ind) {
    return {
      symbol,
      price: quote?.last ?? 0,
      total: 0,
      passedFilters: false,
      filterReasons: ['insufficient price history'],
      components: [],
      indicators: emptySnapshot(quote?.last ?? 0),
    };
  }

  const scored: Record<IndicatorKey, { score: number; note: string }> = {
    momentum: scoreMomentum(ind, cfg),
    relativeVolume: scoreRelVol(ind, cfg),
    rsi: scoreRsi(ind, cfg),
    volatility: scoreVolatility(ind, cfg),
    gap: scoreGap(ind, cfg),
    trend: scoreTrend(ind, cfg),
  };

  const rawValues: Record<IndicatorKey, { value: number | null; display: string }> = {
    momentum: { value: ind.changePct, display: fmtPct(ind.changePct) },
    relativeVolume: { value: ind.relVolume, display: ind.relVolume === null ? '—' : `${ind.relVolume.toFixed(2)}×` },
    rsi: { value: ind.rsi, display: fmtNum(ind.rsi, 1) },
    volatility: { value: ind.atrPct, display: ind.atrPct === null ? '—' : `${ind.atrPct.toFixed(2)}%` },
    gap: { value: ind.gapPct, display: fmtPct(ind.gapPct) },
    trend: { value: ind.maShort, display: ind.maShort === null ? '—' : `${cfg.maShort}MA ${ind.maShort.toFixed(2)}` },
  };

  const keys = Object.keys(cfg.weights) as IndicatorKey[];
  let weightSum = 0;
  let weighted = 0;
  const components: ComponentScore[] = keys.map((key) => {
    const weight = Math.max(0, cfg.weights[key] ?? 0);
    const { score, note } = scored[key];
    weightSum += weight;
    weighted += score * weight;
    return {
      key,
      label: LABELS[key],
      value: rawValues[key].value,
      display: rawValues[key].display,
      score: Math.round(score * 10) / 10,
      weight,
      contribution: Math.round(score * weight * 10) / 10,
      note,
    };
  });

  const total = weightSum > 0 ? weighted / weightSum : 0;
  const { passed, reasons } = applyFilters(ind, cfg);

  return {
    symbol,
    price: ind.price,
    total: Math.round(total * 10) / 10,
    passedFilters: passed,
    filterReasons: reasons,
    components,
    indicators: ind,
  };
}

function applyFilters(ind: IndicatorSnapshot, cfg: ScreenerConfig): { passed: boolean; reasons: string[] } {
  const f = cfg.filters;
  const reasons: string[] = [];
  if (f.minPrice !== undefined && ind.price < f.minPrice) reasons.push(`price < ${f.minPrice}`);
  if (f.maxPrice !== undefined && ind.price > f.maxPrice) reasons.push(`price > ${f.maxPrice}`);
  if (f.minAvgVolume !== undefined && (ind.avgVolume ?? 0) < f.minAvgVolume)
    reasons.push(`avg vol < ${f.minAvgVolume.toLocaleString()}`);
  if (f.minRelVol !== undefined && (ind.relVolume ?? 0) < f.minRelVol) reasons.push(`rel vol < ${f.minRelVol}`);
  if (f.rsiMin !== undefined && (ind.rsi ?? -1) < f.rsiMin) reasons.push(`RSI < ${f.rsiMin}`);
  if (f.rsiMax !== undefined && (ind.rsi ?? 101) > f.rsiMax) reasons.push(`RSI > ${f.rsiMax}`);
  if (f.requireTrendAlignment) {
    const long = cfg.direction === 'long';
    const aligned =
      ind.maShort !== null && ind.maLong !== null && (long ? ind.price > ind.maShort : ind.price < ind.maShort);
    if (!aligned) reasons.push(`not ${cfg.direction}-aligned vs ${cfg.maShort}MA`);
  }
  return { passed: reasons.length === 0, reasons };
}

function emptySnapshot(price: number): IndicatorSnapshot {
  return {
    price,
    changePct: null,
    maShort: null,
    maLong: null,
    distShortPct: null,
    distLongPct: null,
    rsi: null,
    atr: null,
    atrPct: null,
    relVolume: null,
    avgVolume: null,
    volume: null,
    gapPct: null,
  };
}
