import { describe, it, expect, vi } from 'vitest';
import { Candle } from '../src/providers/types';
import { AutotradeConfig, defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { buildDeclinedEntryShadow, SCORE_FLOOR_ACTIONS } from '../src/services/autotrading/declinedEntryShadow';
import type { DeclinedEntry } from '../src/services/autotrading/declinedEntry';

// ---------------------------------------------------------------------------
// The shared replay, exercised on the half the short record never could: a
// declined LONG. The ATR reachability gate refuses ten times as many symbol-days
// as the naked-short gate and every one of them is a long, so a sign error here
// would misread the largest refusal class on the entry path in the direction
// that looks like evidence.
// ---------------------------------------------------------------------------

/** 2026-09-10 09:35 ET, in epoch ms. */
const T0 = Date.parse('2026-09-10T13:35:00Z');
const MIN = 60_000;

function bar(offsetMin: number, high: number, low: number): Candle {
  return { time: T0 + offsetMin * MIN, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}

const cfg = (over: Partial<AutotradeConfig> = {}): AutotradeConfig => ({
  ...defaultAutotradeConfig(),
  liveMinSignalScore: 72,
  targetRMultiple: 1,
  breakevenTriggerRMultiple: 0,
  trailStartRMultiple: 0,
  trailStopRMultiple: 0,
  liveScaleOutEnabled: false,
  stagnationExitMinutes: 0,
  ...over,
});

/** A long at 100 with its stop at 98, so 1R is $2 and the 1R target is 102. */
const longAt100 = (over: Partial<DeclinedEntry> = {}): DeclinedEntry => ({
  symbol: 'MSFT',
  at: T0,
  score: 80,
  entry: 100,
  stop: 98,
  side: 'long',
  ...over,
});

const sourceOf = (bars: Record<string, Candle[]>) => ({
  getCandles: vi.fn(async (symbol: string) => bars[symbol] ?? []),
});

describe('buildDeclinedEntryShadow — a declined LONG', () => {
  it('replays a winner to its target', async () => {
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const out = await buildDeclinedEntryShadow(src, [longAt100()], cfg());
    expect(out.n).toBe(1);
    expect(out.trades[0].exitR).toBeCloseTo(1, 5);
    expect(out.winRatePct).toBe(100);
  });

  it('replays a loser to its stop', async () => {
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 99, 97.5)] });
    const out = await buildDeclinedEntryShadow(src, [longAt100()], cfg());
    expect(out.trades[0].exitR).toBeCloseTo(-1, 5);
    expect(out.winRatePct).toBe(0);
  });

  it('reads the side off the ROW, so a long and a short on identical bars diverge', async () => {
    // The generalisation's whole risk in one case. The same rising bars are a
    // winner for the long and a loser for the short; if the side were assumed
    // rather than read, the ATR gate's refusals (all longs) would be scored as
    // shorts and read exactly backwards.
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const long = await buildDeclinedEntryShadow(src, [longAt100()], cfg());
    const short = await buildDeclinedEntryShadow(src, [longAt100({ side: 'short', stop: 102 })], cfg());
    expect(long.trades[0].exitR).toBeGreaterThan(0);
    expect(short.trades[0].exitR).toBeLessThan(0);
  });

  it('judges each row by the floor that actually declined it', async () => {
    // The #602 defect, generalised. Several of these gates run BEFORE the score
    // floor, so their rows include candidates the book would have declined
    // anyway — and filtering by TODAY's floor re-scores history whenever
    // liveMinSignalScore moves. Raising it 72 -> 81 cut the short record's
    // eligible rows from 32 to 1 that way.
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const pinned = await buildDeclinedEntryShadow(
      src,
      [longAt100({ score: 74, floorAtSkip: 72 })],
      cfg({
        liveMinSignalScore: 81,
      }),
    );
    expect(pinned.n).toBe(1);

    // With no stamp there is nothing to pin to, and the current floor is the
    // best available — the old behaviour, kept deliberately.
    const unpinned = await buildDeclinedEntryShadow(src, [longAt100({ score: 74 })], cfg({ liveMinSignalScore: 81 }));
    expect(unpinned.n).toBe(0);
    expect(unpinned.excluded.below_live_floor).toBe(1);
  });

  it('does not apply the floor filter when the gate under test IS the floor', async () => {
    // The filter's question is "would the book have wanted this candidate at
    // all, setting aside THIS gate". For every gate that runs before the score
    // floor that is right. For the floor's own refusals it deletes exactly the
    // evidence — the rows are below the floor BY DEFINITION — and the replay
    // comes back empty, which reads as "no signal" when it means "wrong
    // question asked".
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const row = longAt100({ score: 65, floorAtSkip: 72 });

    const filtered = await buildDeclinedEntryShadow(src, [row], cfg());
    expect(filtered.n).toBe(0);
    expect(filtered.excluded.below_live_floor).toBe(1);

    const unfiltered = await buildDeclinedEntryShadow(src, [row], cfg(), { applyScoreFloor: false });
    expect(unfiltered.n).toBe(1);
    expect(unfiltered.excluded.below_live_floor).toBe(0);
  });

  it('names the actions whose gate is the floor rather than leaving it to be inferred', () => {
    // finish_line_skipped and regime_score_floor_skipped are the subtle ones:
    // their rows sit ABOVE the everyday floor and were refused by a stricter
    // bar, so the filter would pass them and quietly measure only part of what
    // each rule costs.
    expect([...SCORE_FLOOR_ACTIONS].sort()).toEqual([
      'finish_line_skipped',
      'live_score_floor_skipped',
      'regime_score_floor_skipped',
    ]);
  });

  it('counts a signal with no measurable 1R rather than replaying it', async () => {
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5)] });
    const out = await buildDeclinedEntryShadow(src, [longAt100({ stop: 100 })], cfg());
    expect(out.n).toBe(0);
    expect(out.excluded.unusable_signal).toBe(1);
  });

  it('never credits a refusal with the move that happened before it', async () => {
    // A name refused at 11:00 must not be scored on the 09:35 run-up.
    const src = sourceOf({ MSFT: [bar(0, 103, 102), bar(90, 99, 97.5)] });
    const out = await buildDeclinedEntryShadow(src, [longAt100({ at: T0 + 60 * MIN })], cfg());
    expect(out.trades[0].exitR).toBeCloseTo(-1, 5);
  });

  it('survives a provider failure on one name without losing the record', async () => {
    const src = {
      getCandles: vi.fn(async (symbol: string) => {
        if (symbol === 'GOOGL') throw new Error('provider unavailable');
        return [bar(0, 100.5, 99.5), bar(5, 102.5, 101)];
      }),
    };
    const out = await buildDeclinedEntryShadow(src, [longAt100(), longAt100({ symbol: 'GOOGL' })], cfg());
    expect(out.n).toBe(1);
    expect(out.excluded.no_bars).toBe(1);
  });

  it('carries the exit geometry that produced its numbers', async () => {
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const out = await buildDeclinedEntryShadow(src, [longAt100()], cfg({ targetRMultiple: 1 }));
    expect(out.exitRules).toMatchObject({ targetR: 1, scaleOutR: 0 });
  });

  it('keeps the earliest row per symbol per ET day', async () => {
    const src = sourceOf({ MSFT: [bar(0, 100.5, 99.5), bar(5, 102.5, 101)] });
    const out = await buildDeclinedEntryShadow(
      src,
      [longAt100(), longAt100({ at: T0 + 30 * MIN }), longAt100({ at: T0 + 60 * MIN })],
      cfg(),
    );
    expect(out.n).toBe(1);
    expect(out.excluded.duplicate_same_day).toBe(2);
    expect(out.trades[0].at).toBe(T0);
  });
});
