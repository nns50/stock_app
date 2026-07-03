import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';

vi.mock('../src/services/autotrading/polygonOptionsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/polygonOptionsClient')>();
  return { ...actual, fetchPolygonOptionContracts: vi.fn() };
});

import { fetchPolygonOptionContracts, OptionContractRef } from '../src/services/autotrading/polygonOptionsClient';
import { getHistoricalOptionContracts } from '../src/services/autotrading/optionsHistoricalData';

const mockFetch = vi.mocked(fetchPolygonOptionContracts);

beforeAll(() => initDb());
beforeEach(() => {
  db.exec("DELETE FROM backtest_option_contracts WHERE underlying LIKE 'HISTOPT%'");
  db.exec("DELETE FROM backtest_option_contracts_fetch_log WHERE underlying LIKE 'HISTOPT%'");
  mockFetch.mockReset();
});

const contract = (underlying: string, ticker: string, strike: number, expiration: string): OptionContractRef => ({
  ticker,
  underlying,
  contractType: 'call',
  strike,
  expiration,
});

describe('getHistoricalOptionContracts', () => {
  it('fetches from Polygon and caches when nothing is cached yet', async () => {
    mockFetch.mockResolvedValue([contract('HISTOPT1', 'O:HISTOPT1-A', 100, '2024-03-15')]);
    const contracts = await getHistoricalOptionContracts('HISTOPT1', '2024-01-01', '2024-06-30');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(contracts).toHaveLength(1);
  });

  it('serves from cache without a second fetch when the range is already covered', async () => {
    mockFetch.mockResolvedValue([contract('HISTOPT2', 'O:HISTOPT2-A', 100, '2024-03-15')]);
    await getHistoricalOptionContracts('HISTOPT2', '2024-01-01', '2024-06-30');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    const contracts = await getHistoricalOptionContracts('HISTOPT2', '2024-01-01', '2024-06-30');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(contracts).toHaveLength(1);
  });

  it('re-fetches when the requested range extends beyond what is cached', async () => {
    mockFetch.mockResolvedValue([contract('HISTOPT3', 'O:HISTOPT3-A', 100, '2024-03-15')]);
    await getHistoricalOptionContracts('HISTOPT3', '2024-01-01', '2024-06-30');

    mockFetch.mockClear();
    mockFetch.mockResolvedValue([
      contract('HISTOPT3', 'O:HISTOPT3-A', 100, '2024-03-15'),
      contract('HISTOPT3', 'O:HISTOPT3-B', 100, '2024-12-15'),
    ]);
    const contracts = await getHistoricalOptionContracts('HISTOPT3', '2024-01-01', '2024-12-31');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(contracts).toHaveLength(2);
  });
});
