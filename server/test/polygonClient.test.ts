import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { fetchPolygonBars, PolygonError } from '../src/services/autotrading/polygonClient';

const orig = { ...config.polygon };
afterEach(() => {
  Object.assign(config.polygon, orig);
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('fetchPolygonBars', () => {
  it('throws PolygonError without an API key (no network call)', async () => {
    Object.assign(config.polygon, { apiKey: '' });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchPolygonBars('AAPL', 'daily', '2024-01-01', '2024-01-31')).rejects.toThrow(PolygonError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps o/h/l/c/v/t to the app Candle shape and sends Bearer auth', async () => {
    Object.assign(config.polygon, { apiKey: 'test-key' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        results: [{ o: 100, h: 105, l: 99, c: 103, v: 1_000_000, t: 1704067200000 }],
      }),
    );
    const bars = await fetchPolygonBars('aapl', 'daily', '2024-01-01', '2024-01-31');
    expect(bars).toEqual([{ time: 1704067200000, open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 }]);

    const [url, opts] = spy.mock.calls[0];
    expect(String(url)).toContain('/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-01-31');
    expect(String(url)).toContain('adjusted=true');
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('maps each Timeframe to the correct Polygon multiplier/timespan', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ results: [] }));
    const cases: [string, string][] = [
      ['1min', '/range/1/minute/'],
      ['5min', '/range/5/minute/'],
      ['15min', '/range/15/minute/'],
      ['daily', '/range/1/day/'],
      ['weekly', '/range/1/week/'],
    ];
    for (const [tf, expected] of cases) {
      spy.mockClear();
      await fetchPolygonBars('AAPL', tf as never, '2024-01-01', '2024-01-02');
      expect(String(spy.mock.calls[0][0])).toContain(expected);
    }
  });

  it('normalizes daily/weekly bar times to UTC midnight (Polygon stamps them at midnight ET)', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    // 2024-01-01 is EST: midnight ET = 05:00 UTC. 2024-07-01 is EDT: 04:00 UTC.
    // The backtest engines match bars to simulated days by exact UTC-midnight
    // equality, so leaving these raw made every simulation silently no-op.
    const est = Date.parse('2024-01-01T05:00:00Z');
    const edt = Date.parse('2024-07-01T04:00:00Z');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        results: [
          { o: 1, h: 1, l: 1, c: 1, v: 1, t: est },
          { o: 2, h: 2, l: 2, c: 2, v: 2, t: edt },
        ],
      }),
    );
    for (const tf of ['daily', 'weekly'] as const) {
      const bars = await fetchPolygonBars('AAPL', tf, '2024-01-01', '2024-12-31');
      expect(bars.map((b) => b.time)).toEqual([Date.parse('2024-01-01T00:00:00Z'), Date.parse('2024-07-01T00:00:00Z')]);
    }
  });

  it('leaves intraday bar times untouched', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    const t = Date.parse('2024-01-02T14:35:00Z'); // a real 09:35 ET minute bar
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ results: [{ o: 1, h: 1, l: 1, c: 1, v: 1, t }] }));
    const bars = await fetchPolygonBars('AAPL', '5min', '2024-01-02', '2024-01-02');
    expect(bars[0].time).toBe(t);
  });

  it('follows next_url pagination until exhausted', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    const page1 = jsonResponse({
      results: [{ o: 1, h: 1, l: 1, c: 1, v: 1, t: 1 }],
      next_url: 'https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-01-31?cursor=abc',
    });
    const page2 = jsonResponse({ results: [{ o: 2, h: 2, l: 2, c: 2, v: 2, t: 2 }] });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const bars = await fetchPolygonBars('AAPL', 'daily', '2024-01-01', '2024-01-31');
    expect(bars).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toContain('cursor=abc');
  });

  it('throws PolygonError with the response error message on a non-ok response', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'Unknown API Key' }, false, 401));
    await expect(fetchPolygonBars('AAPL', 'daily', '2024-01-01', '2024-01-31')).rejects.toThrow(/Unknown API Key/);
  });

  it('retries a 429 (honoring Retry-After) instead of failing the whole fetch', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    const rateLimited = {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
      json: async () => ({ error: 'rate limited' }),
    } as unknown as Response;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(jsonResponse({ results: [{ o: 1, h: 1, l: 1, c: 1, v: 1, t: 1704067200000 }] }));
    const bars = await fetchPolygonBars('AAPL', 'daily', '2024-01-01', '2024-01-31');
    expect(bars).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('treats a missing results array as zero bars, not an error', async () => {
    Object.assign(config.polygon, { apiKey: 'k' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'OK' }));
    expect(await fetchPolygonBars('AAPL', 'daily', '2024-01-01', '2024-01-31')).toEqual([]);
  });
});
