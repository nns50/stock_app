import { describe, it, expect } from 'vitest';
import { aggregateExcursions, computeExcursion, ExcursionInput } from '../src/services/excursion';
import type { Candle } from '../src/providers/types';

const candle = (high: number, low: number): Candle => ({ time: 0, open: low, high, low, close: high, volume: 0 });

const longTrade: ExcursionInput = {
  positionId: 1,
  symbol: 'AAA',
  side: 'long',
  entryPrice: 100,
  quantity: 10,
  multiplier: 1,
  stopPrice: 90, // risk = 10*10 = 100
  realizedPnl: 50, // closed at +0.5R
  entryDate: '2026-01-01',
};

describe('computeExcursion', () => {
  it('measures favorable/adverse excursion in % and R for a long', () => {
    // ran up to 130 (MFE +30/sh) and dipped to 94 (MAE -6/sh) before exit
    const ex = computeExcursion(longTrade, [candle(120, 96), candle(130, 94)])!;
    expect(ex.mfePct).toBe(30); // (130-100)*10 / (100*10) * 100
    expect(ex.maePct).toBe(-6); // (94-100)*10 / 1000 * 100
    expect(ex.mfeR).toBe(3); // favDollar 300 / risk 100
    expect(ex.maeR).toBe(-0.6); // advDollar -60 / 100
    expect(ex.realizedR).toBe(0.5);
    expect(ex.capturedPct).toBeCloseTo(16.67); // 0.5R kept of 3R available
  });

  it('clamps to zero when price never moved favorably/adversely', () => {
    // long that only fell: no favorable excursion
    const ex = computeExcursion(longTrade, [candle(99, 80)])!;
    expect(ex.mfePct).toBe(0);
    expect(ex.maeR).toBe(-2); // dipped to 80 -> -20/sh*10 = -200 / 100 = -2R
  });

  it('flips direction for shorts and returns null without candles', () => {
    const short: ExcursionInput = { ...longTrade, side: 'short', stopPrice: 110 };
    const ex = computeExcursion(short, [candle(105, 70)])!; // dropped to 70 = favorable for a short
    expect(ex.mfeR).toBe(3); // (100-70)*10 / 100
    expect(computeExcursion(short, [])).toBeNull();
  });
});

describe('aggregateExcursions', () => {
  it('averages R metrics and capture over winners', () => {
    const a = computeExcursion(longTrade, [candle(130, 94)])!; // mfeR 3, captured 16.67
    const b = computeExcursion({ ...longTrade, positionId: 2, realizedPnl: 200 }, [candle(220, 100)])!; // mfeR 12, realized 2R
    const rep = aggregateExcursions([a, b]);
    expect(rep.trades).toBe(2);
    expect(rep.avgMfeR).toBeCloseTo(7.5); // (3+12)/2
    expect(rep.capturePct).not.toBeNull();
  });
});
