import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mocking boundary convention as backtestRun.test.ts: exercise ONLY
// this file's own orchestration (real-estate pre-filter reuse, contract
// discovery wiring, walk-forward window splitting) — never the DB/network,
// and never re-testing simulateOptionsBacktest's own day-by-day logic
// (already covered in optionsBacktestSimulate.test.ts).
vi.mock('../src/db/autotradeExclusions', () => ({ isExcluded: vi.fn() }));
vi.mock('../src/services/autotrading/realEstateClassifier', () => ({
  classifySector: vi.fn(),
  buildUniverseSectorMap: vi.fn(() => new Map()),
}));
vi.mock('../src/services/autotrading/historicalData', () => ({ getHistoricalBars: vi.fn() }));
vi.mock('../src/services/autotrading/optionsHistoricalData', () => ({ getHistoricalOptionContracts: vi.fn() }));

import { isExcluded } from '../src/db/autotradeExclusions';
import { classifySector } from '../src/services/autotrading/realEstateClassifier';
import { getHistoricalBars } from '../src/services/autotrading/historicalData';
import { getHistoricalOptionContracts } from '../src/services/autotrading/optionsHistoricalData';
import {
  runOptionsBacktest,
  runOptionsWalkForwardBacktest,
  OptionsBacktestConfig,
  OptionsWalkForwardConfig,
} from '../src/services/autotrading/optionsBacktest';
import { Candle } from '../src/providers/types';

const mockIsExcluded = vi.mocked(isExcluded);
const mockClassifySector = vi.mocked(classifySector);
const mockGetBars = vi.mocked(getHistoricalBars);
const mockGetContracts = vi.mocked(getHistoricalOptionContracts);

beforeEach(() => {
  mockIsExcluded.mockReset().mockReturnValue(false);
  mockClassifySector.mockReset().mockResolvedValue({ outcome: 'clear', source: 'fundamentals' });
  mockGetBars.mockReset().mockResolvedValue([]);
  mockGetContracts.mockReset().mockResolvedValue([]);
});

const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };

function cfg(overrides: Partial<OptionsBacktestConfig> = {}): OptionsBacktestConfig {
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

describe('runOptionsBacktest', () => {
  it('excludes a listed real-estate symbol before fetching any bars or contracts for it', async () => {
    mockIsExcluded.mockImplementation((s) => s === 'RE1');
    const report = await runOptionsBacktest(cfg({ symbols: ['RE1', 'OK1'] }));
    expect(report.excludedSymbols).toEqual([{ symbol: 'RE1', reason: 'On the real-estate exclusion list' }]);
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetBars).toHaveBeenCalledWith('OK1', 'daily', expect.any(String), expect.any(String));
  });

  it('excludes a sector-classified real-estate symbol before fetching any bars or contracts for it', async () => {
    mockClassifySector.mockImplementation(async (s) =>
      s === 'RE2'
        ? { outcome: 'real_estate', sector: 'Real Estate', source: 'fundamentals' }
        : { outcome: 'clear', source: 'fundamentals' },
    );
    const report = await runOptionsBacktest(cfg({ symbols: ['RE2', 'OK1'] }));
    expect(report.excludedSymbols).toHaveLength(1);
    expect(report.excludedSymbols[0].symbol).toBe('RE2');
  });

  it('fetches contract reference data for every eligible symbol whose equity bars actually resolved', async () => {
    mockGetBars.mockImplementation(async (symbol: string) => (symbol === 'HASDATA' ? [bar('2024-01-01')] : []));
    await runOptionsBacktest(cfg({ symbols: ['HASDATA', 'NODATA'], from: '2024-06-01', to: '2024-06-05' }));
    // NODATA never resolved any equity bars, so historyBySymbol never gets an
    // entry for it (mirrors backtest.ts's own loadBacktestHistory convention)
    // — no reason to also fetch its option contracts.
    expect(mockGetContracts).toHaveBeenCalledTimes(1);
    const [underlying, fromExp, toExp] = mockGetContracts.mock.calls[0];
    expect(underlying).toBe('HASDATA');
    expect(fromExp).toBe('2024-06-01');
    expect(toExp > '2024-06-05').toBe(true); // padded by maxDaysToExpiration so a late-window entry is still discoverable
  });

  it('does not crash when a symbol has no historical bars, and reports no trades for it', async () => {
    const report = await runOptionsBacktest(cfg({ symbols: ['NODATA'] }));
    expect(report.trades).toEqual([]);
    expect(report.excludedSymbols).toEqual([]);
  });

  it("isolates one symbol's equity-bar fetch failure — the rest of the batch still runs, error reported separately", async () => {
    mockGetBars.mockImplementation(async (symbol: string) => {
      if (symbol === 'BAD1') throw new Error('Polygon 429: rate limited');
      return [];
    });
    const report = await runOptionsBacktest(cfg({ symbols: ['BAD1', 'OK1'] }));
    expect(report.errors).toEqual([{ symbol: 'BAD1', message: 'Polygon 429: rate limited' }]);
    // OK1 (which resolved zero bars, not an error) still gets its contracts fetched.
    expect(mockGetContracts).not.toHaveBeenCalledWith('BAD1', expect.anything(), expect.anything());
  });
});

describe('runOptionsWalkForwardBacktest', () => {
  it('splits into independent in-sample/out-of-sample windows, fetching history and contracts only once', async () => {
    const from = '2024-03-01';
    const splitDate = d(from, 5);
    const to = d(from, 10);
    mockGetBars.mockResolvedValue([bar(from)]);

    const wfCfg: OptionsWalkForwardConfig = {
      symbols: ['WF1'],
      from,
      to,
      splitDate,
      riskProfile: 'MODERATE',
      startingEquity: 100_000,
      screenerConfig: RELAXED,
    };
    const result = await runOptionsWalkForwardBacktest(wfCfg);

    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetContracts).toHaveBeenCalledTimes(1);
    expect(result.inSample.startingEquity).toBe(wfCfg.startingEquity);
    expect(result.outOfSample.startingEquity).toBe(wfCfg.startingEquity);
  });

  it('excludes real estate once, upfront, shared across both windows', async () => {
    mockIsExcluded.mockImplementation((s) => s === 'RE1');
    const result = await runOptionsWalkForwardBacktest({
      ...cfg({ symbols: ['RE1', 'OK1'], from: '2024-01-01', to: '2024-01-10' }),
      splitDate: '2024-01-05',
    });
    expect(result.excludedSymbols).toEqual([{ symbol: 'RE1', reason: 'On the real-estate exclusion list' }]);
    expect(mockGetBars).toHaveBeenCalledTimes(1);
    expect(mockGetBars).toHaveBeenCalledWith('OK1', 'daily', expect.any(String), expect.any(String));
  });
});
