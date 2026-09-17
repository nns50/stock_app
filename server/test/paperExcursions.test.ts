import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import {
  closePaperPosition,
  openPaperPosition,
  paperRealizedR,
  partialClosePaperPosition,
  ratchetPaperPositionStop,
} from '../src/db/autotradePaperPositions';
import { paperExcursionInput } from '../src/services/autotrading/paperExcursions';
import { collectExcursions, computeExcursion } from '../src/services/excursion';
import type { Candle } from '../src/providers/types';

// ---------------------------------------------------------------------------
// The paper book measured the way the live book already is. What these cases
// guard is the MAPPING — the one paper-specific line — and that the same
// candle walk then reads a paper row correctly. The measurement itself is
// excursion.test.ts's business.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_paper_positions;');
  vi.useFakeTimers();
  // 10:00 ET on a Wednesday — a same-session trade lands on intraday bars.
  vi.setSystemTime(Date.parse('2026-09-16T14:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const open = (over: Partial<Parameters<typeof openPaperPosition>[0]> = {}) =>
  openPaperPosition({
    symbol: 'AAPL',
    side: 'buy',
    quantity: 20,
    entryPrice: 100,
    stopPrice: 95, // risk = 5 x 20 = 100
    targetPrice: 110,
    riskAmount: 100,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    ...over,
  });

describe('paperExcursionInput', () => {
  it('maps a closed buy onto the live input shape, with the frozen stop and ET dates', () => {
    const pos = open();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    const closed = closePaperPosition(pos.id, { exitPrice: 103, exitReason: 'target' })!;
    const input = paperExcursionInput(closed)!;
    expect(input).toMatchObject({
      positionId: pos.id,
      symbol: 'AAPL',
      side: 'long',
      entryPrice: 100,
      quantity: 20,
      multiplier: 1,
      stopPrice: 95,
      realizedPnl: 60,
      entryDate: '2026-09-16',
      exitDate: '2026-09-16',
      entryTime: '10:00',
      exitAt: closed.exitAt,
    });
  });

  it('maps a sell onto a short', () => {
    const pos = open({ side: 'sell', stopPrice: 105, targetPrice: 90 });
    const closed = closePaperPosition(pos.id, { exitPrice: 97, exitReason: 'target' })!;
    expect(paperExcursionInput(closed)!.side).toBe('short');
  });

  it('has nothing to measure on a row still open', () => {
    expect(paperExcursionInput(open())).toBeNull();
  });

  it('uses the ORIGINAL quantity and the INITIAL stop after a scale-out and a ratchet, so R matches paperRealizedR', () => {
    // 30 shares at 100, stop 95: risk $150. A third scales out at 102 (+$20
    // banked), the stop ratchets to breakeven, the rest closes at 104 (+$80).
    // Whole trade: +$100 = +0.667R. The row now says quantity 20 and stop 100;
    // measured off those, R would read 100 / (0 x 20) — not a number at all.
    const pos = open({ quantity: 30, riskAmount: 150 });
    partialClosePaperPosition(pos.id, { quantity: 10, exitPrice: 102 });
    ratchetPaperPositionStop(pos.id, 100);
    const closed = closePaperPosition(pos.id, { exitPrice: 104, exitReason: 'target' })!;
    expect(closed.quantity).toBe(20);
    expect(closed.stopPrice).toBe(100);

    const input = paperExcursionInput(closed)!;
    expect(input.quantity).toBe(30);
    expect(input.stopPrice).toBe(95);
    expect(input.realizedPnl).toBe(100);
    // …and the excursion's realized R is the book's own realized R, by construction.
    const bar: Candle = { time: Date.now(), open: 100, high: 105, low: 98, close: 104, volume: 0 };
    const ex = computeExcursion(input, [bar], 'daily')!;
    expect(ex.realizedR).toBeCloseTo(paperRealizedR(closed)!, 2);
    expect(ex.maeR).toBeCloseTo(-0.4, 6); // low 98 against a 5-point stop distance
  });
});

describe('collectExcursions over the paper book', () => {
  it('measures a same-session paper trade on intraday bars narrowed to the minutes held', async () => {
    const pos = open();
    const entryAt = Date.now();
    vi.setSystemTime(entryAt + 30 * 60_000);
    const closed = closePaperPosition(pos.id, { exitPrice: 103, exitReason: 'target' })!;
    const bar = (minutes: number, high: number, low: number): Candle => ({
      time: entryAt + minutes * 60_000,
      open: 100,
      high,
      low,
      close: 100,
      volume: 0,
    });
    const source = {
      getCandles: vi.fn(async (_symbol: string, timeframe: string) =>
        timeframe === '5min'
          ? [bar(-10, 130, 80), bar(5, 102, 99), bar(15, 104, 97), bar(45, 150, 50)] // outside the hold: ignored
          : [],
      ),
    };
    const out = await collectExcursions(source, [paperExcursionInput(closed)!]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ resolution: 'intraday', mfeR: 0.8, maeR: -0.6, realizedR: 0.6 });
  });
});
