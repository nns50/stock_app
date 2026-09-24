import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getLastShortShadowRecord } from '../src/db/shortShadowRecords';
import { Candle } from '../src/providers/types';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';
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
/** A short signalled at 100 with a 102 stop. The replay enters at the first
 *  bar's open, 100, less the whole 0.5% buffer (no live fills are measured
 *  here): 99.5, so 1R is $2.5 and the 2R target is 94.5, which the 94 low
 *  trades through. */
const winning = [{ ...bar(0, 100, 99), open: 100 }, bar(5, 99, 97), bar(10, 97, 94)];
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
  it('carries the tape a row was declined on and the signal ATR, from 2026-09-24', () => {
    skip('KLAC', { ...signal, direction: 'red', atr: 4.2 });
    skip('AMD', { ...signal, direction: 'sideways', atr: 0 }); // neither is a value the record can use
    const rows = [...loadSkippedShorts().rows].sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(rows).toEqual([
      { symbol: 'AMD', at: T0, score: 80, entry: 100, stop: 102, floorAtSkip: 72 },
      { symbol: 'KLAC', at: T0, score: 80, entry: 100, stop: 102, floorAtSkip: 72, atr: 4.2, directionAtSkip: 'red' },
    ]);
  });

  it('reads every scorable live_short_skipped row since the window start, and drops the rest', () => {
    skip('KLAC', signal);
    skip('OLD', signal, SHORT_SHADOW_SINCE_MS - 1); // before the window
    skip('BARE', { reason: 'liveAllowNakedShort is off' }); // no signal fields to score
    const { rows, truncated } = loadSkippedShorts();
    expect(rows).toEqual([{ symbol: 'KLAC', at: T0, score: 80, entry: 100, stop: 102, floorAtSkip: 72 }]);
    expect(truncated).toBe(false);
  });
});

// THE REPLAY'S FILL INPUTS COME FROM THE DATABASE (2026-09-26): asserted on
// the report the switch reads, not on the helper that reads them.
describe('computeShortShadowReport — the honest fill inputs', () => {
  it('replays the market-direction gate from the journaled readings, and stamps the replay', async () => {
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'screen','market_direction_read',?,NULL,?)",
    ).run(JSON.stringify({ direction: 'green' }), T0 - 60_000);
    skip('KLAC', signal);

    setAutotradeConfig({ marketDirectionGateEnabled: true });
    const gated = await computeShortShadowReport();
    // A short on a broad green tape: the gate would have refused it.
    expect(gated).toMatchObject({ n: 0, directionGateReplayed: true, replayVersion: 2 });
    expect(gated.excluded.refused_by_direction).toBe(1);

    setAutotradeConfig({ marketDirectionGateEnabled: false });
    expect(await computeShortShadowReport()).toMatchObject({ n: 1, directionGateReplayed: false });
  });

  it('charges the whole buffer while no live entry has been measured', async () => {
    skip('KLAC', signal);
    const report = await computeShortShadowReport();
    expect(report.entryConcessionPct).toBe(0.5);
    expect(report.trades[0].entryFill).toBeCloseTo(99.5, 6);
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
      redTapeGate: row!.report.redTapeGate,
      // Shorts were never switched on, so there is no live window to replay.
      liveReplay: null,
    });
    expect(shortShadowEvidenceOf(null)).toBeNull();
  });

  // 2026-09-24 (the tape plan's PR 10): once live shorts are on, the same
  // refresh replays each live short's own signal and sets it against what the
  // short realized, and the switch's evidence carries the comparison.
  it('persists the live shorts against the replay of their own signals once shorts are on', async () => {
    db.exec('DELETE FROM position_exits; DELETE FROM positions;');
    const enabledAt = T0 - 60 * 60_000;
    setAutotradeConfig({ liveAllowNakedShort: true, liveShortsEnabledAt: enabledAt });
    // NVDA's live short lost 1.6R; its own signal replays to the 2R target.
    seedClosedAutotradeSessions({
      sessions: { '2026-09-10': [{ entryTime: '09:35', exitTime: '10:30', r: -1.6, symbol: 'NVDA', side: 'short' }] },
    });
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES ('NVDA','execution','live_order_placed',?,NULL,?)",
    ).run(JSON.stringify({ side: 'sell', signalEntry: 100, stop: 102, quantity: 10 }), T0);

    const row = await refreshShortShadowRecordAfterClose(AFTER_CLOSE);
    const expected = {
      since: enabledAt,
      n: 1,
      meanLiveR: expect.closeTo(-1.6, 9),
      meanReplayR: expect.closeTo(2, 5),
      meanGapR: expect.closeTo(-3.6, 5),
      unpaired: 0,
    };
    expect(row?.report.liveReplay).toEqual(expected);
    expect(shortShadowEvidenceOf(row)?.liveReplay).toEqual(expected);
    // One provider for the whole refresh.
    expect(mockGetProvider).toHaveBeenCalledTimes(1);
    db.exec('DELETE FROM position_exits; DELETE FROM positions;');
  });

  // 2026-09-24: the split the red-tape bar reads, asserted on the record the
  // switch reads. KLAC is declined on a mixed tape at 09:35 and again when the
  // tape turns red at 10:15. The price runs to the stop in between and falls
  // after, so the day's first row loses and the red row wins: the red tape is
  // replayed from ITS row, not from the day's first.
  it('persists the record split by tape, the red tape replayed from its own row', async () => {
    const RED_AT = T0 + 40 * 60_000;
    const path = [
      { time: T0, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: T0 + 5 * 60_000, open: 100, high: 102.6, low: 100, close: 102.4, volume: 1000 },
      { time: RED_AT, open: 100, high: 100.2, low: 99.8, close: 99.9, volume: 1000 },
      { time: RED_AT + 5 * 60_000, open: 99.9, high: 99.9, low: 94, close: 94.5, volume: 1000 },
    ];
    mockGetProvider.mockReturnValue({ getCandles: vi.fn(async () => path) } as never);
    skip('KLAC', { ...signal, direction: 'mixed' });
    skip('KLAC', { ...signal, direction: 'red' }, RED_AT);

    const row = await refreshShortShadowRecordAfterClose(AFTER_CLOSE);
    const report = row!.report;
    // All tapes together: the day's first row, stopped out.
    expect(report.n).toBe(1);
    expect(report.trades[0].at).toBe(T0);
    expect(report.trades[0].exitR).toBeLessThan(0);
    // Per tape: the mixed row loses, the red row (10:15) wins.
    expect(report.byTape.mixed.n).toBe(1);
    expect(report.byTape.red.n).toBe(1);
    expect(report.byTape.red.trades[0].at).toBe(RED_AT);
    expect(report.byTape.red.trades[0].exitR).toBeGreaterThan(0);
    expect(report.byTape.green.n + report.byTape.unlabeled.n).toBe(0);
    expect(report.redTapeGate).toMatchObject({ n: 1, winRatePct: 100, otherTapesN: 1, passesN: false });
    expect(report.redTapeGate.edgeR).toBeGreaterThan(0);
    // And the switch's evidence carries the same bar.
    expect(shortShadowEvidenceOf(row)?.redTapeGate).toEqual(report.redTapeGate);
  });

  it('labels a row with no stamp from the journaled reading in force, and an older one as unlabeled', async () => {
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'screen','market_direction_read',?,NULL,?)",
    ).run(JSON.stringify({ direction: 'red' }), T0 - 60_000);
    skip('KLAC', signal); // no `direction` on the row: the reading at 09:34 says red
    skip('AMD', signal, T0 - 86_400_000); // the day before: no reading that day
    const report = await computeShortShadowReport();
    expect(report.byTape.red.trades.map((t) => t.symbol)).toEqual(['KLAC']);
    expect(report.byTape.unlabeled.trades.map((t) => t.symbol)).toEqual(['AMD']);
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
