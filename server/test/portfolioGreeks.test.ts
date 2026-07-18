import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { resolveOptionGreeks } from '../src/services/quotes';
import { computePortfolioGreeks, computeAutotradeOptionsGreeks } from '../src/services/portfolioGreeks';
import type { OptionsChain } from '../src/providers/types';
import type { OptionsPaperPosition } from '../src/db/autotradeOptionsPaperPositions';
import type { LiveOptionsPosition } from '../src/db/autotradeLiveOptionsPositions';

const mockGetProvider = vi.mocked(getProvider);

function chain(overrides: Partial<OptionsChain> = {}): OptionsChain {
  return { underlying: 'TEST', expiration: '2026-08-21', calls: [], puts: [], ...overrides };
}

function mockChains(byKey: Record<string, OptionsChain>) {
  mockGetProvider.mockReturnValue({
    capabilities: { options: true },
    getOptionsChain: vi.fn(async (symbol: string, expiration: string) => {
      const found = byKey[`${symbol}|${expiration}`];
      if (!found) throw new Error('no chain for ' + symbol);
      return found;
    }),
  } as unknown as ReturnType<typeof getProvider>);
}

describe('resolveOptionGreeks', () => {
  beforeEach(() => mockGetProvider.mockReset());

  it('matches by strike + type and returns delta/theta/vega', async () => {
    mockChains({
      'TEST|2026-08-21': chain({
        calls: [
          {
            symbol: 'TEST260821C00100000',
            underlying: 'TEST',
            type: 'call',
            strike: 100,
            expiration: '2026-08-21',
            greeks: { delta: 0.5, theta: -0.05, vega: 0.1 },
          },
        ],
      }),
    });
    const result = await resolveOptionGreeks([
      { key: 'leg1', symbol: 'TEST', optionType: 'call', strike: 100, expiration: '2026-08-21' },
    ]);
    expect(result.get('leg1')).toEqual({ delta: 0.5, theta: -0.05, vega: 0.1 });
  });

  it('returns nulls when no contract matches the strike', async () => {
    mockChains({ 'TEST|2026-08-21': chain({ calls: [] }) });
    const result = await resolveOptionGreeks([
      { key: 'leg1', symbol: 'TEST', optionType: 'call', strike: 999, expiration: '2026-08-21' },
    ]);
    expect(result.get('leg1')).toEqual({ delta: null, theta: null, vega: null });
  });

  it('returns nulls for every leg in a group when the chain fetch fails', async () => {
    mockGetProvider.mockReturnValue({
      capabilities: { options: true },
      getOptionsChain: vi.fn().mockRejectedValue(new Error('rate limited')),
    } as unknown as ReturnType<typeof getProvider>);
    const result = await resolveOptionGreeks([
      { key: 'leg1', symbol: 'TEST', optionType: 'call', strike: 100, expiration: '2026-08-21' },
    ]);
    expect(result.get('leg1')).toEqual({ delta: null, theta: null, vega: null });
  });

  it('batches multiple legs in the same (symbol, expiration) into one chain fetch', async () => {
    const getOptionsChain = vi.fn(async () =>
      chain({
        calls: [
          {
            symbol: 'C1',
            underlying: 'TEST',
            type: 'call',
            strike: 100,
            expiration: '2026-08-21',
            greeks: { delta: 0.5 },
          },
          {
            symbol: 'C2',
            underlying: 'TEST',
            type: 'call',
            strike: 110,
            expiration: '2026-08-21',
            greeks: { delta: 0.3 },
          },
        ],
      }),
    );
    mockGetProvider.mockReturnValue({ capabilities: { options: true }, getOptionsChain } as unknown as ReturnType<
      typeof getProvider
    >);
    const result = await resolveOptionGreeks([
      { key: 'leg1', symbol: 'TEST', optionType: 'call', strike: 100, expiration: '2026-08-21' },
      { key: 'leg2', symbol: 'TEST', optionType: 'call', strike: 110, expiration: '2026-08-21' },
    ]);
    expect(getOptionsChain).toHaveBeenCalledTimes(1);
    expect(result.get('leg1')?.delta).toBe(0.5);
    expect(result.get('leg2')?.delta).toBe(0.3);
  });

  it('is a no-op with no items at all', async () => {
    const result = await resolveOptionGreeks([]);
    expect(result.size).toBe(0);
  });
});

describe('computePortfolioGreeks — pure aggregator', () => {
  it('sums a single long leg scaled by quantity and the x100 contract multiplier', () => {
    const result = computePortfolioGreeks(
      [{ key: 'leg1', quantity: 2, short: false }],
      new Map([['leg1', { delta: 0.5, theta: -0.05, vega: 0.1 }]]),
    );
    expect(result).toEqual({ netDelta: 100, netTheta: -10, netVega: 20 });
  });

  it('negates a short leg (a debit spread) instead of adding it', () => {
    const result = computePortfolioGreeks(
      [
        { key: 'long', quantity: 1, short: false },
        { key: 'short', quantity: 1, short: true },
      ],
      new Map([
        ['long', { delta: 0.5, theta: -0.05, vega: 0.1 }],
        ['short', { delta: 0.2, theta: -0.02, vega: 0.04 }],
      ]),
    );
    // (0.5 - 0.2) * 100 = 30 net delta; (-0.05 - -0.02) * 100 = -3 net theta; (0.1 - 0.04) * 100 = 6 net vega
    expect(result).toEqual({ netDelta: 30, netTheta: -3, netVega: 6 });
  });

  it('excludes a leg with no resolved Greeks rather than treating it as zero risk silently mixed in', () => {
    const result = computePortfolioGreeks(
      [
        { key: 'known', quantity: 1, short: false },
        { key: 'unknown', quantity: 1, short: false },
      ],
      new Map([['known', { delta: 0.5, theta: -0.05, vega: 0.1 }]]), // 'unknown' never resolved
    );
    expect(result).toEqual({ netDelta: 50, netTheta: -5, netVega: 10 });
  });

  it('is zero with no positions at all', () => {
    expect(computePortfolioGreeks([], new Map())).toEqual({ netDelta: 0, netTheta: 0, netVega: 0 });
  });
});

function paperPosition(overrides: Partial<OptionsPaperPosition> = {}): OptionsPaperPosition {
  return {
    id: 1,
    symbol: 'TEST',
    side: 'call',
    kind: 'single_leg',
    contractSymbol: 'TEST-fixture',
    strike: 100,
    shortContractSymbol: null,
    shortStrike: null,
    expiration: '2026-08-21',
    quantity: 1,
    entryPrice: 3,
    shortEntryPrice: null,
    entryAt: Date.now(),
    riskAmount: 300,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    status: 'open',
    exitPrice: null,
    shortExitPrice: null,
    exitAt: null,
    ...overrides,
  } as OptionsPaperPosition;
}

describe('computeAutotradeOptionsGreeks — async orchestrator', () => {
  beforeEach(() => mockGetProvider.mockReset());

  it('is zero with an empty book (never calls the provider)', async () => {
    const result = await computeAutotradeOptionsGreeks([], []);
    expect(result).toEqual({ netDelta: 0, netTheta: 0, netVega: 0 });
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('aggregates a single-leg paper position', async () => {
    mockChains({
      'TEST|2026-08-21': chain({
        calls: [
          {
            symbol: 'TEST-fixture',
            underlying: 'TEST',
            type: 'call',
            strike: 100,
            expiration: '2026-08-21',
            greeks: { delta: 0.5, theta: -0.05, vega: 0.1 },
          },
        ],
      }),
    });
    const result = await computeAutotradeOptionsGreeks([paperPosition({ quantity: 2 })], []);
    expect(result).toEqual({ netDelta: 100, netTheta: -10, netVega: 20 });
  });

  it("subtracts a debit spread's short leg", async () => {
    mockChains({
      'TEST|2026-08-21': chain({
        calls: [
          {
            symbol: 'long',
            underlying: 'TEST',
            type: 'call',
            strike: 100,
            expiration: '2026-08-21',
            greeks: { delta: 0.5, theta: -0.05, vega: 0.1 },
          },
          {
            symbol: 'short',
            underlying: 'TEST',
            type: 'call',
            strike: 110,
            expiration: '2026-08-21',
            greeks: { delta: 0.2, theta: -0.02, vega: 0.04 },
          },
        ],
      }),
    });
    const result = await computeAutotradeOptionsGreeks(
      [paperPosition({ kind: 'debit_spread', shortContractSymbol: 'short', shortStrike: 110 })],
      [],
    );
    expect(result).toEqual({ netDelta: 30, netTheta: -3, netVega: 6 });
  });

  it('combines paper and live pools into one aggregate', async () => {
    mockChains({
      'TEST|2026-08-21': chain({
        calls: [
          {
            symbol: 'c',
            underlying: 'TEST',
            type: 'call',
            strike: 100,
            expiration: '2026-08-21',
            greeks: { delta: 0.5, theta: -0.05, vega: 0.1 },
          },
        ],
      }),
    });
    const liveOptions = [{ ...paperPosition({ id: 2 }), entryAt: Date.now() } as unknown as LiveOptionsPosition];
    const result = await computeAutotradeOptionsGreeks([paperPosition({ id: 1 })], liveOptions);
    // Two identical single-leg long positions (id 1 paper, id 2 live), each delta 0.5 * 1 * 100 = 50.
    expect(result.netDelta).toBe(100);
  });
});
