import { describe, it, expect, beforeAll, beforeEach, onTestFinished, vi } from 'vitest';

// The revert sends a push when it applies; captured, not sent.
vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));

import { dispatchNotifications } from '../src/services/notifier';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listPositions } from '../src/db/positions';
import {
  recordLiveAddOnOrder,
  recordLiveExitOrder,
  recordLiveOrder,
  setLiveOrderPositionId,
} from '../src/db/autotradeLiveOrders';
import { createIntent } from '../src/db/orders';
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
  shortsRevertedAt,
} from '../src/services/autotrading/liveShortsEvidence';
import { replayLiveShorts } from '../src/services/autotrading/shortShadowRecordData';
import { liveExitRules as liveExitRulesOf } from '../src/services/exitReplay';
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
      'DELETE FROM gated_switch_state; DELETE FROM edge_leak_scans; DELETE FROM short_shadow_records; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM order_intents;',
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

/** Give `symbol`'s position the entry order the live path would have written,
 *  placed at `placedAt`. Returns the order's intent id and client order id. */
function entryOrder(symbol: string, placedAt: number): { intentId: number; clientOrderId: string } {
  const clientOrderId = `${symbol.toLowerCase()}-entry`;
  const intent = createIntent(
    { symbol, assetKind: 'stock', side: 'sell', openClose: 'open', quantity: 10, orderType: 'limit' },
    clientOrderId,
  );
  recordLiveOrder({
    intentId: intent.id,
    symbol,
    stopPrice: 105,
    targetPrice: 90,
    riskAmount: 50,
    riskProfile: 'MODERATE',
  });
  setLiveOrderPositionId(intent.id, positionId(symbol));
  db.prepare('UPDATE autotrade_live_orders SET created_at = ? WHERE intent_id = ?').run(placedAt, intent.id);
  return { intentId: intent.id, clientOrderId };
}

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

  // 2026-09-24, on review. The collector's entry time is HH:MM, floored, and
  // the stamp is milliseconds: shorts switched on at 10:00:20 and a short
  // placed at 10:00:40 read as entered at 10:00:00, BEFORE the window, and a
  // losing short tripped nothing. The probation counts the same short by its
  // order's millisecond time, so the two disagreed about the window.
  it('count a short placed in the same minute shorts were switched on, by its entry order', () => {
    seedBook();
    entryOrder('TSLA', at('10:00') + 40_000);
    const since = at('10:00') + 20_000;
    expect(liveShortTradesSince(since, AFTER_CLOSE).map((t) => t.symbol)).toEqual(['TSLA']);
    // An order placed before the stamp is the previous window's.
    expect(liveShortTradesSince(at('10:00') + 50_000, AFTER_CLOSE)).toEqual([]);
  });
});

describe('a short-side execution defect', () => {
  it("is a row the scan's catalog calls a defect that NAMES a live short: its position, or its entry order", () => {
    seedBook();
    const tsla = positionId('TSLA');
    const order = entryOrder('TSLA', at('10:00'));
    journal('TSLA', 'live_time_exit_failed', { positionId: tsla }, at('10:30')); // counts
    // Written before the fill, naming the entry order: counts.
    journal('TSLA', 'live_order_outcome_unknown', { clientOrderId: order.clientOrderId }, at('10:00'));
    journal('TSLA', 'live_order_status_unresolved', { intentId: order.intentId }, at('10:01'));
    journal('AAPL', 'live_time_exit_failed', { positionId: positionId('AAPL') }, at('10:30')); // a long's
    journal('HAND', 'live_time_exit_failed', { positionId: positionId('HAND') }, at('10:30')); // a hand short's
    journal('TSLA', 'live_position_unprotected', { state: 'kill_switch', positionId: tsla }, at('10:31')); // the operator's
    journal('TSLA', 'live_options_exit_failed', { positionId: tsla }, at('10:32')); // an options row
    // Named by its position id, long after the short closed.
    journal('TSLA', 'live_stop_adjust_blocked', { positionId: tsla }, at('10:00', '2026-10-20'));
    // A skip a later correction superseded, and that correction the operator's
    // own hand sale: neither is open.
    journal(
      'TSLA',
      'live_exit_correction_skipped',
      { exitId: 7, positionId: tsla, cause: 'no_matching_sale' },
      at('10:45'),
    );
    journal('TSLA', 'live_exit_corrected', { exitId: 7, positionId: tsla, source: 'broker_history' }, at('11:00'));
    // 2026-09-24, on review: a row that names no short is not the short's, even
    // on its symbol inside its life. The paper book's correlation miss, a
    // long's unknown outcome: each turned shorts off before.
    journal('TSLA', 'correlation_data_unavailable', {}, at('10:20'));
    journal('TSLA', 'live_order_outcome_unknown', { clientOrderId: 'someone-elses' }, at('10:21'));

    expect(shortSideDefectsSince(ENABLED_AT)).toEqual([
      { label: 'A stock order ended with an unknown outcome', symbol: 'TSLA', etDate: DAY },
      { label: 'A stock order the broker accepted could not be found by any read', symbol: 'TSLA', etDate: DAY },
      { label: 'A timed stock exit failed', symbol: 'TSLA', etDate: DAY },
      { label: 'A stop ratchet could not find its resting leg', symbol: 'TSLA', etDate: '2026-10-20' },
    ]);
  });
});

describe("a short-side defect named by another of the short's orders (2026-09-25, second review)", () => {
  it("is the short's when the row names its CLOSE or an ADD-ON, not only its entry", () => {
    // SHOP 2026-09-22's state: a time exit acknowledged and then found in no
    // list names the EXIT's intent. Matched against the entry order alone, it
    // tripped nothing.
    seedBook();
    const tsla = positionId('TSLA');
    entryOrder('TSLA', at('10:00'));
    const close = createIntent(
      { symbol: 'TSLA', assetKind: 'stock', side: 'buy', openClose: 'close', quantity: 10, orderType: 'limit' },
      'tsla-time-exit',
    );
    recordLiveExitOrder({ intentId: close.id, symbol: 'TSLA', riskProfile: 'MODERATE', positionId: tsla });
    const add = createIntent(
      { symbol: 'TSLA', assetKind: 'stock', side: 'sell', openClose: 'open', quantity: 5, orderType: 'limit' },
      'tsla-add',
    );
    recordLiveAddOnOrder({
      intentId: add.id,
      symbol: 'TSLA',
      stopPrice: 104,
      targetPrice: 90,
      riskAmount: 20,
      riskProfile: 'MODERATE',
      addonOfPositionId: tsla,
    });
    journal('TSLA', 'live_order_status_unresolved', { intentId: close.id }, at('10:35'));
    journal('TSLA', 'live_order_outcome_unknown', { clientOrderId: 'tsla-add' }, at('10:20'));

    expect(shortSideDefectsSince(ENABLED_AT).map((d) => d.label)).toEqual([
      'A stock order ended with an unknown outcome',
      'A stock order the broker accepted could not be found by any read',
    ]);
  });

  it("dates a scaled-in short by its FIRST entry order, not the add-on's", () => {
    seedBook();
    const tsla = positionId('TSLA');
    entryOrder('TSLA', at('10:00'));
    const add = createIntent(
      { symbol: 'TSLA', assetKind: 'stock', side: 'sell', openClose: 'open', quantity: 5, orderType: 'limit' },
      'tsla-add-2',
    );
    recordLiveAddOnOrder({
      intentId: add.id,
      symbol: 'TSLA',
      stopPrice: 104,
      targetPrice: 90,
      riskAmount: 20,
      riskProfile: 'MODERATE',
      addonOfPositionId: tsla,
    });
    setLiveOrderPositionId(add.id, tsla);
    db.prepare('UPDATE autotrade_live_orders SET created_at = ? WHERE intent_id = ?').run(at('10:30'), add.id);
    // A window that starts between the entry and the add: the short is the
    // previous window's, whatever its add-on's time says.
    expect(liveShortTradesSince(at('10:15'), AFTER_CLOSE)).toEqual([]);
    expect(liveShortTradesSince(ENABLED_AT, AFTER_CLOSE).map((t) => t.symbol)).toEqual(['TSLA']);
  });
});

describe('a revert that was only proposed (2026-09-25, second review)', () => {
  it('counts as the window having tripped, read from the whole window', () => {
    const row = (action: string, rule: string, createdAt: number) =>
      db
        .prepare(
          'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,?,?,?,NULL,?)',
        )
        .run('config', action, JSON.stringify({ rule }), createdAt);
    row('config_change_proposed', 'shorts_revert', at('16:40'));
    // Other rules' rows after it do not hide it (the old read took the newest 200).
    for (let i = 0; i < 250; i += 1) row('config_change_proposed', 'leak_lever', at('16:41') + i);
    expect(shortsRevertedAt(ENABLED_AT)).toBe(at('16:40'));
    expect(shortsRevertedAt(at('16:45'))).toBeNull();
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

  // 2026-09-24, on review. The live bracket's target can differ from the
  // config's (the regime tighten, a level cap): replayed at the config's 2R,
  // a short that banked its own small target reads as live far below its model,
  // which is an execution gap that never happened.
  it('replays each short at its OWN bracket target, from the placement row', async () => {
    seedBook();
    // Target 99.75: 0.05R against the 105 stop. The 10:00 bar trades through it
    // to 99.5 (the honest fill needs a trade through, not a touch).
    journal('TSLA', 'live_order_placed', { side: 'sell', signalEntry: 100, stop: 105, target: 99.75 }, at('10:00'));
    const replay = await replayLiveShorts(source, cfg, ENABLED_AT, 0);
    expect(replay).toMatchObject({ n: 1, meanReplayR: expect.closeTo(0.05, 9), meanGapR: expect.closeTo(-1.65, 9) });
    // A target on the wrong side of the entry is not a target: the config's stands.
    db.exec("DELETE FROM autotrade_events WHERE action = 'live_order_placed'");
    journal('TSLA', 'live_order_placed', { side: 'sell', signalEntry: 100, stop: 105, target: 101 }, at('10:00'));
    expect((await replayLiveShorts(source, cfg, ENABLED_AT, 0)).meanReplayR).toBeCloseTo(-1, 9);
  });

  // 2026-09-25, second review. Only the target was the trade's own; every
  // other exit rule came from the config at replay time. A scale-out switched
  // on after the trade (the sizing revert) re-replayed it with a scale-out it
  // never had: here +0.25R taken on the first bar's 98.75 low, then the stop.
  it('replays each short under the exit rules its placement row recorded', async () => {
    // The first bar CLOSES at 99.2, past a 0.1R scale-out (99.5) on the 105
    // stop, then the second trades through the stop.
    const scaleBars: Candle[] = [
      { time: at('10:00'), open: 100, high: 100.2, low: 99, close: 99.2, volume: 1000 },
      { time: at('10:05'), open: 99.5, high: 106, low: 99.4, close: 105.5, volume: 1000 },
    ];
    const scaleSource: CandleSource = { getCandles: async () => scaleBars };
    seedBook();
    journal(
      'TSLA',
      'live_order_placed',
      { side: 'sell', signalEntry: 100, stop: 105, exitRules: liveExitRulesOf(cfg) },
      at('10:00'),
    );
    const scaled = { ...cfg, liveScaleOutEnabled: true, partialExitRMultiple: 0.1, partialExitPct: 67 };
    // Placed with no scale-out: replayed with none, whatever the config says now.
    expect((await replayLiveShorts(scaleSource, scaled, ENABLED_AT, 0)).meanReplayR).toBeCloseTo(-1, 9);
    // A row from before the field replays under the config, as before: the
    // scale-out banks part of the move first.
    db.exec("DELETE FROM autotrade_events WHERE action = 'live_order_placed'");
    journal('TSLA', 'live_order_placed', { side: 'sell', signalEntry: 100, stop: 105 }, at('10:00'));
    expect((await replayLiveShorts(scaleSource, scaled, ENABLED_AT, 0)).meanReplayR).toBeGreaterThan(-0.9);
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

  // 2026-09-24, on review. The trips read evidence that keeps moving after a
  // revert (the nightly replay, a skip row a later correction supersedes, the
  // last scan), so a trip could drift back under its bar and the `shorts` rule
  // propose again. The revert row itself now holds the window tripped.
  it('holds the window tripped once it has reverted, whatever the evidence reads later', () => {
    // The revert row is stamped with the clock, and this file's session is in
    // the future: run the evening as it would happen.
    vi.useFakeTimers({ now: AFTER_CLOSE, toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    shortsOn();
    seedBook();
    runGatedSwitches(AFTER_CLOSE);
    const reverted = shortsRevertedAt(ENABLED_AT);
    expect(reverted).not.toBeNull();

    // The losing short's rows are gone: the evidence no longer trips.
    db.exec('DELETE FROM position_exits; DELETE FROM positions;');
    const later = buildLiveShortsEvidence(getAutotradeConfig(), AFTER_CLOSE + 86_400_000, null, null);
    expect(later).toMatchObject({ trades: [], defects: [], revertedAt: reverted });

    // Switched on again: a new window, with nothing reverted in it.
    setAutotradeConfig({ liveAllowNakedShort: true, liveShortsEnabledAt: reverted! + 60_000 });
    expect(buildLiveShortsEvidence(getAutotradeConfig(), AFTER_CLOSE, null, null)?.revertedAt).toBeNull();
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
