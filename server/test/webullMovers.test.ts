import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { webullMovers } from '../src/providers/webull/movers';

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

describe('webull movers', () => {
  it('reports not-configured without keys (no network)', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await webullMovers('gainers');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('maps gainer rows from the live shape (DESC, change_ratio → percent)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [
            {
              symbol: 'bfly',
              name: 'Butterfly Network Inc',
              price: '8.90',
              close: '8.90',
              open: '7.21',
              pre_close: '5.71',
              change: '3.19',
              change_ratio: '0.5587',
              volume: '60480073',
              relative_volume_10d: '4.6733',
              market_value: '2328604063.40',
            },
          ],
          has_more: true,
        }),
    } as Response);
    const r = await webullMovers('gainers', 8);
    expect(r.ok).toBe(true);
    expect(r.movers[0]).toMatchObject({
      symbol: 'BFLY',
      name: 'Butterfly Network Inc',
      price: 8.9,
      change: 3.19,
      changePct: 55.87,
      gapPct: 26.27, // (7.21/5.71 - 1) * 100
      relativeVolume: 4.6733,
      marketCap: 2328604063.4,
    });
    expect(r.session).toBe('regular');
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('/openapi/market-data/screener/gainers-losers');
    expect(url).toContain('direction=DESC');
    expect(url).toContain('rank_type=DAY_1');
    expect(url).toContain('page_size=8');
  });

  it('ranks losers ASC, most-active by volume, unusual by relative volume', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '{"data":[]}' } as Response);
    await webullMovers('losers');
    expect(String(spy.mock.calls[0][0])).toContain('direction=ASC');
    await webullMovers('active');
    expect(String(spy.mock.calls[1][0])).toContain('/openapi/market-data/screener/top-active');
    await webullMovers('unusual');
    const u = String(spy.mock.calls[2][0]);
    expect(u).toContain('/openapi/market-data/screener/top-active');
    expect(u).toContain('sort_by=RELATIVE_VOLUME_10D');
  });

  it('maps the session to the Webull rank_type (pre-market gap scanner)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '{"data":[]}' } as Response);
    const r = await webullMovers('gainers', 10, 'premarket');
    expect(r.session).toBe('premarket');
    expect(String(spy.mock.calls[0][0])).toContain('rank_type=PRE_MARKET');
  });

  it('surfaces a Webull error without throwing', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Insufficient permission' }),
    } as Response);
    const r = await webullMovers('gainers');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/i);
  });
});
