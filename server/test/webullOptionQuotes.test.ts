import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { webullOptionQuotes, clearOptionQuotesCache } from '../src/providers/webull/optionQuotes';

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  clearOptionQuotesCache();
  vi.restoreAllMocks();
});

// One row of the confirmed live /option/snapshot shape (every value a string).
const SNAP = [
  {
    symbol: 'AAPL260622C00300000',
    price: '1.03',
    volume: '30882',
    change_ratio: '-0.2426',
    gamma: '0.0894',
    delta: '0.3152',
    theta: '-0.2526',
    vega: '0.0963',
    bid: '0.98',
    ask: '1.08',
    imp_vol: '0.147',
    open_interest: '4413',
    quote_time: 1781812799000,
    ask_size: '45',
    bid_size: '1',
  },
];

const okResp = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

describe('webull option quotes', () => {
  it('is a no-op (clean error) without keys', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await webullOptionQuotes(['AAPL260622C00300000']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('maps the confirmed snapshot shape (strings → numbers, mark = midpoint)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(SNAP));

    const r = await webullOptionQuotes(['aapl260622c00300000']); // lower-cased on purpose
    expect(r.ok).toBe(true);
    expect(r.quotes).toHaveLength(1);
    const q = r.quotes[0];
    expect(q).toMatchObject({
      symbol: 'AAPL260622C00300000',
      bid: 0.98,
      ask: 1.08,
      bidSize: 1,
      askSize: 45,
      last: 1.03,
      mark: 1.03, // (0.98 + 1.08) / 2
      volume: 30882,
      openInterest: 4413,
      iv: 0.147,
      delta: 0.3152,
      quoteTime: 1781812799000,
    });
    expect(q.changePct).toBeCloseTo(-24.26);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/option/snapshot');
    expect(url).toContain('symbols=AAPL260622C00300000'); // upper-cased
    expect(url).toContain('category=US_OPTION');
  });

  it('serves cached quotes within the TTL (one network call for repeat asks)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(SNAP));

    await webullOptionQuotes(['AAPL260622C00300000']);
    await webullOptionQuotes(['AAPL260622C00300000']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves the requested order regardless of response order', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const A = { ...SNAP[0], symbol: 'AAA260622C00100000' };
    const B = { ...SNAP[0], symbol: 'BBB260622C00100000' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp([B, A])); // reversed
    const r = await webullOptionQuotes(['AAA260622C00100000', 'BBB260622C00100000']);
    expect(r.quotes.map((q) => q.symbol)).toEqual(['AAA260622C00100000', 'BBB260622C00100000']);
  });

  it('makes no network call for an all-empty ask', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await webullOptionQuotes(['', '   ']);
    expect(r).toEqual({ ok: true, quotes: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a Webull error cleanly when nothing is cached', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 417,
      text: async () => JSON.stringify({ error_code: 'INVALID_SYMBOL', message: 'Invalid Symbol:[BOGUS].' }),
    } as Response);
    const r = await webullOptionQuotes(['BOGUS']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid symbol/i);
    expect(r.quotes).toEqual([]);
  });
});
