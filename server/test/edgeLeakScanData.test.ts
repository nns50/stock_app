import { describe, it, expect, beforeAll, beforeEach, onTestFinished } from 'vitest';
import { initDb, db } from '../src/db';
import { recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { createIntent } from '../src/db/orders';
import { createPosition } from '../src/db/positions';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { closeOptionsPaperPosition, openOptionsPaperPosition } from '../src/db/autotradeOptionsPaperPositions';
import { closeLiveOptionsPosition, createLiveOptionsPosition } from '../src/db/autotradeLiveOptionsPositions';
import { recordLiveOptionsEntryOrder, setLiveOptionsOrderPositionId } from '../src/db/autotradeLiveOptionsOrders';
import { recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { createIntent } from '../src/db/orders';
import { listPositions } from '../src/db/positions';
import {
  concentrationCapFloorPct,
  dailyGainStepPct,
  deriveDollarCaps,
  giveBackArmedByOneTrade,
} from '../src/services/autotrading/targetTune';
import { collectBook } from '../src/services/autotrading/dailyTargetSweepData';
import {
  collectConfigurationFindings,
  collectExecutionFindings,
  collectOptionsFlowFindings,
  collectReentryCooldownFinding,
  collectScoringShadowFinding,
  joinLeakTrades,
  runEdgeLeakScanFromDb,
  storedTargetRFor,
} from '../src/services/autotrading/edgeLeakScanData';
import { ROW_CAP } from '../src/db/autotradeEvents';
import { recencySuffix } from '../src/services/autotrading/edgeLeakScan';
import { saveReentryShadowRecord } from '../src/db/reentryShadowRecords';
import { DeclinedEntryShadow, liveExitRules } from '../src/services/autotrading/declinedEntryShadow';
import type { ReentryShadowReport } from '../src/services/autotrading/reentryShadowRecordData';
import { seedClosedAutotradeSessions, weekdaysEndingAt } from './helpers/autotradeSessions';
import { etDateTimeToMs } from '../src/util/marketDate';
import { writeDailyHaltMarker } from '../src/services/autotrading/dailyHaltMarker';
import { readFileSync } from 'node:fs';
import { UNPROTECTED_REPORT_STATES } from '../src/services/autotrading/unprotectedReport';
import { join } from 'node:path';
import { computeRiskSizing } from '../src/services/riskSizing';
import { maxAffordablePremiumPerShare, riskPctUpperBound } from '../src/services/autotrading/optionsAffordability';

// ---------------------------------------------------------------------------
// The DB half. What matters here is not the arithmetic (edgeLeakScan.test.ts
// owns that) but the JOIN: that every trade's R is the collector's R, that the
// round number is assigned per symbol-day, and that the findings a route would
// return are the findings the database actually supports.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM positions; DELETE FROM position_exits; DELETE FROM autotrade_paper_positions; ' +
      'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_live_options_positions; ' +
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM edge_leak_scans; ' +
      'DELETE FROM reentry_shadow_records; DELETE FROM autotrade_live_orders; ' +
      'DELETE FROM autotrade_live_options_orders; DELETE FROM order_intents;',
  );
});

/** Three sessions ending last Friday, so the window is always in the past. */
const SESSIONS = weekdaysEndingAt('2026-09-10', 3);

describe('joinLeakTrades — one R basis, and the round assigned per symbol-day', () => {
  it("takes every trade's R from the collector rather than deriving a second one", () => {
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '09:35', exitTime: '10:00', r: 1.4, symbol: 'NVDA' }] },
    });
    const collected = collectBook('live', 40, Date.parse('2026-09-11T21:00:00Z'));
    const joined = joinLeakTrades(collected, new Map());
    // Every trade was dropped for want of attributes — and COUNTED, not
    // silently skipped, which is what makes a thin scan visible.
    expect(joined.trades).toHaveLength(0);
    expect(joined.droppedTrades).toBe(collected.trades.length);

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const trade = scan.dimensions.find((d) => d.id === 'symbol')?.buckets;
    expect(scan.coverage.liveTrades).toBe(1);
    expect(trade).toEqual([]); // n=1 is under the per-symbol floor
    expect(collected.trades[0].r).toBeCloseTo(1.4, 4);
  });

  it('numbers the rounds by entry time within a symbol and ET date', () => {
    seedClosedAutotradeSessions({
      sessions: {
        [SESSIONS[0]]: [
          { entryTime: '11:00', exitTime: '11:30', r: -0.5, symbol: 'HOOD' },
          { entryTime: '09:35', exitTime: '10:00', r: 0.8, symbol: 'HOOD' },
          { entryTime: '13:00', exitTime: '13:30', r: -0.3, symbol: 'HOOD' },
          // A different symbol on the same day is its own round 1.
          { entryTime: '11:05', exitTime: '11:30', r: 0.2, symbol: 'SMCI' },
        ],
        // …and so is the SAME symbol on the next session.
        [SESSIONS[1]]: [{ entryTime: '09:35', exitTime: '10:00', r: 0.1, symbol: 'HOOD' }],
      },
    });
    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const rounds = scan.dimensions.find((d) => d.id === 'round');
    const byBucket = new Map(rounds?.buckets.map((b) => [b.bucket, b]));
    expect(byBucket.get('1')?.n).toBe(3);
    expect(byBucket.get('2')?.n).toBe(1);
    expect(byBucket.get('3+')?.n).toBe(1);
    // Round 1 is the 09:35 HOOD entry plus SMCI plus the next session's HOOD —
    // 0.8 + 0.2 + 0.1.
    expect(byBucket.get('1')?.totalR).toBeCloseTo(1.1, 4);
  });
});

describe('the entry-extension join — each book reads its OWN reading', () => {
  // 2026-09-14. Two defects met here, and both were invisible from the
  // producer's side:
  //
  //   1. The index was keyed by symbol and minute. Both books enter the same
  //      symbol in the SAME tick, so the live row overwrote the paper one and
  //      the "control" the scan requires to confirm a leak became a copy of the
  //      thing it was controlling — a control that always agrees.
  //   2. Before the paper path journaled at all, every paper row's pctOfRange
  //      was a hardcoded null, so the dimension could never clear the bar
  //      however many trades landed. It read "unconfirmed" for a structural
  //      reason wearing a statistical one's clothes.
  const shadow = (symbol: string, at: number, book: string | null, pctOfRange: number) =>
    db
      .prepare(
        'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
          "VALUES (?,'execution','entry_extension_shadow',?,NULL,?)",
      )
      .run(symbol, JSON.stringify({ ...(book ? { book } : {}), pctOfRange, vwapExtPct: 1.5 }), at);

  const seedPaperAt = (symbol: string, at: number, exitPrice: number) => {
    const p = openPaperPosition({
      symbol,
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(at, p.id);
    closePaperPosition(p.id, { exitPrice, exitReason: 'target' });
  };

  const NOW = Date.parse('2026-09-11T21:00:00Z');
  const pctOf = (scan: ReturnType<typeof runEdgeLeakScanFromDb>, book: 'live' | 'paper') =>
    scan.dimensions
      .find((d) => d.id === 'pctOfRange')
      ?.buckets.map((b) => ({
        bucket: b.bucket,
        n: book === 'live' ? b.n : (b.control?.n ?? 0),
      }));

  it('does not let the live row stand in for the paper control in the same minute', () => {
    const at = etDateTimeToMs(SESSIONS[0], '09:35') as number;
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '09:35', exitTime: '10:00', r: 1.4, symbol: 'NVDA' }] },
    });
    seedPaperAt('NVDA', at, 110);
    // Same symbol, same minute, opposite ends of the range.
    shadow('NVDA', at, 'live', 92);
    shadow('NVDA', at + 400, 'paper', 12);

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    // The live trade lands in 85+, the paper control in <50. Under the old key
    // both read 92 and the control confirmed the live book's own number.
    expect(pctOf(scan, 'live')).toEqual([{ bucket: '85+', n: 1 }]);
    expect(pctOf(scan, 'paper')).toEqual([{ bucket: '85+', n: 0 }]);
    const paperDim = scan.dimensions.find((d) => d.id === 'pctOfRange');
    expect(paperDim?.buckets[0]?.control?.n ?? 0).toBe(0);
  });

  it('joins the paper book to its own reading, where before it joined to nothing', () => {
    const at = etDateTimeToMs(SESSIONS[0], '10:15') as number;
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '10:15', exitTime: '11:00', r: 0.5, symbol: 'AMD' }] },
    });
    seedPaperAt('AMD', at, 110);
    shadow('AMD', at, 'live', 90);
    shadow('AMD', at, 'paper', 90);

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    const bucket = scan.dimensions.find((d) => d.id === 'pctOfRange')?.buckets.find((b) => b.bucket === '85+');
    expect(bucket?.n).toBe(1);
    // The control arm exists now — this is the field that was structurally
    // null, and with it the dimension can be confirmed or refuted at all.
    expect(bucket?.control?.n).toBe(1);
  });

  it('treats a row written before the book field as live, not as orphaned history', () => {
    const at = etDateTimeToMs(SESSIONS[0], '11:20') as number;
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '11:20', exitTime: '12:00', r: -0.4, symbol: 'HPQ' }] },
    });
    shadow('HPQ', at, null, 88);

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    expect(scan.dimensions.find((d) => d.id === 'pctOfRange')?.buckets).toEqual([
      expect.objectContaining({ bucket: '85+', n: 1 }),
    ]);
  });

  it('counts the extension readings it could and could not trust', () => {
    // A report that silently discards 12% of its input is the failure this
    // codebase keeps repeating, so both counts travel with the scan: how many
    // readings were dropped outright, and how many were usable but taken while
    // the 5-minute bars were behind the price.
    const at = etDateTimeToMs(SESSIONS[0], '09:45') as number;
    seedClosedAutotradeSessions({
      sessions: {
        [SESSIONS[0]]: [
          { entryTime: '09:45', exitTime: '10:15', r: 0.3, symbol: 'AAA' },
          { entryTime: '09:46', exitTime: '10:15', r: 0.3, symbol: 'BBB' },
          { entryTime: '09:47', exitTime: '10:15', r: 0.3, symbol: 'CCC' },
        ],
      },
    });
    db.prepare(
      'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
        "VALUES (?,'execution','entry_extension_shadow',?,NULL,?)",
    ).run('AAA', JSON.stringify({ book: 'live', pctOfRange: 40, extendedRange: null }), at);
    db.prepare(
      'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
        "VALUES (?,'execution','entry_extension_shadow',?,NULL,?)",
    ).run('BBB', JSON.stringify({ book: 'live', pctOfRange: 100, extendedRange: 'above' }), at + 60_000);
    db.prepare(
      'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
        "VALUES (?,'execution','entry_extension_shadow',?,NULL,?)",
    ).run('CCC', JSON.stringify({ book: 'live', pctOfRange: 130 }), at + 120_000);

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    expect(scan.coverage.extensionQuality).toEqual({ measured: 2, staleBars: 1, unusable: 1 });
  });

  it('drops a pre-fix reading that fell outside its own range rather than bucketing it', () => {
    // FCX 2026-09-08: entry 77.19 against bars topping at 76.83 — 130.0% of a
    // range the price was above. Clamping it to 100 would invent a reading;
    // bucketing it puts a trade in a band chosen by measurement error. The
    // trade stays in every other dimension and is unmeasured in this one.
    const at = etDateTimeToMs(SESSIONS[0], '12:40') as number;
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '12:40', exitTime: '13:10', r: -0.2, symbol: 'FCX' }] },
    });
    shadow('FCX', at, 'live', 130);

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    expect(scan.dimensions.find((d) => d.id === 'pctOfRange')?.buckets).toEqual([]);
    // Still counted as a trade, and still measured on the dimensions whose
    // inputs were never in doubt.
    expect(scan.coverage.liveTrades).toBe(1);
    expect(scan.dimensions.find((d) => d.id === 'vwapExtension')?.buckets.length).toBeGreaterThan(0);
  });
});

describe('the market’s direction at entry — each trade against the reading in force', () => {
  // 2026-09-23. The loop journals `market_direction_read` only when the reading
  // CHANGES, so the reading in force at an entry is the latest row at or before
  // it that day. A later row must never reach back, and yesterday's must never
  // carry into today.
  const NOW = Date.parse('2026-09-11T21:00:00Z');
  const DAY = SESSIONS[0];
  const reading = (direction: string, at: number) =>
    db
      .prepare(
        'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
          "VALUES (NULL,'screen','market_direction_read',?,NULL,?)",
      )
      .run(JSON.stringify({ direction, indexChangePct: -0.35, redPct: 73 }), at);
  const paperAt = (symbol: string, side: 'buy' | 'sell', at: number) => {
    const p = openPaperPosition({
      symbol,
      side,
      quantity: 10,
      entryPrice: 100,
      stopPrice: side === 'buy' ? 95 : 105,
      targetPrice: side === 'buy' ? 110 : 90,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(at, p.id);
    closePaperPosition(p.id, { exitPrice: side === 'buy' ? 97 : 103, exitReason: 'stop' });
  };
  const at = (time: string) => etDateTimeToMs(DAY, time) as number;

  it('places each entry by the latest reading at or before it, on its own day', () => {
    // Yesterday afternoon read green; it must not carry into this morning.
    reading('green', at('15:00') - 24 * 60 * 60 * 1000);
    reading('red', at('09:40'));
    reading('mixed', at('11:00'));
    seedClosedAutotradeSessions({
      sessions: {
        [DAY]: [
          { entryTime: '09:35', exitTime: '09:50', r: 0.2, symbol: 'EARLY' }, // before any reading today
          { entryTime: '10:15', exitTime: '10:45', r: -1, symbol: 'SHOP' }, // red: a long against it
          { entryTime: '11:30', exitTime: '12:00', r: 0.5, symbol: 'MU' }, // after the flip to mixed
        ],
      },
    });
    paperAt('SHOP', 'buy', at('10:15')); // the control for the same bucket
    paperAt('XNDU', 'sell', at('10:20')); // a short on a red day leans WITH it

    const dim = runEdgeLeakScanFromDb({ now: NOW }).dimensions.find((d) => d.id === 'marketTape');
    expect(dim?.buckets.map((b) => ({ bucket: b.bucket, n: b.n, control: b.control?.n ?? 0 }))).toEqual([
      { bucket: 'against', n: 1, control: 1 },
      { bucket: 'mixed', n: 1, control: 0 },
    ]);
    // The 09:35 entry had no reading: unplaced, not guessed.
    expect(dim?.uncovered).toBe(1);
  });

  // 2026-09-24, on review. The loop journals the tick's reading seconds before
  // it places, and a live stock entry's `entryTime` is HH:MM, floored: on a
  // tick where the reading changed, the floored time came before the tick's own
  // row. A live option's `entry_at` is when its fill was booked, which can be
  // ticks later. Both are now placed by when their ORDER went out.
  it('places a live entry by when its order went out, not a minute-floored or fill-booked time', () => {
    reading('mixed', at('09:40'));
    reading('red', at('10:08') + 3_000); // the reading turns red at 10:08:03
    reading('mixed', at('10:12')); // ...and back by 10:12
    seedClosedAutotradeSessions({
      sessions: { [DAY]: [{ entryTime: '10:08', exitTime: '10:40', r: -1, symbol: 'SHOP' }] },
    });
    const shop = listPositions().find((p) => p.symbol === 'SHOP')!;
    const stockIntent = createIntent(
      { symbol: 'SHOP', assetKind: 'stock', side: 'buy', openClose: 'open', quantity: 10, orderType: 'limit' },
      'shop-entry',
    );
    recordLiveOrder({
      intentId: stockIntent.id,
      symbol: 'SHOP',
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
    });
    setLiveOrderPositionId(stockIntent.id, shop.id);
    db.prepare('UPDATE autotrade_live_orders SET created_at = ? WHERE intent_id = ?').run(
      at('10:08') + 20_000,
      stockIntent.id,
    );
    // A live call placed at 10:08:30, its fill booked at 10:14 (after the reading went mixed).
    const call = createLiveOptionsPosition({
      symbol: 'TSLA',
      side: 'call',
      contractSymbol: 'TSLA-call',
      strike: 100,
      expiration: DAY,
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      accountId: 'acct',
    });
    closeLiveOptionsPosition(call.id, { exitPrice: 1.4, exitReason: 'stop_loss' });
    db.prepare('UPDATE autotrade_live_options_positions SET entry_at = ?, exit_at = ? WHERE id = ?').run(
      at('10:14'),
      at('10:40'),
      call.id,
    );
    const optionIntent = createIntent(
      { symbol: 'TSLA', assetKind: 'option', side: 'buy', openClose: 'open', quantity: 1, orderType: 'limit' },
      'tsla-entry',
    );
    recordLiveOptionsEntryOrder({
      intentId: optionIntent.id,
      symbol: 'TSLA',
      kind: 'single_leg',
      side: 'call',
      contractSymbol: 'TSLA-call',
      strike: 100,
      expiration: DAY,
      riskAmount: 200,
      riskProfile: 'MODERATE',
    });
    setLiveOptionsOrderPositionId(optionIntent.id, call.id);
    db.prepare('UPDATE autotrade_live_options_orders SET created_at = ? WHERE intent_id = ?').run(
      at('10:08') + 30_000,
      optionIntent.id,
    );

    const bySide = runEdgeLeakScanFromDb({ now: NOW }).dimensions.find((d) => d.id === 'marketTapeBySide');
    // Both met the red tape. By 10:08:00 and 10:14 they read mixed.
    expect(Object.fromEntries(bySide!.buckets.map((b) => [b.bucket, b.n]))).toEqual({
      equity_long_red: 1,
      options_long_red: 1,
    });
  });

  // THE SAME READING BY SIDE (2026-09-25). `against` pools a long on a red day
  // with a short on a green one, so it cannot say whether SHORTS pay on red
  // days, which is the question the tape plan turns on. This cut files every
  // entry by asset, side and the tape it met, in both books, and reports the
  // buckets only paper has: the live book takes no stock shorts.
  it('files each entry by asset, side and tape, and reports the buckets only paper has', () => {
    const paperOption = (symbol: string, side: 'call' | 'put', entryAt: number) => {
      const o = openOptionsPaperPosition({
        symbol,
        side,
        contractSymbol: `${symbol}-${side}`,
        strike: 100,
        expiration: DAY,
        quantity: 1,
        entryPrice: 2,
        riskAmount: 140,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
      });
      db.prepare('UPDATE autotrade_options_paper_positions SET entry_at = ? WHERE id = ?').run(entryAt, o.id);
      closeOptionsPaperPosition(o.id, { exitPrice: 2.6, exitReason: 'take_profit' });
    };
    const liveOption = (symbol: string, side: 'call' | 'put', entryAt: number) => {
      const o = createLiveOptionsPosition({
        symbol,
        side,
        contractSymbol: `${symbol}-${side}`,
        strike: 100,
        expiration: DAY,
        quantity: 1,
        entryPrice: 2,
        riskAmount: 200,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
        accountId: 'acct',
      });
      closeLiveOptionsPosition(o.id, { exitPrice: 1.4, exitReason: 'stop_loss' });
      db.prepare('UPDATE autotrade_live_options_positions SET entry_at = ?, exit_at = ? WHERE id = ?').run(
        entryAt,
        entryAt + 20 * 60_000,
        o.id,
      );
    };
    reading('red', at('09:40'));
    seedClosedAutotradeSessions({
      sessions: { [DAY]: [{ entryTime: '10:15', exitTime: '10:45', r: -1, symbol: 'SHOP' }] }, // a live stock long
    });
    paperAt('SHOP', 'buy', at('10:15')); // a paper long
    paperAt('XNDU', 'sell', at('10:20')); // a paper stock short
    paperOption('AMZN', 'put', at('10:25')); // a paper put
    liveOption('TSLA', 'call', at('10:30')); // a live call

    const scan = runEdgeLeakScanFromDb({ now: NOW });
    const bySide = scan.dimensions.find((d) => d.id === 'marketTapeBySide');
    expect(Object.fromEntries(bySide!.buckets.map((b) => [b.bucket, { live: b.n, paper: b.control?.n ?? 0 }]))).toEqual(
      {
        equity_long_red: { live: 1, paper: 1 },
        options_long_red: { live: 1, paper: 0 },
        equity_short_red: { live: 0, paper: 1 },
        options_short_red: { live: 0, paper: 1 },
      },
    );
    // A bucket only paper has is reported and never judged.
    expect(bySide!.buckets.find((b) => b.bucket === 'equity_short_red')).toMatchObject({
      verdict: 'ok',
      lever: null,
      meanR: null,
    });
    // The combined cut reads the same trades as before: the live long and the
    // live call lean against the red tape; paper's short and put lean with it
    // and have no live bucket there.
    expect(
      scan.dimensions
        .find((d) => d.id === 'marketTape')
        ?.buckets.map((b) => ({ bucket: b.bucket, n: b.n, control: b.control?.n ?? 0 })),
    ).toEqual([{ bucket: 'against', n: 2, control: 1 }]);
  });

  it('names the gate as the lever when trades against the tape lose', () => {
    reading('red', at('09:31'));
    seedClosedAutotradeSessions({
      sessions: {
        [DAY]: Array.from({ length: 16 }, (_, i) => ({
          entryTime: `${10 + Math.floor(i / 4)}:${String((i % 4) * 10 + 5).padStart(2, '0')}`,
          exitTime: '15:00',
          r: i % 2 === 0 ? -0.9 : -1.1,
          symbol: `RED${i}`,
        })),
      },
    });
    for (let i = 0; i < 12; i++) paperAt(`RED${i}`, 'buy', at('10:05') + i * 60_000);

    const bucket = runEdgeLeakScanFromDb({ now: NOW })
      .dimensions.find((d) => d.id === 'marketTape')
      ?.buckets.find((b) => b.bucket === 'against');
    expect(bucket?.n).toBe(16);
    expect(bucket?.verdict).toBe('leak');
    expect(bucket?.lever).toMatchObject({
      kind: 'config',
      field: 'marketDirectionGateEnabled',
      value: true,
      direction: 'safe',
    });
  });
});

describe('the options sleeve, which nothing else in the scan can see', () => {
  it('reports a sleeve that cannot size a contract, with the binding number', () => {
    // 2026-09-08..09 on the live book: 29 of 31 candidates refused with
    // failedRules[0] === 'quantity'. The attribution is equity-only, the
    // execution catalog has no options entry class, and the advisor filtered
    // to execution findings — so nobody was told.
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      accountEquityUsd: 3522.81,
      riskPerTradePct: 2.5,
      // The expectancy lean only reaches riskPctUpperBound when method
      // weighting is ON — which production has, and which is what makes the
      // deployed order cap $236 rather than $189.
      methodWeightingEnabled: true,
      expectancyMaxMultiplier: 1.25,
      optionsDisasterStopPct: 70,
      liveOptionsProbationTrades: 0,
    });
    const now = etDateTimeToMs('2026-09-10', '17:00') as number;
    const at = etDateTimeToMs('2026-09-09', '10:00') as number;
    const ins = db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'risk_check',?,?,NULL,?)",
    );
    for (let i = 0; i < 5; i++) {
      ins.run('AAA', 'live_options_risk_blocked', JSON.stringify({ failedRules: ['quantity'] }), at + i);
    }
    // A refusal for a DIFFERENT reason is not this finding.
    ins.run('BBB', 'live_options_risk_blocked', JSON.stringify({ failedRules: ['max_correlated_exposure'] }), at + 9);
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES ('CCC','execution','live_options_order_placed','{}',NULL,?)",
    ).run(at + 10);

    const [f] = collectOptionsFlowFindings(getAutotradeConfig(), now);
    expect(f).toBeTruthy();
    expect(f.kind).toBe('configuration');
    expect(f.count).toBe(5);
    expect(f.lastSeenEtDate).toBe('2026-09-09');
    // 5 refused of 6 candidates (5 + 1 placed) = 83%.
    expect(f.detail).toMatch(/5 of 6 live options candidates \(83%\)/);
    // The ceiling: equity 3522.81 x (2.5 x 1.25)% / 70% / 100 = $1.57/share.
    expect(f.detail).toMatch(/largest affordable premium is \$1\.57\/share/);
    // It is a decision, not a knob.
    expect(f.lever?.direction).toBe('research');
  });

  // PROBATION IS NOT THE CONSTRAINT (2026-09-12). This case used to assert the
  // opposite — a ceiling multiplied by the probation factor, and a lever saying
  // to wait it out. The sizer decides affordability BEFORE probation is
  // consulted (`optionsRiskCheck`'s `quantity` rule, which is what every
  // refusal counted here failed), and the executor then scales the contract
  // COUNT with a one-contract floor. So probation changes how many contracts
  // are bought, never the largest premium one may cost — at any account size,
  // and at this one, where the sizer reaches exactly one contract, it changes
  // nothing at all.
  it('does not attribute the ceiling to probation, which cannot move it', () => {
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      accountEquityUsd: 3522.81,
      riskPerTradePct: 2.5,
      // The expectancy lean only reaches riskPctUpperBound when method
      // weighting is ON — which production has, and which is what makes the
      // deployed order cap $236 rather than $189.
      methodWeightingEnabled: true,
      expectancyMaxMultiplier: 1.25,
      optionsDisasterStopPct: 70,
      liveOptionsProbationTrades: 10,
      liveOptionsProbationSizeMultiplier: 0.5,
      // Probation only exists once the sleeve has been switched on — the
      // status counts orders placed SINCE that moment.
      liveOptionsEnabledAt: etDateTimeToMs('2026-09-01', '09:30') as number,
    });
    const now = etDateTimeToMs('2026-09-10', '17:00') as number;
    const at = etDateTimeToMs('2026-09-09', '10:00') as number;
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES ('AAA','risk_check','live_options_risk_blocked',?,NULL,?)",
    ).run(JSON.stringify({ failedRules: ['quantity'] }), at);

    const [f] = collectOptionsFlowFindings(getAutotradeConfig(), now);
    // The SAME ceiling the case above reports with probation off.
    expect(f.detail).toMatch(/largest affordable premium is \$1\.57\/share/);
    expect(f.detail).toMatch(/unchanged by probation \(0\.5x, 10 trades left\)/);
    expect(f.detail).not.toMatch(/HALVED/);
    expect(f.detail).not.toMatch(/\$0\.79/);
    // …and the lever no longer offers waiting it out as a remedy.
    expect(f.lever?.detail).toMatch(/Probation is NOT the constraint/);
    expect(f.lever?.detail).not.toMatch(/wait for probation to end/);
  });

  // ASSERTED AT THE CONSUMER, against the real sizer: a premium at the reported
  // ceiling really does size, and the probation factor is nowhere in that
  // arithmetic. If optionsRiskCheck ever starts consulting probation, this
  // fails here rather than making the finding quietly wrong again.
  it('a premium at the ceiling sizes one contract, with or without probation', () => {
    const cfg = {
      ...defaultAutotradeConfig(),
      accountEquityUsd: 3522.81,
      riskPerTradePct: 2.5,
      methodWeightingEnabled: true,
      expectancyMaxMultiplier: 1.25,
      optionsDisasterStopPct: 70,
    };
    const ceiling = maxAffordablePremiumPerShare({
      equityUsd: cfg.accountEquityUsd,
      riskPctUpperBound: riskPctUpperBound(cfg),
      disasterStopPct: cfg.optionsDisasterStopPct,
    });
    const sized = (premium: number, riskPct: number) =>
      computeRiskSizing({
        accountSize: cfg.accountEquityUsd,
        riskPct,
        entryPrice: premium,
        stopPrice: Math.round(premium * (1 - cfg.optionsDisasterStopPct / 100) * 10000) / 10000,
        assetType: 'option',
        side: 'long',
      }).suggestedQuantity;

    // At the upper-bound risk % the ceiling is exactly the boundary…
    expect(sized(ceiling - 0.01, riskPctUpperBound(cfg))).toBeGreaterThanOrEqual(1);
    expect(sized(ceiling + 0.01, riskPctUpperBound(cfg))).toBe(0);
    // …and the executor's clamp means a probation factor cannot take that 1 to
    // 0, which is the whole reason the ceiling must not carry the factor.
    for (const multiplier of [0.5, 0.25, 1]) {
      expect(Math.max(1, Math.floor(1 * multiplier))).toBe(1);
    }
  });

  it('the executor really does clamp probation at one contract', () => {
    // A source scan, because the executor cannot be imported here (it pulls the
    // broker). Weaker than a behavioural test and worth saying so: it catches
    // the clamp being removed, which is the change that would make the ceiling
    // above wrong.
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'liveOptionsExecute.ts'), 'utf8');
    expect(src).toMatch(/Math\.max\(1, Math\.floor\(rawQuantity \* probation\.multiplier\)\)/);
  });

  // 2026-09-23: at $26k, 22 of the 32 refusals fit today's ceiling (20 from the
  // $5k days, and MU at $8.77 under the step-down), and the lever still told
  // the operator a $5k-era story. The split is against TODAY's ceiling.
  describe('which kind of refusal', () => {
    const at26k = () =>
      setAutotradeConfig({
        ...defaultAutotradeConfig(),
        accountEquityUsd: 26_446.53,
        riskPerTradePct: 2.5,
        methodWeightingEnabled: true,
        expectancyMaxMultiplier: 1.25,
        optionsDisasterStopPct: 70,
        liveOptionsProbationTrades: 0,
      });
    const refuse = (symbol: string, premium: number, time: string) =>
      db
        .prepare(
          "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'risk_check','live_options_risk_blocked',?,NULL,?)",
        )
        .run(symbol, JSON.stringify({ failedRules: ['quantity'], premium }), etDateTimeToMs('2026-09-22', time));
    const now = etDateTimeToMs('2026-09-22', '17:00') as number;

    it('says a refusal within the ceiling was a size cut, and drops the small-account advice', () => {
      at26k();
      refuse('MU', 8.775, '10:13'); // within: 26,446.53 x 3.125% / 70% / 100 = $11.81
      refuse('AMD', 4.2, '10:40'); // within
      refuse('LITE', 13.25, '11:05'); // above
      const [f] = collectOptionsFlowFindings(getAutotradeConfig(), now);
      expect(f.detail).toMatch(/largest affordable premium is \$11\.81\/share/);
      expect(f.detail).toMatch(/Of the 3 with a recorded premium, 1 cost more than that and 2 did not/);
      // Computed from the latest refusal, not a hard-coded $5k-era example.
      expect(f.lever?.detail).toMatch(/The latest, LITE on 2026-09-22, was \$13\.25: one contract risks \$928/);
      expect(f.lever?.detail).toMatch(/2 fit that ceiling, so a budget below its most refused them/);
      expect(f.lever?.detail).not.toMatch(/\$2\.93/);
      expect(f.lever?.detail).not.toMatch(/account this size/);
    });

    it('keeps the small-account advice when most refusals were too dear at full size', () => {
      at26k();
      refuse('LITE', 13.25, '10:05');
      refuse('GEV', 13.05, '10:12');
      refuse('MU', 8.775, '10:13');
      const [f] = collectOptionsFlowFindings(getAutotradeConfig(), now);
      expect(f.lever?.detail).toMatch(/2 were priced above the most any trade can carry at this equity/);
      expect(f.lever?.detail).toMatch(/account this size/);
    });
  });

  it('stays silent when the sleeve is sizing fine', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 100_000 });
    expect(collectOptionsFlowFindings(getAutotradeConfig(), etDateTimeToMs('2026-09-10', '17:00') as number)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// The scoring shadow, finally read (2026-09-12). It had journaled ~200 rows a
// session for weeks with a written decision rule beside it and nothing in the
// app reading it. These cases pin both branches of that rule.
// ---------------------------------------------------------------------------
describe('the scoring shadow', () => {
  /** One tick's row, in the shape screen.ts actually writes. */
  function shadowRow(at: number, over: Record<string, unknown> = {}) {
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'screen','relvol_pace_scoring_shadow',?,NULL,?)",
    ).run(
      JSON.stringify({
        enabled: false,
        universeMedian: 0.58,
        scored: 480,
        compared: 480,
        relVolComponentZeroRaw: 370,
        relVolComponentZeroPace: 243,
        meanTotalDelta: 2.2,
        wouldNewlyPass: 15,
        wouldNewlyFail: 0.3,
        // The ladder the screen writes: how many of `ladderScored` reach each
        // rung under each scoring. Pace lifts the distribution, so it admits
        // more at every rung — raw admits 100 at 72, pace admits 100 at 76.
        scoreLadder: [60, 64, 68, 72, 76, 80],
        ladderScored: 480,
        ladderRawAtOrAbove: [300, 200, 140, 100, 60, 30],
        ladderPaceAtOrAbove: [400, 300, 200, 140, 100, 60],
        ...over,
      }),
      at,
    );
  }
  const now = etDateTimeToMs('2026-09-10', '17:00') as number;
  const at = etDateTimeToMs('2026-09-09', '10:00') as number;

  it('reports the deployed reading: a one-sided turnover, as research', () => {
    for (let i = 0; i < 10; i++) shadowRow(at + i);
    const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
    expect(f).toBeTruthy();
    expect(f.kind).toBe('configuration');
    expect(f.count).toBe(10);
    expect(f.lastSeenEtDate).toBe('2026-09-09');
    // 15.3 of 480 = 3.2% of the universe changing sides.
    expect(f.detail).toMatch(/newly PASS 15 symbols a tick and newly FAIL 0\.3/);
    expect(f.detail).toMatch(/3\.2% of the universe changing sides/);
    expect(f.detail).toMatch(/\+2\.2 points/);
    expect(f.detail).toMatch(/fall from 370 to 243/);
    // Enabling it WIDENS the set, so it can never be a config lever the app applies.
    expect(f.lever?.direction).toBe('research');
    expect(f.lever?.kind).toBe('code');
    expect(f.lever?.detail).toMatch(/re-fit that floor/);
  });

  it('states the re-fitted floor, measured off the ladder rather than the mean shift', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), liveMinSignalScore: 72 });
    for (let i = 0; i < 10; i++) shadowRow(at + i);
    const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
    expect(f.detail).toMatch(/THE RE-FIT: pace scoring admits as many symbols at a floor of 76/);
    expect(f.detail).toMatch(/liveMinSignalScore of 72/);
    expect(f.detail).toMatch(/over 10 ticks of the score ladder/);
    // Emphatically NOT 72 + the 2.2-point mean move: that number has no basis,
    // because the lift is concentrated in the symbols that scored zero.
    expect(f.detail).not.toMatch(/floor of 74\.2/);
  });

  it('says the floor is not measurable rather than inventing one', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), liveMinSignalScore: 72 });
    // Rows from before the ladder shipped carry none of its fields.
    for (let i = 0; i < 10; i++)
      shadowRow(at + i, { scoreLadder: undefined, ladderRawAtOrAbove: undefined, ladderPaceAtOrAbove: undefined });
    const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
    expect(f.detail).toMatch(/equivalent floor is not yet measurable/);
  });

  it('stays silent when the change really is cosmetic', () => {
    for (let i = 0; i < 10; i++) shadowRow(at + i, { wouldNewlyPass: 2, wouldNewlyFail: 1 });
    // 3 of 480 = 0.6%, under the 1% bar.
    expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
  });

  it('stops nagging once the flag is on — the decision has been taken', () => {
    // Rows written with the flag on, and the flag still on now, with the floor
    // at its re-fitted equivalence (raw 72 admits 100; pace admits 100 at 76).
    setAutotradeConfig({ ...defaultAutotradeConfig(), relVolUsePaceScoring: true, liveMinSignalScore: 76 });
    for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
    expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
  });

  it('stays quiet when the flag was reverted inside the window', () => {
    // The pre-enable case was decided once; a reverted flag must not re-raise it.
    for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: i < 5 });
    expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
  });

  it('says nothing at all when the shadow has not run', () => {
    expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE FLOOR IS RE-CHECKED WHILE THE FLAG IS ON (2026-09-19). The flag went
  // on 2026-09-14 with the floor at 81, the equivalent of raw-72 measured
  // then; this finding went silent the same moment, and nothing asked again.
  // Friday 09-18's in-session ladder read the equivalent at 74.8.
  // -------------------------------------------------------------------------
  describe('the floor re-check, once the flag is on', () => {
    const on = (floor: number) =>
      setAutotradeConfig({ ...defaultAutotradeConfig(), relVolUsePaceScoring: true, liveMinSignalScore: floor });

    it('reports a floor that has drifted ABOVE its equivalence, with a lowering lever that adds exposure', () => {
      on(80); // raw 72 admits 100 a tick; pace admits 100 at 76 and only 60 at 80.
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
      expect(f).toBeTruthy();
      expect(f.id).toBe('configuration:relvol_pace_floor_drift');
      expect(f.kind).toBe('configuration');
      expect(f.count).toBe(10);
      expect(f.lastSeenEtDate).toBe('2026-09-09');
      expect(f.detail).toMatch(/liveMinSignalScore 80/);
      expect(f.detail).toMatch(/admits 60 symbols a tick, while the raw floor of 72 .* admits 100/);
      expect(f.detail).toMatch(/now reads 76 — 4 points below the floor in force/);
      expect(f.detail).toMatch(/seeing fewer candidates/);
      // The lever names the field and the number, and says which way it moves
      // exposure: lowering the floor is never the app's to apply.
      expect(f.lever).toMatchObject({ kind: 'config', field: 'liveMinSignalScore', value: 76, direction: 'exposure' });
      expect(f.lever?.detail).toMatch(/operator's call/);
    });

    it('reports a floor that has drifted BELOW its equivalence, with a raising lever that is safe', () => {
      on(72); // pace admits 140 at 72 against the 100 the reference admits.
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
      expect(f.detail).toMatch(/4 points above the floor in force/);
      expect(f.detail).toMatch(/seeing more candidates/);
      expect(f.lever).toMatchObject({ field: 'liveMinSignalScore', value: 76, direction: 'safe' });
      expect(f.lever?.detail).toMatch(/flow cut/);
    });

    it('is silent inside the two-point bar', () => {
      on(75); // equivalent 76: one point of drift.
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
    });

    it('never nags the pre-enable case while the flag is on', () => {
      on(76);
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      expect(collectScoringShadowFinding(getAutotradeConfig(), now).map((f) => f.id)).not.toContain(
        'configuration:relvol_pace_scoring_shadow',
      );
    });

    it('sums only the rows the loop wrote under the flag — a route run on raw scoring is not the same ladder', () => {
      on(80);
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      // Five rows from a screen route call with the flag overridden off, on a
      // ladder that would hide the drift if it were summed in.
      for (let i = 0; i < 5; i++) {
        shadowRow(at + 100 + i, {
          enabled: false,
          ladderRawAtOrAbove: [300, 200, 140, 100, 60, 30],
          ladderPaceAtOrAbove: [300, 200, 140, 100, 60, 30],
        });
      }
      const [f] = collectScoringShadowFinding(getAutotradeConfig(), now);
      expect(f.count).toBe(10);
      expect(f.lever?.value).toBe(76);
    });

    it('says nothing when the ladder cannot answer — no rungs, or a floor off its ends', () => {
      on(90); // above the ladder's top rung of 80.
      for (let i = 0; i < 10; i++) shadowRow(at + i, { enabled: true });
      expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
      db.exec("DELETE FROM autotrade_events WHERE action = 'relvol_pace_scoring_shadow'");
      on(80);
      for (let i = 0; i < 10; i++)
        shadowRow(at + i, {
          enabled: true,
          scoreLadder: undefined,
          ladderRawAtOrAbove: undefined,
          ladderPaceAtOrAbove: undefined,
        });
      expect(collectScoringShadowFinding(getAutotradeConfig(), now)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// A GIVE-BACK GUARD ARMED BY ITS FIRST WINNER (2026-09-13).
//
// The concentration-cap disease one level up: an absolute percentage chosen
// when a trade moved the day 1.25%, left alone when riskPerTradePct doubled.
// The guard still fires correctly — arm and floor are thresholds, not a window
// a move can jump. What the sizing changed is WHEN it becomes live.
// ---------------------------------------------------------------------------
describe('the give-back arm against what one trade moves', () => {
  const trial = () => ({
    ...defaultAutotradeConfig(),
    accountEquityUsd: 3522.81,
    riskPerTradePct: 2.5,
    targetRMultiple: 1,
    targetDailyGainPct: 3,
    giveBackArmPct: 2,
    giveBackFloorPct: 1,
  });
  const now = etDateTimeToMs('2026-09-10', '17:00') as number;
  const findings = () =>
    collectConfigurationFindings(getAutotradeConfig(), now).filter(
      (f) => f.id === 'configuration:give_back_armed_by_one_trade',
    );

  it('the step is the two terms that make it, not a number of its own', () => {
    // riskPerTradePct x targetRMultiple, and nothing else: the book risks that
    // much and takes the target at that multiple of it.
    expect(dailyGainStepPct(trial())).toBe(2.5);
    expect(dailyGainStepPct({ ...trial(), targetRMultiple: 2 })).toBe(5);
    expect(dailyGainStepPct({ ...trial(), riskPerTradePct: 0 })).toBe(0);
  });

  it('names the trial sizing: a 0.8R arm one 1R winner clears', () => {
    setAutotradeConfig(trial());
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(/arms at 2% while one 1R winner moves the day 2.5%/);
    expect(f[0].detail).toMatch(/an arm at 0.8R and a floor at 0.4R/);
    expect(f[0].detail).toMatch(/halts at roughly flat rather than at the 1%/);
    // Widening the band keeps the book trading on a fading day.
    expect(f[0].lever?.direction).toBe('exposure');
    // And it proposes NO value: inside a 1.2R goal there may be no coherent
    // band at all, which is the operator's call rather than the app's guess.
    expect(f[0].lever?.value).toBeNull();
  });

  it('is SILENT at the sizing the levels were chosen for', () => {
    // 1.25% risk puts the arm at 1.6R, so one winner does not reach it. This
    // is the assertion that keeps the check about the CHANGE: the band was
    // already thinner than one step here (0.8R against 1.0R), and triggering
    // on the band would have fired on a guard that was doing its job.
    setAutotradeConfig({ ...trial(), riskPerTradePct: 1.25 });
    expect(findings()).toEqual([]);
    expect(giveBackArmedByOneTrade({ ...trial(), riskPerTradePct: 1.25 })).toBeNull();
  });

  it('follows the target multiple too, not just the risk', () => {
    // The step is risk x target. At 1.25% risk with a 2R target a winner moves
    // the day 2.5% again, so the same 2% arm is cleared by one of them.
    expect(giveBackArmedByOneTrade({ ...trial(), riskPerTradePct: 1.25, targetRMultiple: 2 })).not.toBeNull();
  });

  it('says nothing when the guard is unconfigured', () => {
    setAutotradeConfig({ ...trial(), giveBackArmPct: null, giveBackFloorPct: null });
    expect(findings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A CONCENTRATION CAP BELOW WHAT ONE POSITION COSTS (2026-09-12).
//
// The sector and correlated caps gate ALREADY-held notional and exclude the
// candidate's own size, so trimming an order cannot satisfy them. Below the
// per-order cap's own fraction of equity, one ordinary position fills the
// sector's whole budget and closes it with its own first trade.
// ---------------------------------------------------------------------------
describe('concentration caps against what one position actually costs', () => {
  const trial = () => ({
    ...defaultAutotradeConfig(),
    accountEquityUsd: 3522.81,
    riskPerTradePct: 2.5,
    maxStopDistancePct: 2.5,
  });
  const now = etDateTimeToMs('2026-09-10', '17:00') as number;
  const findings = () =>
    collectConfigurationFindings(getAutotradeConfig(), now).filter((f) =>
      f.id.startsWith('configuration:concentration_cap:'),
    );

  it('the floor is the per-order cap, not a number of its own', () => {
    // risk 2.5 over a 2.5% widest stop = 100% of equity, times the order cap's
    // 1.5 headroom = 150. Same two terms deriveDollarCaps uses, so the two
    // cannot drift: liveMaxOrderUsd is 150% of equity at this config.
    const cfg = trial();
    expect(concentrationCapFloorPct(cfg)).toBe(150);
    expect(deriveDollarCaps(cfg, cfg.accountEquityUsd).liveMaxOrderUsd).toBe(
      Math.round((cfg.accountEquityUsd * concentrationCapFloorPct(cfg)) / 100),
    );
  });

  it('names the live case: 80% caps against a position that costs more', () => {
    setAutotradeConfig({ ...trial(), maxSectorExposurePct: 80, maxCorrelatedExposurePct: 80 });
    const f = findings();
    expect(f.map((x) => x.id).sort()).toEqual([
      'configuration:concentration_cap:maxCorrelatedExposurePct',
      'configuration:concentration_cap:maxSectorExposurePct',
    ]);
    expect(f[0].detail).toMatch(/80% of equity while the per-order cap permits a single position of 150%/);
    // Raising a cap adds exposure — the app must never apply this itself.
    expect(f[0].lever?.direction).toBe('exposure');
    expect(f[0].lever?.value).toBe(150);
  });

  it('goes quiet at the floor and above — there the number is a real choice', () => {
    setAutotradeConfig({ ...trial(), maxSectorExposurePct: 150, maxCorrelatedExposurePct: 150 });
    expect(findings()).toEqual([]);
    setAutotradeConfig({ ...trial(), maxSectorExposurePct: 190, maxCorrelatedExposurePct: 200 });
    expect(findings()).toEqual([]);
  });

  it('tracks the sizing rather than a stored constant — it moves when risk does', () => {
    // The pre-trial sizing: 1.25 over 2.5 = 50% x 1.5 = 75, so the SAME 80%
    // caps were coherent before 2026-09-12 and stopped being so when risk
    // doubled. That is the whole finding: nothing was edited, the ground moved.
    const pre = { ...trial(), riskPerTradePct: 1.25 };
    expect(concentrationCapFloorPct(pre)).toBe(75);
    setAutotradeConfig({ ...pre, maxSectorExposurePct: 80, maxCorrelatedExposurePct: 80 });
    expect(findings()).toEqual([]);
  });

  it('says nothing when the sizing cannot produce a fraction at all', () => {
    expect(concentrationCapFloorPct({ riskPerTradePct: 0, maxStopDistancePct: 2.5 })).toBe(0);
    expect(concentrationCapFloorPct({ riskPerTradePct: 2.5, maxStopDistancePct: 0 })).toBe(0);
    setAutotradeConfig({ ...trial(), maxStopDistancePct: 0, maxSectorExposurePct: 1 });
    expect(findings()).toEqual([]);
  });
});

describe('the configuration findings', () => {
  it('names a frozen cap and hands back the value that un-freezes it', () => {
    const cfg = { ...defaultAutotradeConfig(), riskPerTradePct: 1.25, maxStopDistancePct: 2.5 };
    const derived = deriveDollarCaps(cfg, 10_000);
    setAutotradeConfig({ ...cfg, ...derived, liveOptionsMaxOrderUsd: 300, liveCapsAnchorEquityUsd: 10_000 });

    const findings = collectConfigurationFindings(getAutotradeConfig(), Date.now());
    const frozen = findings.find((f) => f.id === 'configuration:frozen:liveOptionsMaxOrderUsd');
    expect(frozen).toBeTruthy();
    expect(frozen?.lever).toMatchObject({
      kind: 'config',
      field: 'liveOptionsMaxOrderUsd',
      value: derived.liveOptionsMaxOrderUsd,
      direction: 'safe',
    });
    // Nothing else is frozen, so nothing else is reported.
    expect(findings.filter((f) => f.id.startsWith('configuration:frozen:'))).toHaveLength(1);
  });

  it('reports a tuner row only while the tuner is meant to be off', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), autoTuneEnabled: false });
    logAutotradeEvent({ stage: 'config', action: 'auto_tune_ran', detail: { riskPerTradePct: 2.5 } });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now()).map((f) => f.id)).toContain(
      'configuration:auto_tune_ran',
    );

    setAutotradeConfig({ autoTuneEnabled: true });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now()).map((f) => f.id)).not.toContain(
      'configuration:auto_tune_ran',
    );
  });

  // -------------------------------------------------------------------------
  // The finding asks "did the tuner write while it was meant to be off", and
  // that has no answer without a moment to measure from. On 2026-09-12 the
  // first production read counted 14 rows from the week BEFORE the tuner was
  // switched off — all of them legitimate, and all of them due to be reported
  // again on each of the next five routine runs.
  // -------------------------------------------------------------------------
  it('counts only tuner rows NEWER than the switch, once the switch is journaled', () => {
    const now = Date.parse('2026-09-12T18:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    setAutotradeConfig({ ...defaultAutotradeConfig(), autoTuneEnabled: false });
    // Two legitimate runs from before the switch, one violation after it.
    const write = (action: string, at: number) =>
      db
        .prepare(
          "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'config',?,'{}',NULL,?)",
        )
        .run(action, at);
    write('auto_tune_ran', now - 4 * day);
    write('auto_tune_ran', now - 3 * day);
    write('auto_tune_disabled', now - 2 * day);
    write('auto_tune_ran', now - day);

    const finding = collectConfigurationFindings(getAutotradeConfig(), now).find(
      (f) => f.id === 'configuration:auto_tune_ran',
    );
    expect(finding?.count).toBe(1);
    expect(finding?.detail).toMatch(/since the tuner was switched off/);
  });

  it('does not report the switch itself as the tuner misbehaving', () => {
    const now = Date.parse('2026-09-12T18:00:00Z');
    setAutotradeConfig({ ...defaultAutotradeConfig(), autoTuneEnabled: false });
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'config','auto_tune_disabled','{}',NULL,?)",
    ).run(now - 60_000);
    expect(collectConfigurationFindings(getAutotradeConfig(), now).map((f) => f.id)).not.toContain(
      'configuration:auto_tune_ran',
    );
  });

  it('falls back to TODAY when the journal never recorded the switch', () => {
    // The 2026-09-12 case: the flag flipped before the transition row existed.
    // Yesterday's legitimate run must not be reported; a run dated today must.
    const now = Date.parse('2026-09-12T18:00:00Z');
    setAutotradeConfig({ ...defaultAutotradeConfig(), autoTuneEnabled: false });
    const write = (at: number) =>
      db
        .prepare(
          "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'config','auto_tune_ran','{}',NULL,?)",
        )
        .run(at);
    write(Date.parse('2026-09-11T04:00:00Z')); // yesterday 00:00 ET — legitimate
    expect(collectConfigurationFindings(getAutotradeConfig(), now).map((f) => f.id)).not.toContain(
      'configuration:auto_tune_ran',
    );

    write(Date.parse('2026-09-12T04:00:00Z')); // today 00:00 ET — a real violation
    const finding = collectConfigurationFindings(getAutotradeConfig(), now).find(
      (f) => f.id === 'configuration:auto_tune_ran',
    );
    expect(finding?.count).toBe(1);
  });

  it('reports a held equity reading, which is the caps refusing to follow a bad number', () => {
    setAutotradeConfig(defaultAutotradeConfig());
    logAutotradeEvent({
      stage: 'config',
      action: 'equity_read_suspect',
      detail: { anchorEquityUsd: 5129, readEquityUsd: 3523, dropPct: 31.3 },
    });
    const finding = collectConfigurationFindings(getAutotradeConfig(), Date.now()).find(
      (f) => f.id === 'configuration:equity_read_suspect',
    );
    expect(finding?.count).toBe(1);
  });

  it('says nothing at all about a config that is entirely anchor-owned', () => {
    // The concentration caps have to clear concentrationCapFloorPct (75 at this
    // sizing) or they are a finding of their own — the SHIPPED defaults, 20 and
    // 6, do not. That is a real thing about the defaults, recorded in its own
    // case above; here it would just be noise in a test about frozen caps.
    const cfg = {
      ...defaultAutotradeConfig(),
      riskPerTradePct: 1.25,
      maxStopDistancePct: 2.5,
      maxSectorExposurePct: 100,
      maxCorrelatedExposurePct: 100,
    };
    setAutotradeConfig({ ...cfg, ...deriveDollarCaps(cfg, 10_000), liveCapsAnchorEquityUsd: 10_000 });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now())).toEqual([]);
  });
});

describe('the execution findings — any occurrence is one', () => {
  it('counts the classes that mean something went wrong, and only those', () => {
    const now = Date.parse('2026-09-11T21:00:00Z');
    const at = etDateTimeToMs('2026-09-10', '14:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_position_unprotected','{}',NULL,?),
       (NULL,'execution','live_options_order_placed','{}',NULL,?)`,
    ).run(at, at + 1, at + 2, at + 3);

    const found = collectExecutionFindings(now);
    const byAction = new Map(found.map((f) => [f.action, f.count]));
    expect(byAction.get('live_options_exit_failed')).toBe(2);
    expect(byAction.get('live_position_unprotected')).toBe(1);
    // A successful placement is not a finding.
    expect(byAction.has('live_options_order_placed')).toBe(false);
  });

  it('splits a re-price deferral by its reason — the two are not equally bad', () => {
    // `mid_fill` is the chase correctly standing aside while a partial fill is
    // in flight. `daily_cap` is the chase having given up with the order still
    // resting, which is the HOOD failure mode recurring. Under one label a
    // benign partial fill cries wolf and the real one hides behind it.
    const now = etDateTimeToMs('2026-09-10', '17:00') as number;
    const at = etDateTimeToMs('2026-09-09', '10:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       (NULL,'execution','live_options_exit_reprice_deferred','{"reason":"mid_fill"}',NULL,?),
       (NULL,'execution','live_options_exit_reprice_deferred','{"reason":"mid_fill"}',NULL,?),
       (NULL,'execution','live_options_exit_reprice_deferred','{"reason":"daily_cap"}',NULL,?)`,
    ).run(at, at + 1, at + 2);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f]));
    expect(byAction.get('live_options_exit_reprice_deferred|mid_fill')?.count).toBe(2);
    expect(byAction.get('live_options_exit_reprice_deferred|daily_cap')?.count).toBe(1);
    expect(byAction.get('live_options_exit_reprice_deferred|daily_cap')?.detail).toMatch(/still resting/);
    // Nothing is left under the unsplit action, so a reader cannot double-count.
    expect(byAction.has('live_options_exit_reprice_deferred')).toBe(false);
  });

  it('splits an unprotected position by the state the sweep wrote it in', () => {
    // A kill-switch row is the operator trading the position by hand, which the
    // sweep reports on purpose. Under one label it reads as a stop that failed.
    // A row from before the state field existed keeps the plain label.
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '10:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('AAPL','execution','live_position_unprotected','{"positionId":1,"state":"kill_switch"}',NULL,?),
       ('MSFT','execution','live_position_unprotected','{"positionId":2,"state":"kill_switch"}',NULL,?),
       ('AAPL','execution','live_position_unprotected','{"positionId":1,"state":"naked"}',NULL,?),
       ('NVDA','execution','live_position_unprotected','{"positionId":3,"heldByKillSwitch":true}',NULL,?)`,
    ).run(at, at + 1, at + 2, at + 3);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f]));
    expect(byAction.get('live_position_unprotected|kill_switch')?.count).toBe(2);
    expect(byAction.get('live_position_unprotected|kill_switch')?.detail).toMatch(/expected when trading by hand/);
    expect(byAction.get('live_position_unprotected|naked')?.count).toBe(1);
    expect(byAction.get('live_position_unprotected|naked')?.detail).toMatch(/confirmed held with no resting stop/);
    expect(byAction.get('live_position_unprotected')?.count).toBe(1);
  });

  it('labels every state the protection sweep can write', () => {
    // The sweep's vocabulary and the scan's labels are one list: a state the
    // sweep writes that the scan has no label for would count under the plain
    // label and read as a naked position.
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '10:00') as number;
    const insert = db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at)
       VALUES ('AAPL','execution','live_position_unprotected',?,NULL,?)`,
    );
    UNPROTECTED_REPORT_STATES.forEach((state, i) => insert.run(JSON.stringify({ positionId: 1, state }), at + i));

    const actions = collectExecutionFindings(now).map((f) => f.action);
    for (const state of UNPROTECTED_REPORT_STATES) expect(actions).toContain(`live_position_unprotected|${state}`);
    expect(actions).not.toContain('live_position_unprotected');
  });

  it('stops counting a skipped exit correction once a later pass corrected that exit', () => {
    // HOOD and MRNA, 2026-09-23: skipped at 01:42 because a paging overlap
    // showed each filled leg twice, then corrected by the fix. A skip the next
    // pass overcame is history, not an open "stays an estimate" finding.
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '01:42') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('HOOD','execution','live_exit_correction_skipped','{"exitId":661,"cause":"ambiguous_legs"}',NULL,?),
       ('MRNA','execution','live_exit_correction_skipped','{"exitId":689,"cause":"ambiguous_legs"}',NULL,?),
       ('HOOD','execution','live_exit_corrected','{"exitId":661,"source":"bracket_leg"}',NULL,?)`,
    ).run(at, at + 1, at + 60_000);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f.count]));
    // HOOD's skip is superseded by its correction; MRNA's still stands.
    expect(byAction.get('live_exit_correction_skipped')).toBe(1);
    expect(byAction.get('live_exit_corrected|bracket_leg')).toBe(1);
  });

  it('does not count a correction that is only waiting for the lists', () => {
    // GRML, 2026-09-23: `not_listed_yet` means the order lists had not caught
    // up yet, and the next pass decides. A pass that confirms the estimate to
    // the cent writes no correction row, so a counted wait stayed open for ten
    // sessions; and an exit that ended in another cause was counted twice.
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '09:52') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('GRML','execution','live_exit_correction_skipped','{"exitId":702,"cause":"not_listed_yet"}',NULL,?),
       ('DELL','execution','live_exit_correction_skipped','{"exitId":709,"cause":"not_listed_yet"}',NULL,?),
       ('DELL','execution','live_exit_correction_skipped','{"exitId":709,"cause":"aged_out"}',NULL,?)`,
    ).run(at, at + 1, at + 60_000);

    const actions = collectExecutionFindings(now).map((f) => [f.action, f.count]);
    // Only DELL's final answer counts, once.
    expect(actions.filter(([a]) => String(a).startsWith('live_exit_correction_skipped'))).toEqual([
      ['live_exit_correction_skipped', 1],
    ]);
  });

  it('keeps a skip that came AFTER a correction of the same exit', () => {
    // Order matters: a later skip is news, whatever happened before it.
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '01:42') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('HOOD','execution','live_exit_corrected','{"exitId":661,"source":"bracket_leg"}',NULL,?),
       ('HOOD','execution','live_exit_correction_skipped','{"exitId":661,"cause":"combo_working"}',NULL,?)`,
    ).run(at, at + 60_000);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f.count]));
    expect(byAction.get('live_exit_correction_skipped|combo_working')).toBe(1);
  });

  it('keeps an occurrence whose reason is missing rather than dropping it', () => {
    // An occurrence we cannot classify is still an occurrence; losing it
    // silently is the worse failure.
    const now = etDateTimeToMs('2026-09-10', '17:00') as number;
    const at = etDateTimeToMs('2026-09-09', '10:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       (NULL,'execution','live_options_exit_reprice_deferred','{}',NULL,?),
       (NULL,'execution','live_options_exit_reprice_deferred','not json',NULL,?)`,
    ).run(at, at + 1);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f.count]));
    expect(byAction.get('live_options_exit_reprice_deferred')).toBe(2);
  });

  // WHO ACTS ON IT (2026-09-23). The advisor's headline that evening counted
  // "5 execution defect(s)", and one of the five was the operator's own three
  // hand sales in Webull, re-booked at their fills. A class keeps its finding
  // either way; its nature says whether it is the app's to fix.
  it('marks each class and variant with its nature, defect by default', () => {
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '10:00') as number;
    writeDailyHaltMarker({ pool: 'paper', date: '2026-09-23', dailyPnl: -900, haltLevel: -750 });
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('DELL','execution','live_exit_corrected','{"exitId":1,"source":"broker_history"}',NULL,?),
       ('COIN','execution','live_exit_corrected','{"exitId":2,"source":"bracket_leg"}',NULL,?),
       ('HOOD','execution','live_options_exit_corrected','{"source":"broker_history"}',NULL,?),
       ('AAA','execution','live_position_unprotected','{"state":"kill_switch"}',NULL,?),
       ('BBB','execution','live_position_unprotected','{"state":"naked"}',NULL,?),
       ('CCC','execution','live_options_exit_reprice_deferred','{"reason":"mid_fill"}',NULL,?),
       ('DDD','execution','live_options_exit_reprice_deferred','{"reason":"daily_cap"}',NULL,?),
       (NULL,'execution','daily_give_back_halted','{}',NULL,?),
       ('EEE','execution','live_options_exit_failed','{}',NULL,?),
       ('FFF','execution','live_options_exit_reprice_deferred','{}',NULL,?)`,
    ).run(at, at + 1, at + 2, at + 3, at + 4, at + 5, at + 6, at + 7, at + 8, at + 9);

    const nature = new Map(collectExecutionFindings(now).map((f) => [f.action, f.nature]));
    expect(Object.fromEntries(nature)).toEqual({
      'live_exit_corrected|broker_history': 'operator',
      'live_exit_corrected|bracket_leg': 'defect',
      'live_options_exit_corrected|broker_history': 'operator',
      'live_position_unprotected|kill_switch': 'operator',
      'live_position_unprotected|naked': 'defect',
      'live_options_exit_reprice_deferred|mid_fill': 'control',
      'live_options_exit_reprice_deferred|daily_cap': 'defect',
      // A variant the row does not name falls back to the ACTION's nature.
      live_options_exit_reprice_deferred: 'defect',
      'daily_halt_alerted|paper': 'control',
      daily_give_back_halted: 'control',
      live_options_exit_failed: 'defect',
    });
  });

  it('carries the nature to the scan finding and its lever, where the advice reads it', () => {
    const now = etDateTimeToMs('2026-09-23', '17:00') as number;
    const at = etDateTimeToMs('2026-09-23', '10:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('DELL','execution','live_exit_corrected','{"exitId":1,"source":"broker_history"}',NULL,?),
       ('COIN','execution','live_exit_corrected','{"exitId":2,"source":"bracket_leg"}',NULL,?)`,
    ).run(at, at + 1);

    const byId = new Map(runEdgeLeakScanFromDb({ now }).findings.map((f) => [f.id, f]));
    const own = byId.get('execution:live_exit_corrected|broker_history');
    expect(own?.nature).toBe('operator');
    expect(own?.lever?.detail).toMatch(/^Your own action, recorded as it happened\. Nothing to fix/);
    const race = byId.get('execution:live_exit_corrected|bracket_leg');
    expect(race?.nature).toBe('defect');
    expect(race?.lever?.detail).toBe('An execution failure is a defect to fix, not a setting to change.');
  });

  // THREE ENTRIES NAMED NOTHING THE APP WRITES (2026-09-23). The catalog read
  // `live_order_unknown_outcome` (the writers say `…_order_outcome_unknown`),
  // `daily_drawdown_halt` (a guardrail rule's name, never journaled) and
  // `give_back_halt` (the writer says `daily_give_back_halted`). So an unknown
  // order outcome or a halt could never be a finding. The halt is written here
  // by the alert's own writer. The other two names are checked against their
  // writers statically, in journalActionsReachability.test.ts.
  it('counts halts and unknown outcomes under the names the app actually writes', () => {
    writeDailyHaltMarker({ pool: 'live', date: '2026-09-09', dailyPnl: -800, haltLevel: -750 });
    writeDailyHaltMarker({ pool: 'paper', date: '2026-09-09', dailyPnl: -900, haltLevel: -750 });
    const at = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       ('AAA','execution','live_order_outcome_unknown','{}',NULL,?),
       ('BBB','execution','live_options_order_outcome_unknown','{}',NULL,?),
       (NULL,'execution','daily_give_back_halted','{}',NULL,?)`,
    ).run(at, at + 1, at + 2);

    const byAction = new Map(collectExecutionFindings(Date.now()).map((f) => [f.action, f]));
    // Split by book: the paper halt is the control arm's bad day, not the live book's.
    expect(byAction.get('daily_halt_alerted|live')?.detail).toMatch(/^The LIVE daily drawdown halt tripped/);
    expect(byAction.get('daily_halt_alerted|paper')?.detail).toMatch(/^The PAPER daily drawdown halt tripped/);
    expect(byAction.has('daily_halt_alerted')).toBe(false);
    expect(byAction.get('live_order_outcome_unknown')?.count).toBe(1);
    expect(byAction.get('live_options_order_outcome_unknown')?.count).toBe(1);
    expect(byAction.get('daily_give_back_halted')?.count).toBe(1);
  });

  it('dates each execution class, in SESSIONS rather than days', () => {
    // 2026-09-07 is Labor Day. Counting calendar days from 09-11 to 09-14
    // gives 3; counting sessions gives 1, and it is sessions the window is
    // measured in. A class last seen on the previous session is a very
    // different thing from one last seen three sessions ago.
    const now = etDateTimeToMs('2026-09-14', '17:00') as number;
    const at = etDateTimeToMs('2026-09-11', '10:00') as number;
    const older = etDateTimeToMs('2026-09-04', '10:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_scale_out_blocked','{}',NULL,?)`,
    ).run(older, at, older);

    const byAction = new Map(collectExecutionFindings(now).map((f) => [f.action, f]));
    const exits = byAction.get('live_options_exit_failed');
    expect(exits?.count).toBe(2);
    // The LATEST occurrence dates the class, not the first.
    expect(exits?.lastSeenEtDate).toBe('2026-09-11');
    expect(exits?.sessionsSinceLastSeen).toBe(1);
    // The recency CLAUSE is appended one layer up, where an occurrence becomes
    // a finding — so assert it there rather than here.
    expect(recencySuffix(exits?.sessionsSinceLastSeen ?? null, exits?.lastSeenEtDate ?? null)).toBe(
      ' — none since 2026-09-11, 1 session ago',
    );

    const scaleOuts = byAction.get('live_scale_out_blocked');
    expect(scaleOuts?.lastSeenEtDate).toBe('2026-09-04');
    // 09-14 back: 09-11, 09-10, 09-09, 09-08, 09-04 — four sessions, not ten days.
    expect(scaleOuts?.sessionsSinceLastSeen).toBe(5);
  });

  it('says so when a class occurred in the latest session', () => {
    const now = etDateTimeToMs('2026-09-11', '17:00') as number;
    const at = etDateTimeToMs('2026-09-11', '10:00') as number;
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'execution','live_options_exit_failed','{}',NULL,?)",
    ).run(at);
    const f = collectExecutionFindings(now).find((x) => x.action === 'live_options_exit_failed');
    expect(f?.sessionsSinceLastSeen).toBe(0);
    expect(recencySuffix(f?.sessionsSinceLastSeen ?? null, f?.lastSeenEtDate ?? null)).toBe(
      ' — including the latest session (2026-09-11)',
    );
  });

  it('classifies against the WHOLE skip window, not the newest ROW_CAP of it', () => {
    // The bug, in miniature (2026-09-12). The production window held 1,928
    // skip rows against a 1,000-row read, so the OLDEST skips were invisible
    // and every paper entry they explained was reported as "nothing the
    // journal explains". Here: one real skip for the paper entry, buried under
    // more than ROW_CAP newer skips for other names. Under the capped read the
    // real one is pushed out and the entry classifies as no_live_row.
    const entryAt = etDateTimeToMs('2026-09-10', '10:00') as number;
    const p = openPaperPosition({
      symbol: 'ZZZ',
      side: 'buy',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(entryAt, p.id);
    closePaperPosition(p.id, { exitPrice: 110, exitReason: 'target' });

    const ins = db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'execution',?,'{}',NULL,?)",
    );
    ins.run('ZZZ', 'live_score_floor_skipped', entryAt);
    // …then bury it under more than a capped read can return.
    for (let i = 0; i < ROW_CAP + 50; i++) {
      ins.run('QQQ', 'symbol_reentry_cooldown_skipped', entryAt + 1000 + i);
    }

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const byReason = new Map(scan.attribution.untaken.map((u) => [u.reason, u.n]));
    expect(byReason.get('live_score_floor_skipped') ?? 0).toBeGreaterThan(0);
    expect(byReason.get('no_live_row') ?? 0).toBe(0);
    // And the window read in full, so the classification can be trusted.
    expect(scan.coverage.journalSkipsTruncated).toBe(false);
  });

  // 2026-09-23. Two defects put decisions the journal DOES explain into
  // `no_live_row`, and both are asserted here on the report the route returns.
  describe('what the live journal already says, read by the attribution', () => {
    const paperAt = (symbol: string, at: number, exitPrice: number) => {
      const p = openPaperPosition({
        symbol,
        side: 'buy',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        targetPrice: 110,
        riskAmount: 50,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
      });
      db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(at, p.id);
      closePaperPosition(p.id, { exitPrice, exitReason: exitPrice > 100 ? 'target' : 'stop' });
    };
    const journal = (symbol: string, action: string, at: number) =>
      db
        .prepare(
          "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,'execution',?,'{}',NULL,?)",
        )
        .run(symbol, action, at);
    const untaken = () =>
      new Map(
        runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') }).attribution.untaken.map((u) => [
          u.reason,
          u,
        ]),
      );

    it('files a broker refusal and a level veto under their own names', () => {
      // CRML, 09-21 09:36: the live book tried and Webull answered "Buying
      // power is insufficient". TWST, 09-17 12:32: the level veto, live-only.
      const crml = etDateTimeToMs('2026-09-10', '09:36') as number;
      const twst = etDateTimeToMs('2026-09-10', '12:32') as number;
      paperAt('CRML', crml + 53_000, 110);
      journal('CRML', 'live_entry_failed', crml + 59_000);
      paperAt('TWST', twst + 42_000, 95);
      journal('TWST', 'level_veto', twst + 42_000);

      const byReason = untaken();
      expect(byReason.get('live_entry_failed')?.n).toBe(1);
      expect(byReason.get('level_veto')?.n).toBe(1);
      expect(byReason.has('no_live_row')).toBe(false);
    });

    // The market-direction gate (2026-09-23) journals once per symbol per day,
    // so a paper entry later the same day is explained by the standing row —
    // and its paper R is what the gate's refusals would have earned.
    it('files a paper entry the market-direction gate refused under the gate', () => {
      const skipAt = etDateTimeToMs('2026-09-10', '09:52') as number;
      journal('GRML', 'live_market_direction_skipped', skipAt);
      paperAt('GRML', skipAt + 23 * 60_000, 95);

      const byReason = untaken();
      expect(byReason.get('live_market_direction_skipped')).toMatchObject({ n: 1 });
      expect(byReason.has('no_live_row')).toBe(false);
    });

    it('pairs the live entry with the paper entry made in the same tick, not a later re-entry', () => {
      // COIN, 09-21: live 09:36, paper 09:36:53 and again 10:02:07.
      seedClosedAutotradeSessions({
        sessions: { '2026-09-10': [{ entryTime: '09:36', exitTime: '09:41', r: -0.1, symbol: 'COIN' }] },
      });
      paperAt('COIN', (etDateTimeToMs('2026-09-10', '09:36') as number) + 53_000, 95);
      const reentry = (etDateTimeToMs('2026-09-10', '10:02') as number) + 7_000;
      paperAt('COIN', reentry, 95);
      journal('COIN', 'symbol_reentry_cooldown_skipped', reentry);

      const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
      expect(scan.attribution.pairedTrades).toBe(1);
      expect(scan.attribution.medianPairGapMinutes).toBeCloseTo(0.88, 2);
      const byReason = new Map(scan.attribution.untaken.map((u) => [u.reason, u]));
      expect(byReason.get('symbol_reentry_cooldown_skipped')?.trades).toEqual([
        expect.objectContaining({ symbol: 'COIN', entryTimeEt: '10:02' }),
      ]);
      expect(byReason.has('no_live_row')).toBe(false);
    });

    // 2026-09-23, on the report the route returns. COIN 09-18: the paper stock
    // entry was set against the live OPTION rather than the live stock trade,
    // and paper options were filed under whatever stock refusal hit the name.
    it('pairs no option with a stock trade, and files no option under a stock refusal', () => {
      const paperOption = (symbol: string, at: number) => {
        const o = openOptionsPaperPosition({
          symbol,
          side: 'call',
          contractSymbol: `${symbol}260918C00100000`,
          strike: 100,
          expiration: '2026-09-18',
          quantity: 1,
          entryPrice: 2,
          riskAmount: 140,
          riskProfile: 'MODERATE',
          rationale: 'fixture',
        });
        db.prepare('UPDATE autotrade_options_paper_positions SET entry_at = ? WHERE id = ?').run(at, o.id);
        closeOptionsPaperPosition(o.id, { exitPrice: 2.6, exitReason: 'take_profit' });
      };
      const at = (time: string) => etDateTimeToMs('2026-09-10', time) as number;
      seedClosedAutotradeSessions({
        sessions: { '2026-09-10': [{ entryTime: '09:56', exitTime: '10:24', r: 0.6, symbol: 'COIN' }] },
      });
      paperAt('COIN', at('11:18'), 105);
      // Thirty seconds from the live stock entry: the nearest paper entry, and an option.
      paperOption('COIN', at('09:56') + 30_000);
      paperOption('SMCI', at('10:00'));
      journal('SMCI', 'live_score_floor_skipped', at('10:00'));

      const { attribution } = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
      expect(attribution.pairedTrades).toBe(1);
      expect(attribution.pairs).toEqual([
        expect.objectContaining({
          symbol: 'COIN',
          paperEntryTimeEt: '11:18',
          liveEntryTimeEt: '09:56',
          liveR: 0.6,
          sameTick: false,
        }),
      ]);
      expect(attribution.untaken).toEqual([]);
      expect(attribution.optionsExcluded).toEqual({ live: 0, paper: 2 });
    });
  });

  // 2026-09-23. The width a cut reads has to be the width the trade's R
  // divides by, or the cut and the R it averages disagree about the trade.
  it('reads the stop width from the stop each book measures R against', () => {
    seedClosedAutotradeSessions({
      sessions: { '2026-09-10': [{ entryTime: '10:00', exitTime: '10:30', r: 0.4, symbol: 'WID' }] },
    });
    // Paper opens 100 -> 95 and is ratcheted to breakeven before it stops out.
    // Read from the CURRENT stop its width would be zero and it would drop out
    // of the cut; read from the stop it opened with, it is $5.
    const p = openPaperPosition({
      symbol: 'PWID',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare('UPDATE autotrade_paper_positions SET entry_at = ?, stop_price = 100 WHERE id = ?').run(
      etDateTimeToMs('2026-09-10', '10:05') as number,
      p.id,
    );
    closePaperPosition(p.id, { exitPrice: 100, exitReason: 'stop' });

    const dim = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') }).dimensions.find(
      (x) => x.id === 'stopWidth',
    );
    // The live fixture risks 100 -> 95: $5 a share, the width initialRiskOf divides by.
    expect(dim?.buckets.map((b) => b.bucket)).toEqual(['$2+']);
    expect(dim?.uncovered).toBe(0);
    // …and paper's ratcheted trade is its control, at the width it opened with.
    expect(dim?.buckets[0].control?.n).toBe(1);
  });

  it('carries the recency all the way into the finding a route returns', () => {
    // The consumer, not the producer: the tune advisor ranks on these two
    // fields, so what matters is that they survive the trip from the journal
    // row through the scan and onto the wire.
    const at = etDateTimeToMs('2026-09-10', '10:00') as number;
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'execution','live_options_exit_failed','{}',NULL,?)",
    ).run(at);
    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const finding = scan.findings.find((f) => f.id === 'execution:live_options_exit_failed');
    expect(finding?.lastSeenEtDate).toBe('2026-09-10');
    expect(finding?.sessionsSinceLastSeen).toBe(1);
    expect(finding?.detail).toMatch(/none since 2026-09-10, 1 session ago/);
  });
});

// ---------------------------------------------------------------------------
// The re-entry cooldown finding, read from the PERSISTED record (2026-09-19).
// The scan never replays anything itself — it reads what the loop wrote after
// the close — so what matters here is that the row in the table reaches the
// scan's findings, and that no row reads as silence rather than as evidence.
// ---------------------------------------------------------------------------
describe('the re-entry cooldown finding, read from the persisted record', () => {
  const gapShadow = (minMinutesSinceExit: number, exitRs: number[]): DeclinedEntryShadow => ({
    trades: exitRs.map((exitR, i) => ({
      symbol: `S${i}`,
      at: Date.parse('2026-09-18T15:00:00Z') + i * 86_400_000,
      score: 90,
      entry: 100,
      stop: 98,
      side: 'long',
      floorAtSkip: 81,
      minutesSinceExit: minMinutesSinceExit + 1,
      entryFill: 100.02,
      exitR,
      reason: exitR > 0 ? 'target' : 'stop',
      bestR: Math.max(exitR, 0),
      barsHeld: 3,
    })),
    n: exitRs.length,
    avgR: exitRs.length ? exitRs.reduce((s, r) => s + r, 0) / exitRs.length : null,
    winRatePct: exitRs.length ? (exitRs.filter((r) => r > 0).length / exitRs.length) * 100 : null,
    byReason: {},
    excluded: {
      below_live_floor: 0,
      duplicate_same_day: 0,
      no_bars: 0,
      unusable_signal: 0,
      before_min_gap: 0,
      no_exit_gap: 0,
      refused_by_direction: 0,
    },
    minMinutesSinceExit,
    exitRules: liveExitRules(defaultAutotradeConfig()),
    replayVersion: 2,
    entryConcessionPct: 0.04,
    directionGateReplayed: true,
  });
  const same = (n: number, r: number) => Array.from({ length: n }, () => r);
  const record = (gaps: DeclinedEntryShadow[]): ReentryShadowReport => ({
    since: Date.parse('2026-09-14T04:00:00Z'),
    lookbackSessions: 40,
    journaledRows: 1293,
    journalTruncated: false,
    unscorableRows: 0,
    cooldownMinutes: 390,
    gaps,
  });
  const cleared = () =>
    record([
      gapShadow(0, same(20, 0.15)),
      gapShadow(60, same(20, -0.1)),
      gapShadow(120, same(20, 0.3)),
      gapShadow(180, same(9, 0.5)),
    ]);

  it('reads as silence, not evidence, before the first record exists', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 390 });
    expect(collectReentryCooldownFinding(getAutotradeConfig())).toEqual([]);
  });

  it('reaches the scan’s findings from the row the loop persisted, lever and all', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 390 });
    saveReentryShadowRecord('2026-09-18', cleared(), Date.parse('2026-09-18T20:30:00Z'));
    const [f] = collectReentryCooldownFinding(getAutotradeConfig());
    expect(f?.lever).toMatchObject({ field: 'symbolReentryCooldownMinutes', value: 120, direction: 'exposure' });
    expect(f?.lastSeenEtDate).toBe('2026-09-18');

    // The consumer: the scan a route or the routine runs carries it.
    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-18T21:00:00Z') });
    const found = scan.findings.find((x) => x.id === 'configuration:reentry_cooldown_shadow');
    expect(found?.lever?.value).toBe(120);
  });

  it('judges the record against the cooldown in force NOW, not the one it was computed under', () => {
    // The operator has since lowered the cooldown to 120: the 120-minute gap
    // would lower nothing, and only the first refusal still clears.
    setAutotradeConfig({ ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 120 });
    saveReentryShadowRecord('2026-09-18', cleared(), Date.parse('2026-09-18T20:30:00Z'));
    expect(collectReentryCooldownFinding(getAutotradeConfig())[0]?.lever?.value).toBe(0);
    setAutotradeConfig({ ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 0 });
    expect(collectReentryCooldownFinding(getAutotradeConfig())).toEqual([]);
  });
});

describe('storedTargetRFor — the goal on the R axis', () => {
  it('is the goal % over the risk %, and null without either', () => {
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 1.25 })).toBe(2.4);
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 2.5 })).toBe(1.2);
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: null })).toBeNull();
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 0 })).toBeNull();
  });
});

describe('the scan end to end, over the database', () => {
  it('reports the round-2 leak from real rows in both books, with its lever', () => {
    // Live: a winning first round and a losing second round on each session.
    const sessions = weekdaysEndingAt('2026-09-10', 10);
    const seeded: Record<string, { entryTime: string; exitTime: string; r: number; symbol: string }[]> = {};
    sessions.forEach((date, i) => {
      seeded[date] = [
        { entryTime: '09:35', exitTime: '10:00', r: 0.3 + (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '10:05', exitTime: '10:30', r: 0.28 - (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '11:00', exitTime: '11:30', r: -0.3 + (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '12:00', exitTime: '12:30', r: -0.32 - (i % 2) * 0.02, symbol: `S${i % 3}` },
      ];
    });
    seedClosedAutotradeSessions({ sessions: seeded });

    // Paper: the control arm, losing on its own second rounds too.
    sessions.forEach((date, i) => {
      const base = etDateTimeToMs(date, '09:35') as number;
      for (const [k, r] of [
        [0, 0.4],
        [1, 0.38],
        [2, -0.2],
        [3, -0.22],
      ] as const) {
        const p = openPaperPosition({
          symbol: `S${i % 3}`,
          side: 'buy',
          quantity: 10,
          entryPrice: 100,
          stopPrice: 95,
          targetPrice: 110,
          riskAmount: 50,
          riskProfile: 'MODERATE',
          rationale: 'fixture',
        });
        db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(base + k * 60_000 * 30, p.id);
        closePaperPosition(p.id, { exitPrice: 100 + 5 * r, exitReason: 'target' });
      }
    });

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const round2 = scan.leaks.find((l) => l.dimension === 'round' && l.bucket === '3+');
    const anyRoundLeak = scan.leaks.find((l) => l.dimension === 'round');
    expect(anyRoundLeak).toBeTruthy();
    expect(anyRoundLeak?.lever).toMatchObject({ field: 'symbolReentryCooldownMinutes', value: 390 });
    expect(round2 ?? anyRoundLeak).toBeTruthy();
    // Both books are counted, and nothing was dropped.
    expect(scan.coverage.liveTrades).toBe(40);
    expect(scan.coverage.paperTrades).toBe(40);
    expect(scan.coverage.liveDropped).toBe(0);
    // Ten weekdays, NINE sessions: 2026-09-07 is Labor Day, and the window is
    // built from the market calendar rather than from weekdays, so that day's
    // seeded trades are remapped onto the previous session (which is exactly
    // what buildSessionPaths is supposed to do with a non-session date).
    expect(scan.dayLevel.activeSessions).toBe(9);
    expect(scan.dayLevel.sessions).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// The attribution's entry slippage reads STOCK entries only (2026-09-24, on
// review). It is read against the stock's marketable 0.5% buffer, and an
// option's entry limit is a different one: a hand-placed call (the Trade page's
// reconcile links it by source_intent_id) filled at its ask reads about -4.8%
// against a limit at the ask x 1.05. Pooled, one of them turns 0.2% of the
// buffer paid into "none of it". None had on 2026-09-24 (0 of 142 entry rows).
// ---------------------------------------------------------------------------
describe('runEdgeLeakScanFromDb — entry slippage', () => {
  it('reads the stock entries against the stock buffer, not an option’s fill', () => {
    onTestFinished(() => {
      db.exec('DELETE FROM autotrade_live_orders; DELETE FROM order_intents;');
    });
    // The loop's stock buy, limited at 100.5 and filled at 100.2 (-0.30%
    // against its limit: 0.2% of the 0.5% buffer paid), adopted and linked
    // from its entry order.
    const stockIntent = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 100.5,
      },
      'AAPL-stock',
    );
    const stock = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 1,
      entryPrice: 100.2,
      entryDate: SESSIONS[0],
      entryTime: '10:00',
      tags: ['live', 'autotrade'],
    });
    recordLiveOrder({
      intentId: stockIntent.id,
      symbol: 'AAPL',
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 5,
      riskProfile: 'MODERATE',
    });
    setLiveOrderPositionId(stockIntent.id, stock.id);
    // A hand-placed call limited at 1.05 and filled at 1.00.
    const optionIntent = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'option',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 1.05,
      },
      'AAPL-option',
    );
    createPosition({
      assetType: 'option',
      symbol: 'AAPL',
      side: 'long',
      quantity: 1,
      entryPrice: 1.0,
      entryDate: SESSIONS[0],
      entryTime: '10:00',
      optionType: 'call',
      strike: 100,
      expiration: SESSIONS[2],
      multiplier: 100,
      tags: ['live'],
      sourceIntentId: optionIntent.id,
    });

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    expect(scan.attribution.meanEntrySlippagePct).toBeCloseTo(-0.3, 2);
    expect(scan.attribution.meanEntryBufferConsumedPct).toBeCloseTo(0.2, 2);
  });
});
