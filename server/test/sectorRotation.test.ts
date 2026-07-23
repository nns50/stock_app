import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/db/universe', () => ({ listUniverse: vi.fn(() => []) }));

import { getProvider } from '../src/providers';
import { listUniverse } from '../src/db/universe';
import {
  rankSectors,
  computeSectorRotation,
  _resetSectorRotationCache,
  MAX_MEMBERS_PER_SECTOR,
  SectorMemberReturn,
} from '../src/services/sectorRotation';

const mockGetProvider = vi.mocked(getProvider);
const mockUniverse = vi.mocked(listUniverse);

function candlesFrom(closes: number[]) {
  return closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 0 }));
}

// A rising/falling series whose lookbackReturnPct over `lookbackDays` equals a
// target %: last close = first close * (1 + target/100), linear in between.
function seriesWithReturn(returnPct: number, lookbackDays: number) {
  const start = 100;
  const end = start * (1 + returnPct / 100);
  const n = lookbackDays + 1;
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1));
}

function uni(symbol: string, sector: string | null) {
  return { symbol, name: null, sector, addedAt: 0 };
}

describe('rankSectors — pure', () => {
  const base = (over: Partial<Parameters<typeof rankSectors>[0]> = {}) => ({
    membersBySector: new Map<string, SectorMemberReturn[]>(),
    unresolvedSectors: [],
    benchmarkReturnPct: 2,
    benchmarkSymbol: 'SPY',
    lookbackDays: 20,
    asOf: 0,
    ...over,
  });

  it('ranks sectors by median relative strength, strongest first', () => {
    const r = rankSectors(
      base({
        membersBySector: new Map([
          // Tech members return 10% & 12% -> rel 8 & 10 -> median 9
          [
            'Tech',
            [
              { symbol: 'AAA', returnPct: 10 },
              { symbol: 'BBB', returnPct: 12 },
            ],
          ],
          // Utils members return 1% & 3% -> rel -1 & 1 -> median 0
          [
            'Utilities',
            [
              { symbol: 'CCC', returnPct: 1 },
              { symbol: 'DDD', returnPct: 3 },
            ],
          ],
        ]),
      }),
    );
    expect(r.basis).toBe('relative-to-benchmark');
    expect(r.sectors.map((s) => s.sector)).toEqual(['Tech', 'Utilities']);
    expect(r.sectors[0].medianRelStrengthPct).toBeCloseTo(9, 6);
    expect(r.sectors[1].medianRelStrengthPct).toBeCloseTo(0, 6);
  });

  it('uses the median, so one runaway member does not carry a sector', () => {
    const r = rankSectors(
      base({
        benchmarkReturnPct: 0,
        membersBySector: new Map([
          [
            'A',
            [
              { symbol: 'X', returnPct: 1 },
              { symbol: 'Y', returnPct: 2 },
              { symbol: 'Z', returnPct: 300 },
            ],
          ],
        ]),
      }),
    );
    expect(r.sectors[0].medianRelStrengthPct).toBe(2); // median of 1,2,300
    expect(r.sectors[0].topSymbol).toEqual({ symbol: 'Z', relStrengthPct: 300 });
  });

  it('falls back to absolute-return basis when the benchmark is null', () => {
    const r = rankSectors(
      base({
        benchmarkReturnPct: null,
        membersBySector: new Map([['A', [{ symbol: 'X', returnPct: 5 }]]]),
      }),
    );
    expect(r.basis).toBe('absolute-return');
    expect(r.sectors[0].medianRelStrengthPct).toBe(5); // benchmark treated as 0
  });

  it('carries unresolved sectors through without ranking them', () => {
    const r = rankSectors(base({ unresolvedSectors: ['Energy'] }));
    expect(r.sectors).toEqual([]);
    expect(r.unresolvedSectors).toEqual(['Energy']);
  });
});

describe('computeSectorRotation — async orchestrator', () => {
  beforeEach(() => {
    mockGetProvider.mockReset();
    mockUniverse.mockReset();
    mockUniverse.mockReturnValue([]);
    _resetSectorRotationCache();
  });

  it('groups the universe by sector and ranks by member relative strength', async () => {
    mockUniverse.mockReturnValue([
      uni('AAA', 'Tech'),
      uni('BBB', 'Tech'),
      uni('CCC', 'Utilities'),
      uni('NOSEC', null), // no sector -> excluded entirely
    ]);
    const getCandles = vi.fn(async (symbol: string) => {
      const map: Record<string, number> = { SPY: 2, AAA: 10, BBB: 12, CCC: 1 };
      return candlesFrom(seriesWithReturn(map[symbol] ?? 0, 20));
    });
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeSectorRotation({ force: true });
    expect(r.sectors.map((s) => s.sector)).toEqual(['Tech', 'Utilities']); // Tech leads
    expect(r.sectors[0].members.sort()).toEqual(['AAA', 'BBB']);
    expect(r.benchmarkReturnPct).toBeCloseTo(2, 6);
  });

  it('drops a member whose candles fail, listing a fully-failed sector as unresolved', async () => {
    mockUniverse.mockReturnValue([uni('GOOD', 'Tech'), uni('BAD', 'Energy')]);
    const getCandles = vi.fn(async (symbol: string) => {
      if (symbol === 'BAD') throw new Error('rate limited');
      return candlesFrom(seriesWithReturn(5, 20));
    });
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeSectorRotation({ force: true });
    expect(r.sectors.map((s) => s.sector)).toEqual(['Tech']);
    expect(r.unresolvedSectors).toEqual(['Energy']);
  });

  it('caps each sector at MAX_MEMBERS_PER_SECTOR', async () => {
    mockUniverse.mockReturnValue(Array.from({ length: MAX_MEMBERS_PER_SECTOR + 15 }, (_, i) => uni(`S${i}`, 'Tech')));
    const getCandles = vi.fn(async () => candlesFrom(seriesWithReturn(5, 20)));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    const r = await computeSectorRotation({ force: true });
    expect(r.sectors[0].sampledCount).toBe(MAX_MEMBERS_PER_SECTOR);
  });

  it('caches within the TTL — a second call does not re-hit the provider', async () => {
    mockUniverse.mockReturnValue([uni('AAA', 'Tech')]);
    const getCandles = vi.fn(async () => candlesFrom(seriesWithReturn(5, 20)));
    mockGetProvider.mockReturnValue({ getCandles } as unknown as ReturnType<typeof getProvider>);

    await computeSectorRotation({ force: true });
    const after = getCandles.mock.calls.length;
    await computeSectorRotation(); // served from cache
    expect(getCandles.mock.calls.length).toBe(after);
  });
});
