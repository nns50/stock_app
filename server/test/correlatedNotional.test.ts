import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { correlatedNotional } from '../src/services/autotrading/riskCheck';
import type { Candle } from '../src/providers/types';

const mockGetProvider = vi.mocked(getProvider);

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: i * 86_400_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
  }));
}

// Two series that move in perfect lockstep -> r = 1 (definitely >= any
// realistic threshold). A third, flat series is perfectly UNcorrelated with
// either (zero variance -> Pearson r is undefined/null, excluded from the sum
// rather than assumed correlated, per correlatedNotional's own doc comment).
const RISING = [100, 101, 102, 103, 104, 105, 103, 106, 108, 107, 109, 110];
const FLAT = Array(RISING.length).fill(50);

function mockCandles(bySymbol: Record<string, number[]>) {
  mockGetProvider.mockReturnValue({
    getCandles: vi.fn(async (symbol: string) => candlesFromCloses(bySymbol[symbol] ?? FLAT)),
  } as unknown as ReturnType<typeof getProvider>);
}

describe('correlatedNotional', () => {
  beforeEach(() => mockGetProvider.mockReset());

  it('adds a correlated position on the SAME side as the candidate (original, always-additive behavior)', async () => {
    mockCandles({ CAND: RISING, EXIST: RISING });
    const { amount } = await correlatedNotional(
      'CAND',
      'long',
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      10,
      0.7,
    );
    expect(amount).toBe(1000);
  });

  it('nets (subtracts) a correlated position on the OPPOSITE side — a hedge, not compounding risk', async () => {
    mockCandles({ CAND: RISING, EXIST: RISING });
    const { amount } = await correlatedNotional(
      'CAND',
      'short', // candidate is short, existing correlated position is long -> hedges it
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      10,
      0.7,
    );
    expect(amount).toBe(0); // fully offset, floored at 0 -- not -1000
  });

  it('floors net exposure at 0 rather than going negative when the hedge outweighs same-side exposure', async () => {
    mockCandles({ CAND: RISING, EXIST: RISING, EXIST2: RISING });
    const { amount } = await correlatedNotional(
      'CAND',
      'long',
      [
        { symbol: 'EXIST', notional: 500, side: 'long' }, // +500 (same side)
        { symbol: 'EXIST2', notional: 2000, side: 'short' }, // -2000 (opposite side)
      ],
      10,
      0.7,
    );
    expect(amount).toBe(0); // 500 - 2000 = -1500, floored at 0
  });

  it('sums multiple same-side correlated positions and nets an opposite-side one, net positive', async () => {
    mockCandles({ CAND: RISING, EXIST: RISING, EXIST2: RISING, EXIST3: RISING });
    const { amount } = await correlatedNotional(
      'CAND',
      'long',
      [
        { symbol: 'EXIST', notional: 1000, side: 'long' }, // +1000
        { symbol: 'EXIST2', notional: 500, side: 'long' }, // +500
        { symbol: 'EXIST3', notional: 300, side: 'short' }, // -300
      ],
      10,
      0.7,
    );
    expect(amount).toBe(1200);
  });

  it('ignores an uncorrelated position regardless of side', async () => {
    mockCandles({ CAND: RISING, EXIST: FLAT });
    const { amount } = await correlatedNotional(
      'CAND',
      'long',
      [{ symbol: 'EXIST', notional: 1000, side: 'short' }],
      10,
      0.7,
    );
    expect(amount).toBe(0);
  });

  it('is a no-op with no positions at all (never calls the provider)', async () => {
    const { amount, correlations } = await correlatedNotional('CAND', 'long', [], 10, 0.7);
    expect(amount).toBe(0);
    expect(correlations).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });
});
