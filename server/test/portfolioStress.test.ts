import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/services/quotes', () => ({ resolveStockPrices: vi.fn(), resolveOptionMarks: vi.fn() }));

import { getProvider } from '../src/providers';
import { resolveStockPrices, resolveOptionMarks } from '../src/services/quotes';
import { computeStressScenarios, computePortfolioStress, StressPositionInput } from '../src/services/portfolioStress';
import { Position } from '../src/db/positions';

const mockGetProvider = vi.mocked(getProvider);
const mockResolveStockPrices = vi.mocked(resolveStockPrices);
const mockResolveOptionMarks = vi.mocked(resolveOptionMarks);

let nextId = 1;

function makePosition(
  over: Partial<Position> & Pick<Position, 'assetType' | 'symbol' | 'side' | 'quantity'>,
): Position {
  return {
    id: nextId++,
    entryPrice: 100,
    entryDate: '2026-01-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: over.assetType === 'option' ? 100 : 1,
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
    remainingQuantity: over.quantity,
    ...over,
  };
}

function fundamentals(beta: number | undefined) {
  return { symbol: 'TEST', beta };
}

describe('computeStressScenarios — pure aggregator', () => {
  it('is zero across every scenario with no inputs', () => {
    const result = computeStressScenarios([], [-10, 0, 10]);
    expect(result).toEqual([
      { pct: -10, estimatedPnl: 0 },
      { pct: 0, estimatedPnl: 0 },
      { pct: 10, estimatedPnl: 0 },
    ]);
  });

  it('scales a single input linearly by each scenario percentage', () => {
    const inputs: StressPositionInput[] = [{ symbol: 'AAPL', dollarDeltaPerPct: 15 }];
    const result = computeStressScenarios(inputs, [-10, -5, 0, 5, 10]);
    expect(result).toEqual([
      { pct: -10, estimatedPnl: -150 },
      { pct: -5, estimatedPnl: -75 },
      { pct: 0, estimatedPnl: 0 },
      { pct: 5, estimatedPnl: 75 },
      { pct: 10, estimatedPnl: 150 },
    ]);
  });

  it('sums multiple inputs before scaling', () => {
    const inputs: StressPositionInput[] = [
      { symbol: 'AAPL', dollarDeltaPerPct: 15 },
      { symbol: 'TSLA', dollarDeltaPerPct: -5 },
    ];
    const result = computeStressScenarios(inputs, [10]);
    expect(result).toEqual([{ pct: 10, estimatedPnl: 100 }]); // (15 - 5) * 10
  });

  it('uses the default scenario set when none is passed', () => {
    const result = computeStressScenarios([{ symbol: 'AAPL', dollarDeltaPerPct: 10 }]);
    expect(result.map((s) => s.pct)).toEqual([-10, -5, -2, 0, 2, 5, 10]);
  });
});

describe('computePortfolioStress — async orchestrator', () => {
  beforeEach(() => {
    mockGetProvider.mockReset();
    mockResolveStockPrices.mockReset();
    mockResolveOptionMarks.mockReset();
    mockGetProvider.mockReturnValue({ capabilities: { fundamentals: true } } as unknown as ReturnType<
      typeof getProvider
    >);
  });

  it('is zero with no open positions at all (never touches the provider)', async () => {
    const result = await computePortfolioStress([]);
    expect(result).toEqual({
      scenarios: [-10, -5, -2, 0, 2, 5, 10].map((pct) => ({ pct, estimatedPnl: 0 })),
      netDollarDeltaPerPct: 0,
      unresolved: [],
      resolvedCount: 0,
      totalCount: 0,
    });
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('ignores closed positions and fully-exited open rows', async () => {
    const positions = [
      makePosition({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 10, status: 'closed' }),
      makePosition({ assetType: 'stock', symbol: 'MSFT', side: 'long', quantity: 10, remainingQuantity: 0 }),
    ];
    const result = await computePortfolioStress(positions);
    expect(result.totalCount).toBe(0);
    expect(mockResolveStockPrices).not.toHaveBeenCalled();
  });

  it('beta-weights a long stock position by its current market value', async () => {
    const getFundamentals = vi.fn().mockResolvedValue(fundamentals(1.5));
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals,
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([['AAPL', { symbol: 'AAPL', price: 100, stale: false, asOf: 1 }]]),
    );
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [makePosition({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 10 })];
    const result = await computePortfolioStress(positions, [-10, 10]);

    // marketValue 100 * 10 = 1000; per-1% delta = 1000 * 1.5 * 0.01 = 15
    expect(result.netDollarDeltaPerPct).toBe(15);
    expect(result.scenarios).toEqual([
      { pct: -10, estimatedPnl: -150 },
      { pct: 10, estimatedPnl: 150 },
    ]);
    expect(result.resolvedCount).toBe(1);
    expect(result.unresolved).toEqual([]);
  });

  it('flips the sign for a short stock position', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockResolvedValue(fundamentals(2)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(new Map([['TSLA', { symbol: 'TSLA', price: 50, stale: false, asOf: 1 }]]));
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [makePosition({ assetType: 'stock', symbol: 'TSLA', side: 'short', quantity: 4 })];
    const result = await computePortfolioStress(positions);

    // marketValue 50 * 4 * -1 = -200; per-1% delta = -200 * 2 * 0.01 = -4
    expect(result.netDollarDeltaPerPct).toBe(-4);
  });

  it("beta-weights a long call option by the underlying's move and the option's own delta", async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockResolvedValue(fundamentals(1)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([['NVDA', { symbol: 'NVDA', price: 200, stale: false, asOf: 1 }]]),
    );
    const optionPosition = makePosition({
      assetType: 'option',
      symbol: 'NVDA',
      side: 'long',
      quantity: 2,
      optionType: 'call',
      strike: 210,
      expiration: '2026-09-18',
    });
    mockResolveOptionMarks.mockResolvedValue(new Map([[optionPosition.id, { mark: 5, delta: 0.4 }]]));

    const result = await computePortfolioStress([optionPosition]);

    // underlying move per 1% = 200 * 1 * 0.01 = 2; option $ delta per 1% = 0.4 * 2 * 2 contracts * 100 multiplier = 160
    expect(result.netDollarDeltaPerPct).toBe(160);
    expect(result.resolvedCount).toBe(1);
  });

  it('excludes a position with no resolvable beta, and reports why', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockResolvedValue(fundamentals(undefined)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(new Map([['ZZZZ', { symbol: 'ZZZZ', price: 10, stale: false, asOf: 1 }]]));
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [makePosition({ assetType: 'stock', symbol: 'ZZZZ', side: 'long', quantity: 1 })];
    const result = await computePortfolioStress(positions);

    expect(result.resolvedCount).toBe(0);
    expect(result.totalCount).toBe(1);
    expect(result.unresolved).toEqual([{ positionId: positions[0].id, symbol: 'ZZZZ', reason: 'no-beta' }]);
    expect(result.netDollarDeltaPerPct).toBe(0);
  });

  it('excludes a position with no resolvable underlying price', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockResolvedValue(fundamentals(1.2)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([['ZZZZ', { symbol: 'ZZZZ', price: null, stale: false, asOf: null }]]),
    );
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [makePosition({ assetType: 'stock', symbol: 'ZZZZ', side: 'long', quantity: 1 })];
    const result = await computePortfolioStress(positions);

    expect(result.unresolved).toEqual([{ positionId: positions[0].id, symbol: 'ZZZZ', reason: 'no-price' }]);
  });

  it('excludes an option position with no resolvable delta, but still resolves its beta/price lookups', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockResolvedValue(fundamentals(1)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([['NVDA', { symbol: 'NVDA', price: 200, stale: false, asOf: 1 }]]),
    );
    const optionPosition = makePosition({
      assetType: 'option',
      symbol: 'NVDA',
      side: 'long',
      quantity: 1,
      optionType: 'call',
      strike: 210,
      expiration: '2026-09-18',
    });
    mockResolveOptionMarks.mockResolvedValue(new Map([[optionPosition.id, { mark: null, delta: null }]]));

    const result = await computePortfolioStress([optionPosition]);

    expect(result.unresolved).toEqual([{ positionId: optionPosition.id, symbol: 'NVDA', reason: 'no-delta' }]);
    expect(result.resolvedCount).toBe(0);
  });

  it('skips the beta lookup entirely when the provider has no fundamentals capability', async () => {
    const getFundamentals = vi.fn();
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: false },
      getFundamentals,
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([['AAPL', { symbol: 'AAPL', price: 100, stale: false, asOf: 1 }]]),
    );
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [makePosition({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 1 })];
    const result = await computePortfolioStress(positions);

    expect(getFundamentals).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ positionId: positions[0].id, symbol: 'AAPL', reason: 'no-beta' }]);
  });

  it('sums multiple resolved positions into one net figure', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { fundamentals: true },
      getFundamentals: vi.fn().mockImplementation(async (symbol: string) => fundamentals(symbol === 'AAPL' ? 1 : 2)),
    } as unknown as ReturnType<typeof getProvider>);
    mockResolveStockPrices.mockResolvedValue(
      new Map([
        ['AAPL', { symbol: 'AAPL', price: 100, stale: false, asOf: 1 }],
        ['TSLA', { symbol: 'TSLA', price: 50, stale: false, asOf: 1 }],
      ]),
    );
    mockResolveOptionMarks.mockResolvedValue(new Map());

    const positions = [
      makePosition({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 10 }), // 100*10*1*0.01 = 10
      makePosition({ assetType: 'stock', symbol: 'TSLA', side: 'short', quantity: 4 }), // 50*4*-1*2*0.01 = -4
    ];
    const result = await computePortfolioStress(positions);

    expect(result.netDollarDeltaPerPct).toBe(6); // 10 + -4
    expect(result.resolvedCount).toBe(2);
  });
});
