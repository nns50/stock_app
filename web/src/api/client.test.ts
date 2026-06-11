import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, client } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('parses JSON on success', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { name: 'mock', synthetic: true, configured: true, capabilities: {} }));
    const p = await client.provider();
    expect(p.name).toBe('mock');
    expect(p.synthetic).toBe(true);
  });

  it('throws ApiError with status, message and code on failure', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'not configured', code: 'not_configured' }));
    await expect(client.provider()).rejects.toBeInstanceOf(ApiError);
    await expect(client.provider()).rejects.toMatchObject({ status: 503, message: 'not configured', code: 'not_configured' });
  });

  it('sends PUT with a JSON body for settings', async () => {
    const fetchMock = mockFetch(200, { key: 'k', value: 1 });
    vi.stubGlobal('fetch', fetchMock);
    await client.saveSetting('k', 1);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/k', expect.objectContaining({ method: 'PUT' }));
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({ value: 1 });
  });
});
