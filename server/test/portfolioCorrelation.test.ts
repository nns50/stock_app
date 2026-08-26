import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import {
  computeCorrelationMatrix,
  computePortfolioCorrelation,
  MAX_CORRELATION_SYMBOLS,
} from '../src/services/portfolioCorrelation';
import { Position } from '../src/db/positions';

const mockGetProvider = vi.mocked(getProvider);

let nextId = 1;
function makePosition(over: Partial<Position> & Pick<Position, 'symbol'>): Position {
  return {
    id: nextId++,
    assetType: 'stock',
    side: 'long',
    quantity: 10,
    entryPrice: 100,
    entryDate: '2026-01-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
    initialStopPrice: null,
    bestPriceSinceEntry: null,
    createdAt: 0,
    updatedAt: 0,
    exits: [],
    remainingQuantity: 10,
    ...over,
  };
}

function candlesFrom(closes: number[]) {
  return closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 0 }));
}

describe('computeCorrelationMatrix — pure', () => {
  it('is 1 on the diagonal and symmetric; perfectly correlated series read +1', () => {
    const r = computeCorrelationMatrix(
      ['AAA', 'BBB'],
      new Map([
        ['AAA', [0.01, 0.02, -0.01, 0.03]],
        ['BBB', [0.02, 0.04, -0.02, 0.06]], // exactly 2× AAA -> corr +1
      ]),
      30,
    );
    expect(r.matrix[0][0]).toBe(1);
    expect(r.matrix[1][1]).toBe(1);
    expect(r.matrix[0][1]).toBeCloseTo(1, 5);
    expect(r.matrix[0][1]).toBe(r.matrix[1][0]); // symmetric
    expect(r.topPair).toEqual({ a: 'AAA', b: 'BBB', r: r.matrix[0][1] });
  });

  it('reads a perfectly inverse pair as -1 and still flags it as the top |r| pair', () => {
    const r = computeCorrelationMatrix(
      ['UP', 'DOWN'],
      new Map([
        ['UP', [0.01, 0.02, 0.03]],
        ['DOWN', [-0.01, -0.02, -0.03]],
      ]),
      30,
    );
    expect(r.matrix[0][1]).toBeCloseTo(-1, 5);
    expect(r.topPair?.r).toBeCloseTo(-1, 5);
  });

  it('nulls out cells for an unresolved symbol and lists it, never a fake 0', () => {
    const r = computeCorrelationMatrix(
      ['AAA', 'GONE'],
      new Map([['AAA', [0.01, 0.02, 0.03]]]), // GONE absent
      30,
    );
    expect(r.matrix[1][1]).toBeNull(); // unresolved diagonal is null, not 1
    expect(r.matrix[0][1]).toBeNull();
    expect(r.matrix[1][0]).toBeNull();
    expect(r.unresolved).toEqual(['GONE']);
    expect(r.topPair).toBeNull(); // no resolvable pair
  });
});

describe('computePortfolioCorrelation — async orchestrator', () => {
  beforeEach(() => mockGetProvider.mockReset());

  it('is empty with no open positions (never calls the provider)', async () => {
    const r = await computePortfolioCorrelation([], 30);
    expect(r.symbols).toEqual([]);
    expect(r.matrix).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('dedupes underlyings (a stock and an option on the same name collapse to one row)', async () => {
    const getCandles = vi.fn(async (symbol: string) =>
      candlesFrom(symbol === 'AAPL' ? [100, 101, 102, 103] : [50, 51, 50, 52]),
    );
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computePortfolioCorrelation(
      [
        makePosition({ symbol: 'AAPL', assetType: 'stock' }),
        makePosition({
          symbol: 'AAPL',
          assetType: 'option',
          optionType: 'call',
          strike: 100,
          expiration: '2026-09-18',
        }),
        makePosition({ symbol: 'MSFT' }),
      ],
      30,
    );
    expect(r.symbols.sort()).toEqual(['AAPL', 'MSFT']);
    // one fetch per distinct underlying
    expect(getCandles).toHaveBeenCalledTimes(2);
  });

  it('reports a symbol whose candle fetch throws as unresolved', async () => {
    const getCandles = vi.fn(async (symbol: string) => {
      if (symbol === 'BAD') throw new Error('rate limited');
      return candlesFrom([100, 101, 102, 103]);
    });
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computePortfolioCorrelation(
      [makePosition({ symbol: 'GOOD' }), makePosition({ symbol: 'BAD' })],
      30,
    );
    expect(r.unresolved).toEqual(['BAD']);
  });

  it('caps the number of distinct symbols correlated', async () => {
    const getCandles = vi.fn(async () => candlesFrom([1, 2, 3, 4]));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);
    const positions = Array.from({ length: MAX_CORRELATION_SYMBOLS + 10 }, (_, i) => makePosition({ symbol: `S${i}` }));
    const r = await computePortfolioCorrelation(positions, 30);
    expect(r.symbols.length).toBe(MAX_CORRELATION_SYMBOLS);
  });
});
