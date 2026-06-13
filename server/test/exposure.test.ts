import { describe, it, expect } from 'vitest';
import { computeExposure, ExposureInput } from '../src/services/exposure';

const sectors: Record<string, string> = { AAPL: 'Tech', MSFT: 'Tech', XOM: 'Energy' };
const sectorOf = (s: string) => sectors[s] ?? null;

describe('computeExposure', () => {
  const items: ExposureInput[] = [
    { symbol: 'AAPL', side: 'long', value: 6000 },
    { symbol: 'MSFT', side: 'long', value: 2000 },
    { symbol: 'XOM', side: 'short', value: 2000 },
  ];

  it('splits gross/net/long/short', () => {
    const e = computeExposure(items, sectorOf);
    expect(e.gross).toBe(10000);
    expect(e.long).toBe(8000);
    expect(e.short).toBe(2000);
    expect(e.net).toBe(6000);
  });

  it('groups by sector with percentages, sorted by gross', () => {
    const e = computeExposure(items, sectorOf);
    expect(e.bySector[0]).toEqual({ key: 'Tech', gross: 8000, pct: 80, count: 2 });
    expect(e.bySector[1]).toEqual({ key: 'Energy', gross: 2000, pct: 20, count: 1 });
  });

  it('reports the largest single position as a share of gross', () => {
    const e = computeExposure(items, sectorOf);
    expect(e.largest).toEqual({ symbol: 'AAPL', pct: 60 });
  });

  it('labels unknown symbols Unclassified and ignores zero-value rows', () => {
    const e = computeExposure(
      [
        { symbol: 'ZZZ', side: 'long', value: 1000 },
        { symbol: 'AAPL', side: 'long', value: 0 },
      ],
      sectorOf,
    );
    expect(e.bySector).toEqual([{ key: 'Unclassified', gross: 1000, pct: 100, count: 1 }]);
  });

  it('is empty-safe', () => {
    const e = computeExposure([], sectorOf);
    expect(e.gross).toBe(0);
    expect(e.largest).toBeNull();
    expect(e.bySector).toEqual([]);
  });
});
