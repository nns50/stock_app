import { describe, it, expect } from 'vitest';
import { simulateBacktest, BacktestConfig } from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';
import { RISK_PROFILES } from '../src/services/autotrading/riskProfiles';

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

  it('breaks exact score ties deterministically by symbol name, not Map/fetch insertion order', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const history = [...warmupThrough(signalDay), bar(entryDay)];
    // Inserted in reverse-alphabetical order — if the candidate sort ever
    // regresses to relying on Map iteration order (which mirrors real
    // concurrent-fetch completion timing in loadBacktestHistory), this would
    // flip which two of the three tied candidates get approved.
    const historyBySymbol = new Map([
      ['ZZZZ', history],
      ['MMM', history],
      ['AAA', history],
    ]);
    const report = simulateBacktest(
      historyBySymbol,
      baseConfig({ symbols: ['ZZZZ', 'MMM', 'AAA'], from: signalDay, to: entryDay }),
    );
    // MODERATE caps at 2 concurrent positions; all three tie on score (identical
    // price data) and are mutually uncorrelated (a flat-close series has zero
    // variance, so pearsonCorrelation is null — never counted as correlated) —
    // so exactly the two alphabetically-first symbols should be approved.
    expect(report.trades.map((t) => t.symbol).sort()).toEqual(['AAA', 'MMM']);
  });

  it('threads same-day approvals into the correlation check, not a stale pre-batch snapshot', () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    // A zigzag close (100/102) so daily returns have real variance —
    // pearsonCorrelation is undefined (null) against the flat-close
    // warmupThrough() fixture used elsewhere, since a constant close has zero
    // variance.
    const days: string[] = [];
    for (let i = 60; i >= -1; i--) days.push(d(signalDay, -i));
    const series: Candle[] = days.map((day, idx) => {
      const close = idx % 2 === 0 ? 100 : 102;
      return {
        time: Date.parse(`${day}T00:00:00Z`),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 500_000,
      };
    });
    const historyBySymbol = new Map([
      ['CORRA', series],
      ['CORRB', series], // identical series -> pearsonCorrelation = 1.0
    ]);
    const report = simulateBacktest(
      historyBySymbol,
      baseConfig({ symbols: ['CORRA', 'CORRB'], from: signalDay, to: entryDay }),
    );
    // CORRA (alphabetically first among the tied scores) is approved first;
    // CORRB is perfectly correlated (r=1.0), and CORRA's OWN just-approved
    // notional alone (position sizing at 1% risk on a ~$100 stock produces a
    // notional far larger than MODERATE's 6%-of-equity correlated cap) should
    // block CORRB — but only if the running (not stale pre-batch) position
    // list is what the correlation check actually sees.
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0].symbol).toBe('CORRA');
  });

  it('blocks a same-day candidate via max_trades_per_day once enough positions have filled today', () => {
    const original = { ...RISK_PROFILES.MODERATE };
    // Generous on every other cap so max_trades_per_day is unambiguously the
    // one doing the blocking below.
    Object.assign(RISK_PROFILES.MODERATE, {
      maxConcurrentPositions: 100,
      maxAggregateOpenRiskPct: 100,
      maxCorrelatedExposurePct: 100,
      maxDailyDrawdownPct: 100,
      maxTradesPerDay: 1,
    });
    try {
      const day0 = '2024-03-01';
      const day1 = d(day0, 1);
      const day2 = d(day0, 2);
      // TDAYA: standard 60-day warmup, signals on day0, fills on day1 ->
      // one position has already filled "today" by the time day1's step 3 runs.
      // Extends through day2 so a day1 approval (if wrongly allowed) has a day
      // to actually fill and show up in report.trades — a signal approved on
      // the LAST simulated day never fills and would be silently invisible
      // either way, which would make this test pass for the wrong reason.
      const tdayA = [...warmupThrough(day0), bar(day1), bar(day2)];
      // TDAYD: exactly 14 bars through day0 — atrSeries needs >= period+1 (15)
      // bars to produce a non-null ATR, so TDAYD's ATR is null (no signal
      // possible) on day0. The 15th bar (day1) makes ATR computable for the
      // FIRST time exactly on day1 — the same day TDAYA's fill already used
      // up the day's one-trade cap.
      const tdayDWarmup: Candle[] = [];
      for (let i = 13; i >= 0; i--) tdayDWarmup.push(bar(d(day0, -i)));
      const tdayD = [...tdayDWarmup, bar(day1), bar(day2)];

      const historyBySymbol = new Map([
        ['TDAYA', tdayA],
        ['TDAYD', tdayD],
      ]);
      const report = simulateBacktest(
        historyBySymbol,
        baseConfig({ symbols: ['TDAYA', 'TDAYD'], from: day0, to: day2 }),
      );
      // Only TDAYA's trade should exist — TDAYD's first-ever eligible signal
      // (day1) is blocked by max_trades_per_day, not approved as a second
      // same-day trade (which would otherwise fill, and appear here, on day2).
      expect(report.trades.map((t) => t.symbol)).toEqual(['TDAYA']);
    } finally {
      Object.assign(RISK_PROFILES.MODERATE, original);
    }
  });
});
