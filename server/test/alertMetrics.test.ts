import { describe, it, expect } from 'vitest';
import { Candle } from '../src/providers/types';
import { computeCandleMetrics } from '../src/services/alertMetrics';

const mk = (close: number, high = close, low = close): Candle => ({
  time: 0,
  open: close,
  high,
  low,
  close,
  volume: 0,
});

describe('computeCandleMetrics', () => {
  it('derives MA spread and 52-week distances', () => {
    const candles: Candle[] = Array.from({ length: 60 }, () => mk(100));
    candles[5] = mk(100, 130, 100); // a 52w high of 130
    candles[7] = mk(100, 100, 90); // a 52w low of 90
    const m = computeCandleMetrics(candles, 110);
    expect(m.maSpreadPct).toBe(0); // all closes equal → MA20 == MA50
    expect(m.pctFromHigh52).toBe(-15.38); // (110 − 130) / 130
    expect(m.pctFromLow52).toBe(22.22); // (110 − 90) / 90
  });

  it('reports a positive MA spread when the short average leads', () => {
    // 50 closes at 100 then 10 at 120 → MA20 > MA50.
    const candles: Candle[] = [
      ...Array.from({ length: 50 }, () => mk(100)),
      ...Array.from({ length: 10 }, () => mk(120)),
    ];
    const m = computeCandleMetrics(candles, 120);
    expect(m.maSpreadPct).not.toBeNull();
    expect(m.maSpreadPct as number).toBeGreaterThan(0);
  });

  it('is null-safe with no candles', () => {
    expect(computeCandleMetrics([], 100)).toEqual({
      rsi: null,
      maSpreadPct: null,
      pctFromHigh52: null,
      pctFromLow52: null,
    });
  });

  it('falls back to the last close when no price is given', () => {
    const candles: Candle[] = Array.from({ length: 60 }, () => mk(100, 120, 80));
    const m = computeCandleMetrics(candles, null);
    expect(m.pctFromHigh52).toBe(-16.67); // (100 − 120) / 120
    expect(m.pctFromLow52).toBe(25); // (100 − 80) / 80
  });
});
