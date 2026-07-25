import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebullClient, WebullError } from '../src/providers/webull/client';

// Make the rate-limit backoff sleep instant so retry tests don't actually wait.
vi.mock('../src/util/http', async (orig) => {
  const actual = await orig<typeof import('../src/util/http')>();
  return { ...actual, sleep: async () => {} };
});

const client = new WebullClient({ appKey: 'APPKEY123', appSecret: 'SECRET456', region: 'us' });

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

/** A 429 response that carries a (header-less) Retry-After lookup. */
function rateLimited(): Response {
  return { ok: false, status: 429, headers: { get: () => null }, text: async () => '{}' } as unknown as Response;
}

describe('WebullClient', () => {
  it('GETs market data from the quotes host with signed headers', async () => {
    const f = mockFetch(200, { data: [{ symbol: 'AAPL' }] });
    const out = await client.get<{ data: unknown[] }>('/market-data/snapshot', { symbols: 'AAPL' });
    expect(out.data).toHaveLength(1);

    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://api.webull.com/market-data/snapshot?symbols=AAPL');
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-app-key']).toBe('APPKEY123');
    expect(headers['x-signature']).toBeTruthy();
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA1');
    expect(headers['x-version']).toBe('v2');
  });

  it('sends x-access-token only when a token is configured', async () => {
    const f1 = mockFetch(200, {});
    await client.get('/openapi/market-data/stock/snapshot', { symbols: 'AAPL' });
    expect((f1.mock.calls[0][1]?.headers as Record<string, string>)['x-access-token']).toBeUndefined();

    vi.restoreAllMocks();
    const f2 = mockFetch(200, {});
    const withToken = new WebullClient({ appKey: 'k', appSecret: 's', region: 'us', accessToken: 'TKN123' });
    await withToken.get('/openapi/account/list', {}, 'trade');
    expect((f2.mock.calls[0][1]?.headers as Record<string, string>)['x-access-token']).toBe('TKN123');
  });

  it('honors host overrides and call() returns the URL + status (no throw)', async () => {
    const f = mockFetch(404, { code: 'NOT_FOUND' });
    const overridden = new WebullClient({
      appKey: 'k',
      appSecret: 's',
      region: 'us',
      apiHost: 'ustrade.example.com',
    });
    const r = await overridden.call('GET', '/openapi/account/list', { surface: 'trade' });
    expect(r).toMatchObject({ ok: false, status: 404, url: 'https://ustrade.example.com/openapi/account/list' });
    expect(String(f.mock.calls[0][0])).toContain('ustrade.example.com');
  });

  it('POSTs to the trade host with a JSON body', async () => {
    const f = mockFetch(200, { ok: true });
    await client.post('/account/positions', { account_id: 'X1' });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://api.webull.com/account/positions');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ account_id: 'X1' }));
  });

  it('throws a WebullError carrying the API code/message on non-2xx', async () => {
    mockFetch(401, { code: 'AUTH_FAILED', msg: 'invalid signature' });
    await expect(client.get('/market-data/snapshot', { symbols: 'AAPL' })).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_FAILED',
      message: 'invalid signature',
    });
    await expect(client.get('/x', {})).rejects.toBeInstanceOf(WebullError);
  });

  it('retries on HTTP 429 (rate limited) then returns the success', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);
    const r = await client.call('GET', '/openapi/market-data/stock/snapshot', { query: { symbols: 'AAPL' } });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on a persistent 429', async () => {
    const limited = new WebullClient({ appKey: 'k', appSecret: 's', region: 'us', maxRetries: 2 });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimited());
    const r = await limited.call('GET', '/openapi/market-data/stock/snapshot', { query: { symbols: 'AAPL' } });
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries a network error (fetch rejection) then returns the success — never throws', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);
    const r = await client.call('GET', '/openapi/market-data/stock/snapshot', { query: { symbols: 'AAPL' } });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('returns a clean failure (never throws) on a persistent network error / timeout abort', async () => {
    // Regression (hardening audit): call() promises "never throws" and
    // webullPlaceOrder relies on it — a throw would unwind before the intent is
    // recorded, orphaning an order that may have reached the broker.
    const limited = new WebullClient({ appKey: 'k', appSecret: 's', region: 'us', maxRetries: 1 });
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const r = await limited.call('POST', '/openapi/trade/order/place', { surface: 'trade', body: { x: 1 } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect((r.data as { error?: string })?.error).toMatch(/timed out|abort/i);
    expect(f).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('does NOT retry a nonIdempotent call on a network error (no double-submit of a placed order)', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const r = await client.call('POST', '/openapi/trade/order/place', {
      surface: 'trade',
      body: { x: 1 },
      nonIdempotent: true,
    });
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(1); // exactly one attempt — the lost response is NOT retried
  });

  it('does NOT retry a nonIdempotent call on HTTP 429', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimited());
    const r = await client.call('POST', '/openapi/trade/order/place', {
      surface: 'trade',
      body: { x: 1 },
      nonIdempotent: true,
    });
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1); // no retry even on 429 — a 429 can post-date acceptance
  });
});
