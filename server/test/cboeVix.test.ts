import { describe, it, expect, vi } from 'vitest';
import { CBOE_VIX_CSV_URL, fetchCboeVix, fillVixTail, parseCboeVixCsv } from '../src/services/cboeVix';
import { ProviderError } from '../src/providers/MarketDataProvider';

// ---------------------------------------------------------------------------
// The VIX close from CBOE for the days FRED has not published yet (2026-09-26).
// CBOE's CLOSE equals FRED's VIXCLS exactly on all 9,278 days both carry, so a
// fill is the number FRED will publish, but only if it adds the missing days
// and nothing else, and only while the two still agree.
// ---------------------------------------------------------------------------

const BODY =
  'DATE,OPEN,HIGH,LOW,CLOSE\n' +
  '09/21/2026,14.960000,15.130000,14.600000,14.870000\n' +
  '09/18/2026,15.070000,15.630000,14.800000,14.810000\n' +
  '09/22/2026,14.640000,14.950000,14.190000,14.210000\n' +
  '09/23/2026,14.160000,15.450000,14.120000,15.180000\n';

const pts = (rows: [string, number][]) => rows.map(([date, value]) => ({ date, value }));
const FRED = pts([
  ['2026-09-16', 15.2],
  ['2026-09-17', 15.44],
  ['2026-09-18', 14.81],
  ['2026-09-21', 14.87],
  ['2026-09-22', 14.21],
]);
const CBOE = [
  ...FRED,
  ...pts([
    ['2026-09-23', 15.18],
    ['2026-09-24', 15.67],
    ['2026-09-25', 14.87],
  ]),
];

describe('parseCboeVixCsv', () => {
  it('reads the CLOSE column by ISO date, sorted, at the double FRED parses', () => {
    const rows = parseCboeVixCsv(BODY);
    expect(rows.map((r) => r.date)).toEqual(['2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23']);
    expect(rows.find((r) => r.date === '2026-09-22')?.value).toBe(14.21);
    // "14.210000" and FRED's "14.21" are the same number: the fill is exact.
    expect(Number('14.210000')).toBe(Number('14.21'));
  });

  it('tolerates CRLF and blank lines, and keeps the last of a repeated date', () => {
    const rows = parseCboeVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\r\n09/22/2026,1,1,1,14\r\n\r\n09/22/2026,1,1,1,15\r\n');
    expect(rows).toEqual([{ date: '2026-09-22', value: 15 }]);
  });

  it('refuses anything that is not that file', () => {
    expect(() => parseCboeVixCsv('')).toThrow(/empty body/);
    expect(() => parseCboeVixCsv('observation_date,VIXCLS\n2026-09-22,14.21\n')).toThrow(/unexpected header/);
    expect(() => parseCboeVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3\n')).toThrow(/malformed row/);
    expect(() => parseCboeVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n2026-09-22,1,2,3,4\n')).toThrow(/malformed date/);
    expect(() => parseCboeVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3,x\n')).toThrow(/bad close/);
    expect(() => parseCboeVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3,0\n')).toThrow(ProviderError);
  });
});

describe('fetchCboeVix', () => {
  const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch;

  it('asks CBOE for its history file and parses it', async () => {
    const fn = vi.fn(async (_url: string) => new Response(BODY, { status: 200 }));
    const rows = await fetchCboeVix({ fetchImpl: asFetch(fn) });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(CBOE_VIX_CSV_URL);
    expect(rows).toHaveLength(4);
  });

  it('retries a 5xx once, and gives up on a 404 or an unparsable body at once', async () => {
    const flaky = vi.fn(async () => new Response('', { status: 503 }));
    flaky.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response(BODY));
    expect(await fetchCboeVix({ fetchImpl: asFetch(flaky) })).toHaveLength(4);
    expect(flaky).toHaveBeenCalledTimes(2);

    const missing = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchCboeVix({ fetchImpl: asFetch(missing) })).rejects.toThrow(/upstream 404/);
    expect(missing).toHaveBeenCalledTimes(1);

    const garbage = vi.fn(async () => new Response('<html>moved</html>', { status: 200 }));
    await expect(fetchCboeVix({ fetchImpl: asFetch(garbage) })).rejects.toThrow(/unexpected header/);
    expect(garbage).toHaveBeenCalledTimes(1);
  });
});

describe('fillVixTail', () => {
  it("adds CBOE's days after FRED's last one, through the S&P 500's last day, and nothing else", () => {
    const out = fillVixTail(FRED, CBOE, '2026-09-24');
    expect(out.refused).toBeNull();
    expect(out.filled).toEqual(['2026-09-23', '2026-09-24']);
    expect(out.vix.slice(0, FRED.length)).toEqual(FRED);
    expect(out.vix.map((p) => p.date).slice(-2)).toEqual(['2026-09-23', '2026-09-24']);
  });

  it('never replaces a FRED value, even on a day older than the ones it checks', () => {
    const fred = [{ date: '2026-09-15', value: 16 }, ...FRED];
    const cboe = [{ date: '2026-09-15', value: 99 }, ...CBOE];
    const out = fillVixTail(fred, cboe, '2026-09-25');
    expect(out.refused).toBeNull();
    expect(out.filled).toEqual(['2026-09-23', '2026-09-24', '2026-09-25']);
    expect(out.vix[0]).toEqual({ date: '2026-09-15', value: 16 });
  });

  it('is refused when the two disagree on one of the latest days both carry', () => {
    const cboe = CBOE.map((p) => (p.date === '2026-09-21' ? { ...p, value: 14.88 } : p));
    const out = fillVixTail(FRED, cboe, '2026-09-25');
    expect(out.filled).toEqual([]);
    expect(out.refused).toMatch(/2026-09-21 close 14\.88 differs from FRED's 14\.87/);
    expect(out.vix).toEqual(FRED);
  });

  it("is refused when CBOE lacks one of FRED's latest days", () => {
    const out = fillVixTail(
      FRED,
      CBOE.filter((p) => p.date !== '2026-09-18'),
      '2026-09-25',
    );
    expect(out.filled).toEqual([]);
    expect(out.refused).toMatch(/no close for 2026-09-18/);
  });

  it("is refused when CBOE has nothing after FRED's last day either", () => {
    const out = fillVixTail(FRED, FRED, '2026-09-25');
    expect(out.filled).toEqual([]);
    expect(out.refused).toMatch(/no close after 2026-09-22 either/);
    expect(out.vix).toEqual(FRED);
  });

  it('adds nothing when FRED is current, and refuses an empty FRED series', () => {
    expect(fillVixTail(FRED, CBOE, '2026-09-22')).toEqual({ vix: FRED, filled: [], refused: null });
    expect(fillVixTail([], CBOE, '2026-09-25').refused).toMatch(/no VIX rows/);
  });
});
