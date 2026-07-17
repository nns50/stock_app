import { describe, it, expect } from 'vitest';
import { Candle } from '../src/providers/types';
import {
  candleIndicatorsAt,
  computeCandleIndicators,
  computeCandleIndicatorSeries,
  computeIndicators,
  defaultScreenerConfig,
  resolveScreenerConfig,
  scoreSymbol,
  scoreSymbolBothDirections,
} from '../src/indicators/screener';
import { Quote } from '../src/providers/types';

function candlesFromCloses(closes: number[], volume = 1_000_000): Candle[] {
  let prev = closes[0];
  return closes.map((close, i) => {
    const open = i === 0 ? close : prev;
    prev = close;
    return {
      time: Date.UTC(2026, 0, 1) + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume,
    };
  });
}

const uptrend = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 100 + i)); // steady rise
const downtrend = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 200 - i)); // steady fall

describe('resolveScreenerConfig', () => {
  it('deep-merges weights and filters onto defaults', () => {
    const cfg = resolveScreenerConfig({ weights: { momentum: 99 } as any, filters: { minPrice: 7 } });
    expect(cfg.weights.momentum).toBe(99);
    expect(cfg.weights.rsi).toBe(defaultScreenerConfig().weights.rsi); // untouched
    expect(cfg.filters.minPrice).toBe(7);
  });
});

describe('scoreSymbol — transparency contract', () => {
  const result = scoreSymbol('TEST', uptrend, undefined, defaultScreenerConfig());

  it('returns a total within 0..100', () => {
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('exposes every weighted component with an explanation', () => {
    const keys = result.components.map((c) => c.key).sort();
    expect(keys).toEqual(['gap', 'momentum', 'relativeStrength', 'relativeVolume', 'rsi', 'trend', 'volatility']);
    for (const c of result.components) {
      expect(c).toHaveProperty('score');
      expect(c).toHaveProperty('weight');
      expect(c).toHaveProperty('contribution');
      expect(typeof c.note).toBe('string');
      expect(c.note.length).toBeGreaterThan(0);
    }
  });

  it('total equals the weighted average of component sub-scores', () => {
    const weightSum = result.components.reduce((s, c) => s + c.weight, 0);
    const weighted = result.components.reduce((s, c) => s + c.score * c.weight, 0);
    expect(result.total).toBeCloseTo(weighted / weightSum, 1);
  });

  it('populates the indicator snapshot', () => {
    expect(result.indicators.maShort).not.toBeNull();
    expect(result.indicators.maLong).not.toBeNull();
    expect(result.indicators.rsi).not.toBeNull();
  });
});

describe('scoreSymbol — direction awareness', () => {
  it('an uptrend scores higher for long than for short', () => {
    const long = scoreSymbol('UP', uptrend, undefined, resolveScreenerConfig({ direction: 'long' }));
    const short = scoreSymbol('UP', uptrend, undefined, resolveScreenerConfig({ direction: 'short' }));
    expect(long.total).toBeGreaterThan(short.total);
  });

  it('a downtrend scores higher for short than for long', () => {
    const long = scoreSymbol('DN', downtrend, undefined, resolveScreenerConfig({ direction: 'long' }));
    const short = scoreSymbol('DN', downtrend, undefined, resolveScreenerConfig({ direction: 'short' }));
    expect(short.total).toBeGreaterThan(long.total);
  });

  it('a strong uptrend gives a high trend sub-score for long', () => {
    const r = scoreSymbol('UP', uptrend, undefined, resolveScreenerConfig({ direction: 'long' }));
    const trend = r.components.find((c) => c.key === 'trend')!;
    expect(trend.score).toBe(100);
  });
});

describe('scoreSymbolBothDirections', () => {
  it('matches calling scoreSymbol twice with direction overridden each way', () => {
    const cfg = resolveScreenerConfig({ direction: 'long' }); // direction on cfg is irrelevant to this call
    const both = scoreSymbolBothDirections('UP', uptrend, undefined, cfg);
    const long = scoreSymbol('UP', uptrend, undefined, { ...cfg, direction: 'long' });
    const short = scoreSymbol('UP', uptrend, undefined, { ...cfg, direction: 'short' });
    expect(both.long).toEqual(long);
    expect(both.short).toEqual(short);
  });

  it('ignores cfg.direction entirely — same result regardless of what it was set to', () => {
    const asLong = scoreSymbolBothDirections('UP', uptrend, undefined, resolveScreenerConfig({ direction: 'long' }));
    const asShort = scoreSymbolBothDirections('UP', uptrend, undefined, resolveScreenerConfig({ direction: 'short' }));
    expect(asLong).toEqual(asShort);
  });

  it('an uptrend: long wins; a downtrend: short wins', () => {
    const up = scoreSymbolBothDirections('UP', uptrend, undefined, defaultScreenerConfig());
    expect(up.long.total).toBeGreaterThan(up.short.total);

    const down = scoreSymbolBothDirections('DN', downtrend, undefined, defaultScreenerConfig());
    expect(down.short.total).toBeGreaterThan(down.long.total);
  });

  it('falls back to the quote price (not 0) on both sides when history is insufficient', () => {
    const quote = { symbol: 'X', last: 42, timestamp: 0 } as Quote;
    const both = scoreSymbolBothDirections('X', [], quote, defaultScreenerConfig());
    expect(both.long.price).toBe(42);
    expect(both.short.price).toBe(42);
    expect(both.long.passedFilters).toBe(false);
    expect(both.short.passedFilters).toBe(false);
  });
});

describe('scoreSymbol — filters', () => {
  it('flags symbols that fail a hard filter with a reason', () => {
    const cfg = resolveScreenerConfig({ filters: { minPrice: 10_000 } });
    const r = scoreSymbol('TEST', uptrend, undefined, cfg);
    expect(r.passedFilters).toBe(false);
    expect(r.filterReasons.join(' ')).toContain('price');
  });

  it('passes when filters are satisfied', () => {
    const cfg = resolveScreenerConfig({ filters: { minPrice: 1, minAvgVolume: 1 } });
    const r = scoreSymbol('TEST', uptrend, undefined, cfg);
    expect(r.passedFilters).toBe(true);
    expect(r.filterReasons).toHaveLength(0);
  });

  it('handles insufficient history gracefully', () => {
    const r = scoreSymbol('SHORT', candlesFromCloses([100]), undefined, defaultScreenerConfig());
    expect(r.passedFilters).toBe(false);
    expect(r.components).toHaveLength(0);
  });
});

describe('scoreSymbol — weekly trend alignment filter (2026-07-16)', () => {
  const cfg = resolveScreenerConfig({ direction: 'long', filters: { requireWeeklyTrendAlignment: true } });
  // uptrend's own last close (its `price` when scored against itself) is 179
  // (closes 100..179). A flat weekly series well BELOW that price means
  // "price > weeklyMaShort" — long-aligned; well ABOVE means the opposite.
  const weeklyBelow = computeCandleIndicators(candlesFromCloses(Array(25).fill(100)), cfg)!;
  const weeklyAbove = computeCandleIndicators(candlesFromCloses(Array(25).fill(300)), cfg)!;

  it('is inactive (ignored) when the filter is off, even with no weekly data at all', () => {
    const off = resolveScreenerConfig({ direction: 'long' }); // requireWeeklyTrendAlignment omitted
    const r = scoreSymbol('TEST', uptrend, undefined, off);
    expect(r.passedFilters).toBe(true);
    expect(r.indicators.weeklyMaShort).toBeNull();
  });

  it('fails CLOSED when enabled but the caller supplied no weekly indicators at all', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg); // no 7th arg
    expect(r.indicators.weeklyMaShort).toBeNull();
    expect(r.passedFilters).toBe(false);
    expect(r.filterReasons.join(' ')).toContain('weekly');
  });

  it('blocks a long candidate whose weekly trend disagrees (price below its weekly MA)', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg, undefined, undefined, weeklyAbove);
    expect(r.indicators.weeklyMaShort).toBe(weeklyAbove.maShort);
    expect(r.passedFilters).toBe(false);
    expect(r.filterReasons.join(' ')).toContain('weekly');
  });

  it('passes a long candidate whose weekly trend agrees (price above its weekly MA)', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg, undefined, undefined, weeklyBelow);
    expect(r.passedFilters).toBe(true);
    expect(r.filterReasons).toHaveLength(0);
  });

  it('mirrors correctly for a short candidate (blocks/passes on the opposite side)', () => {
    const shortCfg = { ...cfg, direction: 'short' as const };
    // For a short, agreement means price is BELOW its weekly MA.
    const agrees = scoreSymbol('TEST', uptrend, undefined, shortCfg, undefined, undefined, weeklyAbove);
    expect(agrees.passedFilters).toBe(true);

    const disagrees = scoreSymbol('TEST', uptrend, undefined, shortCfg, undefined, undefined, weeklyBelow);
    expect(disagrees.passedFilters).toBe(false);
  });

  it("doesn't affect a symbol that already fails on other filters (reasons accumulate, not replace)", () => {
    const strict = { ...cfg, filters: { ...cfg.filters, minPrice: 10_000 } };
    const r = scoreSymbol('TEST', uptrend, undefined, strict, undefined, undefined, weeklyAbove);
    expect(r.passedFilters).toBe(false);
    expect(r.filterReasons.length).toBeGreaterThanOrEqual(2);
    expect(r.filterReasons.join(' ')).toContain('price');
    expect(r.filterReasons.join(' ')).toContain('weekly');
  });
});

describe('scoreSymbol — relative strength vs. benchmark (2026-07-17)', () => {
  // uptrend: closes 100..179 (80 bars). Default relativeStrengthLookbackDays
  // is 20, so the candidate's own lookback return is (179-159)/159*100 ≈
  // +12.58% (close at index 59 is 100+59=159).
  const cfg = resolveScreenerConfig({ direction: 'long', weights: { relativeStrength: 25 } as any });

  it('contributes nothing to the total when weight is 0 (the default), even with no benchmark data at all', () => {
    const off = resolveScreenerConfig({ direction: 'long' }); // weights.relativeStrength omitted -> 0
    const r = scoreSymbol('TEST', uptrend, undefined, off);
    const component = r.components.find((c) => c.key === 'relativeStrength')!;
    expect(component.weight).toBe(0);
    expect(component.contribution).toBe(0);
    expect(r.indicators.benchmarkLookbackReturnPct).toBeNull();
  });

  it('scores 0 (not a total-corrupting NaN) when weight is nonzero but the caller supplied no benchmark return at all', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg); // no 8th arg
    const component = r.components.find((c) => c.key === 'relativeStrength')!;
    expect(component.score).toBe(0);
    expect(component.note).toContain('no relative-strength data');
    expect(Number.isFinite(r.total)).toBe(true);
  });

  it('scores well above the midpoint for a long candidate that outperformed the benchmark', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg, undefined, undefined, undefined, 5); // benchmark +5%, candidate ~+12.58%
    const component = r.components.find((c) => c.key === 'relativeStrength')!;
    expect(component.score).toBeGreaterThan(50);
    expect(r.indicators.symbolLookbackReturnPct).toBeCloseTo(12.58, 1);
    expect(r.indicators.benchmarkLookbackReturnPct).toBe(5);
  });

  it('scores well below the midpoint for a long candidate that underperformed the benchmark', () => {
    const r = scoreSymbol('TEST', uptrend, undefined, cfg, undefined, undefined, undefined, 20); // benchmark +20%, candidate ~+12.58%
    const component = r.components.find((c) => c.key === 'relativeStrength')!;
    expect(component.score).toBeLessThan(50);
  });

  it('mirrors correctly for a short candidate — underperformance (not outperformance) scores higher', () => {
    const shortCfg = { ...cfg, direction: 'short' as const };
    const underperformed = scoreSymbol('TEST', uptrend, undefined, shortCfg, undefined, undefined, undefined, 20); // candidate lagged
    const outperformed = scoreSymbol('TEST', uptrend, undefined, shortCfg, undefined, undefined, undefined, 5); // candidate led
    const scoreOf = (r: typeof underperformed) => r.components.find((c) => c.key === 'relativeStrength')!.score;
    expect(scoreOf(underperformed)).toBeGreaterThan(scoreOf(outperformed));
  });

  it('is null when history does not reach back far enough for the lookback window', () => {
    const short = candlesFromCloses(Array.from({ length: 10 }, (_, i) => 100 + i)); // fewer than 20 bars
    const r = scoreSymbol('TEST', short, undefined, cfg, undefined, undefined, undefined, 5);
    expect(r.indicators.symbolLookbackReturnPct).toBeNull();
    const component = r.components.find((c) => c.key === 'relativeStrength')!;
    expect(component.score).toBe(0);
  });
});

describe('computeCandleIndicators — cacheable, quote-independent piece of computeIndicators', () => {
  const cfg = defaultScreenerConfig();

  it('matches the maShort/maLong/rsi/atr computeIndicators would derive on its own', () => {
    const fresh = computeIndicators(uptrend, undefined, cfg);
    const candleOnly = computeCandleIndicators(uptrend, cfg);
    expect(candleOnly).toEqual({
      maShort: fresh!.maShort,
      maLong: fresh!.maLong,
      rsiVal: fresh!.rsi,
      atrVal: fresh!.atr,
    });
  });

  it('returns null on insufficient history, same guard as computeIndicators', () => {
    expect(computeCandleIndicators(candlesFromCloses([100]), cfg)).toBeNull();
  });

  it('computeIndicators given a matching cached result produces IDENTICAL output to computing fresh', () => {
    const quote: Quote = { symbol: 'UP', last: 199, changePct: 1.2, volume: 5_000_000, avgVolume: 2_000_000 };
    const fresh = computeIndicators(uptrend, quote, cfg);
    const cached = computeCandleIndicators(uptrend, cfg)!;
    const viaCache = computeIndicators(uptrend, quote, cfg, cached);
    expect(viaCache).toEqual(fresh);
  });

  it('scoreSymbol given a matching cached result produces IDENTICAL output to computing fresh', () => {
    const quote: Quote = { symbol: 'UP', last: 199, changePct: 1.2, volume: 5_000_000, avgVolume: 2_000_000 };
    const fresh = scoreSymbol('UP', uptrend, quote, cfg);
    const cached = computeCandleIndicators(uptrend, cfg)!;
    const viaCache = scoreSymbol('UP', uptrend, quote, cfg, cached);
    expect(viaCache).toEqual(fresh);
  });

  it('a stale/wrong cache would change the result — proving the cache genuinely feeds the computation, not silently ignored', () => {
    const quote: Quote = { symbol: 'UP', last: 199, changePct: 1.2, volume: 5_000_000, avgVolume: 2_000_000 };
    const fresh = scoreSymbol('UP', uptrend, quote, cfg);
    const wrongCache = computeCandleIndicators(downtrend, cfg)!; // deliberately mismatched
    const viaWrongCache = scoreSymbol('UP', uptrend, quote, cfg, wrongCache);
    expect(viaWrongCache).not.toEqual(fresh);
  });
});

describe('computeCandleIndicatorSeries / candleIndicatorsAt — precomputed-once lookup for a backtest day-loop', () => {
  const cfg = defaultScreenerConfig();
  // A longer, varied series (not a pure monotonic trend) so RSI/ATR genuinely
  // move around across indices, not just settle at an extreme.
  const wobble = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 15 + i * 0.3));

  it('matches computeCandleIndicators(candles.slice(0, i + 1)) at every index — the causal-prefix property the whole optimization relies on', () => {
    const series = computeCandleIndicatorSeries(wobble, cfg);
    // Sample across the array: right at the edge of insufficient history,
    // just past every configured warmup period, and deep into the series.
    const sampleIndices = [0, 1, cfg.maShort - 1, cfg.maShort, cfg.maLong, cfg.rsiPeriod, 60, 90, wobble.length - 1];
    for (const i of sampleIndices) {
      const viaSeries = candleIndicatorsAt(series, i);
      const viaFresh = computeCandleIndicators(wobble.slice(0, i + 1), cfg);
      expect(viaSeries).toEqual(viaFresh);
    }
  });

  it('returns null for an out-of-range index', () => {
    const series = computeCandleIndicatorSeries(wobble, cfg);
    expect(candleIndicatorsAt(series, -1)).toBeNull();
    expect(candleIndicatorsAt(series, wobble.length)).toBeNull();
  });

  it('computeIndicators with asOfIndex + a precomputed series matches computing fresh on a truncated history, at several points in time', () => {
    const series = computeCandleIndicatorSeries(wobble, cfg);
    for (const i of [30, 60, 90, wobble.length - 1]) {
      const cached = candleIndicatorsAt(series, i)!;
      const viaAsOfIndex = computeIndicators(wobble, undefined, cfg, cached, i);
      const viaTruncatedHistory = computeIndicators(wobble.slice(0, i + 1), undefined, cfg);
      expect(viaAsOfIndex).toEqual(viaTruncatedHistory);
    }
  });

  it('scoreSymbol with asOfIndex + a precomputed series matches computing fresh on a truncated history', () => {
    const series = computeCandleIndicatorSeries(wobble, cfg);
    const i = 75;
    const cached = candleIndicatorsAt(series, i)!;
    const viaAsOfIndex = scoreSymbol('WOBBLE', wobble, undefined, cfg, cached, i);
    const viaTruncatedHistory = scoreSymbol('WOBBLE', wobble.slice(0, i + 1), undefined, cfg);
    expect(viaAsOfIndex).toEqual(viaTruncatedHistory);
  });

  it('an asOfIndex pointing at a DIFFERENT day than the cache changes the result — proving asOfIndex is genuinely wired in, not silently ignored', () => {
    const series = computeCandleIndicatorSeries(wobble, cfg);
    const at40 = scoreSymbol('WOBBLE', wobble, undefined, cfg, candleIndicatorsAt(series, 40)!, 40);
    const at41 = scoreSymbol('WOBBLE', wobble, undefined, cfg, candleIndicatorsAt(series, 41)!, 41);
    expect(at41).not.toEqual(at40);
  });

  it('omitting asOfIndex still defaults to the full array (unchanged behavior for every existing caller)', () => {
    const withoutIndex = scoreSymbol('WOBBLE', wobble, undefined, cfg);
    const withExplicitLastIndex = scoreSymbol('WOBBLE', wobble, undefined, cfg, undefined, wobble.length - 1);
    expect(withoutIndex).toEqual(withExplicitLastIndex);
  });
});
