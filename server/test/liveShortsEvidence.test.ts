import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The revert sends a push when it applies; captured, not sent.
vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));

import { dispatchNotifications } from '../src/services/notifier';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listPositions } from '../src/db/positions';
import { etDateTimeToMs } from '../src/util/marketDate';
import type { Candle } from '../src/providers/types';
import type { CandleSource } from '../src/services/excursion';
import type { EdgeLeakScanResult } from '../src/services/autotrading/edgeLeakScan';
import type { ShortShadowEvidence } from '../src/services/autotrading/gatedSwitches';
import {
  buildLiveShortsEvidence,
  liveEquityShortRedLeak,
  liveShortTradesSince,
  shortSideDefectsSince,
} from '../src/services/autotrading/liveShortsEvidence';
import { replayLiveShorts } from '../src/services/autotrading/shortShadowRecordData';
import { runGatedSwitches } from '../src/services/autotrading/gatedSwitchesData';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';

// ---------------------------------------------------------------------------
// The live short book the shorts_revert tripwires read (2026-09-24, the tape
// plan's PR 10), over real rows: which shorts count, which journal rows are a
// short's defect, the replay each is held against, and the revert itself
// asserted on the stored CONFIG, where it lands.
// ---------------------------------------------------------------------------

const DAY = '2026-10-08'; // a Thursday session
const at = (time: string, day = DAY): number => etDateTimeToMs(day, time) as number;
/** Shorts were switched on that morning, before the open. */
const ENABLED_AT = at('09:00');
const AFTER_CLOSE = Date.parse('2026-10-08T21:30:00Z');

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_events; DELETE FROM autotrade_config; ' +
      'DELETE FROM gated_switch_state; DELETE FROM edge_leak_scans; DELETE FROM short_shadow_records;',
  );
  vi.mocked(dispatchNotifications).mockClear();
});

/** A journal row at a moment of our choosing. */
function journal(symbol: string | null, action: string, detail: Record<string, unknown>, createdAt: number): void {
  db.prepare(
    'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,?,?,?,NULL,?)',
  ).run(symbol, 'execution', action, JSON.stringify(detail), createdAt);
}

/** The book of the tests below: a live short that lost 1.6R, a live long, a
 *  short traded by hand (not the app's), and an app short from the day before
 *  shorts were last switched on. */
function seedBook(): void {
  seedClosedAutotradeSessions({
    sessions: {
      [DAY]: [
        { entryTime: '10:00', exitTime: '10:40', r: -1.6, symbol: 'TSLA', side: 'short' },
        { entryTime: '10:05', exitTime: '11:00', r: 0.5, symbol: 'AAPL', side: 'long' },
        { entryTime: '10:10', exitTime: '11:10', r: -2, symbol: 'HAND', side: 'short', tags: ['webull'] },
      ],
      '2026-10-07': [{ entryTime: '10:00', exitTime: '10:30', r: -3, symbol: 'OLD', side: 'short' }],
    },
  });
}

const positionId = (symbol: string): number => listPositions().find((p) => p.symbol === symbol)!.id;

describe('the live shorts the tripwires count', () => {
  it("are the app's own stock shorts entered since shorts were switched on, with the collector's R", () => {
    seedBook();
    expect(liveShortTradesSince(ENABLED_AT, AFTER_CLOSE)).toEqual([
      {
        id: `pos:${positionId('TSLA')}`,
        symbol: 'TSLA',
        etDate: DAY,
        entryAt: at('10:00'),
        r: expect.closeTo(-1.6, 9),
      },
    ]);
  });
});

describe('a short-side execution defect', () => {
  it("is a row the scan's catalog calls a defect, on a live short, during its life", () => {
    seedBook();
    const tsla = positionId('TSLA');
    journal('TSLA', 'live_time_exit_failed', {}, at('10:30')); // counts
    journal('AAPL', 'live_time_exit_failed', {}, at('10:30')); // a long's
    journal('HAND', 'live_time_exit_failed', {}, at('10:30')); // a hand short's
    journal('TSLA', 'live_position_unprotected', { state: 'kill_switch' }, at('10:31')); // the operator's
    journal('TSLA', 'live_options_exit_failed', {}, at('10:32')); // an options row
    journal('TSLA', 'live_time_exit_failed', {}, at('09:30')); // before the short
    // Named by its position id, long after the symbol window has closed.
    journal('TSLA', 'live_stop_adjust_blocked', { positionId: tsla }, at('10:00', '2026-10-20'));
    // A skip a later correction superseded, and that correction the operator's
    // own hand sale: neither is open.
    journal('TSLA', 'live_exit_correction_skipped', { exitId: 7, cause: 'no_matching_sale' }, at('10:45'));
    journal('TSLA', 'live_exit_corrected', { exitId: 7, source: 'broker_history' }, at('11:00'));

    expect(shortSideDefectsSince(ENABLED_AT, Date.parse('2026-10-21T20:00:00Z'))).toEqual([
      { label: 'A timed stock exit failed', symbol: 'TSLA', etDate: DAY },
      { label: 'A stop ratchet could not find its resting leg', symbol: 'TSLA', etDate: '2026-10-20' },
    ]);
  });
});

describe('the live shorts against the replay of their own signals', () => {
  /** The stop, 105, trades on the second bar: the replay loses exactly 1R. */
  const bars: Candle[] = [
    { time: at('10:00'), open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
    { time: at('10:05'), open: 101, high: 106, low: 100.5, close: 105.5, volume: 1000 },
  ];
  const source: CandleSource = { getCandles: async () => bars };
  const cfg = {
    ...defaultAutotradeConfig(),
    targetRMultiple: 2,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    liveScaleOutEnabled: false,
  };

  it('pairs each with its replay on the same symbol-day, and says which it could not', async () => {
    seedBook();
    seedClosedAutotradeSessions({
      sessions: { [DAY]: [{ entryTime: '12:00', exitTime: '12:30', r: 0.4, symbol: 'NVDA', side: 'short' }] },
    });
    // TSLA's entry wrote its placement row; NVDA's did not.
    journal('TSLA', 'live_order_placed', { side: 'sell', signalEntry: 100, stop: 105, quantity: 10 }, at('10:00'));
    journal('AAPL', 'live_order_placed', { side: 'buy', signalEntry: 100, stop: 95, quantity: 10 }, at('10:05'));

    expect(await replayLiveShorts(source, cfg, ENABLED_AT, 0)).toEqual({
      since: ENABLED_AT,
      n: 1,
      meanLiveR: expect.closeTo(-1.6, 9),
      meanReplayR: expect.closeTo(-1, 9),
      // Live lost 0.6R more than the model of the same trade.
      meanGapR: expect.closeTo(-0.6, 9),
      unpaired: 1,
    });
  });
});

describe('the evidence the tripwires read', () => {
  const shadow = (since: number): ShortShadowEvidence =>
    ({
      liveReplay: { since, n: 12, meanLiveR: -0.5, meanReplayR: 0, meanGapR: -0.5, unpaired: 0 },
    }) as ShortShadowEvidence;

  it('is null until shorts have been switched on', () => {
    expect(buildLiveShortsEvidence(defaultAutotradeConfig(), AFTER_CLOSE, null, null)).toBeNull();
  });

  it('reads the replay only when it covers this very window', () => {
    const cfg = { ...defaultAutotradeConfig(), liveAllowNakedShort: true, liveShortsEnabledAt: ENABLED_AT };
    expect(buildLiveShortsEvidence(cfg, AFTER_CLOSE, shadow(ENABLED_AT), null)?.replay).toEqual({
      n: 12,
      meanGapR: -0.5,
    });
    // Replayed for the window before shorts were last switched on: not this one.
    expect(buildLiveShortsEvidence(cfg, AFTER_CLOSE, shadow(ENABLED_AT - 86_400_000), null)?.replay).toBeNull();
  });

  it("reads the scan's live equity_short_red verdict, and says when it cannot", () => {
    const scan = (verdict: string, n: number, books = ['live', 'paper']) =>
      ({
        books,
        dimensions: [{ id: 'marketTapeBySide', buckets: [{ bucket: 'equity_short_red', n, verdict }] }],
      }) as unknown as EdgeLeakScanResult;
    expect(liveEquityShortRedLeak(scan('leak', 22))).toBe(true);
    // The scan's own leaks list carries an unconfirmed leak too.
    expect(liveEquityShortRedLeak(scan('unconfirmed', 22))).toBe(true);
    expect(liveEquityShortRedLeak(scan('ok', 22))).toBe(false);
    // Paper's bucket alone says nothing about the live book.
    expect(liveEquityShortRedLeak(scan('ok', 0))).toBeNull();
    expect(liveEquityShortRedLeak(scan('leak', 22, ['paper']))).toBeNull();
    expect(liveEquityShortRedLeak(null)).toBeNull();
  });
});

// THE CONSUMER: the stored config. A tripwire that fires and writes nothing
// would pass every test above.
describe('shorts_revert, over real rows', () => {
  const shortsOn = () =>
    setAutotradeConfig({ ...defaultAutotradeConfig(), liveAllowNakedShort: true, liveShortsEnabledAt: ENABLED_AT });

  it('turns live shorts off after the close of the day a short lost 1.6R, and says why', () => {
    shortsOn();
    seedBook();

    runGatedSwitches(AFTER_CLOSE);

    expect(getAutotradeConfig().liveAllowNakedShort).toBe(false);
    const applied = listAutotradeEvents({ stage: 'config', actions: ['config_auto_applied'] })
      .map((e) => JSON.parse(e.detail!) as { rule: string; changes: unknown; evidence: string })
      .find((d) => d.rule === 'shorts_revert');
    expect(applied).toMatchObject({ changes: { liveAllowNakedShort: { from: true, to: false } } });
    expect(applied?.evidence).toMatch(/^TSLA \(2026-10-08\) closed at -1\.60R/);
    const pushes = vi
      .mocked(dispatchNotifications)
      .mock.calls.filter(([events]) => events[0]?.title.includes('shorts_revert'));
    expect(pushes).toHaveLength(1);
  });

  it('leaves them on when the losing short came before shorts were last switched on', () => {
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      liveAllowNakedShort: true,
      // Switched on again after TSLA closed: a new window, clean.
      liveShortsEnabledAt: at('12:00'),
    });
    seedBook();

    runGatedSwitches(AFTER_CLOSE);

    expect(getAutotradeConfig().liveAllowNakedShort).toBe(true);
  });
});
