import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { webullProbe, webullStatus } from '../src/providers/webull/account';

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

describe('webull account probe', () => {
  it('is not configured without keys, and the probe no-ops', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    expect(webullStatus().configured).toBe(false);
    const r = await webullProbe('account-list');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('runs a snapshot probe through the signed client when configured', async () => {
    Object.assign(config.webull, { appKey: 'APPKEY123', appSecret: 'SECRET456', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ symbol: 'AAPL' }] }),
    } as Response);

    const r = await webullProbe('snapshot', { symbol: 'aapl' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ data: [{ symbol: 'AAPL' }] });

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/stock/snapshot');
    expect(url).toContain('symbols=AAPL'); // upper-cased
  });

  it('runs a bars probe (stock candles) for the given symbol', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('bars', { symbol: 'tsla' });
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/stock/bars');
    expect(url).toContain('symbol=TSLA'); // upper-cased
    expect(url).toContain('timespan=M1');
  });

  it('runs a movers probe against the gainers-losers screener', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('movers');
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/screener/gainers-losers');
    expect(url).toContain('direction=DESC');
  });

  it('runs an L2 depth probe for a symbol', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '{}' } as Response);
    const r = await webullProbe('depth', { symbol: 'aapl' });
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/stock/quotes');
    expect(url).toContain('symbol=AAPL');
    expect(url).toContain('depth=1');
  });

  it('runs an option-snapshot probe with the given OCC symbol', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('option-snapshot', { symbol: 'aapl260522c00300000' });
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/market-data/option/snapshot');
    expect(url).toContain('symbols=AAPL260522C00300000');
    expect(url).toContain('category=US_OPTION');
  });

  it('requires an account id for positions/balance, then queries assets', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    expect((await webullProbe('positions')).error).toMatch(/account/i); // guarded, no network

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('positions', { accountId: 'ACC1' });
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/assets/positions');
    expect(url).toContain('account_id=ACC1');
  });

  it('runs read-only order-query probes under /trade/, requiring an account id', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    // Guarded — no network until an account id is supplied.
    expect((await webullProbe('open-orders')).error).toMatch(/account/i);
    expect((await webullProbe('order-history')).error).toMatch(/account/i);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);

    await webullProbe('open-orders', { accountId: 'ACC1' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.webull.com/trade/open_orders');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('account_id=ACC1');

    await webullProbe('order-history', { accountId: 'ACC1' });
    expect(String(fetchSpy.mock.calls[1][0])).toContain('api.webull.com/trade/order_history');

    // GET only — these probes never POST (place nothing).
    expect(fetchSpy.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method === 'GET')).toBe(true);
  });

  it('lists app quote subscriptions (no account id needed)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('subscriptions');
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/app/subscriptions/list');
  });

  it('surfaces a Webull error cleanly (no throw)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ code: 'NO_PERMISSION', msg: 'market data not subscribed' }),
    } as Response);
    const r = await webullProbe('snapshot');
    expect(r).toMatchObject({ ok: false, status: 403, code: 'NO_PERMISSION' });
    expect(r.error).toMatch(/not subscribed/i);
  });

  it('surfaces the live snapshot 401 shape (error_code + message)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error_code: 'Unauthorized',
          message: 'Insufficient permission, please subscribe to stock quotes.',
        }),
    } as Response);
    const r = await webullProbe('snapshot');
    expect(r).toMatchObject({ ok: false, status: 401, code: 'Unauthorized' });
    expect(r.error).toMatch(/insufficient permission/i);
  });
});
