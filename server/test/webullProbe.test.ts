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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.webull.com/openapi/trade/order/open');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('account_id=ACC1');

    await webullProbe('order-history', { accountId: 'ACC1' });
    expect(String(fetchSpy.mock.calls[1][0])).toContain('api.webull.com/openapi/trade/order/history');

    // GET only — these probes never POST (place nothing).
    expect(fetchSpy.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method === 'GET')).toBe(true);
  });

  it('passes the order-list paging through as named, dates on the history only', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);

    await webullProbe('order-history', {
      accountId: 'ACC1',
      pageSize: 100,
      lastClientOrderId: 'abc123',
      startDate: '2026-09-17',
      endDate: '2026-09-23',
    });
    const history = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(history.pathname).toBe('/openapi/trade/order/history');
    expect(history.searchParams.get('account_id')).toBe('ACC1');
    expect(history.searchParams.get('page_size')).toBe('100');
    expect(history.searchParams.get('last_client_order_id')).toBe('abc123');
    expect(history.searchParams.get('start_date')).toBe('2026-09-17');
    expect(history.searchParams.get('end_date')).toBe('2026-09-23');

    // The open list takes the page and the cursor, never a date window.
    await webullProbe('open-orders', {
      accountId: 'ACC1',
      pageSize: 5,
      lastClientOrderId: 'def456',
      startDate: '2026-09-17',
    });
    const open = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(open.pathname).toBe('/openapi/trade/order/open');
    expect(open.searchParams.get('page_size')).toBe('5');
    expect(open.searchParams.get('last_client_order_id')).toBe('def456');
    expect(open.searchParams.has('start_date')).toBe(false);

    // Without paging the probe still reads the broker's default first page.
    await webullProbe('order-history', { accountId: 'ACC1' });
    const bare = new URL(String(fetchSpy.mock.calls[2][0]));
    expect([...bare.searchParams.keys()]).toEqual(['account_id']);
  });

  it('reads one order by its client_order_id, and needs both ids first', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '{}' } as Response);
    // Guarded — no network without either id.
    expect((await webullProbe('order-detail', { clientOrderId: 'abc' })).error).toMatch(/account/i);
    expect((await webullProbe('order-detail', { accountId: 'ACC1' })).error).toMatch(/client_order_id/i);
    expect(fetchSpy).not.toHaveBeenCalled();

    const r = await webullProbe('order-detail', { accountId: 'ACC1', clientOrderId: 'abc123' });
    expect(r.ok).toBe(true);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/openapi/trade/order/detail');
    expect(url.searchParams.get('account_id')).toBe('ACC1');
    expect(url.searchParams.get('client_order_id')).toBe('abc123');
    expect((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.method).toBe('GET');
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

  it('runs an unconfirmed instrument probe for a symbol (no account id needed)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullProbe('instrument', { symbol: 'aapl' });
    expect(r.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('api.webull.com/openapi/instrument/stock/list');
    expect(url).toContain('symbols=AAPL'); // upper-cased
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
