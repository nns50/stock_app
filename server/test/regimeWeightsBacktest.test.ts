import { describe, it, expect } from 'vitest';
import { simulateBacktest, BacktestConfig } from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';
import { defaultScreenerConfig } from '../src/indicators/screener';

// Regime-conditional weights exercised through the real backtest engine.

const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };
const DEFAULTS = defaultScreenerConfig().weights;

function d(base: string, offsetDays: number): string {
  const dt = new Date(`${base}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}
function bar(day: string, close: number, range = 2): Candle {
  return {
    time: Date.parse(`${day}T00:00:00Z`),
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 500_000,
  };
}
// 60 flat warmup days ending the day before signalDay, then the signal day.
function warmupThrough(signalDay: string): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 1; i--) days.push(bar(d(signalDay, -i), 100));
  days.push(bar(signalDay, 100));
  return days;
}
// A proxy series long enough for the day range, trending down with big swings so
// the derived regime is a stable risk-off across the whole window.
function riskOffProxy(signalDay: string, throughDay: string): Candle[] {
  const bars: Candle[] = [];
  for (let i = 210; i >= 0; i--) {
    const close = 205 - (210 - i) * 0.5;
    bars.push(bar(d(signalDay, -i), close, 10));
  }
  bars.push(bar(throughDay, 100, 10));
  return bars;
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['TEST'],
    from: '2024-03-01',
    to: '2024-03-02',
    riskProfile: 'MODERATE',
    startingEquity: 100_000,
    maxConcurrentPositions: 2,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

describe('regime-conditional weights in simulateBacktest', () => {
  const signalDay = '2024-03-01';
  const entryDay = d(signalDay, 1);
  const history = () => new Map<string, Candle[]>([['TEST', [...warmupThrough(signalDay), bar(entryDay, 102)]]]);

  it('is a safe no-op when enabled but no proxy series is supplied (identical to off)', () => {
    const off = simulateBacktest(history(), baseConfig({ from: signalDay, to: entryDay }));
    // Enabled, with presets, but benchmarkCandles omitted → regimeLabelFromProxy
    // returns null → weights unchanged → byte-identical trades.
    const onNoProxy = simulateBacktest(
      history(),
      baseConfig({
        from: signalDay,
        to: entryDay,
        regimeAdaptiveWeightsEnabled: true,
        regimeWeightPresets: {
          riskOn: DEFAULTS,
          neutral: DEFAULTS,
          riskOff: { ...DEFAULTS, momentum: 0, trend: 100 },
        },
      }),
    );
    expect(onNoProxy.trades.map((t) => `${t.symbol}@${t.entryDate}`)).toEqual(
      off.trades.map((t) => `${t.symbol}@${t.entryDate}`),
    );
  });

  it('scores with the risk-off preset when a risk-off proxy is supplied (per-day path runs)', () => {
    // A risk-off preset that zeroes every core weight: every candidate totals 0,
    // but still passes the relaxed filters, so the run completes and produces the
    // entry — proving the regime→preset path executes end-to-end without error.
    const proxy = riskOffProxy(signalDay, entryDay);
    const report = simulateBacktest(
      history(),
      baseConfig({
        from: signalDay,
        to: entryDay,
        regimeAdaptiveWeightsEnabled: true,
        regimeWeightPresets: {
          riskOn: DEFAULTS,
          neutral: DEFAULTS,
          riskOff: {
            momentum: 0,
            relativeVolume: 0,
            rsi: 0,
            volatility: 0,
            gap: 0,
            trend: 0,
            relativeStrength: 0,
            sentiment: 0,
          },
        },
      }),
      undefined,
      proxy,
    );
    expect(report.trades.some((t) => t.symbol === 'TEST' && t.entryDate === entryDay)).toBe(true);
  });
});
