import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { fetchPolygonOptionContracts } from '../src/services/autotrading/polygonOptionsClient';
import { PolygonError } from '../src/services/autotrading/polygonClient';

const orig = { ...config.polygon };
afterEach(() => {
  Object.assign(config.polygon, orig);
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('fetchPolygonOptionContracts', () => {
  it('throws PolygonError without an API key (no network call)', async () => {
    Object.assign(config.polygon, { apiKey: '' });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchPolygonOptionContracts('AAPL', '2024-01-01', '2024-03-01')).rejects.toThrow(PolygonError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps Polygon contract fields to OptionContractRef and sends Bearer auth', async () => {
    Object.assign(config.polygon, { apiKey: 'test-key' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        results: [
          {
            ticker: 'O:AAPL240315C00100000',
            underlying_ticker: 'AAPL',
            contract_type: 'call',
            strike_price: 100,
            expiration_date: '2024-03-15',
          },
        ],
      }),
    );
    const contracts = await fetchPolygonOptionContracts('aapl', '2024-01-01', '2024-03-31');
    // The same response served to both the expired and active passes — the
    // ticker-keyed merge must not duplicate the contract.
    expect(contracts).toEqual([
      {
        ticker: 'O:AAPL240315C00100000',
        underlying: 'AAPL',
        contractType: 'call',
        strike: 100,
        expiration: '2024-03-15',
      },
    ]);

    const [url, opts] = spy.mock.calls[0];
    expect(String(url)).toContain('/v3/reference/options/contracts?underlying_ticker=AAPL');
    expect(String(url)).toContain('expiration_date.gte=2024-01-01');
    expect(String(url)).toContain('expiration_date.lte=2024-03-31');
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('queries BOTH expired and active contracts and merges them (Polygon defaults to active-only)', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    const contract = (ticker: string, expiration: string) => ({
      ticker,
      underlying_ticker: 'AAPL',
      contract_type: 'call',
      strike_price: 100,
      expiration_date: expiration,
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url).includes('expired=true')
          ? jsonResponse({ results: [contract('O:AAPL240315C00100000', '2024-03-15')] })
          : jsonResponse({ results: [contract('O:AAPL270115C00100000', '2027-01-15')] }),
      );
    const contracts = await fetchPolygonOptionContracts('AAPL', '2024-01-01', '2027-01-31');
    expect(contracts.map((c) => c.ticker).sort()).toEqual(['O:AAPL240315C00100000', 'O:AAPL270115C00100000']);
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('expired=true'))).toBe(true);
    expect(urls.some((u) => u.includes('expired=false'))).toBe(true);
  });

  it('follows next_url pagination until exhausted', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    // Keyed on URL, not call order — both the expired and active passes hit
    // this mock, and each must follow its own next_url chain independently.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('cursor=abc')
        ? jsonResponse({
            results: [
              {
                ticker: 'O:AAPL240315C00105000',
                underlying_ticker: 'AAPL',
                contract_type: 'call',
                strike_price: 105,
                expiration_date: '2024-03-15',
              },
            ],
          })
        : jsonResponse({
            results: [
              {
                ticker: 'O:AAPL240315C00100000',
                underlying_ticker: 'AAPL',
                contract_type: 'call',
                strike_price: 100,
                expiration_date: '2024-03-15',
              },
            ],
            next_url: 'https://api.polygon.io/v3/reference/options/contracts?cursor=abc',
          }),
    );
    const contracts = await fetchPolygonOptionContracts('AAPL', '2024-01-01', '2024-03-31');
    expect(contracts).toHaveLength(2);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('cursor=abc'))).toBe(true);
  });

  it('throws PolygonError with the response error message on a non-ok response', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'Unknown API Key' }, false, 401));
    await expect(fetchPolygonOptionContracts('AAPL', '2024-01-01', '2024-03-31')).rejects.toThrow(/Unknown API Key/);
  });

  it('treats a missing results array as zero contracts, not an error', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'OK' }));
    expect(await fetchPolygonOptionContracts('AAPL', '2024-01-01', '2024-03-31')).toEqual([]);
  });

  it('skips a non call/put contract_type rather than throwing or crashing the batch', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        results: [
          {
            ticker: 'O:WEIRD',
            underlying_ticker: 'AAPL',
            contract_type: 'other',
            strike_price: 100,
            expiration_date: '2024-03-15',
          },
          {
            ticker: 'O:AAPL240315C00100000',
            underlying_ticker: 'AAPL',
            contract_type: 'call',
            strike_price: 100,
            expiration_date: '2024-03-15',
          },
        ],
      }),
    );
    const contracts = await fetchPolygonOptionContracts('AAPL', '2024-01-01', '2024-03-31');
    expect(contracts).toHaveLength(1);
    expect(contracts[0].ticker).toBe('O:AAPL240315C00100000');
  });
});
