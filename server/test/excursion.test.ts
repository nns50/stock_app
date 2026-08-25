import { describe, it, expect } from 'vitest';
import {
  aggregateExcursions,
  computeExcursion,
  barsWithinHoldingPeriod,
  ExcursionInput,
} from '../src/services/excursion';
import type { Candle } from '../src/providers/types';

/** A bar on a given ET date. These carried `time: 0` (1970) until 2026-08-25 —
 *  harmless only because computeExcursion ignored timestamps entirely, which is
 *  the very bug the holding-period filter now fixes. A dated bar is the honest
 *  fixture. Noon ET keeps the date unambiguous either side of a DST change. */
const barOn = (date: string, high: number, low: number): Candle => ({
  time: Date.parse(`${date}T16:00:00Z`),
  open: low,
  high,
  low,
  close: high,
  volume: 0,
});
/** Default in-window bar for the fixtures below (entry 01-01, exit 01-05). */
const candle = (high: number, low: number): Candle => barOn('2026-01-02', high, low);

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
  exitDate: '2026-01-05',
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

  it('defaults coverage to "these rows were the whole population"', () => {
    // True for a direct call, and the only default that cannot overstate.
    const a = computeExcursion(longTrade, [candle(130, 94)])!;
    expect(aggregateExcursions([a]).coverage).toEqual({
      closedStockTrades: 1,
      undated: 0,
      overCap: 0,
      unavailable: 0,
    });
  });

  it('reports what a caller could not analyse, so a truncated sample says so', () => {
    // The averages above are over ONE trade out of seventy. Without this the
    // report is indistinguishable from a complete one over a one-trade journal.
    const a = computeExcursion(longTrade, [candle(130, 94)])!;
    const rep = aggregateExcursions([a], {
      closedStockTrades: 70,
      undated: 4,
      overCap: 16,
      unavailable: 49,
    });
    expect(rep.trades).toBe(1);
    expect(rep.coverage.closedStockTrades).toBe(70);
    expect(rep.coverage.undated).toBe(4);
    expect(rep.coverage.overCap).toBe(16);
    expect(rep.coverage.unavailable).toBe(49);
    // The four buckets account for the whole population: analysed + the reasons
    // the rest are missing. An identity worth asserting — it is what makes the
    // numbers checkable rather than decorative.
    const c = rep.coverage;
    expect(rep.trades + c.undated + c.overCap + c.unavailable).toBe(c.closedStockTrades);
  });
});

// ---------------------------------------------------------------------------
// Holding-period window (2026-08-25). computeExcursion used to scan EVERY bar
// it was handed. Both callers ask their provider for {start: entryDate, end:
// exitDate} and assumed that bounded the fetch — but the live provider (Webull)
// has no date-range parameter at all, so the range was dropped and the last 120
// daily bars came back instead. MAE/MFE was therefore the symbol's ~6-month
// high/low, reporting +20.95R average MFE and -4.28R average MAE across the
// book: an average adverse excursion four times the stop, on trades that would
// have been stopped out at 1R.
// ---------------------------------------------------------------------------
describe('holding-period window', () => {
  it('ignores bars from before the entry and after the exit', () => {
    const ex = computeExcursion(longTrade, [
      barOn('2025-06-01', 175, 40), // months BEFORE the trade — the real defect
      barOn('2026-01-02', 130, 94), // the only bar actually held through
      barOn('2026-03-01', 260, 20), // months AFTER the exit
    ])!;
    // Exactly the single-bar answer, as if the out-of-window bars were absent.
    expect(ex.mfeR).toBe(3);
    expect(ex.maeR).toBe(-0.6);
  });

  it('reproduces the VALE day trade: 6-month range vs the day actually held', () => {
    // Position 537, 2026-08-24: 81sh @ 15.14, stop 14.56 (risk 0.58/sh).
    // Its own daily bar was H 15.22 / L 14.62. The six months of bars around it
    // ranged to 17.45 — which is where the reported "+15.26% MFE" came from.
    const vale: ExcursionInput = {
      positionId: 537,
      symbol: 'VALE',
      side: 'long',
      entryPrice: 15.14,
      quantity: 81,
      multiplier: 1,
      stopPrice: 14.56,
      realizedPnl: -1.62,
      entryDate: '2026-08-24',
      exitDate: '2026-08-24',
    };
    const bars = [barOn('2026-05-12', 17.45, 13.56), barOn('2026-08-24', 15.22, 14.62)];
    const ex = computeExcursion(vale, bars)!;
    expect(ex.mfeR).toBeCloseTo(0.14, 2); // was +3.98R
    expect(ex.maeR).toBeCloseTo(-0.9, 2); // was -2.72R
    expect(ex.mfePct).toBeCloseTo(0.53, 2); // was 15.26%
  });

  it('is unmeasurable — not silently widened — when no bar falls in the window', () => {
    // The failure mode this whole filter exists to prevent is a SILENT widening,
    // so an empty window must report nothing rather than fall back to the full set.
    expect(computeExcursion(longTrade, [barOn('2025-06-01', 175, 40)])).toBeNull();
  });

  it('runs open-ended forward when the trade has no dated exit', () => {
    const noExit = { ...longTrade, exitDate: null };
    const ex = computeExcursion(noExit, [barOn('2025-12-31', 999, 1), barOn('2026-04-01', 130, 94)])!;
    expect(ex.mfeR).toBe(3); // the pre-entry bar is still excluded
  });

  it('passes through a set a range-supporting provider already bounded', () => {
    const inWindow = [barOn('2026-01-01', 110, 99), barOn('2026-01-05', 130, 94)];
    expect(barsWithinHoldingPeriod(inWindow, '2026-01-01', '2026-01-05')).toEqual(inWindow);
  });

  it('includes the boundary days themselves', () => {
    // A day trade entered and exited the same session has exactly one bar, and
    // an inclusive window is the difference between measuring it and measuring
    // nothing at all.
    const oneDay = barsWithinHoldingPeriod([barOn('2026-01-01', 110, 99)], '2026-01-01', '2026-01-01');
    expect(oneDay).toHaveLength(1);
  });
});
