import { describe, it, expect, vi } from 'vitest';
import { Candle } from '../src/providers/types';
import { AutotradeConfig, defaultAutotradeConfig } from '../src/db/autotradeConfig';
import {
  barsFromSignal,
  buildShortShadowRecord,
  dedupeBySymbolDay,
  liveExitRules,
  redTapeGateOf,
  SHORT_ENABLE_GATE,
  SHORT_RED_TAPE_GATE,
  type ShadowTrade,
  type SkippedShort,
} from '../src/services/autotrading/shortShadowRecord';

/** 2026-09-10 09:35 ET, in epoch ms — a normal mid-morning signal. */
const T0 = Date.parse('2026-09-10T13:35:00Z');
const MIN = 60_000;

function bar(offsetMin: number, high: number, low: number): Candle {
  return { time: T0 + offsetMin * MIN, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}

/** A bar with every price given. The replay enters at the signal's own price
 *  plus the entry concession (replay version 2), so a test about exits passes
 *  EXACT (no concession) to keep 1R at $2, and opens its first bar at the
 *  signal's 100 so the bars and the fill agree. */
function ohlc(offsetMin: number, open: number, high: number, low: number, close: number): Candle {
  return { time: T0 + offsetMin * MIN, open, high, low, close, volume: 1000 };
}
const EXACT = { entryConcessionPct: 0 };

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
    expect(
      liveExitRules(cfg({ targetRMultiple: 1.5, breakevenTriggerRMultiple: 0.25, liveTrailingEnabled: true })),
    ).toMatchObject({
      targetR: 1.5,
      breakevenTriggerR: 0.25,
    });
  });

  // 2026-09-23. stopAdjust.ts moves no live stop while liveTrailingEnabled is
  // off; this read breakeven and the trail regardless, so a shadow could credit
  // a ratchet the live book never makes.
  it('turns breakeven and the trail off when the live book does not trail', () => {
    expect(
      liveExitRules(
        cfg({
          breakevenTriggerRMultiple: 0.25,
          trailStartRMultiple: 0.5,
          trailStopRMultiple: 0.5,
          liveTrailingEnabled: false,
        }),
      ),
    ).toMatchObject({ breakevenTriggerR: 0, trailStartR: 0, trailStopR: 0 });
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
    // Trades through 96 = the 2R target for a short entered at 100 with a 102 stop.
    const src = sourceOf({ KLAC: [ohlc(0, 100, 100, 99, 99), bar(5, 99, 97), bar(10, 97, 95.5)] });
    const out = await buildShortShadowRecord(src, [shortAt100()], cfg(), EXACT);
    expect(out.n).toBe(1);
    expect(out.trades[0].reason).toBe('target');
    expect(out.trades[0].exitR).toBeCloseTo(2, 5);
    expect(out.avgR).toBeCloseTo(2, 5);
    expect(out.winRatePct).toBe(100);
  });

  it('banks the scale-out on a winner that gives everything back — the understatement this fixes', async () => {
    // Short at 100, stop 102, so 1R = $2. Closes at 99.5 (0.25R, the scale-out
    // trigger: the live scale-out reads a tick's price, so the replay arms it on
    // a close) and then runs all the way back to the 102 stop. Without the
    // scale-out that is a clean -1R. With 67% banked at 0.25R it is materially
    // better, because two thirds of the position left at a profit.
    const src = sourceOf({ KLAC: [ohlc(0, 100, 100, 99.4, 99.5), bar(5, 102.5, 101)] });
    const withScaleOut = await buildShortShadowRecord(
      src,
      [shortAt100()],
      cfg({ liveScaleOutEnabled: true, partialExitRMultiple: 0.25, partialExitPct: 67 }),
      EXACT,
    );
    const without = await buildShortShadowRecord(src, [shortAt100()], cfg({ liveScaleOutEnabled: false }), EXACT);

    expect(without.trades[0].exitR).toBeCloseTo(-1, 5);
    expect(withScaleOut.trades[0].exitR).toBeGreaterThan(without.trades[0].exitR);
  });

  it('carries the exit geometry that produced its numbers', async () => {
    // 2026-09-14. Every figure this record reports is a function of the live
    // exit rules, and on 2026-09-14 three of them moved in a single settings
    // PUT: targetR 2 -> 1, the scale-out off, the stagnation timer 90 -> 60.
    // The previous case proves the same bars give a different exitR under a
    // different geometry; this one proves the record SAYS which geometry, so a
    // reader comparing two evenings cannot mistake a knob turn for the shorts
    // getting better. The gate below puts real money on a threshold.
    const src = sourceOf({ KLAC: [ohlc(0, 100, 100, 99.4, 99.5), bar(5, 102.5, 101)] });
    const before = await buildShortShadowRecord(
      src,
      [shortAt100()],
      cfg({ targetRMultiple: 2, liveScaleOutEnabled: true, partialExitRMultiple: 0.25, stagnationExitMinutes: 90 }),
      EXACT,
    );
    const after = await buildShortShadowRecord(
      src,
      [shortAt100()],
      cfg({ targetRMultiple: 1, liveScaleOutEnabled: false, stagnationExitMinutes: 60 }),
      EXACT,
    );

    expect(before.exitRules).toMatchObject({ targetR: 2, scaleOutR: 0.25, stagnationMinutes: 90 });
    expect(after.exitRules).toMatchObject({ targetR: 1, scaleOutR: 0, stagnationMinutes: 60 });
    // And the provenance is not decorative: the numbers really did move.
    expect(after.trades[0].exitR).not.toBeCloseTo(before.trades[0].exitR, 5);
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

  // RAISING THE FLOOR MUST NOT RE-SCORE HISTORY (2026-09-14).
  //
  // `live_short_skipped` carries the floor in force when it was written, for
  // the reason liveExecute.ts states at the write site: "the floor travels
  // with the row so a later change to liveMinSignalScore cannot silently
  // rewrite history". This filter read CURRENT config instead, so the field
  // was journaled to prevent a thing and nothing read it — and the thing
  // happened. The floor went 72 -> 81 that afternoon (the exposure-neutral
  // partner to pace scoring) and the eligible sample fell from 32 rows to 1,
  // reading as "shorts stopped qualifying" rather than "the yardstick moved".
  //
  // The like-for-like point is the sharper one: those scores came from RAW
  // relative-volume scoring, and 81 is calibrated for PACE scoring — the
  // shadow's own re-fit puts pace-at-80.8 level with raw-at-72.
  it('judges a row by the floor in force WHEN IT WAS SKIPPED, not the floor today', async () => {
    const src = sourceOf({ KLAC: [bar(0, 100, 95)] });
    // Scored 75 against a floor of 72 on the day; the floor is 81 now.
    const out = await buildShortShadowRecord(
      src,
      [shortAt100({ score: 75, floorAtSkip: 72 })],
      cfg({ liveMinSignalScore: 81 }),
    );
    expect(out.excluded.below_live_floor).toBe(0);
    expect(out.n).toBe(1);
  });

  it('still excludes a row that was below the floor of ITS OWN day', async () => {
    // The stamped floor cuts both ways: it is the row's own verdict, not a
    // licence to admit everything that today's lower bar would let in.
    const src = sourceOf({ KLAC: [bar(0, 100, 95)] });
    const out = await buildShortShadowRecord(
      src,
      [shortAt100({ score: 65, floorAtSkip: 72 })],
      cfg({ liveMinSignalScore: 60 }),
    );
    expect(out.n).toBe(0);
    expect(out.excluded.below_live_floor).toBe(1);
  });

  it('falls back to the current floor for a row written before the field existed', async () => {
    const src = sourceOf({ KLAC: [bar(0, 100, 95)] });
    const out = await buildShortShadowRecord(src, [shortAt100({ score: 65 })], cfg({ liveMinSignalScore: 72 }));
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
    const bars = Object.fromEntries(
      many.map(({ row, offsetMin }) => [row.symbol, [ohlc(offsetMin, 100, 100, 95.5, 96)]]),
    );
    const out = await buildShortShadowRecord(
      sourceOf(bars),
      many.map((m) => m.row),
      cfg(),
      EXACT,
    );
    expect(out.n).toBe(SHORT_ENABLE_GATE.minTrades);
    expect(out.gate).toMatchObject({ passesN: true, passesAvgR: true, passesWinRate: true, passes: true });
  });

  it('fails the gate on sample size alone, even with a perfect record', async () => {
    const out = await buildShortShadowRecord(
      sourceOf({ KLAC: [ohlc(0, 100, 100, 95.5, 96)] }),
      [shortAt100()],
      cfg(),
      EXACT,
    );
    expect(out.n).toBe(1);
    expect(out.gate.passesAvgR).toBe(true);
    expect(out.gate.passesWinRate).toBe(true);
    expect(out.gate.passesN).toBe(false);
    expect(out.gate.passes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE ATR GATE AND THE TAPE (2026-09-24, the tape plan's PR 4).
// ---------------------------------------------------------------------------
describe('buildShortShadowRecord — the ATR reachability gate the live path applies next', () => {
  // A short at 100 with its stop at 102: 1R is $2. At the book's 0.7, an ATR
  // under $2.86 makes that stop unreachable in a session.
  const win = { KLAC: [ohlc(0, 100, 100, 95.5, 96)], AMD: [ohlc(0, 100, 100, 95.5, 96)] };

  it('refuses a row whose stop is past the fraction of its own ATR, and counts one that carries none', async () => {
    const out = await buildShortShadowRecord(
      sourceOf(win),
      [shortAt100({ atr: 2.5 }), shortAt100({ symbol: 'AMD' })],
      cfg({ maxRiskAtrFraction: 0.7 }),
      EXACT,
    );
    expect(out.excluded.refused_by_atr_reach).toBe(1);
    expect(out.trades.map((t) => t.symbol)).toEqual(['AMD']);
    expect(out.atrReach).toEqual({ maxRiskAtrFraction: 0.7, refused: 1, unchecked: 1 });
  });

  it('keeps a row whose stop the ATR can reach, and replays nothing of the gate while it is off', async () => {
    const reachable = await buildShortShadowRecord(
      sourceOf(win),
      [shortAt100({ atr: 3 })],
      cfg({ maxRiskAtrFraction: 0.7 }),
      EXACT,
    );
    expect(reachable.n).toBe(1);
    expect(reachable.atrReach).toEqual({ maxRiskAtrFraction: 0.7, refused: 0, unchecked: 0 });

    const off = await buildShortShadowRecord(
      sourceOf(win),
      [shortAt100({ atr: 2.5 })],
      cfg({ maxRiskAtrFraction: 0 }),
      EXACT,
    );
    expect(off.n).toBe(1);
    expect(off.atrReach).toBeNull();
  });
});

describe('buildShortShadowRecord — by tape', () => {
  const winning = [ohlc(0, 100, 100, 95.5, 96)];

  it('puts each row on the tape it was declined on, and reads every tape even with the gate on', async () => {
    const out = await buildShortShadowRecord(
      sourceOf({ KLAC: winning, AMD: winning, NVDA: winning, TSLA: winning }),
      [
        shortAt100({ directionAtSkip: 'red' }),
        shortAt100({ symbol: 'AMD', at: T0 - 1, directionAtSkip: 'green' }),
        shortAt100({ symbol: 'NVDA', directionAtSkip: 'unknown' }),
        shortAt100({ symbol: 'TSLA' }),
      ],
      cfg({ marketDirectionGateEnabled: true }),
      // The journal agrees AMD's moment was green, so the gate replay on the
      // whole record refuses it; the tape split must not.
      { ...EXACT, directionAt: (at) => (at === T0 - 1 ? 'green' : null) },
    );
    expect(out.excluded.refused_by_direction).toBe(1);
    expect(out.trades.map((t) => t.symbol)).not.toContain('AMD');
    expect(out.byTape.red.trades.map((t) => t.symbol)).toEqual(['KLAC']);
    // The gate would refuse a short on a green tape; the split still reads it.
    expect(out.byTape.green.trades.map((t) => t.symbol)).toEqual(['AMD']);
    expect(out.byTape.mixed.n).toBe(0);
    // An unknown reading, and no reading at all, are not a tape.
    expect(out.byTape.unlabeled.trades.map((t) => t.symbol).sort()).toEqual(['NVDA', 'TSLA']);
  });
});

describe('redTapeGateOf — the red-tape bar', () => {
  const trades = (...rs: number[]) => ({ trades: rs.map((exitR) => ({ exitR }) as ShadowTrade) });
  const none = trades();
  const g = SHORT_RED_TAPE_GATE;

  it('passes only when the count, the average, the win rate and the edge over the other tapes all do', () => {
    // 20 red trades: 12 at +0.5R and 8 at -0.35R, so +0.16R at 60%.
    const red = trades(...Array(12).fill(0.5), ...Array(8).fill(-0.35));
    const out = redTapeGateOf({ red, mixed: trades(0, 0.1), green: trades(-0.1), unlabeled: trades(5) });
    expect(out.n).toBe(g.minTrades);
    expect(out.avgR).toBeCloseTo(0.16, 9);
    expect(out.winRatePct).toBe(60);
    // Mixed and green pooled; an unlabeled trade is not an "other tape".
    expect(out.otherTapesN).toBe(3);
    expect(out.otherTapesAvgR).toBeCloseTo(0, 9);
    expect(out.edgeR).toBeCloseTo(0.16, 9);
    expect(out).toMatchObject({ passesN: true, passesAvgR: true, passesWinRate: true, passesEdge: true, passes: true });
  });

  it('fails on each leg alone', () => {
    const base = [...Array(12).fill(0.5), ...Array(8).fill(-0.35)];
    expect(
      redTapeGateOf({ red: trades(...base.slice(1)), mixed: none, green: trades(0), unlabeled: none }),
    ).toMatchObject({ passesN: false, passes: false });
    const thin = [...Array(12).fill(0.3), ...Array(8).fill(-0.2)]; // +0.10R
    expect(redTapeGateOf({ red: trades(...thin), mixed: trades(0), green: none, unlabeled: none })).toMatchObject({
      passesAvgR: false,
      passes: false,
    });
    const coinFlip = [...Array(9).fill(1), ...Array(11).fill(-0.5)]; // +0.175R at 45%
    expect(redTapeGateOf({ red: trades(...coinFlip), mixed: trades(0), green: none, unlabeled: none })).toMatchObject({
      passesAvgR: true,
      passesWinRate: false,
      passes: false,
    });
    // Every tape paying the same is not a red-tape edge.
    expect(redTapeGateOf({ red: trades(...base), mixed: trades(0.16), green: none, unlabeled: none })).toMatchObject({
      passesEdge: false,
      passes: false,
    });
  });

  it('cannot pass the edge with nothing to compare it to', () => {
    const out = redTapeGateOf({ red: trades(...Array(20).fill(0.5)), mixed: none, green: none, unlabeled: none });
    expect(out.edgeR).toBeNull();
    expect(out.passesEdge).toBe(false);
    expect(out.passes).toBe(false);
  });

  it('does not fail a bar on the last bit of a float sum', () => {
    // (-0.17 + 0.47) / 2 computes to 0.14999999999999997: a mean of exactly
    // +0.15R, the bar, one bit under it.
    const avgOnTheBar = redTapeGateOf({ red: trades(-0.17, 0.47), mixed: trades(0), green: none, unlabeled: none });
    expect(avgOnTheBar.avgR).toBeLessThan(0.15);
    expect(avgOnTheBar.passesAvgR).toBe(true);
    // 0.15 - 0.05 computes to 0.09999999999999999: an edge of exactly +0.10R.
    const edgeOnTheBar = redTapeGateOf({ red: trades(0.35, -0.05), mixed: trades(0.05), green: none, unlabeled: none });
    expect(edgeOnTheBar.edgeR).toBeLessThan(0.1);
    expect(edgeOnTheBar.passesEdge).toBe(true);
  });
});
