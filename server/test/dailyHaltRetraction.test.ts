import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { initDb, db } from '../src/db';
import { createPosition, addExit, updatePosition } from '../src/db/positions';
import {
  createLiveOptionsPosition,
  closeLiveOptionsPosition,
  listLiveOptionsPositions,
} from '../src/db/autotradeLiveOptionsPositions';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listDailyResults } from '../src/db/dailyResults';
import { etDateTimeToMs } from '../src/util/marketDate';
import {
  liveDrawdownHaltedOn,
  liveDrawdownHaltRetracted,
  writeDailyHaltMarker,
} from '../src/services/autotrading/dailyHaltMarker';
import { retractDailyHalt } from '../src/services/autotrading/dailyHaltRetraction';
import { dayReachedLine, liveDayCloses, LiveDayClose } from '../src/services/autotrading/liveDayCloses';
import { recordDailyResult, strategyDayFor } from '../src/services/autotrading/dailyResults';
import { buildSizingReview } from '../src/services/autotrading/gatedSwitchesData';
import { collectExecutionFindings } from '../src/services/autotrading/edgeLeakScanData';

// ---------------------------------------------------------------------------
// A halt that tripped on a booking error stops counting — and only that one.
//
// 2026-09-23: the live halt fired at 10:23 on −$2,046 against a −$1,942 line.
// −$384 of it was the options sleeve's MRNA call booked into the stock book (a
// linking bug, fixed in #658). With the ledger corrected the day's running
// total never reached the line, so the day was never a halt. But the daily
// results row, and so the sizing review's "two halts in any five sessions →
// revert", would have kept counting it.
//
// A retraction must never erase a halt the loop's own trades earned. The first
// version judged the day only at the marker's moment, and a review showed three
// ways a real halt got through: a later crossing (the alert marks once a day),
// a loss re-entered after the close (it reads as booked after the marker), and
// an options loss older than the book's newest 200 closes (the list's default
// cap). Each has a case below that fails on that version.
// ---------------------------------------------------------------------------

const DATE = '2026-09-22'; // a closed session, so "after the close" holds
const at = (hhmm: string): number => etDateTimeToMs(DATE, hhmm)!;

let base = '';
beforeAll(async () => {
  initDb();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_events; DELETE FROM position_exits; DELETE FROM positions; ' +
      'DELETE FROM autotrade_live_options_positions; DELETE FROM autotrade_daily_results;',
  );
});

/** A closed live stock trade worth `pnl`, its closing exit BOOKED at `bookedAt`. */
function closedStock(pnl: number, bookedAt: number, tags = ['webull', 'live', 'autotrade']) {
  const p = createPosition({
    assetType: 'stock',
    symbol: 'AAA',
    side: 'long',
    quantity: 100,
    entryPrice: 100,
    entryDate: DATE,
    tags,
  });
  addExit(p.id, { quantity: 100, exitPrice: 100 + pnl / 100, exitDate: DATE });
  db.prepare('UPDATE position_exits SET created_at = ? WHERE position_id = ?').run(bookedAt, p.id);
  return p;
}

/** Reprice a stock trade's exit so it is worth `pnl`, keeping its booking time
 *  (what the exit correction does to an estimate). */
function repriceStock(positionId: number, pnl: number) {
  db.prepare('UPDATE position_exits SET exit_price = ? WHERE position_id = ?').run(100 + pnl / 100, positionId);
}

/** A closed live options trade worth `pnl`, closed at `exitAt`. */
function closedOption(pnl: number, exitAt: number) {
  const p = createLiveOptionsPosition({
    symbol: 'BBB',
    side: 'call',
    contractSymbol: 'BBB-fixture',
    strike: 100,
    expiration: '2026-09-25',
    quantity: 1,
    entryPrice: 5,
    riskAmount: 500,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
  });
  closeLiveOptionsPosition(p.id, { exitPrice: 5 + pnl / 100, exitReason: 'stop_loss', exitAt });
  return p;
}

/** The live halt marker, written at `when`. */
function halt(dailyPnl: number, haltLevel: number, when: number) {
  writeDailyHaltMarker({ pool: 'live', date: DATE, dailyPnl, haltLevel });
  db.prepare("UPDATE autotrade_events SET created_at = ? WHERE action = 'daily_halt_alerted'").run(when);
}

const reviewHalts = () => buildSizingReview(listDailyResults(DATE, DATE), '2026-09-01').haltsMaxIn5;

describe('dayReachedLine', () => {
  const close = (pnl: number, bookedAt: number | null, book: 'stock' | 'options' = 'stock'): LiveDayClose => ({
    book,
    id: Math.round(Math.random() * 1e9),
    pnl,
    bookedAt,
  });
  const closeAt = at('16:00');

  it('judges the lowest running total, not the total and not one moment', () => {
    // Down 1,200 at 11:30, back to -600 by the close: the halt was earned at 11:30.
    const r = dayReachedLine(
      [close(-700, at('10:00')), close(600, at('14:00')), close(-500, at('11:30'))],
      -1000,
      closeAt,
    );
    expect(r).toMatchObject({ total: -600, lowest: -1200, reached: true, untimed: 0 });
  });

  it('is not reached when the gains came between the losses', () => {
    const r = dayReachedLine(
      [close(-700, at('10:00')), close(600, at('10:30')), close(-500, at('11:30'))],
      -1000,
      closeAt,
    );
    expect(r).toMatchObject({ lowest: -700, reached: false });
  });

  it('puts a loss with no in-session booking time before everything, and a gain after', () => {
    const closes = [
      close(800, at('10:00')),
      close(-600, at('11:00')),
      close(-500, at('16:30')), // re-entered after the close
      close(700, null), // no time at all
    ];
    expect(dayReachedLine(closes, -1000, closeAt)).toMatchObject({ lowest: -500, reached: false, untimed: 2 });
    expect(dayReachedLine(closes, -500, closeAt)).toMatchObject({ reached: true });
    // A gain with no time cannot rescue a day that went through the line.
    expect(dayReachedLine([close(-1100, at('10:00')), close(500, null)], -1000, closeAt)).toMatchObject({
      lowest: -1100,
      reached: true,
    });
  });

  it('takes the loss first when two closes share a moment, and splits the books', () => {
    const r = dayReachedLine([close(900, at('10:00'), 'options'), close(-1000, at('10:00'))], -1000, closeAt);
    expect(r).toMatchObject({ lowest: -1000, reached: true, stockPnl: -1000, optionsPnl: 900, total: -100 });
  });
});

describe('liveDayCloses', () => {
  it('lists both books, the autotrade book only, at the closing exit’s booking time', () => {
    closedStock(-500, at('10:00'));
    closedStock(-384, at('09:45'), ['webull']); // an untagged row is not the loop's
    closedOption(-200, at('10:10'));

    const closes = liveDayCloses(DATE);
    expect(closes.map((c) => [c.book, c.pnl, c.bookedAt])).toEqual(
      expect.arrayContaining([
        ['stock', -500, at('10:00')],
        ['options', -200, at('10:10')],
      ]),
    );
    expect(closes).toHaveLength(2);
    expect(strategyDayFor(DATE)).toEqual({ pnlUsd: -700, trades: 2 });
  });

  it('reads an options close older than the book’s newest 200 (a page of the list)', () => {
    closedOption(-600, at('10:10'));
    const later = etDateTimeToMs('2026-09-23', '10:00')!;
    for (let i = 0; i < 205; i++) closedOption(10, later + i * 1000);
    // A 200-row page does not reach it (the list's default until the history
    // readers were given every row, 2026-09-23)…
    expect(listLiveOptionsPositions({ status: 'closed', limit: 200 }).some((p) => p.exitAt === at('10:10'))).toBe(
      false,
    );
    // …and the day's two consumers still do.
    expect(liveDayCloses(DATE).map((c) => c.pnl)).toEqual([-600]);
    expect(strategyDayFor(DATE).pnlUsd).toBe(-600);
  });
});

describe('retractDailyHalt', () => {
  it('refuses without a halt to retract', () => {
    const r = retractDailyHalt({ date: DATE, reason: 'nothing to see here' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses while the session is still open', () => {
    halt(-1100, -1000, at('10:23'));
    const r = retractDailyHalt({ date: DATE, reason: 'too early to judge', now: at('11:00') });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(liveDrawdownHaltedOn(DATE)).toBe(true);
  });

  it('refuses a halt the corrected ledger still earns — and it keeps counting', () => {
    closedStock(-1200, at('10:00'));
    halt(-1200, -1000, at('10:23'));
    recordDailyResult(DATE);

    const r = retractDailyHalt({ date: DATE, reason: 'trying to erase a real one' });

    expect(r).toMatchObject({ ok: false, status: 409, reading: { lowest: -1200, reached: true } });
    expect(listAutotradeEvents({ actions: ['daily_halt_retracted'] })).toHaveLength(0);
    expect(reviewHalts()).toBe(1);
  });

  it('refuses when the day crossed the line again later, on its own losses', () => {
    closedStock(-700, at('10:00'));
    const phantom = closedStock(-400, at('09:45'));
    halt(-1100, -1000, at('10:23'));
    closedStock(-500, at('11:30')); // a real stop, after the only marker the day gets
    updatePosition(phantom.id, { tags: ['webull'] });

    const r = retractDailyHalt({ date: DATE, reason: 'the phantom was untagged' });

    expect(r).toMatchObject({ ok: false, status: 409, reading: { lowest: -1200, reached: true } });
    expect(liveDrawdownHaltedOn(DATE)).toBe(true);
  });

  it('refuses when a real loss was re-entered after the close', () => {
    const real = closedStock(-1100, at('10:00'));
    halt(-1100, -1000, at('10:23'));
    // Deleting and re-posting an exit books it NOW, after the session.
    db.prepare('UPDATE position_exits SET created_at = ? WHERE position_id = ?').run(at('17:00'), real.id);

    const r = retractDailyHalt({ date: DATE, reason: 'exit re-entered by hand' });

    expect(r).toMatchObject({ ok: false, status: 409, reading: { lowest: -1100, untimed: 1 } });
  });

  it('counts an options loss older than the book’s newest 200 closes', () => {
    closedStock(-800, at('10:00'));
    closedOption(-600, at('10:05'));
    halt(-1400, -1000, at('10:23'));
    const later = etDateTimeToMs('2026-09-23', '10:00')!;
    for (let i = 0; i < 205; i++) closedOption(10, later + i * 1000);

    const r = retractDailyHalt({ date: DATE, reason: 'no phantom here at all' });

    expect(r).toMatchObject({ ok: false, status: 409, reading: { lowest: -1400, optionsPnl: -600 } });
  });

  it('withdraws the MRNA-shaped halt: the phantom leaves the book and the review stops counting the day', () => {
    closedStock(-700, at('10:00')); // the loop's real losses
    const phantom = closedStock(-400, at('09:45')); // an options row booked into the stock book
    halt(-1100, -1000, at('10:23'));
    recordDailyResult(DATE);
    expect(listDailyResults(DATE, DATE)[0].drawdownHalted).toBe(true);
    expect(reviewHalts()).toBe(1);

    // The correction: the phantom was never the stock book's, and the real
    // shares' take-profit is entered by hand after the close.
    updatePosition(phantom.id, { tags: ['webull'] });
    closedStock(546, at('16:40'));
    const r = retractDailyHalt({ date: DATE, reason: 'MRNA call row was linked to the stock order' });

    expect(r).toMatchObject({
      ok: true,
      alreadyRetracted: false,
      markerPnl: -1100,
      haltLevel: -1000,
      reading: { lowest: -700, total: -154, reached: false, untimed: 1 },
    });
    // The consumers: the day's row and the sizing review.
    expect(listDailyResults(DATE, DATE)[0].drawdownHalted).toBe(false);
    expect(reviewHalts()).toBe(0);
    expect(liveDrawdownHaltedOn(DATE)).toBe(false);
    expect(liveDrawdownHaltRetracted(DATE)).toBe(true);
    // The marker is history and stays; the retraction is its own row.
    expect(listAutotradeEvents({ actions: ['daily_halt_alerted'] })).toHaveLength(1);
    const rows = listAutotradeEvents({ actions: ['daily_halt_retracted'] });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail ?? '{}')).toMatchObject({
      pool: 'live',
      date: DATE,
      markerPnl: -1100,
      haltLevel: -1000,
      lowestPnl: -700,
      totalPnl: -154,
      untimedCloses: 1,
      reason: 'MRNA call row was linked to the stock order',
    });
  });

  it('lapses when a later correction puts the day back through the line', () => {
    const real = closedStock(-700, at('10:00'));
    const phantom = closedStock(-400, at('09:45'));
    halt(-1100, -1000, at('10:23'));
    recordDailyResult(DATE);
    updatePosition(phantom.id, { tags: ['webull'] });
    expect(retractDailyHalt({ date: DATE, reason: 'the phantom was untagged' })).toMatchObject({ ok: true });
    expect(reviewHalts()).toBe(0);

    // The exit correction reprices the real stop to its fill: a worse one.
    repriceStock(real.id, -1050);
    recordDailyResult(DATE);

    expect(liveDrawdownHaltRetracted(DATE)).toBe(false);
    expect(liveDrawdownHaltedOn(DATE)).toBe(true);
    expect(listDailyResults(DATE, DATE)[0].drawdownHalted).toBe(true);
    expect(reviewHalts()).toBe(1);
    expect(retractDailyHalt({ date: DATE, reason: 'asking again after the reprice' })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it('is idempotent, and a later re-record cannot bring the halt back', () => {
    const phantom = closedStock(-1100, at('09:45'));
    halt(-1100, -1000, at('10:23'));
    recordDailyResult(DATE);
    updatePosition(phantom.id, { tags: ['webull'] });

    expect(retractDailyHalt({ date: DATE, reason: 'booking error, first call' })).toMatchObject({ ok: true });
    expect(retractDailyHalt({ date: DATE, reason: 'booking error, second call' })).toMatchObject({
      ok: true,
      alreadyRetracted: true,
    });
    expect(listAutotradeEvents({ actions: ['daily_halt_retracted'] })).toHaveLength(1);

    recordDailyResult(DATE);
    expect(listDailyResults(DATE, DATE)[0].drawdownHalted).toBe(false);
  });
});

describe('the nightly scan', () => {
  it('drops a retracted live halt while it holds, reports the retraction, and leaves the paper halt alone', () => {
    // Markers written NOW, not backdated: the scan counts a ten-session window
    // back from the real clock, and a backdated row would fall out of it on a
    // later run and let this pass for the wrong reason.
    const real = closedStock(-700, at('10:00'));
    const phantom = closedStock(-400, at('09:45'));
    writeDailyHaltMarker({ pool: 'live', date: DATE, dailyPnl: -1100, haltLevel: -1000 });
    writeDailyHaltMarker({ pool: 'paper', date: DATE, dailyPnl: -900, haltLevel: -800 });
    const findings = () => new Set(collectExecutionFindings(Date.now()).map((f) => f.action));
    expect(findings().has('daily_halt_alerted|live')).toBe(true);

    updatePosition(phantom.id, { tags: ['webull'] });
    expect(retractDailyHalt({ date: DATE, reason: 'booking error in the stock book' })).toMatchObject({ ok: true });
    const after = findings();
    expect(after.has('daily_halt_alerted|live')).toBe(false);
    expect(after.has('daily_halt_alerted|paper')).toBe(true);
    expect(after.has('daily_halt_retracted')).toBe(true);

    // A correction that puts the day back through the line brings the halt
    // back, and the retraction stops being reported.
    repriceStock(real.id, -1050);
    const lapsed = findings();
    expect(lapsed.has('daily_halt_alerted|live')).toBe(true);
    expect(lapsed.has('daily_halt_retracted')).toBe(false);
  });
});

describe('POST /api/journal/daily-halt/retract', () => {
  const post = (body: unknown) =>
    fetch(`${base}/api/journal/daily-halt/retract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('needs a date and a reason worth reading', async () => {
    expect((await post({ date: DATE })).status).toBe(400);
    expect((await post({ date: DATE, reason: 'oops' })).status).toBe(400);
  });

  it('answers 404 with no halt, 409 with the reading for an earned one, and 200 once corrected', async () => {
    expect((await post({ date: DATE, reason: 'no halt on this date' })).status).toBe(404);

    const phantom = closedStock(-1100, at('09:45'));
    halt(-1100, -1000, at('10:23'));
    const earned = await post({ date: DATE, reason: 'before the correction' });
    expect(earned.status).toBe(409);
    expect(await earned.json()).toMatchObject({
      error: expect.stringMatching(/That halt was earned; it stays/),
      reading: { lowest: -1100, reached: true },
    });

    updatePosition(phantom.id, { tags: ['webull'] });
    const r = await post({ date: DATE, reason: 'the phantom row was untagged' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: true,
      reading: { lowest: 0, total: 0, reached: false },
      dailyResult: { drawdownHalted: false },
    });
  });
});
