import { describe, it, expect } from 'vitest';
import {
  replayExit,
  aggregateReplay,
  compareExitRules,
  type ExitRules,
  type ReplayInput,
} from '../src/services/exitReplay';
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
      { exitR: 2, reason: 'target', barsHeld: 3, bestR: 2, scaledOut: false, bankedR: 0 },
      { exitR: -1, reason: 'stop', barsHeld: 1, bestR: 0.1, scaledOut: false, bankedR: 0 },
      { exitR: 0.3, reason: 'time_exit', barsHeld: 9, bestR: 0.5, scaledOut: false, bankedR: 0 },
    ]);
    expect(agg.trades).toBe(3);
    expect(agg.meanR).toBeCloseTo(0.43, 2);
    expect(agg.medianR).toBe(0.3);
    expect(agg.reasons).toEqual({ stop: 1, breakeven: 0, trail: 0, target: 1, time_exit: 1, stagnation: 0 });
    expect(agg.scaleOuts).toBe(0);
  });

  it('reports null averages for an empty set, never 0', () => {
    const agg = aggregateReplay([]);
    expect(agg.trades).toBe(0);
    expect(agg.meanR).toBeNull();
    expect(agg.medianR).toBeNull();
  });
});

describe('the scale-out and the stagnation timer (2026-09-11)', () => {
  // The path every case below walks: a 0.6R peak (103) in the first bar, then
  // a dip to 99.5 that stops the trail 0.1R behind that peak.
  const trailPath = () => [bar(99, 103), bar(99.5, 102)];

  it('replays the four-field rules exactly as before when neither is set', () => {
    const a = replayExit(LONG, trailPath(), rules())!;
    const b = replayExit(
      LONG,
      trailPath(),
      rules({ scaleOutR: 0, scaleOutFraction: 0.5, stagnationMinutes: 0, stagnationMinR: 0.5 }),
    )!;
    expect(b).toEqual(a);
    expect(a).toMatchObject({ reason: 'trail', scaledOut: false, bankedR: 0 });
    expect(a.exitR).toBeCloseTo(0.1, 6);
  });

  it('banks the scale-out share at its level and lets the remainder run — a blended R', () => {
    const r = replayExit(LONG, trailPath(), rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 }))!;
    expect(r).toMatchObject({ reason: 'trail', scaledOut: true, bankedR: 0.25 });
    // Half at 0.5R plus half of the remainder's 0.1R trail exit.
    expect(r.exitR).toBeCloseTo(0.3, 6);
    expect(r.bestR).toBeCloseTo(0.6, 6);
  });

  it('resolves a bar holding both the stop and the scale-out level AGAINST the trade', () => {
    const r = replayExit(LONG, [bar(94, 103)], rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 }))!;
    expect(r).toMatchObject({ exitR: -1, reason: 'stop', scaledOut: false, bankedR: 0 });
  });

  it('fills the scale-out before a target in the same bar, so the target takes only the remainder', () => {
    const r = replayExit(LONG, [bar(99, 111)], rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 }))!;
    expect(r).toMatchObject({ reason: 'target', scaledOut: true, bankedR: 0.25 });
    expect(r.exitR).toBeCloseTo(1.25, 6);
  });

  it('a full scale-out books the level and nothing else', () => {
    const r = replayExit(LONG, [bar(99, 103), bar(94, 100)], rules({ scaleOutR: 0.5, scaleOutFraction: 1 }))!;
    expect(r.exitR).toBe(0.5);
    expect(r.bankedR).toBe(0.5);
  });

  it('mirrors the scale-out for a short', () => {
    // 0.5R favourable for the short from 100 with its stop at 105 is 97.5.
    const r = replayExit(SHORT, [bar(97, 101), bar(98, 100.5)], rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 }))!;
    expect(r).toMatchObject({ scaledOut: true, bankedR: 0.25, reason: 'trail' });
  });

  it('scratches a stagnant remainder at the close once the timer has run, and leaves a working one alone', () => {
    // Eight bars hovering at +0.2R (close 101): the 30-minute timer fires at
    // the seventh bar's close, 30 minutes after the first.
    const flat = () => bar(100.5, 101.2, 101);
    const bars = [flat(), flat(), flat(), flat(), flat(), flat(), flat(), flat()];
    const r = replayExit(LONG, bars, rules({ stagnationMinutes: 30, stagnationMinR: 0.5 }))!;
    expect(r).toMatchObject({ reason: 'stagnation', barsHeld: 6, exitR: 0.2, scaledOut: false });
    // Working — at or above the bar — and the timer stands aside.
    expect(replayExit(LONG, bars, rules({ stagnationMinutes: 30, stagnationMinR: 0.15 }))!.reason).toBe('time_exit');
    // 0 minutes: no timer at all.
    expect(replayExit(LONG, bars, rules({ stagnationMinutes: 0, stagnationMinR: 0.5 }))!.reason).toBe('time_exit');
  });

  it('counts scale-outs and stagnation exits in the aggregate', () => {
    const agg = aggregateReplay([
      { exitR: 0.3, reason: 'trail', barsHeld: 2, bestR: 0.6, scaledOut: true, bankedR: 0.25 },
      { exitR: 0.2, reason: 'stagnation', barsHeld: 6, bestR: 0.24, scaledOut: false, bankedR: 0 },
    ]);
    expect(agg.scaleOuts).toBe(1);
    expect(agg.reasons.stagnation).toBe(1);
  });
});

describe('compareExitRules — two shapes over the SAME trades', () => {
  const trailPath = () => [bar(99, 103), bar(99.5, 102)];
  const trades = (n: number) => Array.from({ length: n }, () => ({ input: LONG, bars: trailPath() }));

  it('reads rules that only differ by an inert field as no_change', () => {
    const c = compareExitRules(trades(25), rules(), rules({ scaleOutR: 0, scaleOutFraction: 0.5 }));
    expect(c.verdict).toBe('no_change');
    expect(c.trades).toBe(25);
    expect(c.unpaired).toBe(0);
  });

  it('pairs the arms and calls a uniform gain better and a uniform loss worse', () => {
    const half = rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 });
    const better = compareExitRules(trades(25), rules(), half, { resamples: 300 });
    expect(better.meanDiffR).toBeCloseTo(0.2, 2);
    expect(better.current.replay.scaleOuts).toBe(0);
    expect(better.candidate.replay.scaleOuts).toBe(25);
    expect(better.significance.reliable).toBe(true);
    expect(better.verdict).toBe('better');
    const worse = compareExitRules(trades(25), half, rules(), { resamples: 300 });
    expect(worse.meanDiffR).toBeCloseTo(-0.2, 2);
    expect(worse.verdict).toBe('worse');
  });

  it('is insufficient under 20 paired trades, and a trade either arm cannot replay is unpaired, never a zero', () => {
    const c = compareExitRules(
      [...trades(5), { input: LONG, bars: [] }],
      rules(),
      rules({ scaleOutR: 0.5, scaleOutFraction: 0.5 }),
      { resamples: 100 },
    );
    expect(c.trades).toBe(5);
    expect(c.unpaired).toBe(1);
    expect(c.verdict).toBe('insufficient');
  });
});
