import { describe, it, expect, vi } from 'vitest';
import { parseFredCsv, fetchFredSeries } from '../src/services/fredSeries';
import { ProviderError } from '../src/providers/MarketDataProvider';

// The runtime fetcher must parse FRED by the same rules as ml/regime/data.py —
// the model was trained on those numbers, and a body from the wrong series or
// a half-parsed one would feed it a silently different column.

describe('parseFredCsv', () => {
  it('drops holiday rows, sorts by date, and keeps the LAST of a duplicated date', () => {
    const rows = parseFredCsv(
      'observation_date,VIXCLS\n2024-01-03,13.0\n2024-01-02,12.5\n2024-01-04,.\n2024-01-03,13.5\n',
      'VIXCLS',
    );
    expect(rows).toEqual([
      { date: '2024-01-02', value: 12.5 },
      { date: '2024-01-03', value: 13.5 },
    ]);
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const rows = parseFredCsv('observation_date,SP500\r\n2024-01-02,4700\r\n\r\n2024-01-03,4710\r\n', 'SP500');
    expect(rows.map((r) => r.value)).toEqual([4700, 4710]);
  });

  it('refuses another series, an empty body, a malformed row and a non-numeric value', () => {
    expect(() => parseFredCsv('observation_date,SP500\n2024-01-02,1\n', 'VIXCLS')).toThrow(ProviderError);
    expect(() => parseFredCsv('observation_date,SP500\n2024-01-02,1\n', 'VIXCLS')).toThrow(/unexpected header/);
    expect(() => parseFredCsv('', 'VIXCLS')).toThrow(/empty body/);
    expect(() => parseFredCsv('observation_date,VIXCLS\n2024-01-02,1,2\n', 'VIXCLS')).toThrow(/malformed row/);
    expect(() => parseFredCsv('observation_date,VIXCLS\n01/02/2024,1\n', 'VIXCLS')).toThrow(/malformed date/);
    expect(() => parseFredCsv('observation_date,VIXCLS\n2024-01-02,abc\n', 'VIXCLS')).toThrow(/non-numeric/);
  });
});

describe('fetchFredSeries', () => {
  const body = 'observation_date,SP500\n2024-01-02,4700\n';
  const ok = () => new Response(body, { status: 200 });
  const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch;

  it('requests the series from cosd and parses the body', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ok());
    const rows = await fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(fetchImpl) });
    expect(rows).toEqual([{ date: '2024-01-02', value: 4700 }]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('id=SP500&cosd=2023-01-01');
  });

  it('retries once after a 503 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(ok());
    const rows = await fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(fetchImpl) });
    expect(rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempts are spent, naming the upstream status', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(fetchImpl) })).rejects.toThrow(
      /upstream 503/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404 or a body from the wrong series — those are final', async () => {
    const notFound = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(notFound) })).rejects.toThrow(
      /upstream 404/,
    );
    expect(notFound).toHaveBeenCalledTimes(1);
    const wrong = vi.fn(async () => new Response('observation_date,VIXCLS\n2024-01-02,13\n', { status: 200 }));
    await expect(fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(wrong) })).rejects.toThrow(
      /unexpected header/,
    );
    expect(wrong).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging request', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      fetchFredSeries('SP500', '2023-01-01', { fetchImpl: asFetch(hanging), timeoutMs: 20, attempts: 1 }),
    ).rejects.toThrow(/aborted/);
  });
});
