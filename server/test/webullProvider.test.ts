import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebullProvider } from '../src/providers/WebullProvider';
import { WebullClient } from '../src/providers/webull/client';
import { MarketDataProvider } from '../src/providers/MarketDataProvider';
import { OptionsChain } from '../src/providers/types';

afterEach(() => vi.restoreAllMocks());

const client = () => WebullClient.fromEnv({ appKey: 'k', appSecret: 's', region: 'us' });

// Minimal auxiliary provider (stands in for Yahoo). Quote/candle methods return
// a marker value (last 9.99) so fallbacks are observable; option/fundamentals
// are spies for the delegation tests.
function fakeAux(): MarketDataProvider {
  return {
    name: 'aux',
    synthetic: false,
    capabilities: { quotes: true, candles: true, options: true, fundamentals: true },
    getQuote: vi.fn(async (s: string) => ({ symbol: s.toUpperCase(), last: 9.99, timestamp: 1 })),
    getQuotes: vi.fn(async (syms: string[]) =>
      syms.map((s) => ({ symbol: s.toUpperCase(), last: 9.99, timestamp: 1 })),
    ),
    getCandles: vi.fn(async () => [{ time: 1, open: 9, high: 9, low: 9, close: 9, volume: 9 }]),
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
  it('maps a snapshot row to a Quote (live shape: string prices, fractional change_ratio, bid/ask)', async () => {
    // Trimmed from a real /stock/snapshot response.
    mockFetch([
      {
        symbol: 'AAPL',
        price: '298.0100',
        open: '298.1100',
        high: '300.5700',
        low: '295.6200',
        volume: '85962201',
        change: '2.0600',
        close: '298.0100',
        instrument_id: '913256135',
        pre_close: '295.95',
        change_ratio: '0.006961',
        last_trade_time: 1781812800994,
        ask: '303.0000',
        bid: '297.2000',
      },
    ]);
    const p = new WebullProvider(client(), fakeAux());
    const q = await p.getQuote('aapl');
    expect(q.symbol).toBe('AAPL');
    expect(q.last).toBe(298.01);
    expect(q.prevClose).toBe(295.95);
    expect(q.changePct).toBe(0.7); // 0.006961 fraction -> 0.70%
    expect(q.bid).toBe(297.2);
    expect(q.ask).toBe(303);
    expect(q.volume).toBe(85962201);
    expect(q.timestamp).toBe(1781812800994);
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

  // -------------------------------------------------------------------------
  // Date ranges (2026-08-25). Webull's bars endpoint has no range parameter —
  // it takes a `count` and nothing else — and start/end used to be dropped here
  // WITHOUT a trace. A caller asking for one specific day got the last 120 bars
  // and could not tell. That is how the MAE/MFE report came to measure the
  // symbol's six-month high/low instead of each trade's excursion, reporting an
  // average adverse excursion four times the stop distance.
  // -------------------------------------------------------------------------
  const barAt = (day: string, close: string) => ({
    symbol: 'AAPL',
    time: `${day}T19:59:00.000+0000`,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
  });

  it('filters returned bars to a requested start/end window', async () => {
    mockFetch([barAt('2026-06-16', '1'), barAt('2026-06-17', '2'), barAt('2026-06-18', '3')]);
    const p = new WebullProvider(client(), fakeAux());
    const candles = await p.getCandles('AAPL', 'daily', { start: '2026-06-17', end: '2026-06-17' });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(2);
  });

  it('includes both boundary days — a same-day trade has exactly one bar', async () => {
    mockFetch([barAt('2026-06-16', '1'), barAt('2026-06-17', '2'), barAt('2026-06-18', '3')]);
    const p = new WebullProvider(client(), fakeAux());
    const candles = await p.getCandles('AAPL', 'daily', { start: '2026-06-16', end: '2026-06-18' });
    expect(candles.map((c) => c.close)).toEqual([1, 2, 3]);
  });

  it('asks for enough bars to reach a far-back start, not just the default 120', async () => {
    const fetchSpy = mockFetch([barAt('2026-06-18', '3')]);
    const p = new WebullProvider(client(), fakeAux());
    // A start ~2 years back needs far more than the 120-bar default.
    await p.getCandles('AAPL', 'daily', { start: '2024-08-25', end: '2026-06-18' }).catch(() => []);
    const url = String(fetchSpy.mock.calls[0][0]);
    const count = Number(new URL(url).searchParams.get('count'));
    expect(count).toBeGreaterThan(400);
  });

  it('falls back to the aux provider when the window starts before the oldest bar available', async () => {
    // Returning a truncated window the caller would read as complete is the
    // failure this whole change is about — hand it to a provider with real
    // range support instead.
    mockFetch([barAt('2026-06-17', '2'), barAt('2026-06-18', '3')]);
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    const q = { start: '2020-01-01', end: '2026-06-18' };
    const candles = await p.getCandles('AAPL', 'daily', q);
    expect(aux.getCandles).toHaveBeenCalledWith('AAPL', 'daily', q);
    expect(candles).toEqual([{ time: 1, open: 9, high: 9, low: 9, close: 9, volume: 9 }]);
  });

  it('leaves plain limit-only queries alone (the hot path)', async () => {
    mockFetch([barAt('2026-06-16', '1'), barAt('2026-06-17', '2'), barAt('2026-06-18', '3')]);
    const p = new WebullProvider(client(), fakeAux());
    const candles = await p.getCandles('AAPL', 'daily', { limit: 2 });
    expect(candles.map((c) => c.close)).toEqual([2, 3]);
  });

  it('also handles a nested bars array with epoch-seconds timestamps (defensive)', async () => {
    mockFetch([
      {
        symbol: 'AAPL',
        bars: [{ timestamp: 1700000000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '20' }],
      },
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
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    await expect(p.getQuote('AAPL')).rejects.toMatchObject({ status: 401 });
    // An auth failure must NOT be masked by falling back to the aux provider.
    expect(aux.getQuotes).not.toHaveBeenCalled();
  });

  it('falls back to the aux provider for candles Webull rejects (BRK.B → 417)', async () => {
    mockFetch({ error_code: 'INVALID_SYMBOL', message: 'The symbol does not exist in the category.' }, 417);
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    const candles = await p.getCandles('BRK.B', 'daily');
    expect(aux.getCandles).toHaveBeenCalledWith('BRK.B', 'daily', undefined);
    expect(candles).toHaveLength(1); // served by aux
  });

  it('does NOT fall back to the aux provider for candles on an auth error', async () => {
    mockFetch({ message: 'Insufficient permission, please subscribe to stock quotes.' }, 401);
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    await expect(p.getCandles('AAPL', 'daily')).rejects.toMatchObject({ status: 401 });
    expect(aux.getCandles).not.toHaveBeenCalled();
  });

  it('fills Webull-missing symbols from the aux provider (getQuotes)', async () => {
    // Webull returns AAPL but omits BRK.B; the aux provider supplies it.
    mockFetch([{ symbol: 'AAPL', price: '298.01' }]);
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    const qs = await p.getQuotes(['AAPL', 'BRK.B']);
    const bySym = Object.fromEntries(qs.map((q) => [q.symbol, q.last]));
    expect(bySym['AAPL']).toBe(298.01); // from Webull
    expect(bySym['BRK.B']).toBe(9.99); // from aux
    expect(aux.getQuotes).toHaveBeenCalledWith(['BRK.B']);
  });

  it('delegates option chains to the auxiliary provider', async () => {
    const aux = fakeAux();
    const p = new WebullProvider(client(), aux);
    expect(await p.getOptionsExpirations('AAPL')).toEqual(['2026-07-17']);
    await p.getOptionsChain('AAPL', '2026-07-17');
    expect(aux.getOptionsExpirations).toHaveBeenCalledWith('AAPL');
    expect(aux.getOptionsChain).toHaveBeenCalledWith('AAPL', '2026-07-17');
  });

  it('overlays Webull snapshot valuation metrics on the aux fundamentals', async () => {
    // aux supplies name/sector; Webull's snapshot supplies the licensed numerics.
    const aux = fakeAux();
    aux.getFundamentals = vi.fn(async () => ({
      symbol: 'AAPL',
      name: 'Apple',
      sector: 'Tech',
      peRatio: 30, // stale aux value, should be overridden
      marketCap: 1,
    }));
    mockFetch([
      {
        symbol: 'AAPL',
        market_value: '4376978961560',
        pe_ratio: '36.05',
        eps_ttm: '8.27',
        yield: '0.0036',
        fifty_two_wk_high: '317.4',
        fifty_two_wk_low: '194.3',
      },
    ]);
    const p = new WebullProvider(client(), aux);
    const f = await p.getFundamentals('AAPL');
    expect(f.name).toBe('Apple'); // kept from aux
    expect(f.sector).toBe('Tech'); // kept from aux
    expect(f.peRatio).toBe(36.05); // overridden by Webull
    expect(f.marketCap).toBe(4376978961560);
    expect(f.eps).toBe(8.27);
    expect(f.high52).toBe(317.4);
  });

  it('keeps the aux fundamentals when Webull does not carry the symbol', async () => {
    const aux = fakeAux();
    aux.getFundamentals = vi.fn(async () => ({ symbol: 'BRK.B', name: 'Berkshire', peRatio: 9 }));
    mockFetch({ error_code: 'INVALID_SYMBOL', message: 'The symbol does not exist in the category.' }, 417);
    const p = new WebullProvider(client(), aux);
    const f = await p.getFundamentals('BRK.B');
    expect(f).toMatchObject({ symbol: 'BRK.B', name: 'Berkshire', peRatio: 9 });
  });
});
