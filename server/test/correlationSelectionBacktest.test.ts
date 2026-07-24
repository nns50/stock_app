import { describe, it, expect } from 'vitest';
import { simulateBacktest, BacktestConfig } from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';

// Correlation-aware selection, exercised through the real backtest engine.
// Two perfectly-correlated names (identical price paths → r = 1) plus one
// uncorrelated name, under a 2-position cap: with the flag OFF the two
// correlated names fill both slots; with it ON the redundant one is demoted so
// the uncorrelated name takes the second slot instead.

const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };
const STARTING_EQUITY = 100_000;

function d(base: string, offsetDays: number): string {
  const dt = new Date(`${base}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

function bar(day: string, close: number, volume = 500_000): Candle {
  return {
    time: Date.parse(`${day}T00:00:00Z`),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  };
}

// The correlated pair (AAA, BBB) share a small mean-reverting zig-zag: identical
// paths → r = 1, and an RSI-near-sweet-spot profile that scores WELL. The
// diverse name (CCC) is a steady uptrend: a valid long candidate, but it scores
// BELOW the pair and its steady daily returns are uncorrelated with the
// alternating zig-zag. So the score sort is [AAA, BBB, CCC] — the correlated
// pair on top — which is exactly the setup where the re-rank changes the
// outcome: without it the pair takes both slots; with it the redundant BBB is
// demoted so CCC wins the second slot.
function trendSeries(signalDay: string, kind: 'zigzag' | 'up'): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 0; i--) {
    const day = d(signalDay, -i);
    const t = 60 - i;
    const close = kind === 'zigzag' ? 100 + (t % 2 === 0 ? 1 : -1) : 100 + t * 0.25;
    days.push(bar(day, close));
  }
  return days;
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['AAA', 'BBB', 'CCC'],
    from: '2024-03-01',
    to: '2024-03-02',
    riskProfile: 'MODERATE',
    startingEquity: STARTING_EQUITY,
    maxConcurrentPositions: 2,
    maxAggregateOpenRiskPct: 100,
    // Relax the correlated-EXPOSURE veto so it isn't what blocks the redundant
    // name — that veto already handles the perfectly-correlated case on its own.
    // The point here is the re-rank's effect when the POSITION CAP is the
    // binding constraint instead, which is where a redundant name would
    // otherwise crowd out a diverse pick.
    maxCorrelatedExposurePct: 1000,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

describe('correlation-aware selection in simulateBacktest', () => {
  const signalDay = '2024-03-01';
  const entryDay = d(signalDay, 1);
  function history() {
    return new Map<string, Candle[]>([
      ['AAA', [...trendSeries(signalDay, 'zigzag'), bar(entryDay, 101)]],
      ['BBB', [...trendSeries(signalDay, 'zigzag'), bar(entryDay, 101)]], // identical to AAA → r = 1
      ['CCC', [...trendSeries(signalDay, 'up'), bar(entryDay, 116)]],
    ]);
  }

  it('with the flag OFF, both correlated names fill the 2-position cap', () => {
    const report = simulateBacktest(history(), baseConfig({ correlationAwareSelectionEnabled: false }));
    const entered = new Set(report.trades.filter((t) => t.entryDate === entryDay).map((t) => t.symbol));
    expect(entered.has('AAA')).toBe(true);
    expect(entered.has('BBB')).toBe(true);
    expect(entered.has('CCC')).toBe(false);
  });

  it('with the flag ON, the redundant correlated name is demoted and the diverse name enters', () => {
    const report = simulateBacktest(history(), baseConfig({ correlationAwareSelectionEnabled: true }));
    const entered = new Set(report.trades.filter((t) => t.entryDate === entryDay).map((t) => t.symbol));
    expect(entered.has('AAA')).toBe(true); // top pick keeps its slot
    expect(entered.has('CCC')).toBe(true); // diverse pick now wins the second slot
    expect(entered.has('BBB')).toBe(false); // demoted behind CCC, cap exhausted
  });
});
