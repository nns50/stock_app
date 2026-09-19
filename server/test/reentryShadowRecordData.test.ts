import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getLastReentryShadowRecord } from '../src/db/reentryShadowRecords';
import { Candle } from '../src/providers/types';
import {
  computeReentryShadowReport,
  loadReentryRefusals,
  REENTRY_SHADOW_GAPS,
  REENTRY_SHADOW_SINCE_MS,
  reentryShadowEvidenceOf,
  reentryShadowWindowStart,
  refreshReentryShadowRecordAfterClose,
  resetReentryShadowRefreshState,
} from '../src/services/autotrading/reentryShadowRecordData';

// ---------------------------------------------------------------------------
// The DB half of the re-entry cooldown record. What matters is the chain the
// leak scan's cooldown finding reads: every refusal in the window in, one
// replay per gap out, persisted once per session after the close, with one bar
// fetch per symbol-day across the four gaps.
// ---------------------------------------------------------------------------

const mockGetProvider = vi.mocked(getProvider);

/** 2026-09-16 09:35 ET — a Wednesday session inside the record's window. */
const T0 = Date.parse('2026-09-16T13:35:00Z');
const MIN = 60_000;
const AFTER_CLOSE = Date.parse('2026-09-16T21:30:00Z');
const IN_SESSION = Date.parse('2026-09-16T18:00:00Z');

function bar(offsetMin: number, high: number, low: number): Candle {
  return { time: T0 + offsetMin * MIN, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}
/** Flat around each refusal, then a run to 105 at 125 minutes: a 1R winner
 *  whichever refusal the replay enters at (100 → 102, 101 → 103, 102 → 104). */
const day = [bar(0, 100.4, 99.8), bar(60, 101.4, 100.6), bar(120, 102.4, 101.6), bar(125, 105, 102)];
let getCandles = vi.fn(async () => day);
const armProvider = () => {
  getCandles = vi.fn(async () => day);
  mockGetProvider.mockReturnValue({ getCandles } as never);
};

const insert = () =>
  db.prepare(
    "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'execution','symbol_reentry_cooldown_skipped',?,NULL,?)",
  );
/** The cooldown's own row: the replay fields plus its reading of the gap. */
function refusal(
  symbol: string,
  minutesSince: number,
  entry: number,
  at: number = T0 + (minutesSince - 1) * MIN,
): void {
  insert().run(
    symbol,
    JSON.stringify({
      side: 'long',
      score: 90,
      entry,
      stop: entry - 2,
      liveEligible: true,
      liveMinSignalScore: 81,
      minutesSince,
      cooldownMinutes: 390,
    }),
    at,
  );
}
/** One symbol-day refused at 1, 61 and 121 minutes after its exit. */
function series(symbol: string): void {
  refusal(symbol, 1, 100);
  refusal(symbol, 61, 101);
  refusal(symbol, 121, 102);
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events; DELETE FROM reentry_shadow_records; DELETE FROM autotrade_config;');
  resetReentryShadowRefreshState();
  mockGetProvider.mockReset();
  armProvider();
  setAutotradeConfig({
    ...defaultAutotradeConfig(),
    liveMinSignalScore: 81,
    targetRMultiple: 1,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    liveScaleOutEnabled: false,
    stagnationExitMinutes: 0,
    symbolReentryCooldownMinutes: 390,
  });
});
afterAll(() => db.exec('DELETE FROM reentry_shadow_records;'));

describe('reentryShadowWindowStart', () => {
  it('never reads before the cooldown went to the whole session, however long the window', () => {
    // Forty sessions back from 09-16 is July; the record starts on 09-14.
    expect(reentryShadowWindowStart(AFTER_CLOSE)).toBe(REENTRY_SHADOW_SINCE_MS);
  });

  it('is the window’s first session once that is later than the boundary', () => {
    expect(reentryShadowWindowStart(AFTER_CLOSE, 1)).toBe(Date.parse('2026-09-16T04:00:00Z'));
  });
});

describe('loadReentryRefusals', () => {
  it('reads every scorable refusal since the window start and counts the rest', () => {
    series('HOOD');
    refusal('OLD', 1, 100, REENTRY_SHADOW_SINCE_MS - 1); // the 120-minute era
    insert().run('BARE', JSON.stringify({ reason: 'Re-entry cooldown', minutesSince: 5 }), T0); // no replay fields
    const out = loadReentryRefusals(REENTRY_SHADOW_SINCE_MS);
    expect(out.journaledRows).toBe(4);
    expect(out.unscorableRows).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.rows.map((r) => r.minutesSinceExit ?? -1).sort((a, b) => a - b)).toEqual([1, 61, 121]);
  });
});

describe('computeReentryShadowReport', () => {
  it('replays every gap from the same rows, and fetches each symbol-day’s bars once', async () => {
    series('HOOD');
    series('COIN');
    const report = await computeReentryShadowReport(AFTER_CLOSE);
    expect(report.gaps.map((g) => g.minMinutesSinceExit)).toEqual([...REENTRY_SHADOW_GAPS]);
    expect(report).toMatchObject({
      since: REENTRY_SHADOW_SINCE_MS,
      journaledRows: 6,
      unscorableRows: 0,
      journalTruncated: false,
      cooldownMinutes: 390,
    });
    const [first, at60, at120, at180] = report.gaps;
    // The first refusal of the day — the immediate re-entry — at 100.
    expect(first.n).toBe(2);
    expect(first.trades.map((t) => t.entry)).toEqual([100, 100]);
    // The 60- and 120-minute gaps enter at THOSE ticks' prices, each a 1R winner.
    expect(at60.trades.map((t) => t.entry)).toEqual([101, 101]);
    expect(at120.trades.map((t) => t.entry)).toEqual([102, 102]);
    expect(at120.avgR).toBeCloseTo(1, 5);
    expect(at120.excluded.before_min_gap).toBe(4);
    // Nothing was refused three hours out: an empty gap, not the first refusal.
    expect(at180.n).toBe(0);
    // Two symbol-days, four gaps, two fetches.
    expect(getCandles).toHaveBeenCalledTimes(2);
  });
});

describe('refreshReentryShadowRecordAfterClose', () => {
  it('does nothing in session or on a weekend', async () => {
    series('HOOD');
    expect(await refreshReentryShadowRecordAfterClose(IN_SESSION)).toBeNull();
    expect(await refreshReentryShadowRecordAfterClose(Date.parse('2026-09-19T21:30:00Z'))).toBeNull(); // Saturday
    expect(getLastReentryShadowRecord()).toBeNull();
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('replays once after the close and persists the record the scan reads', async () => {
    series('HOOD');
    const row = await refreshReentryShadowRecordAfterClose(AFTER_CLOSE);
    expect(row?.etDate).toBe('2026-09-16');
    expect(row?.report.gaps.map((g) => [g.minMinutesSinceExit, g.n])).toEqual([
      [0, 1],
      [60, 1],
      [120, 1],
      [180, 0],
    ]);

    // The same row, and no second replay, on the next tick of the same session.
    const again = await refreshReentryShadowRecordAfterClose(AFTER_CLOSE + MIN);
    expect(again?.createdAt).toBe(row?.createdAt);
    expect(mockGetProvider).toHaveBeenCalledTimes(1);

    // What the scan's finding reads out of it: each gap's exit Rs.
    const evidence = reentryShadowEvidenceOf(row);
    expect(evidence?.etDate).toBe('2026-09-16');
    expect(evidence?.journalTruncated).toBe(false);
    expect(evidence?.gaps.map((g) => g.minMinutesSinceExit)).toEqual([0, 60, 120, 180]);
    expect(evidence?.gaps[2].exitRs[0]).toBeCloseTo(1, 5);
    expect(evidence?.gaps[3].exitRs).toEqual([]);
    expect(reentryShadowEvidenceOf(null)).toBeNull();
  });

  it('tries once per session: a failed replay is not retried every tick, and the next session tries again', async () => {
    series('HOOD');
    mockGetProvider.mockImplementation(() => {
      throw new Error('provider down');
    });
    await expect(refreshReentryShadowRecordAfterClose(AFTER_CLOSE)).rejects.toThrow(/provider down/);
    expect(getLastReentryShadowRecord()).toBeNull();
    expect(await refreshReentryShadowRecordAfterClose(AFTER_CLOSE + MIN)).toBeNull();
    expect(mockGetProvider).toHaveBeenCalledTimes(1);

    armProvider();
    const row = await refreshReentryShadowRecordAfterClose(Date.parse('2026-09-17T21:30:00Z'));
    expect(row?.etDate).toBe('2026-09-17');
    expect(row?.report.gaps[0].n).toBe(1);
  });
});
