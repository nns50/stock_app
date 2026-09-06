import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

const mockScreen = vi.fn();
vi.mock('../src/services/autotrading/screen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/screen')>()),
  runAutotradeScreen: (...args: unknown[]) => mockScreen(...args),
}));

import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../src/index';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { addSymbols } from '../src/db/universe';

// ---------------------------------------------------------------------------
// "Why did this symbol not get traded today?" used to be unanswerable.
//
// The screener journals excluded_re / excluded_rel_vol_pace /
// excluded_volatility / excluded_earnings / skipped_unknown_sector per symbol,
// and says NOTHING about the filters inside the score — minChangePct,
// minScore, weekly-trend alignment, minPrice, minAvgVolume. Those reasons were
// computed and thrown away, which is both the more common case and the more
// useful question: SPY and QQQ were added to the universe by an explicit
// operator decision (2026-08-27), had their unknown-sector skip fixed
// (2026-09-03), then produced zero candidates on 09-04 with nothing anywhere
// recording what stopped them.
// ---------------------------------------------------------------------------

// Same harness as routes.integration.test.ts: the app's own listener is guarded
// behind require.main, so bind an ephemeral port here.
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

const emptyScreen = (over: Record<string, unknown> = {}) => ({
  generatedAt: 1_780_000_000_000,
  candidates: [],
  excluded: [],
  skipped: [],
  errors: [],
  rejected: [],
  relVolMedian: 0.53,
  discovery: { universeCount: 528, moversCount: 0, scannedCount: 528, moversError: null },
  ...over,
});

beforeEach(() => {
  mockScreen.mockReset();
  mockScreen.mockResolvedValue(emptyScreen());
  setAutotradeConfig({ minChangePct: 1, minSignalScore: 60, liveMinSignalScore: 72, minRelVolPace: 1.5 });
  addSymbols([{ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', sector: 'Index ETF' }]);
});

type Body = Record<string, never>;
const get = async (symbol: string): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${base}/api/autotrade/explain/${symbol}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('GET /api/autotrade/explain/:symbol', () => {
  it('names the filters a scored-but-rejected symbol failed', async () => {
    mockScreen.mockResolvedValue(
      emptyScreen({
        rejected: [
          { symbol: 'SPY', direction: 'long', total: 41.2, reasons: ['up only 0.3% today (needs 1%)', 'score < 60'] },
        ],
      }),
    );
    const r = await get('spy');
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('rejected_by_filters');
    expect(r.body.score).toBe(41.2);
    expect(r.body.reasons).toEqual(['up only 0.3% today (needs 1%)', 'score < 60']);
    expect(r.body.detail).toContain('needs 1%');
    expect(r.body.inUniverse).toBe(true);
  });

  it('reports a symbol that passed, with its score', async () => {
    mockScreen.mockResolvedValue(emptyScreen({ candidates: [{ symbol: 'SPY', total: 78.5, direction: 'long' }] }));
    const r = await get('SPY');
    expect(r.body.outcome).toBe('candidate');
    expect(r.body.score).toBe(78.5);
    expect(r.body.detail).toContain('78.5');
  });

  it('distinguishes excluded, skipped and errored from rejected', async () => {
    mockScreen.mockResolvedValue(emptyScreen({ excluded: [{ symbol: 'SPY', reason: 'Classified as real estate' }] }));
    expect((await get('SPY')).body.outcome).toBe('excluded');
    mockScreen.mockResolvedValue(emptyScreen({ skipped: [{ symbol: 'SPY', reason: 'sector unknown' }] }));
    expect((await get('SPY')).body.outcome).toBe('skipped');
    mockScreen.mockResolvedValue(emptyScreen({ errors: [{ symbol: 'SPY', message: 'quote fetch failed' }] }));
    expect((await get('SPY')).body.outcome).toBe('error');
  });

  it('separates "in the universe but not scanned" from "not in the universe"', async () => {
    expect((await get('SPY')).body.outcome).toBe('not_scanned');
    const r = await get('ZZZNOTREAL');
    expect(r.body.outcome).toBe('not_in_universe');
    expect(r.body.inUniverse).toBe(false);
  });

  it('reports the LIVE bar too, not just the screen minimum', async () => {
    // A signal can clear minSignalScore and still be refused by the live
    // conviction floor. An explain that only showed the screen's bar would say
    // "passed" about a trade the live book then declines.
    const r = await get('SPY');
    expect((r.body.filters as Body).minSignalScore).toBe(60);
    expect((r.body.filters as Body).liveMinSignalScore).toBe(72);
  });

  it('carries the pace denominator the reasons are measured against', async () => {
    const r = await get('SPY');
    expect((r.body.screen as Body).relVolMedian).toBe(0.53);
    expect((r.body.screen as Body).scannedCount).toBe(528);
  });

  it('screens the WHOLE universe, never just the one symbol', async () => {
    // relVolPace is a multiple of the universe's MEDIAN relVolume this tick, so
    // a one-symbol screen would make that median the symbol's own relVolume and
    // every pace would come out at exactly 1.0x — the gate would then pass or
    // fail on an arithmetic artifact. An explain whose verdict differs from the
    // loop's is worse than none.
    await get('SPY');
    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(mockScreen.mock.calls[0][0]).not.toHaveProperty('symbols');
  });
});

describe('the reasons reach the route because the screen stopped discarding them', () => {
  it('screen.ts records a filter rejection instead of returning null and forgetting', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'screen.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    // BOTH scoring paths must record: single-direction and both-directions.
    expect((code.match(/rejected\.push\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
