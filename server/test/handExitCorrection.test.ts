import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Only the history read is replaced, and its fills are parsed from the
// broker's own envelope shapes (handTradeFixtures.ts). The positions sync the
// first case runs through is the real code, fed through a stubbed fetch.
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return { ...actual, listBrokerFills: vi.fn() };
});
vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

import { initDb, db } from '../src/db';
import { config } from '../src/config';
import {
  addExit,
  createPosition,
  getPosition,
  listSyncEstimatedHandExits,
  SYNC_ESTIMATE_NOTE_PREFIX,
} from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import { recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { listAutotradeEvents, logAutotradeEvent } from '../src/db/autotradeEvents';
import {
  BrokerEquityFill,
  BrokerOptionFill,
  listBrokerFills,
  parseBrokerEquityFills,
  parseBrokerOptionFills,
} from '../src/providers/webull/orders';
import { importWebullPositions, syncClosedWebullPositions } from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';
import { realizedPnlOf } from '../src/services/pnl';
import {
  correctEstimatedHandExits,
  HAND_EXIT_CORRECTED,
  HAND_EXIT_CORRECTION_SKIPPED,
  HandOptionWindow,
  matchHandOptionClose,
  resetHandExitCorrectionState,
} from '../src/services/autotrading/handExitCorrection';
import {
  fillsClaimedByCorrections,
  STOCK_EXIT_CORRECTION_INTERVAL_MS,
} from '../src/services/autotrading/stockExitCorrection';
import { eventBook } from '../src/services/autotrading/eventBook';
import { etDateTimeToMs } from '../src/util/marketDate';
import {
  AMC_COVER_ENVELOPE,
  AMC_COVER_ID,
  AMC_COVER_STOP_ENVELOPE,
  AMC_SHORT_ENTRY_ENVELOPE,
  AMC_SHORT_POSITION_ROW,
  AMC_TIMES,
  DELL_COPY,
  DELL_SLEEVE_CLOSE_ENVELOPE,
  DELL_SLEEVE_CLOSE_ID,
} from './handTradeFixtures';

const mockFills = vi.mocked(listBrokerFills);
const origWebull = { ...config.webull };

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    `DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders;
     DELETE FROM order_intents; DELETE FROM autotrade_events; DELETE FROM webull_miss_streak;`,
  );
  resetHandExitCorrectionState();
  mockFills.mockReset();
  mockFills.mockResolvedValue({ ok: true, equity: [], option: [] });
  vi.mocked(priceMap).mockReset();
});
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ESTIMATE_NOTE = `${SYNC_ESTIMATE_NOTE_PREFIX} from the latest quote (not a confirmed fill); edit it if you have your broker confirmation.`;

/** A position the sync imported, as it leaves one: tagged `webull` only, no
 *  entry order anywhere, created when the sync saw it. */
function imported(opts: {
  symbol: string;
  side?: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  importedAt: number;
  accountId?: string;
  option?: { optionType: 'call' | 'put'; strike: number; expiration: string };
}) {
  const pos = createPosition({
    assetType: opts.option ? 'option' : 'stock',
    symbol: opts.symbol,
    side: opts.side ?? 'long',
    quantity: opts.quantity,
    entryPrice: opts.entryPrice,
    entryDate: null,
    ...(opts.option ?? {}),
    tags: ['webull'],
    notes: 'Imported from Webull',
    accountId: opts.accountId ?? 'ACC1',
  });
  db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(opts.importedAt, pos.id);
  return pos;
}

/** The sync's close at a quote, booked at `bookedAt`. */
function estimate(positionId: number, qty: number, price: number, exitDate: string, bookedAt: number): number {
  const before = new Set(getPosition(positionId)!.exits.map((e) => e.id));
  addExit(positionId, { quantity: qty, exitPrice: price, exitDate, exitReason: 'manual', notes: ESTIMATE_NOTE });
  const id = getPosition(positionId)!.exits.find((e) => !before.has(e.id))!.id;
  db.prepare('UPDATE position_exits SET created_at = ? WHERE id = ?').run(bookedAt, id);
  return id;
}

const exitOf = (positionId: number, exitId: number) => getPosition(positionId)!.exits.find((e) => e.id === exitId)!;
const detailOf = (action: string) => listAutotradeEvents({ actions: [action] }).map((e) => JSON.parse(e.detail!));

describe('correctEstimatedHandExits', () => {
  it("books the operator's AMC test short at its buy to cover, from the import to the correction (2026-09-24)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positionsReply = (rows: unknown[]) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(rows),
      } as Response);

    // 1. The sync sees the short and imports it: side from the negative
    //    quantity (there is no side field), entry from the positive cost_price.
    vi.setSystemTime(AMC_TIMES.imported);
    positionsReply([AMC_SHORT_POSITION_ROW]);
    expect(await importWebullPositions('ACC1')).toMatchObject({ ok: true, imported: 1 });
    const [row] = db.prepare("SELECT id FROM positions WHERE symbol = 'AMC'").all() as { id: number }[];
    expect(getPosition(row.id)).toMatchObject({ side: 'short', quantity: 1, entryPrice: 2.83, tags: ['webull'] });

    // 2. Covered in Webull at 09:52:53. Gone from two syncs in a row, it is
    //    closed at the quote the sync could get: an estimate.
    vi.mocked(priceMap).mockImplementation(
      async (positions) =>
        new Map(positions.map((p) => [p.id, { price: AMC_TIMES.estimatePrice, stale: false, asOf: 0 }])),
    );
    positionsReply([]);
    vi.setSystemTime(AMC_TIMES.estimateBooked - 20_000);
    await syncClosedWebullPositions('ACC1');
    vi.setSystemTime(AMC_TIMES.estimateBooked);
    expect(await syncClosedWebullPositions('ACC1')).toMatchObject({ ok: true, closed: 1 });
    const booked = getPosition(row.id)!;
    expect(booked.exits).toHaveLength(1);
    expect(booked.exits[0].exitPrice).toBe(2.805);
    expect(booked.exits[0].notes).toContain(SYNC_ESTIMATE_NOTE_PREFIX);
    expect(listSyncEstimatedHandExits()).toHaveLength(1);

    // 3. The pass reads the cover out of the history, parsed from the
    //    broker's own envelopes: the SHORT entry is no BUY or SELL, and the
    //    cancelled stop never filled, so only the cover can match.
    mockFills.mockResolvedValue({
      ok: true,
      equity: parseBrokerEquityFills([AMC_SHORT_ENTRY_ENVELOPE, AMC_COVER_ENVELOPE, AMC_COVER_STOP_ENVELOPE]),
      option: [],
    });
    const now = AMC_TIMES.estimateBooked + 60_000;
    vi.setSystemTime(now);
    expect(await correctEstimatedHandExits('ACC1', now)).toBe(1);

    const fixed = getPosition(row.id)!;
    expect(fixed.exits[0].exitPrice).toBe(2.82);
    // The take-profit leg of the operator's own OCO filled it.
    expect(fixed.exits[0].exitReason).toBe('target');
    expect(fixed.exits[0].notes).toMatch(/your buy to cover in Webull's order history \(was 2\.805/);
    // A short's P&L is entry minus exit: +$0.01, not the estimate's +$0.025.
    expect(realizedPnlOf(fixed)).toBeCloseTo(0.01, 9);
    const [corr] = detailOf(HAND_EXIT_CORRECTED);
    expect(corr).toMatchObject({
      positionId: row.id,
      assetType: 'stock',
      fromPrice: 2.805,
      toPrice: 2.82,
      fillClientOrderIds: [AMC_COVER_ID],
      // Covering higher costs a short: -$0.015, to the cent.
      pnlDelta: -0.01,
      pnlAfter: 0.01,
    });
    // It leaves the candidates, and it is filed under the live book.
    expect(listSyncEstimatedHandExits()).toHaveLength(0);
    const [ev] = listAutotradeEvents({ actions: [HAND_EXIT_CORRECTED] });
    expect(eventBook(ev.action, ev.detail)).toBe('live');
  });

  it("books the journal's copy of an options-sleeve contract at the sleeve's own close (DELL, 2026-09-23)", async () => {
    const pos = imported({
      symbol: 'DELL',
      quantity: 1,
      entryPrice: DELL_COPY.entryPrice,
      importedAt: DELL_COPY.imported,
      option: { optionType: 'call', strike: DELL_COPY.strike, expiration: DELL_COPY.expiration },
    });
    const exitId = estimate(pos.id, 1, DELL_COPY.estimatePrice, '2026-09-23', DELL_COPY.estimateBooked);
    // The close is the SLEEVE's order, one of the app's own. It still books
    // here: it is what closed the contract the copy records.
    createIntent(
      {
        symbol: 'DELL',
        assetKind: 'option',
        side: 'sell',
        openClose: 'close',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 4.9,
      },
      DELL_SLEEVE_CLOSE_ID,
    );
    mockFills.mockResolvedValue({ ok: true, equity: [], option: parseBrokerOptionFills([DELL_SLEEVE_CLOSE_ENVELOPE]) });

    const now = etDateTimeToMs('2026-09-23', '17:00')!;
    expect(await correctEstimatedHandExits('ACC1', now)).toBe(1);

    const fixed = getPosition(pos.id)!;
    expect(exitOf(pos.id, exitId).exitPrice).toBe(4.95);
    // An options fill does not say what kind of order it was: the reason stays.
    expect(exitOf(pos.id, exitId).exitReason).toBe('manual');
    expect(exitOf(pos.id, exitId).notes).toMatch(/the fill that closed the contract/);
    // A $165 loss, not the $330 win the quote made of it.
    expect(realizedPnlOf(fixed)).toBeCloseTo(-165, 6);
    expect(detailOf(HAND_EXIT_CORRECTED)[0]).toMatchObject({
      assetType: 'option',
      fromPrice: 9.9,
      toPrice: 4.95,
      fillClientOrderIds: [DELL_SLEEVE_CLOSE_ID],
      pnlDelta: -495,
      pnlBefore: 330,
      pnlAfter: -165,
    });
  });

  it("never books one of the app's own STOCK orders, and says so once, the day after", async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'MRNA', quantity: 23, entryPrice: 180, importedAt: at('10:00') });
    const exitId = estimate(pos.id, 23, 181.5, day, at('11:02'));
    createIntent(
      {
        symbol: 'MRNA',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 23,
        orderType: 'limit',
        limitPrice: 181.2,
      },
      'app-close-key',
    );
    const appSale: BrokerEquityFill = {
      clientOrderId: 'app-close-key',
      comboType: 'NORMAL',
      orderType: 'LIMIT',
      side: 'SELL',
      symbol: 'MRNA',
      filledQty: 23,
      filledPrice: 181.2,
      filledAt: at('11:00'),
    };
    mockFills.mockResolvedValue({ ok: true, equity: [appSale], option: [] });

    // Through the close's own day the history may still be catching up.
    expect(await correctEstimatedHandExits('ACC1', at('15:00'))).toBe(0);
    expect(detailOf(HAND_EXIT_CORRECTION_SKIPPED)).toHaveLength(0);

    // The day after it is left an estimate for good, with what the history held.
    const nextDay = etDateTimeToMs('2026-09-23', '09:00')!;
    expect(await correctEstimatedHandExits('ACC1', nextDay)).toBe(0);
    expect(exitOf(pos.id, exitId).exitPrice).toBe(181.5);
    const skips = detailOf(HAND_EXIT_CORRECTION_SKIPPED);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      exitId,
      cause: 'no_matching_fill',
      fills: [{ clientOrderId: 'app-close-key', appOrder: true, price: 181.2 }],
    });

    // Not asked about again, and after a restart not said twice.
    mockFills.mockClear();
    expect(await correctEstimatedHandExits('ACC1', nextDay + STOCK_EXIT_CORRECTION_INTERVAL_MS)).toBe(0);
    expect(mockFills).not.toHaveBeenCalled();
    resetHandExitCorrectionState();
    await correctEstimatedHandExits('ACC1', nextDay + 2 * STOCK_EXIT_CORRECTION_INTERVAL_MS);
    expect(detailOf(HAND_EXIT_CORRECTION_SKIPPED)).toHaveLength(1);
  });

  it("leaves every position the app opened to the app's own pass, and reads nothing for them", async () => {
    const today = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(today, hhmm)!;
    // Tagged live.
    const live = createPosition({
      assetType: 'stock',
      symbol: 'COIN',
      side: 'long',
      quantity: 10,
      entryPrice: 200,
      entryDate: today,
      tags: ['webull', 'live', 'autotrade'],
      accountId: 'ACC1',
    });
    estimate(live.id, 10, 201, today, at('11:00'));
    // Adopted: tagged `webull` only, but an entry order of the app's points at it.
    const adopted = imported({ symbol: 'HOOD', quantity: 10, entryPrice: 100, importedAt: at('10:00') });
    const intent = createIntent(
      {
        symbol: 'HOOD',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 100,
      },
      'cid-hood',
    );
    recordLiveOrder({
      intentId: intent.id,
      symbol: 'HOOD',
      stopPrice: 98,
      targetPrice: 104,
      riskAmount: 20,
      riskProfile: 'MODERATE',
      accountId: 'ACC1',
    });
    setLiveOrderPositionId(intent.id, adopted.id);
    estimate(adopted.id, 10, 101, today, at('11:00'));
    // Materialized from its own intent.
    const materialized = imported({ symbol: 'SMCI', quantity: 10, entryPrice: 40, importedAt: at('10:00') });
    db.prepare('UPDATE positions SET source_intent_id = ? WHERE id = ?').run(intent.id, materialized.id);
    estimate(materialized.id, 10, 41, today, at('11:00'));
    // Logged by hand in the journal: not the sync's, so no estimate note.
    const logged = createPosition({
      assetType: 'stock',
      symbol: 'SPY',
      side: 'long',
      quantity: 1,
      entryPrice: 500,
      entryDate: today,
      accountId: 'ACC1',
    });
    addExit(logged.id, { quantity: 1, exitPrice: 501, exitDate: today, notes: 'sold at the open' });

    expect(listSyncEstimatedHandExits()).toHaveLength(0);
    expect(await correctEstimatedHandExits('ACC1', at('17:00'))).toBe(0);
    expect(mockFills).not.toHaveBeenCalled();
  });

  it('asks only about this account, and only inside the broker history window', async () => {
    const now = etDateTimeToMs('2026-09-22', '17:00')!;
    const other = imported({
      symbol: 'AMD',
      quantity: 5,
      entryPrice: 150,
      importedAt: now - 3_600_000,
      accountId: 'ACC2',
    });
    estimate(other.id, 5, 151, '2026-09-22', now - 1_800_000);
    const old = imported({ symbol: 'AMD', quantity: 5, entryPrice: 150, importedAt: now - 9 * 86_400_000 });
    estimate(old.id, 5, 151, '2026-09-14', now - 8 * 86_400_000);

    expect(await correctEstimatedHandExits('ACC1', now)).toBe(0);
    expect(mockFills).not.toHaveBeenCalled();
  });

  it('never takes a fill from before the import: it closed an earlier trade', async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'TSLA', quantity: 10, entryPrice: 400, importedAt: at('10:00') });
    const exitId = estimate(pos.id, 10, 405, day, at('11:02'));
    const sold = (id: string, price: number, t: number): BrokerEquityFill => ({
      clientOrderId: id,
      comboType: 'NORMAL',
      orderType: 'LIMIT',
      side: 'SELL',
      symbol: 'TSLA',
      filledQty: 10,
      filledPrice: price,
      filledAt: t,
    });
    mockFills.mockResolvedValue({ ok: true, equity: [sold('EARLIER', 390, at('09:40'))], option: [] });
    expect(await correctEstimatedHandExits('ACC1', at('15:00'))).toBe(0);
    expect(exitOf(pos.id, exitId).exitPrice).toBe(405);

    // Once its own sale is in the history, that is the one booked.
    mockFills.mockResolvedValue({
      ok: true,
      equity: [sold('EARLIER', 390, at('09:40')), sold('ITS-OWN', 404.1, at('11:00'))],
      option: [],
    });
    expect(await correctEstimatedHandExits('ACC1', at('15:00') + STOCK_EXIT_CORRECTION_INTERVAL_MS)).toBe(1);
    expect(exitOf(pos.id, exitId).exitPrice).toBe(404.1);
  });

  it("books a position closed in two pieces at each piece's own fill, after an exit the operator edited", async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'NVDA', quantity: 100, entryPrice: 180, importedAt: at('09:50') });
    // The first half's estimate was already set right by hand, so no
    // correction claims its fill. Only the time bound keeps it out of the
    // second half's match.
    const first = estimate(pos.id, 50, 200, day, at('10:02'));
    db.prepare('UPDATE position_exits SET notes = ? WHERE id = ?').run(
      'corrected by hand from the confirmation',
      first,
    );
    const second = estimate(pos.id, 50, 209, day, at('11:02'));
    const sold = (id: string, price: number, t: number): BrokerEquityFill => ({
      clientOrderId: id,
      comboType: 'NORMAL',
      orderType: 'LIMIT',
      side: 'SELL',
      symbol: 'NVDA',
      filledQty: 50,
      filledPrice: price,
      filledAt: t,
    });
    mockFills.mockResolvedValue({
      ok: true,
      equity: [sold('HAND-A', 200, at('10:00')), sold('HAND-B', 210, at('11:00'))],
      option: [],
    });

    expect(await correctEstimatedHandExits('ACC1', at('17:00'))).toBe(1);
    expect(exitOf(pos.id, second).exitPrice).toBe(210);
    expect(detailOf(HAND_EXIT_CORRECTED)[0].fillClientOrderIds).toEqual(['HAND-B']);
  });

  it('books no fill twice: one the stock pass booked is taken, and one this pass books is taken for it', async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'PLTR', quantity: 20, entryPrice: 150, importedAt: at('09:45') });
    const exitId = estimate(pos.id, 20, 152, day, at('10:32'));
    logAutotradeEvent({
      symbol: 'PLTR',
      stage: 'execution',
      action: 'live_exit_corrected',
      detail: { exitId: 999, source: 'broker_history', fillClientOrderIds: ['TAKEN'] },
    });
    const sold = (id: string, price: number, t: number): BrokerEquityFill => ({
      clientOrderId: id,
      comboType: 'NORMAL',
      orderType: 'LIMIT',
      side: 'SELL',
      symbol: 'PLTR',
      filledQty: 20,
      filledPrice: price,
      filledAt: t,
    });
    mockFills.mockResolvedValue({
      ok: true,
      equity: [sold('TAKEN', 149, at('10:00')), sold('ITS-OWN', 151.4, at('10:30'))],
      option: [],
    });

    const now = at('17:00');
    expect(await correctEstimatedHandExits('ACC1', now)).toBe(1);
    expect(exitOf(pos.id, exitId).exitPrice).toBe(151.4);
    // What the stock pass reads before it books a hand sale of its own.
    const claimed = fillsClaimedByCorrections(now);
    expect(claimed.has('TAKEN')).toBe(true);
    expect(claimed.has('ITS-OWN')).toBe(true);
  });

  it('confirms an estimate the fill already matches, and never asks about it again', async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'AAPL', quantity: 5, entryPrice: 250, importedAt: at('09:45') });
    const exitId = estimate(pos.id, 5, 251.1, day, at('10:32'));
    mockFills.mockResolvedValue({
      ok: true,
      equity: [
        {
          clientOrderId: 'HAND',
          comboType: 'NORMAL',
          orderType: 'MARKET',
          side: 'SELL',
          symbol: 'AAPL',
          filledQty: 5,
          filledPrice: 251.1,
          filledAt: at('10:30'),
        },
      ],
      option: [],
    });

    expect(await correctEstimatedHandExits('ACC1', at('17:00'))).toBe(0);
    expect(exitOf(pos.id, exitId).notes).toMatch(/confirmed against the broker's actual fill/);
    expect(detailOf(HAND_EXIT_CORRECTED)).toHaveLength(0);
    expect(listSyncEstimatedHandExits()).toHaveLength(0);
  });

  it('reads a new estimate at once, the rest every 15 minutes, and retries a failed read', async () => {
    const day = '2026-09-22';
    const at = (hhmm: string) => etDateTimeToMs(day, hhmm)!;
    const pos = imported({ symbol: 'AMZN', quantity: 3, entryPrice: 220, importedAt: at('09:45') });
    const exitId = estimate(pos.id, 3, 221, day, at('10:32'));
    mockFills.mockResolvedValue({ ok: false, equity: [], option: [], error: 'HTTP 429' });

    const t0 = at('10:35');
    expect(await correctEstimatedHandExits('ACC1', t0)).toBe(0);
    expect(mockFills).toHaveBeenCalledTimes(1);
    await correctEstimatedHandExits('ACC1', t0 + 60_000);
    expect(mockFills).toHaveBeenCalledTimes(1);

    // A second estimate is new: read on the next pass.
    const other = imported({ symbol: 'META', quantity: 2, entryPrice: 700, importedAt: at('09:45') });
    estimate(other.id, 2, 705, day, at('10:40'));
    await correctEstimatedHandExits('ACC1', t0 + 6 * 60_000);
    expect(mockFills).toHaveBeenCalledTimes(2);

    mockFills.mockResolvedValue({
      ok: true,
      equity: [
        {
          clientOrderId: 'HAND',
          comboType: 'NORMAL',
          orderType: 'LIMIT',
          side: 'SELL',
          symbol: 'AMZN',
          filledQty: 3,
          filledPrice: 220.6,
          filledAt: at('10:31'),
        },
      ],
      option: [],
    });
    expect(await correctEstimatedHandExits('ACC1', t0 + 6 * 60_000 + STOCK_EXIT_CORRECTION_INTERVAL_MS)).toBe(1);
    expect(exitOf(pos.id, exitId).exitPrice).toBe(220.6);
  });
});

describe('matchHandOptionClose', () => {
  const entered = Date.parse('2026-09-23T13:38:00Z');
  const row: HandOptionWindow = {
    symbol: 'DELL',
    optionType: 'call',
    strike: 575,
    expiration: '2026-09-25',
    positionSide: 'long',
    quantity: 2,
    enteredAt: entered,
    after: null,
    createdAt: entered + 60 * 60_000,
  };
  const fill = (over: Partial<BrokerOptionFill> = {}): BrokerOptionFill => ({
    clientOrderId: 'c1',
    side: 'SELL',
    positionIntent: 'SELL_TO_CLOSE',
    underlying: 'DELL',
    optionType: 'call',
    strike: 575,
    expiration: '2026-09-25',
    filledQty: 2,
    filledPrice: 4.95,
    filledAt: entered + 10 * 60_000,
    ...over,
  });

  it('takes one close of the whole quantity, or several adding up exactly, at their weighted price', () => {
    expect(matchHandOptionClose(row, [fill()])).toMatchObject({ price: 4.95, qty: 2, clientOrderIds: ['c1'] });
    const two = [
      fill({ clientOrderId: 'b', filledQty: 1, filledPrice: 5.1, filledAt: entered + 20 * 60_000 }),
      fill({ clientOrderId: 'a', filledQty: 1, filledPrice: 4.9, filledAt: entered + 10 * 60_000 }),
    ];
    expect(matchHandOptionClose(row, two)).toMatchObject({ price: 5, qty: 2, clientOrderIds: ['a', 'b'] });
  });

  it('reads only the exact contract, on the closing side, and never an opening order', () => {
    for (const other of [
      fill({ strike: 580 }),
      fill({ expiration: '2026-10-02' }),
      fill({ optionType: 'put' }),
      fill({ underlying: 'DELLX' }),
      fill({ side: 'BUY', positionIntent: 'BUY_TO_CLOSE' }),
      fill({ positionIntent: 'SELL_TO_OPEN' }),
    ]) {
      expect(matchHandOptionClose(row, [other])).toBeNull();
    }
    // A short contract is closed by a BUY.
    const short = { ...row, positionSide: 'short' as const };
    expect(matchHandOptionClose(short, [fill({ side: 'BUY', positionIntent: 'BUY_TO_CLOSE' })])).not.toBeNull();
    expect(matchHandOptionClose(short, [fill()])).toBeNull();
    // A fill whose intent the broker left out still counts.
    expect(matchHandOptionClose(row, [fill({ positionIntent: null })])).not.toBeNull();
  });

  it('refuses closes that overshoot or fall short of the booked quantity', () => {
    expect(matchHandOptionClose(row, [fill({ filledQty: 3 })])).toBeNull();
    expect(matchHandOptionClose(row, [fill({ filledQty: 1 })])).toBeNull();
  });

  it('reads only its own window, and nothing claimed', () => {
    expect(matchHandOptionClose(row, [fill({ filledAt: entered - 1 })])).toBeNull();
    expect(matchHandOptionClose(row, [fill({ filledAt: row.createdAt + 61_000 })])).toBeNull();
    expect(matchHandOptionClose(row, [fill({ filledAt: row.createdAt + 59_000 })])).not.toBeNull();
    expect(matchHandOptionClose({ ...row, after: entered + 15 * 60_000 }, [fill()])).toBeNull();
    expect(matchHandOptionClose(row, [fill()], new Set(['c1']))).toBeNull();
  });

  it('cannot match a row missing its contract', () => {
    expect(matchHandOptionClose({ ...row, strike: null }, [fill()])).toBeNull();
  });

  // 2026-09-24, on review. The options sleeve trades the same contracts: the
  // operator sells a hand DELL call, and the sleeve buys and sells the same
  // one before the sync books the hand row's exit. Oldest first booked the
  // first close whichever it was.
  it('refuses a window holding more than one round trip: a later close, or the contract opened again', () => {
    const t = (min: number) => entered + min * 60_000;
    const hand = fill({ clientOrderId: 'hand', filledAt: t(10) });
    const sleeveIn = fill({ clientOrderId: 'sleeve-in', side: 'BUY', positionIntent: 'BUY_TO_OPEN', filledAt: t(12) });
    const sleeveOut = fill({ clientOrderId: 'sleeve-out', filledAt: t(22) });
    expect(matchHandOptionClose(row, [hand, sleeveIn, sleeveOut])).toBeNull();
    // Either sign alone is enough.
    expect(matchHandOptionClose(row, [hand, sleeveOut])).toBeNull();
    expect(matchHandOptionClose(row, [hand, sleeveIn])).toBeNull();
    // An open with no intent reads by its side: a BUY opens a long again.
    expect(matchHandOptionClose(row, [hand, fill({ ...sleeveIn, positionIntent: null })])).toBeNull();
    // An open before the matched close, or after the sync booked it, is no second trip here.
    expect(matchHandOptionClose(row, [fill({ ...sleeveIn, filledAt: t(5) }), hand])).not.toBeNull();
    expect(
      matchHandOptionClose(row, [hand, fill({ ...sleeveIn, filledAt: row.createdAt + 5 * 60_000 })]),
    ).not.toBeNull();
  });
});
