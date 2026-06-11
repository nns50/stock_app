import { describe, it, expect } from 'vitest';
import { Candle } from '../src/providers/types';
import {
  defaultScreenerConfig,
  resolveScreenerConfig,
  scoreSymbol,
} from '../src/indicators/screener';

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
    expect(keys).toEqual(['gap', 'momentum', 'relativeVolume', 'rsi', 'trend', 'volatility']);
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
