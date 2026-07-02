import { describe, it, expect } from 'vitest';
import { simulateBacktest, BacktestConfig } from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';

// Fully relaxed filters so a signal fires on the very first eligible day
// (once ATR has its 14-day warmup) regardless of the exact price action —
// this makes entry timing fully predictable for hand-verified assertions.
const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };
const STARTING_EQUITY = 100_000;

function d(base: string, offsetDays: number): string {
  const dt = new Date(`${base}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

function bar(day: string, overrides: Partial<Omit<Candle, 'time'>> = {}): Candle {
  return {
    time: Date.parse(`${day}T00:00:00Z`),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 500_000,
    ...overrides,
  };
}

/**
 * 60 flat warmup days (open=high=low=close=100-ish, ATR settles ~2) ending
 * the day before `signalDay`, then the signal day itself. With RELAXED
 * filters, a long signal fires using data through signalDay's close:
 * ATR ≈ 2, entry ≈ 100, stop ≈ 100 - 1.5×2 = 97, target ≈ 100 + 2×3 = 106
 * (defaultDecisionConfig: stopAtrMultiple 1.5, targetRMultiple 2).
 */
function warmupThrough(signalDay: string): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 1; i--) days.push(bar(d(signalDay, -i)));
  days.push(bar(signalDay));
  return days;
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['TEST'],
    from: '2024-03-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: STARTING_EQUITY,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

describe('simulateBacktest', () => {
  it('returns an empty report for an empty history map', () => {
    const report = simulateBacktest(new Map(), baseConfig());
    expect(report.trades).toEqual([]);
    expect(report.finalEquity).toBe(STARTING_EQUITY);
  });

  it("enters at the NEXT day's open, not the signal day's price (no lookahead)", () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    // Gapped up from the ~100 signal-day price (proving entry != signal price)
    // but kept well inside [stop 97, target 106] so nothing closes same-day —
    // isolating the entry mechanics from any exit-timing complexity.
    const history = new Map([
      ['TEST', [...warmupThrough(signalDay), bar(entryDay, { open: 102, high: 103, low: 101, close: 102.5 })]],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: entryDay }));
    expect(report.trades).toHaveLength(1); // force-closed at entryDay's own close, since it's also the last day
    expect(report.trades[0].entryDate).toBe(entryDay);
    expect(report.trades[0].entryPrice).toBe(102); // the NEXT day's open, not signalDay's ~100 close
    expect(report.trades[0].signalDate).toBe(signalDay);
  });

  it('exits at the stop price (not the bar low) when the stop is hit, with the correct pnl and rMultiple', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1); // open 100 — matches the signal's assumed entry exactly
    const stopDay = d(signalDay, 2);
    const history = new Map([
      ['TEST', [...warmupThrough(signalDay), bar(entryDay), bar(stopDay, { open: 98, high: 99, low: 96, close: 97 })]],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: stopDay }));
    expect(report.trades).toHaveLength(1);
    const t = report.trades[0];
    expect(t.exitReason).toBe('stop');
    expect(t.exitDate).toBe(stopDay);
    expect(t.exitPrice).toBe(97); // the STOP level, not the bar's actual low (96)
    // 1% of 100,000 / 3 (|100-97|) = floor(1000/3) = 333 shares
    expect(t.quantity).toBe(333);
    expect(t.pnl).toBeCloseTo((97 - 100) * 333, 5);
    expect(t.rMultiple).toBeCloseTo(-1, 5); // a stop-out is always ~ -1R by construction
    expect(report.finalEquity).toBeCloseTo(STARTING_EQUITY + t.pnl, 5);
  });

  it('exits at the target price when the target is hit', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const targetDay = d(signalDay, 2);
    const history = new Map([
      [
        'TEST',
        [...warmupThrough(signalDay), bar(entryDay), bar(targetDay, { open: 101, high: 107, low: 100, close: 106 })],
      ],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: targetDay }));
    expect(report.trades).toHaveLength(1);
    const t = report.trades[0];
    expect(t.exitReason).toBe('target');
    expect(t.exitPrice).toBe(106);
    expect(t.rMultiple).toBeCloseTo(2, 5); // target is always exactly 2R by construction (targetRMultiple: 2)
  });

  it('assumes the stop hit first (conservative) when a single bar could have hit both', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const bothDay = d(signalDay, 2);
    const history = new Map([
      [
        'TEST',
        [...warmupThrough(signalDay), bar(entryDay), bar(bothDay, { open: 100, high: 108, low: 95, close: 102 })],
      ],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: bothDay }));
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0].exitReason).toBe('stop');
    expect(report.trades[0].exitPrice).toBe(97);
  });

  it('force-closes at the last available close when neither stop nor target is hit by period end', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const lastDay = d(signalDay, 2);
    const history = new Map([
      [
        'TEST',
        [...warmupThrough(signalDay), bar(entryDay), bar(lastDay, { open: 100, high: 102, low: 99, close: 101 })],
      ],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: lastDay }));
    expect(report.trades).toHaveLength(1);
    const t = report.trades[0];
    expect(t.exitReason).toBe('end_of_period');
    expect(t.exitDate).toBe(lastDay);
    expect(t.exitPrice).toBe(101); // the last close
    expect(t.pnl).toBeCloseTo((101 - 100) * t.quantity, 5);
  });

  it('does not open a second position in a symbol that already has one open', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const nextDay = d(signalDay, 2);
    // Never hits stop/target, so the position stays open the whole window —
    // if the loop wrongly re-signaled on `nextDay`, a second trade would appear.
    const history = new Map([
      [
        'TEST',
        [...warmupThrough(signalDay), bar(entryDay), bar(nextDay), bar(d(signalDay, 3), { open: 100, close: 101 })],
      ],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: d(signalDay, 3) }));
    // Exactly one trade (force-closed at the end) — never two concurrent/duplicate opens.
    expect(report.trades).toHaveLength(1);
  });

  it('tracks equity across multiple sequential trades in the same symbol', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const stopDay = d(signalDay, 2);
    // After the first trade stops out, a fresh signal can fire again once the
    // symbol is flat again (it re-qualifies under the fully relaxed filters).
    const secondEntryDay = d(signalDay, 3);
    const endDay = d(signalDay, 4);
    const history = new Map([
      [
        'TEST',
        [
          ...warmupThrough(signalDay),
          bar(entryDay),
          bar(stopDay, { open: 98, high: 99, low: 96, close: 97 }), // stops out trade 1
          bar(secondEntryDay, { open: 97, high: 98, low: 96, close: 97 }),
          bar(endDay, { open: 97, high: 99, low: 96, close: 98 }), // force-close trade 2 here
        ],
      ],
    ]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: endDay }));
    expect(report.trades.length).toBeGreaterThanOrEqual(1);
    // Whatever happened, equity must equal starting equity plus the sum of realized trade P&Ls.
    const expectedEquity = STARTING_EQUITY + report.trades.reduce((s, t) => s + t.pnl, 0);
    expect(report.finalEquity).toBeCloseTo(expectedEquity, 5);
  });

  it('reports an equity curve with one point per simulated day', () => {
    const signalDay = '2024-03-01';
    const history = new Map([['TEST', warmupThrough(signalDay)]]);
    const report = simulateBacktest(history, baseConfig({ from: signalDay, to: signalDay }));
    expect(report.equityCurve).toHaveLength(1);
    expect(report.equityCurve[0].date).toBe(signalDay);
  });
});
