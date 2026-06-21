import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebullProvider } from '../src/providers/WebullProvider';
import { WebullClient } from '../src/providers/webull/client';
import { MarketDataProvider } from '../src/providers/MarketDataProvider';
import { OptionsChain } from '../src/providers/types';

afterEach(() => vi.restoreAllMocks());

const client = () => WebullClient.fromEnv({ appKey: 'k', appSecret: 's', region: 'us' });

// Minimal auxiliary provider (stands in for Yahoo) with spies on the delegated
// option/fundamentals methods.
function fakeAux(): MarketDataProvider {
  return {
    name: 'aux',
    synthetic: false,
    capabilities: { quotes: true, candles: true, options: true, fundamentals: true },
    getQuote: vi.fn(),
    getCandles: vi.fn(),
    getOptionsExpirations: vi.fn(async () => ['2026-07-17']),
    getOptionsChain: vi.fn(
      async () => ({ underlying: 'AAPL', expiration: '2026-07-17', calls: [], puts: [] }) as OptionsChain,
    ),
    getFundamentals: vi.fn(async () => ({ symbol: 'AAPL', name: 'Apple' })),
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('WebullProvider', () => {
  it('maps a snapshot row to a Quote (string prices, fractional change_ratio)', async () => {
    mockFetch([
      {
        symbol: 'AAPL',
        price: '190.12',
        open: '188.00',
        high: '191.00',
        low: '187.50',
        pre_close: '187.62',
        change: '2.50',
        change_ratio: '0.0133',
        volume: '52000000',
        last_trade_time: 1718900000000,
      },
    ]);
    const p = new WebullProvider(client(), fakeAux());
    const q = await p.getQuote('aapl');
    expect(q.symbol).toBe('AAPL');
    expect(q.last).toBe(190.12);
    expect(q.prevClose).toBe(187.62);
    expect(q.changePct).toBe(1.33); // 0.0133 fraction -> percent
    expect(q.volume).toBe(52000000);
    expect(q.timestamp).toBe(1718900000000);
  });

  it('batches getQuotes through one snapshot call', async () => {
    const spy = mockFetch([
      { symbol: 'AAPL', price: '1' },
      { symbol: 'MSFT', price: '2' },
    ]);
    const p = new WebullProvider(client(), fakeAux());
    const qs = await p.getQuotes(['aapl', 'msft']);
    expect(qs.map((q) => q.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('symbols=AAPL%2CMSFT');
  });

  it('maps bars from the live shape (flat array, ISO time string, newest-first)', async () => {
    // Exact shape returned by /stock/bars: a bare array, ISO-8601 `time`, string OHLCV.
    mockFetch([
      {
        tickerId: '913256135',
        symbol: 'AAPL',
        time: '2026-06-18T19:59:00.000+0000',
        open: '298.49',
        high: '298.51',
        low: '297.85',
        close: '298.01',
        volume: '24686259',
        trading_session: 'RTH',
      },
      {
        tickerId: '913256135',
        symbol: 'AAPL',
        time: '2026-06-18T19:58:00.000+0000',
        open: '298.50',
        high: '298.54',
        low: '298.48',
        close: '298.505',
        volume: '358184',
        trading_session: 'RTH',
      },
    ]);
    const p = new WebullProvider(client(), fakeAux());
    const candles = await p.getCandles('AAPL', 'daily');
    expect(candles).toHaveLength(2);
    // Sorted ascending despite the newest-first payload.
    expect(candles[0].time).toBe(Date.parse('2026-06-18T19:58:00.000+0000'));
    expect(candles[1].time).toBe(Date.parse('2026-06-18T19:59:00.000+0000'));
    expect(candles[1].close).toBe(298.01);
    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain('/openapi/market-data/stock/bars');
    expect(url).toContain('timespan=D');
  });

  it('also handles a nested bars array with epoch-seconds timestamps (defensive)', async () => {
    mockFetch([
      { symbol: 'AAPL', bars: [{ timestamp: 1700000000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '20' }] },
    ]);
    const p = new WebullProvider(client(), fakeAux());
    const candles = await p.getCandles('AAPL', '1min');
    expect(candles).toHaveLength(1);
    expect(candles[0].time).toBe(1700000000000); // seconds -> ms
  });

  it('surfaces a 401 quote-subscription error as a ProviderError', async () => {
    mockFetch(
      { error_code: 'Unauthorized', message: 'Insufficient permission, please subscribe to stock quotes.' },
      401,
    );
    const p = new WebullProvider(client(), fakeAux());
    await expect(p.getQuote('AAPL')).rejects.toMatchObject({ status: 401 });
  });

  it('delegates option chains and fundamentals to the auxiliary provider', async () => {
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    expect(await p.getOptionsExpirations('AAPL')).toEqual(['2026-07-17']);
    await p.getOptionsChain('AAPL', '2026-07-17');
    await p.getFundamentals('AAPL');
    expect(aux.getOptionsExpirations).toHaveBeenCalledWith('AAPL');
    expect(aux.getOptionsChain).toHaveBeenCalledWith('AAPL', '2026-07-17');
    expect(aux.getFundamentals).toHaveBeenCalledWith('AAPL');
  });
});
