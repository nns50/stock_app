import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  convictionGrade,
  defaultDecisionConfig,
  generateSignal,
  runAutotradeDecision,
} from '../src/services/autotrading/decide';
import { ScreenCandidate } from '../src/services/autotrading/screen';
import { IndicatorSnapshot } from '../src/indicators/screener';
import { listAutotradeEvents } from '../src/db/autotradeEvents';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_events'));

function ind(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 100,
    changePct: 3,
    maShort: 95,
    maLong: 90,
    distShortPct: 5,
    distLongPct: 10,
    rsi: 65,
    atr: 4,
    atrPct: 4,
    relVolume: 1.8,
    avgVolume: 1_000_000,
    volume: 1_800_000,
    gapPct: 3.5,
    weeklyMaShort: null,
    symbolLookbackReturnPct: null,
    benchmarkLookbackReturnPct: null,
    sentimentNetScore: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    symbol: 'AAPL',
    price: 100,
    total: 72.5,
    passedFilters: true,
    filterReasons: [],
    components: [],
    indicators: ind(),
    discoverySource: 'universe',
    direction: 'long',
    ...overrides,
  };
}

describe('generateSignal', () => {
  it('computes an ATR-based stop and R-multiple target for a long', () => {
    const signal = generateSignal(candidate({ direction: 'long' }), { stopAtrMultiple: 1.5, targetRMultiple: 2 });
    expect(signal).not.toBeNull();
    expect(signal!.side).toBe('buy');
    expect(signal!.entry).toBe(100);
    expect(signal!.stop).toBe(100 - 1.5 * 4); // 94
    expect(signal!.target).toBe(100 + 1.5 * 4 * 2); // entry + 2x the stop distance = 112
    expect(signal!.rMultiple).toBe(2);
  });

  it('mirrors the math for a short — direction comes from the candidate, not cfg', () => {
    const signal = generateSignal(candidate({ direction: 'short' }), { stopAtrMultiple: 1.5, targetRMultiple: 2 });
    expect(signal).not.toBeNull();
    expect(signal!.side).toBe('sell');
    expect(signal!.stop).toBe(100 + 1.5 * 4); // 106
    expect(signal!.target).toBe(100 - 1.5 * 4 * 2); // 88
  });

  it('rounds stop/target to the nearest cent even when the ATR math lands on a sub-penny value', () => {
    // Regression: confirmed in production. stop/target flow straight through
    // to a live bracket order as REAL broker prices (liveExecute.ts's
    // attemptLiveEntry() passes them as bracket.stopLossPrice/takeProfitPrice
    // with no rounding of its own) — an ATR-derived distance is essentially
    // never an exact cent, so an unrounded stop/target here got the WHOLE
    // bracket order rejected by Webull's tick-size validation ("Price
    // increment should be 0.01...") on every single live entry attempt.
    const signal = generateSignal(candidate({ price: 100, direction: 'long', indicators: ind({ atr: 1.23456 }) }), {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
    });
    expect(signal).not.toBeNull();
    // Raw (unrounded) math would give 98.14816 / 103.70368 -- neither is a
    // clean cent.
    expect(signal!.stop).toBe(98.15);
    expect(signal!.target).toBe(103.7);
    expect(String(signal!.stop).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(String(signal!.target).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('returns null when ATR is unavailable (insufficient history)', () => {
    expect(generateSignal(candidate({ indicators: ind({ atr: null }) }))).toBeNull();
  });

  it('returns null when ATR is zero or negative', () => {
    expect(generateSignal(candidate({ indicators: ind({ atr: 0 }) }))).toBeNull();
  });

  it('returns null when the computed stop would be at or below zero', () => {
    // price 2, atr 3, stopAtrMultiple 1.5 -> stop = 2 - 4.5 = negative
    const c = candidate({ price: 2, direction: 'long', indicators: ind({ price: 2, atr: 3 }) });
    expect(generateSignal(c, { stopAtrMultiple: 1.5, targetRMultiple: 2 })).toBeNull();
  });

  it('includes a human-readable rationale', () => {
    const signal = generateSignal(candidate({ direction: 'long' }));
    expect(signal!.rationale).toMatch(/Long breakout/);
    expect(signal!.rationale).toMatch(/ATR/);
  });

  it("mirrors the rationale wording for a short ('Short breakout')", () => {
    const signal = generateSignal(candidate({ direction: 'short' }));
    expect(signal!.rationale).toMatch(/Short breakout/);
  });

  it('defaults to a 1.5x ATR stop, 2R target', () => {
    expect(defaultDecisionConfig()).toEqual({ stopAtrMultiple: 1.5, targetRMultiple: 2 });
  });
});

describe('runAutotradeDecision', () => {
  it('generates a signal per valid candidate and journals it', () => {
    const result = runAutotradeDecision([candidate({ symbol: 'AAPL' }), candidate({ symbol: 'MSFT' })]);
    expect(result.signals).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    const events = listAutotradeEvents({ stage: 'decision' });
    expect(events.filter((e) => e.action === 'signal_generated')).toHaveLength(2);
  });

  it('skips and journals candidates with no usable ATR', () => {
    const result = runAutotradeDecision([candidate({ symbol: 'NOATR', indicators: ind({ atr: null }) })]);
    expect(result.signals).toHaveLength(0);
    expect(result.skipped).toEqual([{ symbol: 'NOATR', reason: expect.stringMatching(/ATR/) }]);
    const events = listAutotradeEvents({ stage: 'decision', symbol: 'NOATR' });
    expect(events[0].action).toBe('no_signal');
  });

  it('applies a config patch (e.g. a tighter stop) across all candidates', () => {
    const result = runAutotradeDecision([candidate()], { stopAtrMultiple: 1 });
    expect(result.signals[0].stop).toBe(100 - 1 * 4); // 96, not the default 1.5x
  });

  it('produces both a buy signal and a sell signal from ONE batch when candidates have mixed direction', () => {
    // The core promise of per-candidate direction: one decision cycle can
    // hold a long on one symbol and a short on another, not just one global
    // direction for the whole batch.
    const result = runAutotradeDecision([
      candidate({ symbol: 'LONGCO', direction: 'long' }),
      candidate({ symbol: 'SHORTCO', direction: 'short' }),
    ]);
    expect(result.signals).toHaveLength(2);
    const longSignal = result.signals.find((s) => s.symbol === 'LONGCO')!;
    const shortSignal = result.signals.find((s) => s.symbol === 'SHORTCO')!;
    expect(longSignal.side).toBe('buy');
    expect(shortSignal.side).toBe('sell');
  });
});

describe('convictionGrade', () => {
  const cfg = { aMinScore: 75, bMinScore: 60 };
  it('grades A at or above the A threshold', () => {
    expect(convictionGrade(75, cfg)).toBe('A');
    expect(convictionGrade(92, cfg)).toBe('A');
  });
  it('grades B between the B and A thresholds', () => {
    expect(convictionGrade(60, cfg)).toBe('B');
    expect(convictionGrade(74.9, cfg)).toBe('B');
  });
  it('grades C below the B threshold', () => {
    expect(convictionGrade(59.9, cfg)).toBe('C');
    expect(convictionGrade(0, cfg)).toBe('C');
  });
  it('sets the entry signal’s grade indirectly via score — generateSignal carries the score used to grade', () => {
    // Sanity: generateSignal exposes the score the grade is derived from.
    const c = candidate({ total: 82 });
    const sig = generateSignal(c, defaultDecisionConfig())!;
    expect(convictionGrade(sig.score, cfg)).toBe('A');
  });
});
