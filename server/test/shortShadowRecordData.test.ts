import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getLastShortShadowRecord } from '../src/db/shortShadowRecords';
import { Candle } from '../src/providers/types';
import {
  computeShortShadowReport,
  loadSkippedShorts,
  refreshShortShadowRecordAfterClose,
  resetShortShadowRefreshState,
  SHORT_SHADOW_SINCE_MS,
  shortShadowEvidenceOf,
} from '../src/services/autotrading/shortShadowRecordData';

// ---------------------------------------------------------------------------
// The DB half of the short shadow record. What matters here is the chain the
// `shorts` switch actually reads: journal rows in, a persisted record out,
// once per session after the close, with the route and the hook sharing one
// compute path so the number the operator reads and the number the switch
// reads cannot differ.
// ---------------------------------------------------------------------------

const mockGetProvider = vi.mocked(getProvider);

/** 2026-09-10 09:35 ET — a mid-morning signal on a Thursday session. */
const T0 = Date.parse('2026-09-10T13:35:00Z');
const AFTER_CLOSE = Date.parse('2026-09-10T21:30:00Z');
const IN_SESSION = Date.parse('2026-09-10T18:00:00Z');

function bar(offsetMin: number, high: number, low: number): Candle {
  return { time: T0 + offsetMin * 60_000, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}
/** Falls to 96 = the 2R target for a short entered at 100 with a 102 stop. */
const winning = [bar(0, 100, 99), bar(5, 99, 97), bar(10, 97, 95.5)];
const armProvider = () => mockGetProvider.mockReturnValue({ getCandles: vi.fn(async () => winning) } as never);

function skip(symbol: string, detail: Record<string, unknown>, at: number = T0): void {
  db.prepare(
    "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'execution','live_short_skipped',?,NULL,?)",
  ).run(symbol, JSON.stringify(detail), at);
}
const signal = { score: 80, entry: 100, stop: 102, liveMinSignalScore: 72 };

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events; DELETE FROM short_shadow_records; DELETE FROM autotrade_config;');
  resetShortShadowRefreshState();
  mockGetProvider.mockReset();
  armProvider();
  setAutotradeConfig({
    ...defaultAutotradeConfig(),
    liveMinSignalScore: 72,
    targetRMultiple: 2,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    liveScaleOutEnabled: false,
  });
});

describe('loadSkippedShorts', () => {
  it('reads every scorable live_short_skipped row since the window start, and drops the rest', () => {
    skip('KLAC', signal);
    skip('OLD', signal, SHORT_SHADOW_SINCE_MS - 1); // before the window
    skip('BARE', { reason: 'liveAllowNakedShort is off' }); // no signal fields to score
    const { rows, truncated } = loadSkippedShorts();
    expect(rows).toEqual([{ symbol: 'KLAC', at: T0, score: 80, entry: 100, stop: 102, floorAtSkip: 72 }]);
    expect(truncated).toBe(false);
  });
});

describe('refreshShortShadowRecordAfterClose', () => {
  it('does nothing in session or on a weekend', async () => {
    skip('KLAC', signal);
    expect(await refreshShortShadowRecordAfterClose(IN_SESSION)).toBeNull();
    expect(await refreshShortShadowRecordAfterClose(Date.parse('2026-09-12T21:30:00Z'))).toBeNull(); // Saturday
    expect(getLastShortShadowRecord()).toBeNull();
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('replays the declined shorts once after the close and persists the record the switch reads', async () => {
    skip('KLAC', signal);
    skip('AMD', signal);
    const row = await refreshShortShadowRecordAfterClose(AFTER_CLOSE);
    expect(row?.etDate).toBe('2026-09-10');
    expect(row?.report).toMatchObject({
      journaledRows: 2,
      journalTruncated: false,
      n: 2,
      winRatePct: 100,
      gate: { passesN: false, passesAvgR: true, passesWinRate: true, passes: false },
    });
    expect(row?.report.avgR).toBeCloseTo(2, 5);

    // The same row, and no second replay, on the next tick of the same session.
    const again = await refreshShortShadowRecordAfterClose(AFTER_CLOSE + 60_000);
    expect(again?.createdAt).toBe(row?.createdAt);
    expect(mockGetProvider).toHaveBeenCalledTimes(1);

    // What the gated-switch snapshot carries out of it.
    expect(shortShadowEvidenceOf(row)).toEqual({
      etDate: '2026-09-10',
      journaledRows: 2,
      n: 2,
      avgR: row!.report.avgR,
      winRatePct: 100,
      gate: row!.report.gate,
    });
    expect(shortShadowEvidenceOf(null)).toBeNull();
  });

  it('is the number the route serves — one compute path, one loader', async () => {
    skip('KLAC', signal);
    const viaRoute = await computeShortShadowReport();
    const row = await refreshShortShadowRecordAfterClose(AFTER_CLOSE);
    expect(row?.report).toEqual(viaRoute);
  });

  it('tries once per session: a failed replay is not retried every tick, and the next session tries again', async () => {
    skip('KLAC', signal);
    mockGetProvider.mockImplementation(() => {
      throw new Error('provider down');
    });
    await expect(refreshShortShadowRecordAfterClose(AFTER_CLOSE)).rejects.toThrow(/provider down/);
    expect(getLastShortShadowRecord()).toBeNull();
    // The loop calls this ~480 times a night; the failure must cost one replay.
    expect(await refreshShortShadowRecordAfterClose(AFTER_CLOSE + 60_000)).toBeNull();
    expect(mockGetProvider).toHaveBeenCalledTimes(1);

    armProvider();
    const row = await refreshShortShadowRecordAfterClose(Date.parse('2026-09-11T21:30:00Z'));
    expect(row?.etDate).toBe('2026-09-11');
    expect(row?.report.n).toBe(1);
  });
});
