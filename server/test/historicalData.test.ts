import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';

vi.mock('../src/services/autotrading/polygonClient', () => ({
  fetchPolygonBars: vi.fn(),
}));

import { fetchPolygonBars } from '../src/services/autotrading/polygonClient';
import { getHistoricalBars } from '../src/services/autotrading/historicalData';

const mockFetch = vi.mocked(fetchPolygonBars);

beforeAll(() => initDb());
beforeEach(() => {
  db.exec("DELETE FROM backtest_bars WHERE symbol LIKE 'HISTB%'");
  mockFetch.mockReset();
});

const bar = (time: number, close: number) => ({ time, open: close, high: close, low: close, close, volume: 1000 });

describe('getHistoricalBars', () => {
  it('fetches from Polygon and caches when nothing is cached yet', async () => {
    mockFetch.mockResolvedValue([
      bar(Date.parse('2024-01-02T00:00:00Z'), 1),
      bar(Date.parse('2024-01-03T00:00:00Z'), 2),
    ]);
    const bars = await getHistoricalBars('HISTB1', 'daily', '2024-01-01', '2024-01-05');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bars).toHaveLength(2);
  });

  it('serves from cache without a second fetch when the range is already covered', async () => {
    mockFetch.mockResolvedValue([bar(Date.parse('2024-01-02T00:00:00Z'), 1)]);
    await getHistoricalBars('HISTB2', 'daily', '2024-01-01', '2024-01-05');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    const bars = await getHistoricalBars('HISTB2', 'daily', '2024-01-01', '2024-01-05');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(bars).toHaveLength(1);
  });

  it('re-fetches when the requested range extends beyond what is cached', async () => {
    mockFetch.mockResolvedValue([bar(Date.parse('2024-01-02T00:00:00Z'), 1)]);
    await getHistoricalBars('HISTB3', 'daily', '2024-01-01', '2024-01-05');

    mockFetch.mockClear();
    mockFetch.mockResolvedValue([
      bar(Date.parse('2024-01-02T00:00:00Z'), 1),
      bar(Date.parse('2024-06-01T00:00:00Z'), 9),
    ]);
    const bars = await getHistoricalBars('HISTB3', 'daily', '2024-01-01', '2024-06-30');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bars).toHaveLength(2);
  });
});
