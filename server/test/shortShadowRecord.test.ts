import { describe, it, expect, vi } from 'vitest';
import { Candle } from '../src/providers/types';
import { AutotradeConfig, defaultAutotradeConfig } from '../src/db/autotradeConfig';
import {
  barsFromSignal,
  buildShortShadowRecord,
  dedupeBySymbolDay,
  liveExitRules,
  SHORT_ENABLE_GATE,
  type SkippedShort,
} from '../src/services/autotrading/shortShadowRecord';

/** 2026-09-10 09:35 ET, in epoch ms — a normal mid-morning signal. */
const T0 = Date.parse('2026-09-10T13:35:00Z');
const MIN = 60_000;

function bar(offsetMin: number, high: number, low: number): Candle {
  return { time: T0 + offsetMin * MIN, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}

const cfg = (over: Partial<AutotradeConfig> = {}): AutotradeConfig => ({
  ...defaultAutotradeConfig(),
  liveMinSignalScore: 72,
  targetRMultiple: 2,
  breakevenTriggerRMultiple: 0,
  trailStartRMultiple: 0,
  trailStopRMultiple: 0,
  ...over,
});

/** A short at 100 with its stop at 102, so 1R is $2 and the 2R target is 96. */
const shortAt100 = (over: Partial<SkippedShort> = {}): SkippedShort => ({
  symbol: 'KLAC',
  at: T0,
  score: 80,
  entry: 100,
  stop: 102,
  ...over,
});

const sourceOf = (bars: Record<string, Candle[]>) => ({
  getCandles: vi.fn(async (symbol: string) => bars[symbol] ?? []),
});

describe('dedupeBySymbolDay', () => {
  it('keeps the EARLIEST row per symbol per ET day — the moment live declined it', () => {
    const rows = [shortAt100({ at: T0 + 30 * MIN, entry: 99 }), shortAt100({ at: T0, entry: 100 })];
    const { kept, dropped } = dedupeBySymbolDay(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0].entry).toBe(100);
    expect(dropped).toBe(1);
  });

  it('keeps the same symbol on a DIFFERENT day — one trade per symbol per session, not per lifetime', () => {
    const nextDay = T0 + 24 * 60 * MIN;
    const { kept, dropped } = dedupeBySymbolDay([shortAt100(), shortAt100({ at: nextDay })]);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });
});

describe('barsFromSignal', () => {
  it('drops bars from before the signal — a short declined at 14:00 gets no credit for the morning', () => {
    const bars = [bar(-30, 105, 104), bar(0, 100, 99), bar(5, 99, 98)];
    expect(barsFromSignal(bars, T0)).toHaveLength(2);
  });
});

describe('liveExitRules', () => {
  it('reads the book its own geometry, so the shadow moves when the book does', () => {
    expect(liveExitRules(cfg({ targetRMultiple: 1.5, breakevenTriggerRMultiple: 0.25 }))).toMatchObject({
      targetR: 1.5,
      breakevenTriggerR: 0.25,
    });
  });

  // 2026-09-11: exitReplay learned the scale-out and the stagnation timer in
  // #563, the day after this shipped. The live book runs BOTH, so a record that
  // passed only the four original fields was replaying a geometry the book does
  // not use — and understating, because the scale-out banks gains this record
  // was letting run all the way back to breakeven.
  it('passes the SCALE-OUT and the STAGNATION timer through, because the live book runs both', () => {
    expect(
      liveExitRules(
        cfg({
          liveScaleOutEnabled: true,
          partialExitRMultiple: 0.25,
          partialExitPct: 67,
          stagnationExitMinutes: 90,
          stagnationExitMinR: 0.5,
        }),
      ),
    ).toMatchObject({ scaleOutR: 0.25, scaleOutFraction: 0.67, stagnationMinutes: 90, stagnationMinR: 0.5 });
  });

  it('disables the scale-out when the book has it switched off, rather than replaying one it never runs', () => {
    expect(liveExitRules(cfg({ liveScaleOutEnabled: false, partialExitRMultiple: 0.25 })).scaleOutR).toBe(0);
  });
});

describe('buildShortShadowRecord', () => {
  it('replays a winning short to its target and reports +R', async () => {
    // Falls to 96 = the 2R target for a short entered at 100 with a 102 stop.
    const src = sourceOf({ KLAC: [bar(0, 100, 99), bar(5, 99, 97), bar(10, 97, 95.5)] });
    const out = await buildShortShadowRecord(src, [shortAt100()], cfg());
    expect(out.n).toBe(1);
    expect(out.trades[0].reason).toBe('target');
    expect(out.trades[0].exitR).toBeCloseTo(2, 5);
    expect(out.avgR).toBeCloseTo(2, 5);
    expect(out.winRatePct).toBe(100);
  });

  it('banks the scale-out on a winner that gives everything back — the understatement this fixes', async () => {
    // Short at 100, stop 102, so 1R = $2. Falls to 99.5 (0.25R, the scale-out
    // trigger) and then runs all the way back to the 102 stop. Without the
    // scale-out that is a clean -1R. With 67% banked at 0.25R it is materially
    // better, because two thirds of the position left at a profit.
    const src = sourceOf({ KLAC: [bar(0, 100, 99.4), bar(5, 102.5, 101)] });
    const withScaleOut = await buildShortShadowRecord(
      src,
      [shortAt100()],
      cfg({ liveScaleOutEnabled: true, partialExitRMultiple: 0.25, partialExitPct: 67 }),
    );
    const without = await buildShortShadowRecord(src, [shortAt100()], cfg({ liveScaleOutEnabled: false }));

    expect(without.trades[0].exitR).toBeCloseTo(-1, 5);
    expect(withScaleOut.trades[0].exitR).toBeGreaterThan(without.trades[0].exitR);
  });

  it('replays a losing short to its stop', async () => {
    const src = sourceOf({ KLAC: [bar(0, 101, 100), bar(5, 103, 101)] });
    const out = await buildShortShadowRecord(src, [shortAt100()], cfg());
    expect(out.trades[0].reason).toBe('stop');
    expect(out.trades[0].exitR).toBeCloseTo(-1, 5);
    expect(out.winRatePct).toBe(0);
  });

  it('resolves an ambiguous bar AGAINST the trade, so the record understates shorts', async () => {
    // One bar spans BOTH the 96 target and the 102 stop. exitReplay charges the
    // stop. That pessimism is the point: a gate that passes here passes on the
    // unfavourable reading.
    const src = sourceOf({ KLAC: [bar(0, 103, 95)] });
    const out = await buildShortShadowRecord(src, [shortAt100()], cfg());
    expect(out.trades[0].reason).toBe('stop');
    expect(out.trades[0].exitR).toBeCloseTo(-1, 5);
  });

  it('excludes a signal below the live floor — the 13x overcount this exists to remove', async () => {
    const src = sourceOf({ KLAC: [bar(0, 100, 95)] });
    const out = await buildShortShadowRecord(src, [shortAt100({ score: 65 })], cfg({ liveMinSignalScore: 72 }));
    expect(out.n).toBe(0);
    expect(out.excluded.below_live_floor).toBe(1);
  });

  it('excludes a signal with no measurable 1R rather than dividing by zero', async () => {
    const src = sourceOf({ KLAC: [bar(0, 100, 95)] });
    const out = await buildShortShadowRecord(src, [shortAt100({ stop: 100 })], cfg());
    expect(out.n).toBe(0);
    expect(out.excluded.unusable_signal).toBe(1);
  });

  it('counts a symbol with no bars as unmeasured instead of dropping it silently', async () => {
    const out = await buildShortShadowRecord(sourceOf({}), [shortAt100()], cfg());
    expect(out.n).toBe(0);
    expect(out.excluded.no_bars).toBe(1);
  });

  it('lets one provider failure cost its own signal, never the whole record', async () => {
    const src = {
      getCandles: vi.fn(async (symbol: string) => {
        if (symbol === 'BOOM') throw new Error('provider down');
        return [bar(0, 100, 95)];
      }),
    };
    const out = await buildShortShadowRecord(
      src,
      [shortAt100({ symbol: 'BOOM' }), shortAt100({ symbol: 'KLAC' })],
      cfg(),
    );
    expect(out.n).toBe(1);
    expect(out.trades[0].symbol).toBe('KLAC');
    expect(out.excluded.no_bars).toBe(1);
  });

  it('scores task #21 gate: all three conditions, and passes only when every one does', async () => {
    // 30 identical winners at +2R, one per symbol on its own day. Each one's
    // bar has to sit at ITS OWN signal time — barsFromSignal drops anything
    // earlier, which is the same guard that stops a late signal being credited
    // with the morning's move.
    const many = Array.from({ length: SHORT_ENABLE_GATE.minTrades }, (_, i) => ({
      row: shortAt100({ symbol: `S${i}`, at: T0 + i * 24 * 60 * MIN }),
      offsetMin: i * 24 * 60,
    }));
    const bars = Object.fromEntries(many.map(({ row, offsetMin }) => [row.symbol, [bar(offsetMin, 100, 95.5)]]));
    const out = await buildShortShadowRecord(
      sourceOf(bars),
      many.map((m) => m.row),
      cfg(),
    );
    expect(out.n).toBe(SHORT_ENABLE_GATE.minTrades);
    expect(out.gate).toMatchObject({ passesN: true, passesAvgR: true, passesWinRate: true, passes: true });
  });

  it('fails the gate on sample size alone, even with a perfect record', async () => {
    const out = await buildShortShadowRecord(sourceOf({ KLAC: [bar(0, 100, 95.5)] }), [shortAt100()], cfg());
    expect(out.n).toBe(1);
    expect(out.gate.passesAvgR).toBe(true);
    expect(out.gate.passesWinRate).toBe(true);
    expect(out.gate.passesN).toBe(false);
    expect(out.gate.passes).toBe(false);
  });
});
