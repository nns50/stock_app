import { describe, it, expect } from 'vitest';
import { replayExit, aggregateReplay, type ExitRules, type ReplayInput } from '../src/services/exitReplay';
import type { Candle } from '../src/providers/types';

// A long from 100 with its initial stop at 95 — so 1R = 5.00 in price terms,
// and every R below reads directly off the price.
const LONG: ReplayInput = { side: 'long', entryPrice: 100, initialStopPrice: 95 };
const SHORT: ReplayInput = { side: 'short', entryPrice: 100, initialStopPrice: 105 };

let t = 0;
const bar = (low: number, high: number, close?: number): Candle =>
  ({
    time: (t += 300_000),
    open: (low + high) / 2,
    high,
    low,
    close: close ?? (low + high) / 2,
    volume: 1000,
  }) as Candle;

const rules = (over: Partial<ExitRules> = {}): ExitRules => ({
  breakevenTriggerR: 0.25,
  trailStartR: 0.5,
  trailStopR: 0.5,
  targetR: 2,
  ...over,
});

describe('replayExit', () => {
  it('books the initial stop at exactly -1R', () => {
    const r = replayExit(LONG, [bar(94, 101)], rules())!;
    expect(r.exitR).toBe(-1);
    expect(r.reason).toBe('stop');
  });

  it('books the target at exactly the target R', () => {
    // 2R above 100 is 110.
    const r = replayExit(LONG, [bar(99, 110)], rules())!;
    expect(r.exitR).toBe(2);
    expect(r.reason).toBe('target');
  });

  it('closes at the last CLOSE when nothing fires — the time exit', () => {
    const r = replayExit(LONG, [bar(99, 101), bar(100, 101, 100.5)], rules({ breakevenTriggerR: 0, trailStartR: 0 }))!;
    expect(r.reason).toBe('time_exit');
    expect(r.exitR).toBe(0.1); // 100.5 is 0.5/5 = 0.1R
  });

  // -------------------------------------------------------------------------
  // The assumption the whole module exists to make honest.
  // -------------------------------------------------------------------------
  it('resolves an ambiguous bar AGAINST the trade — stop before target', () => {
    // One bar spanning both the stop (95) and the target (110). We cannot know
    // which came first, so the stop fills. A replay that chose the target here
    // would flatter every tighter geometry under test.
    const r = replayExit(LONG, [bar(95, 110)], rules())!;
    expect(r.exitR).toBe(-1);
    expect(r.reason).toBe('stop');
  });

  it('charges a tighter trail for the dip that a peak-and-distance model cannot see', () => {
    // Runs to +0.6R (103), pulls back to +0.1R (100.5), then runs to +1.5R.
    // A "peak minus D" model sees peak 1.5R and reports 1.5 - D for any D.
    // The real path takes out a 0.5R-wide trail on the pullback.
    const path = [bar(99, 103), bar(100.5, 102), bar(101, 107.5, 107)];
    const tight = replayExit(LONG, path, rules({ trailStartR: 0.5, trailStopR: 0.5, targetR: 0 }))!;
    // Trail armed at 0.6R best -> stop 0.1R; the second bar's low of 100.5 is
    // exactly 0.1R, so it fills there rather than riding to 1.5R.
    expect(tight.reason).toBe('trail');
    expect(tight.exitR).toBeCloseTo(0.1, 2);
    // A WIDER trail survives the same pullback and keeps the run.
    const wide = replayExit(LONG, path, rules({ trailStartR: 0.5, trailStopR: 1.5, targetR: 0 }))!;
    expect(wide.reason).toBe('time_exit');
    expect(wide.exitR).toBeGreaterThan(tight.exitR);
  });

  it('never loosens a stop once ratcheted', () => {
    // Best reaches 1.0R (105) then the trade fades. The trail must not follow
    // it back down.
    const r = replayExit(LONG, [bar(99, 105), bar(102, 103), bar(99, 100)], rules({ trailStopR: 0.5, targetR: 0 }))!;
    expect(r.reason).toBe('trail');
    expect(r.exitR).toBeCloseTo(0.5, 2); // 1.0R best - 0.5R trail, held
  });

  it('a WIDE trail arming must not loosen a stop already at breakeven', () => {
    // The case the monotonic-bestR argument misses. bestR only ever rises, so
    // `bestR - trailStopR` rises too and the ratchet looks redundant — until
    // the trail ARMS with a distance wider than the progress made. Best 0.6R
    // with a 1.5R-wide trail computes a stop at -0.9R, BELOW the breakeven stop
    // already earned at 0.25R. Without the ratchet the trade gives back
    // protection it had, and takes a loss it had already escaped.
    const path = [bar(99, 103), bar(97.5, 100)]; // +0.6R, then back to -0.5R
    const r = replayExit(
      LONG,
      path,
      rules({ breakevenTriggerR: 0.25, trailStartR: 0.5, trailStopR: 1.5, targetR: 0 }),
    )!;
    expect(r.exitR).toBe(0); // held at breakeven, not -0.9R
    expect(r.exitR).toBeGreaterThanOrEqual(0);
  });

  it('moves to breakeven and books 0R, not a loss', () => {
    const r = replayExit(LONG, [bar(99, 101.5), bar(99, 100.5)], rules({ trailStartR: 0, targetR: 0 }))!;
    expect(r.reason).toBe('breakeven');
    expect(r.exitR).toBe(0);
  });

  it('leaves the stop at -1R when the breakeven trigger is never reached', () => {
    const r = replayExit(LONG, [bar(99, 101), bar(94, 100)], rules({ breakevenTriggerR: 0.25, trailStartR: 0 }))!;
    expect(r.exitR).toBe(-1);
    expect(r.reason).toBe('stop');
  });

  it('reports bestR, so the cost of cutting a trade short is visible', () => {
    const r = replayExit(LONG, [bar(99, 105), bar(99, 100)], rules({ trailStartR: 0.5, trailStopR: 0.5, targetR: 0 }))!;
    expect(r.bestR).toBeCloseTo(1.0, 2);
    expect(r.exitR).toBeLessThan(r.bestR); // the give-back, measured
  });

  // -------------------------------------------------------------------------
  // Shorts are not an afterthought — tradeDirection can be 'both'.
  // -------------------------------------------------------------------------
  it('mirrors every rule for a short', () => {
    expect(replayExit(SHORT, [bar(99, 106)], rules())!.exitR).toBe(-1); // stop at 105
    expect(replayExit(SHORT, [bar(90, 101)], rules())!.exitR).toBe(2); // target at 90
    const trailed = replayExit(SHORT, [bar(95, 101), bar(97, 99.5)], rules({ trailStopR: 0.5, targetR: 0 }))!;
    expect(trailed.reason).toBe('trail');
    expect(trailed.exitR).toBeCloseTo(0.5, 2);
  });

  // -------------------------------------------------------------------------
  // Unmeasurable must stay unmeasurable.
  // -------------------------------------------------------------------------
  it('returns null rather than 0 when it cannot be replayed', () => {
    expect(replayExit(LONG, [], rules())).toBeNull();
    // Entry == stop: 1R is zero wide and every R would be infinite.
    expect(replayExit({ side: 'long', entryPrice: 100, initialStopPrice: 100 }, [bar(99, 101)], rules())).toBeNull();
  });
});

describe('aggregateReplay', () => {
  it('counts how each geometry ENDED its trades, not just the mean', () => {
    // A geometry that lifts the mean by turning time exits into stops is a
    // different bet from one that turns them into targets, and a mean cannot
    // tell them apart.
    const agg = aggregateReplay([
      { exitR: 2, reason: 'target', barsHeld: 3, bestR: 2 },
      { exitR: -1, reason: 'stop', barsHeld: 1, bestR: 0.1 },
      { exitR: 0.3, reason: 'time_exit', barsHeld: 9, bestR: 0.5 },
    ]);
    expect(agg.trades).toBe(3);
    expect(agg.meanR).toBeCloseTo(0.43, 2);
    expect(agg.medianR).toBe(0.3);
    expect(agg.reasons).toEqual({ stop: 1, breakeven: 0, trail: 0, target: 1, time_exit: 1 });
  });

  it('reports null averages for an empty set, never 0', () => {
    const agg = aggregateReplay([]);
    expect(agg.trades).toBe(0);
    expect(agg.meanR).toBeNull();
    expect(agg.medianR).toBeNull();
  });
});
