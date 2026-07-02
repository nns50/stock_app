import { describe, it, expect, vi, beforeEach } from 'vitest';

// The DB/sector-classification/data-fetch boundaries are mocked so these tests
// exercise ONLY backtest.ts's own orchestration (pre-filter wiring, warmup
// padding, walk-forward window splitting) — never touching the DB or network.
// classifySector's own real_estate/clear/unknown logic already has dedicated
// coverage in autotradeRealEstateClassifier.test.ts; getHistoricalBars's own
// caching logic already has dedicated coverage in historicalData.test.ts.
vi.mock('../src/db/autotradeExclusions', () => ({ isExcluded: vi.fn() }));
vi.mock('../src/services/autotrading/realEstateClassifier', () => ({ classifySector: vi.fn() }));
vi.mock('../src/services/autotrading/historicalData', () => ({ getHistoricalBars: vi.fn() }));

import { isExcluded } from '../src/db/autotradeExclusions';
import { classifySector } from '../src/services/autotrading/realEstateClassifier';
import { getHistoricalBars } from '../src/services/autotrading/historicalData';
import {
  runBacktest,
  runWalkForwardBacktest,
  BacktestConfig,
  WalkForwardConfig,
} from '../src/services/autotrading/backtest';
import { Candle } from '../src/providers/types';

const mockIsExcluded = vi.mocked(isExcluded);
const mockClassifySector = vi.mocked(classifySector);
const mockGetBars = vi.mocked(getHistoricalBars);

beforeEach(() => {
  mockIsExcluded.mockReset().mockReturnValue(false);
  mockClassifySector.mockReset().mockResolvedValue({ outcome: 'clear', source: 'fundamentals' });
  mockGetBars.mockReset().mockResolvedValue([]);
});

const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };

function cfg(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['OK1'],
    from: '2024-01-01',
    to: '2024-01-02',
    riskProfile: 'MODERATE',
    startingEquity: 100_000,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

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

/** 60 flat warmup days ending the day before `signalDay` — same construction
 *  as backtestSimulate.test.ts, so a RELAXED-filter signal fires predictably
 *  on the first eligible day (ATR ≈ 2, entry ≈ 100, stop ≈ 97, target ≈ 106). */
function warmupThrough(signalDay: string): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 1; i--) days.push(bar(d(signalDay, -i)));
  days.push(bar(signalDay));
  return days;
}

describe('runBacktest', () => {
  it('excludes a listed real-estate symbol before fetching any bars for it', async () => {
    mockIsExcluded.mockImplementation((s) => s === 'RE1');
    const report = await runBacktest(cfg({ symbols: ['RE1', 'OK1'] }));
    expect(report.excludedSymbols).toEqual([{ symbol: 'RE1', reason: 'On the real-estate exclusion list' }]);
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetBars).toHaveBeenCalledWith('OK1', 'daily', expect.any(String), expect.any(String));
  });

  it('excludes a sector-classified real-estate symbol before fetching any bars for it', async () => {
    mockClassifySector.mockImplementation(async (s) =>
      s === 'RE2'
        ? { outcome: 'real_estate', sector: 'Real Estate', source: 'fundamentals' }
        : { outcome: 'clear', source: 'fundamentals' },
    );
    const report = await runBacktest(cfg({ symbols: ['RE2', 'OK1'] }));
    expect(report.excludedSymbols).toHaveLength(1);
    expect(report.excludedSymbols[0].symbol).toBe('RE2');
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetBars).toHaveBeenCalledWith('OK1', 'daily', expect.any(String), expect.any(String));
  });

  it('fetches with a warmup-padded from date, but the exact requested to date', async () => {
    await runBacktest(cfg({ symbols: ['OK1'], from: '2024-06-01', to: '2024-06-05' }));
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    const [symbol, timeframe, fetchedFrom, fetchedTo] = mockGetBars.mock.calls[0];
    expect(symbol).toBe('OK1');
    expect(timeframe).toBe('daily');
    expect(fetchedFrom < '2024-06-01').toBe(true); // padded well before the raw `from`
    expect(fetchedTo).toBe('2024-06-05');
  });

  it('does not crash when a symbol has no historical bars, and reports no trades for it', async () => {
    mockGetBars.mockResolvedValue([]);
    const report = await runBacktest(cfg({ symbols: ['NODATA'] }));
    expect(report.trades).toEqual([]);
    expect(report.excludedSymbols).toEqual([]);
  });

  it('feeds fetched bars into the simulation end to end and returns a real trade', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const targetDay = d(signalDay, 2);
    mockGetBars.mockResolvedValue([
      ...warmupThrough(signalDay),
      bar(entryDay),
      bar(targetDay, { open: 101, high: 107, low: 100, close: 106 }),
    ]);
    const report = await runBacktest(cfg({ symbols: ['OK1'], from: signalDay, to: targetDay }));
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0].exitReason).toBe('target');
    expect(report.finalEquity).toBeGreaterThan(report.startingEquity);
  });
});

describe('runWalkForwardBacktest', () => {
  it('splits into independent in-sample/out-of-sample windows, fetching history only once', async () => {
    const from = '2024-03-01';
    const entryDay = d(from, 1); // 2024-03-02
    const targetDay = d(from, 2); // 2024-03-03
    const splitDate = targetDay;
    const outOfSampleFrom = d(splitDate, 1); // 2024-03-04
    const secondEntryDay = d(splitDate, 2); // 2024-03-05
    const to = d(from, 10); // 2024-03-11

    const history: Candle[] = [
      ...warmupThrough(from),
      bar(entryDay),
      bar(targetDay, { open: 101, high: 107, low: 100, close: 106 }), // trade 1 hits target — a real win
      bar(outOfSampleFrom),
      bar(secondEntryDay),
      bar(d(splitDate, 3)),
      bar(d(splitDate, 4)),
      bar(d(splitDate, 5)),
      bar(d(splitDate, 6)),
      bar(d(splitDate, 7)),
      bar(to), // out-of-sample position force-closes here, flat close = entry price
    ];
    mockGetBars.mockResolvedValue(history);

    const wfCfg: WalkForwardConfig = {
      symbols: ['WF1'],
      from,
      to,
      splitDate,
      riskProfile: 'MODERATE',
      startingEquity: 100_000,
      screenerConfig: RELAXED,
    };
    const result = await runWalkForwardBacktest(wfCfg);

    // Fetched once per symbol — reused for both simulated windows, not re-fetched.
    expect(mockGetBars).toHaveBeenCalledTimes(1);

    expect(result.inSample.trades).toHaveLength(1);
    expect(result.inSample.trades[0].exitReason).toBe('target');
    expect(result.inSample.trades[0].exitDate).toBe(splitDate);
    expect(result.inSample.finalEquity).toBeGreaterThan(result.inSample.startingEquity);

    expect(result.outOfSample.trades).toHaveLength(1);
    expect(result.outOfSample.trades[0].entryDate).toBe(secondEntryDay);
    expect(result.outOfSample.trades[0].exitDate).toBe(to);
    expect(result.outOfSample.trades[0].exitReason).toBe('end_of_period');

    // The critical independence check: out-of-sample starts from the ORIGINAL
    // configured equity, not from in-sample's (higher, post-win) final equity —
    // proving the two windows don't compound into one another.
    expect(result.outOfSample.startingEquity).toBe(wfCfg.startingEquity);
    expect(result.outOfSample.startingEquity).not.toBe(result.inSample.finalEquity);
  });

  it('excludes real estate once, upfront, shared across both windows', async () => {
    mockIsExcluded.mockImplementation((s) => s === 'RE1');
    const result = await runWalkForwardBacktest({
      ...cfg({ symbols: ['RE1', 'OK1'], from: '2024-01-01', to: '2024-01-10' }),
      splitDate: '2024-01-05',
    });
    expect(result.excludedSymbols).toEqual([{ symbol: 'RE1', reason: 'On the real-estate exclusion list' }]);
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetBars).toHaveBeenCalledWith('OK1', 'daily', expect.any(String), expect.any(String));
  });
});
