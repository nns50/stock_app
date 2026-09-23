import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Only the combo read is replaced. Everything else in the orders module, and the
// positions provider the sync runs through, is the real code.
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return { ...actual, webullOrderStatusBatch: vi.fn(), listBrokerEquityFills: vi.fn() };
});
vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

import { initDb, db } from '../src/db';
import { config } from '../src/config';
import {
  addExit,
  createPosition,
  getPosition,
  listSyncEstimatedExits,
  SYNC_ESTIMATE_NOTE_PREFIX,
} from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import { recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { DailyResult, listDailyResults, saveDailyResult } from '../src/db/dailyResults';
import { bumpMissStreak, clearMissStreak, missStreakStartedAt } from '../src/db/webullMissStreak';
import {
  BrokerEquityFill,
  listBrokerEquityFills,
  webullOrderStatusBatch,
  WebullOrderStatus,
  WebullOrderLeg,
} from '../src/providers/webull/orders';
import { BRACKET_RECONCILE_GRACE_MS, syncClosedWebullPositions } from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';
import {
  correctEstimatedStockExits,
  matchStockHandSale,
  resetStockExitCorrectionState,
  STOCK_EXIT_CORRECTION_INTERVAL_MS,
} from '../src/services/autotrading/stockExitCorrection';
import { getLivePortfolioSnapshot } from '../src/services/autotrading/liveExecute';
import { etToday } from '../src/util/marketDate';

const mockBatch = vi.mocked(webullOrderStatusBatch);
const mockEquityFills = vi.mocked(listBrokerEquityFills);
const origWebull = { ...config.webull };

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    `DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders;
     DELETE FROM order_intents; DELETE FROM autotrade_events; DELETE FROM webull_miss_streak;
     DELETE FROM autotrade_daily_results; DELETE FROM autotrade_daily_baseline;`,
  );
  resetStockExitCorrectionState();
  mockBatch.mockReset();
  mockBatch.mockResolvedValue(new Map());
  mockEquityFills.mockReset();
  mockEquityFills.mockResolvedValue({ ok: true, fills: [] });
  vi.mocked(priceMap).mockReset();
});
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The broker's answer for a bracket entry: the MASTER we asked about, plus its
 *  two exit legs, shaped as webullOrderStatusBatch returns them. */
function combo(key: string, legs: WebullOrderLeg[]): Map<string, WebullOrderStatus> {
  return new Map([
    [
      key,
      {
        ok: true,
        found: true,
        status: 'FILLED',
        legs: [
          { clientOrderId: key, isRequested: true, comboType: 'MASTER', status: 'FILLED', filledQty: 161 },
          ...legs,
        ],
      },
    ],
  ]);
}

const stopLeg = (over: Partial<WebullOrderLeg> = {}): WebullOrderLeg => ({
  clientOrderId: 'leg-sl',
  isRequested: false,
  comboType: 'STOP_LOSS',
  orderType: 'STOP_LOSS',
  status: 'FILLED',
  filledQty: 161,
  filledPrice: 204.37,
  ...over,
});
const targetLeg = (over: Partial<WebullOrderLeg> = {}): WebullOrderLeg => ({
  clientOrderId: 'leg-tp',
  isRequested: false,
  comboType: 'STOP_PROFIT',
  orderType: 'LIMIT',
  status: 'CANCELLED',
  filledQty: 0,
  ...over,
});

/** An autotrade stock position with its bracket entry order on record, as the
 *  live path leaves it in production: ADOPTED. The broker sync imports the
 *  fill before the reconcile materializes it, so the position has no
 *  source_intent_id and the entry order row points at it instead. The first
 *  deploy of this pass read only source_intent_id and found nothing, because
 *  its fixtures set one. `materialized: true` is the other, rarer shape. */
function bracketedCoin(opts: { key?: string; entryDate?: string; accountId?: string; materialized?: boolean } = {}) {
  const key = opts.key ?? 'cid-coin-0921';
  const intent = createIntent(
    {
      symbol: 'COIN',
      assetKind: 'stock',
      side: 'buy',
      openClose: 'open',
      quantity: 161,
      orderType: 'limit',
      limitPrice: 205.43,
      bracket: { takeProfitPrice: 209.74, stopLossPrice: 199.5 },
    },
    key,
  );
  const pos = createPosition({
    assetType: 'stock',
    symbol: 'COIN',
    side: 'long',
    quantity: 161,
    entryPrice: 204.39,
    entryDate: opts.entryDate ?? etToday(),
    // The stop had been ratcheted to breakeven, so a quote above it and below
    // the target is "between the levels" to the sync's inference.
    stopPrice: 204.39,
    targetPrice: 209.74,
    tags: ['webull', 'live', 'autotrade'],
    accountId: opts.accountId ?? 'ACC1',
    sourceIntentId: opts.materialized ? intent.id : null,
  });
  recordLiveOrder({
    intentId: intent.id,
    symbol: 'COIN',
    stopPrice: 204.39,
    targetPrice: 209.74,
    riskAmount: 790,
    riskProfile: 'MODERATE',
    accountId: opts.accountId ?? 'ACC1',
  });
  setLiveOrderPositionId(intent.id, pos.id);
  return { intent, pos, key };
}

/** The row the sync writes when it prices a close itself, written directly. */
function estimatedExit(positionId: number, exitDate: string, exitPrice = 205.0451) {
  addExit(positionId, {
    quantity: 161,
    exitPrice,
    exitDate,
    exitReason: 'manual',
    notes: `${SYNC_ESTIMATE_NOTE_PREFIX} from the latest quote (not a confirmed fill); edit it if you have your broker confirmation.`,
  });
}

describe('the miss streak knows when a run of misses began', () => {
  it('stamps the first miss, keeps it through later ones, and forgets it on a sighting', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-21T13:41:48Z');
    vi.setSystemTime(t0);
    expect(bumpMissStreak('ACC1', 'COIN|stock')).toBe(1);
    vi.setSystemTime(t0 + 30_000);
    expect(bumpMissStreak('ACC1', 'COIN|stock')).toBe(2);
    expect(missStreakStartedAt('ACC1', 'COIN|stock')).toBe(t0);
    clearMissStreak('ACC1', 'COIN|stock');
    expect(missStreakStartedAt('ACC1', 'COIN|stock')).toBeNull();
  });

  it('reads a row written before the column existed as starting at its last bump', () => {
    db.prepare('INSERT INTO webull_miss_streak (account_id, contract_key, streak, updated_at) VALUES (?, ?, ?, ?)').run(
      'ACC1',
      'OLD|stock',
      3,
      1_000,
    );
    expect(missStreakStartedAt('ACC1', 'OLD|stock')).toBe(1_000);
    bumpMissStreak('ACC1', 'OLD|stock');
    // The old last bump becomes the start, and it stays put from here on.
    expect(missStreakStartedAt('ACC1', 'OLD|stock')).toBe(1_000);
  });
});

describe('correctEstimatedStockExits', () => {
  // The whole 2026-09-21 chain, with the real producer of the estimate: the
  // sync prices COIN's close at a quote after its grace, the step-down reads
  // that phantom win, and the correction puts the real stop fill back.
  it('corrects the COIN case end to end, and the step-down then counts the loss', async () => {
    const today = etToday();
    // INTC's breakeven stop, a real $1.83 loss booked from its fill.
    const intc = createPosition({
      assetType: 'stock',
      symbol: 'INTC',
      side: 'long',
      quantity: 183,
      entryPrice: 115.86,
      entryDate: today,
      tags: ['live', 'autotrade'],
      accountId: 'ACC1',
    });
    addExit(intc.id, { quantity: 183, exitPrice: 115.85, exitDate: today, exitReason: 'stop' });

    const { pos, key } = bracketedCoin();
    // The sync, as production runs it: the broker holds nothing, the quote is
    // $205.0451, and the grace is spent.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    } as Response);
    vi.mocked(priceMap).mockImplementation(
      async (positions) => new Map(positions.map((p) => [p.id, { price: 205.0451, stale: false, asOf: 0 }])),
    );
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(t0 + (i * BRACKET_RECONCILE_GRACE_MS) / 3);
      await syncClosedWebullPositions('ACC1');
    }
    vi.useRealTimers();
    const booked = getPosition(pos.id)!;
    expect(booked.status).toBe('closed');
    expect(booked.exits[0]).toMatchObject({ exitPrice: 205.0451, exitReason: 'manual' });
    // The estimate the sync wrote is exactly what the correction looks for.
    expect(listSyncEstimatedExits().map((r) => r.positionId)).toEqual([pos.id]);
    // What the step-down read on 2026-09-21: a win breaks the losing run.
    expect(getLivePortfolioSnapshot().consecutiveLosses).toBe(0);

    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));
    expect(await correctEstimatedStockExits('ACC1')).toBe(1);

    expect(mockBatch).toHaveBeenCalledWith('ACC1', [key]);
    const fixed = getPosition(pos.id)!;
    expect(fixed.exits[0]).toMatchObject({ exitPrice: 204.37, exitReason: 'stop', quantity: 161 });
    expect(fixed.exits[0].notes).toMatch(/corrected to the broker's actual fill/);
    // THE CONSUMER: the live snapshot the step-down sizes from now sees two
    // losses in a row, which is what the next entry should have been sized on.
    expect(getLivePortfolioSnapshot().consecutiveLosses).toBe(2);

    const rows = listAutotradeEvents({ actions: ['live_exit_corrected'] });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail!)).toMatchObject({
      positionId: pos.id,
      source: 'bracket_leg',
      fromPrice: 205.0451,
      toPrice: 204.37,
      fromReason: 'manual',
      toReason: 'stop',
      pnlDelta: -108.69,
      pnlBefore: 105.47,
      pnlAfter: -3.22,
    });
    // Corrected rows leave the candidate set: nothing is re-asked.
    expect(listSyncEstimatedExits()).toHaveLength(0);
  });

  it('asks about a new estimate at once, and otherwise at most every 15 minutes', async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    // The lists have not shown the leg yet: still working.
    mockBatch.mockResolvedValue(combo(key, [stopLeg({ status: 'WORKING', filledQty: 0 }), targetLeg()]));
    const t0 = Date.now();

    expect(await correctEstimatedStockExits('ACC1', t0)).toBe(0);
    expect(await correctEstimatedStockExits('ACC1', t0 + 60_000)).toBe(0);
    expect(mockBatch).toHaveBeenCalledTimes(1);

    // A second estimate appears: asked about on the next pass, not in 15 minutes.
    const other = bracketedCoin({ key: 'cid-coin-2' });
    estimatedExit(other.pos.id, etToday());
    await correctEstimatedStockExits('ACC1', t0 + 120_000);
    expect(mockBatch).toHaveBeenCalledTimes(2);

    // Once the lists show the fill, the next scheduled pass corrects it.
    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));
    expect(await correctEstimatedStockExits('ACC1', t0 + 120_000 + STOCK_EXIT_CORRECTION_INTERVAL_MS)).toBe(1);
    expect(getPosition(pos.id)!.exits[0].exitPrice).toBe(204.37);
  });

  // The operator's takeover of 2026-09-22: the bracket cancelled, the shares
  // sold by hand in Webull. No leg filled, so the bracket cannot price it; the
  // history holds the operator's own sale.
  const handSale = (over: Partial<BrokerEquityFill> = {}): BrokerEquityFill => ({
    clientOrderId: '6ab289b7ff86f20000054f99', // 24 hex: a hand order, not one of ours
    comboType: 'NORMAL',
    side: 'SELL',
    symbol: 'COIN',
    filledQty: 161,
    filledPrice: 204.95,
    filledAt: Date.now() - 60_000,
    ...over,
  });
  const cancelledBracket = (key: string) =>
    combo(key, [stopLeg({ status: 'CANCELLED', filledQty: 0, filledPrice: undefined }), targetLeg()]);

  it("books a hand sale at the operator's own fill, and keeps the reason manual", async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    mockBatch.mockResolvedValue(cancelledBracket(key));
    mockEquityFills.mockResolvedValue({ ok: true, fills: [handSale()] });

    expect(await correctEstimatedStockExits('ACC1')).toBe(1);

    expect(mockEquityFills).toHaveBeenCalledTimes(1);
    const fixed = getPosition(pos.id)!;
    expect(fixed.exits[0]).toMatchObject({ exitPrice: 204.95, exitReason: 'manual' });
    expect(fixed.exits[0].notes).toMatch(/your own sale in Webull's order history/);
    const rows = listAutotradeEvents({ actions: ['live_exit_corrected'] });
    expect(JSON.parse(rows[0].detail!)).toMatchObject({
      source: 'broker_history',
      fromPrice: 205.0451,
      toPrice: 204.95,
      toReason: 'manual',
      fillClientOrderIds: ['6ab289b7ff86f20000054f99'],
      pnlDelta: -15.31,
    });
  });

  it('keeps asking about an unmatched hand close through its own day, then leaves it an estimate', async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    mockBatch.mockResolvedValue(cancelledBracket(key));
    const t0 = Date.now();
    // The history has not shown the sale yet.
    expect(await correctEstimatedStockExits('ACC1', t0)).toBe(0);
    expect(await correctEstimatedStockExits('ACC1', t0 + STOCK_EXIT_CORRECTION_INTERVAL_MS)).toBe(0);
    expect(mockEquityFills).toHaveBeenCalledTimes(2);
    expect(getPosition(pos.id)!.exits[0]).toMatchObject({ exitPrice: 205.0451, exitReason: 'manual' });

    // A close from an earlier day that still does not match is final.
    resetStockExitCorrectionState();
    mockBatch.mockClear();
    mockEquityFills.mockClear();
    const old = bracketedCoin({ key: 'cid-coin-old', entryDate: etToday(t0 - 2 * 24 * 60 * 60 * 1000) });
    db.prepare('DELETE FROM position_exits WHERE position_id = ?').run(pos.id);
    estimatedExit(old.pos.id, etToday(t0 - 2 * 24 * 60 * 60 * 1000));
    mockBatch.mockResolvedValue(cancelledBracket('cid-coin-old'));
    await correctEstimatedStockExits('ACC1', t0);
    await correctEstimatedStockExits('ACC1', t0 + 2 * STOCK_EXIT_CORRECTION_INTERVAL_MS);
    expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(mockEquityFills).toHaveBeenCalledTimes(1);
  });

  it('never reads the stock history for a bracket still working or one whose leg filled', async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    mockBatch.mockResolvedValue(combo(key, [stopLeg({ status: 'WORKING', filledQty: 0 }), targetLeg()]));
    await correctEstimatedStockExits('ACC1');
    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));
    await correctEstimatedStockExits('ACC1', Date.now() + STOCK_EXIT_CORRECTION_INTERVAL_MS);
    expect(mockEquityFills).not.toHaveBeenCalled();
    expect(getPosition(pos.id)!.exits[0]).toMatchObject({ exitPrice: 204.37, exitReason: 'stop' });
  });

  it('keeps asking after a failed read, and gives up on a combo aged out of history', async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    const t0 = Date.now();
    mockBatch.mockResolvedValue(new Map([[key, { ok: false, found: false, error: '429' }]]));
    await correctEstimatedStockExits('ACC1', t0);
    mockBatch.mockResolvedValue(new Map([[key, { ok: true, found: false }]]));
    await correctEstimatedStockExits('ACC1', t0 + STOCK_EXIT_CORRECTION_INTERVAL_MS);
    await correctEstimatedStockExits('ACC1', t0 + 3 * STOCK_EXIT_CORRECTION_INTERVAL_MS);
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it('asks only about this account, and only inside the broker history window', async () => {
    const other = bracketedCoin({ key: 'cid-other-acct', accountId: 'ACC2' });
    estimatedExit(other.pos.id, etToday());
    const old = bracketedCoin({ key: 'cid-old' });
    const eightDaysAgo = etToday(Date.now() - 8 * 24 * 60 * 60 * 1000);
    estimatedExit(old.pos.id, eightDaysAgo);

    expect(await correctEstimatedStockExits('ACC1')).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('re-records a past day, so the calendar and the review read the fill', async () => {
    const yesterdayMs = Date.now() - 24 * 60 * 60 * 1000;
    const day = etToday(yesterdayMs);
    const { pos, key } = bracketedCoin({ entryDate: day });
    estimatedExit(pos.id, day);
    const row: DailyResult = {
      etDate: day,
      baselineEquityUsd: 30_401.8,
      closeEquityUsd: 27_776.75,
      accountGainPct: -8.63,
      strategyPnlUsd: 105.47,
      strategyGainPct: 0.35,
      liveTrades: 1,
      paperPnlUsd: 0,
      goalReached: false,
      giveBackHalted: false,
      drawdownHalted: false,
      accountStrategyDiverged: true,
      divergenceUsd: -2_730,
      preOpenMoveUsd: null,
      riskPerTradePct: 2.5,
      goalBasis: 'strategy',
      recordedAt: 1,
    };
    saveDailyResult(row);
    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));

    expect(await correctEstimatedStockExits('ACC1')).toBe(1);

    const after = listDailyResults(day, day)[0];
    expect(after.strategyPnlUsd).toBe(-3.22);
    // A past day keeps its account half.
    expect(after.baselineEquityUsd).toBe(30_401.8);
    expect(after.closeEquityUsd).toBe(27_776.75);
  });

  it('corrects a position materialized with its own source_intent_id the same way', async () => {
    const { pos, key } = bracketedCoin({ materialized: true });
    estimatedExit(pos.id, etToday());
    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));
    expect(await correctEstimatedStockExits('ACC1')).toBe(1);
    expect(mockBatch).toHaveBeenCalledWith('ACC1', [key]);
    expect(getPosition(pos.id)!.exits[0]).toMatchObject({ exitPrice: 204.37, exitReason: 'stop' });
  });

  it('never asks about an estimate with no entry order at all (a position the operator opened)', async () => {
    const own = createPosition({
      assetType: 'stock',
      symbol: 'SPY',
      side: 'long',
      quantity: 10,
      entryPrice: 500,
      entryDate: etToday(),
      tags: ['webull'],
      accountId: 'ACC1',
    });
    addExit(own.id, {
      quantity: 10,
      exitPrice: 501,
      exitDate: etToday(),
      exitReason: 'manual',
      notes: `${SYNC_ESTIMATE_NOTE_PREFIX} from the latest quote (not a confirmed fill)`,
    });
    expect(listSyncEstimatedExits()).toHaveLength(0);
    expect(await correctEstimatedStockExits('ACC1')).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('does nothing and reads nothing when there is no estimate to correct', async () => {
    const { pos } = bracketedCoin();
    // A close booked from its real fill carries no estimate note.
    addExit(pos.id, { quantity: 161, exitPrice: 204.37, exitDate: etToday(), exitReason: 'stop' });
    expect(await correctEstimatedStockExits('ACC1')).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

describe('matchStockHandSale', () => {
  const entered = Date.parse('2026-09-22T14:13:00Z');
  const fill = (over: Partial<BrokerEquityFill> = {}): BrokerEquityFill => ({
    clientOrderId: 'hand-1',
    comboType: 'NORMAL',
    side: 'SELL',
    symbol: 'MRNA',
    filledQty: 23,
    filledPrice: 181.2,
    filledAt: entered + 15 * 60_000,
    ...over,
  });
  const exit = { symbol: 'MRNA', quantity: 23 };
  const none = () => false;

  it('takes one sale of the whole quantity, or several adding up exactly, at their weighted price', () => {
    expect(matchStockHandSale(exit, entered, [fill()], none)).toMatchObject({ price: 181.2, qty: 23 });
    const two = matchStockHandSale(
      exit,
      entered,
      [
        fill({ clientOrderId: 'b', filledQty: 13, filledPrice: 182, filledAt: entered + 20 * 60_000 }),
        fill({ filledQty: 10, filledPrice: 181 }),
      ],
      none,
    );
    expect(two).toMatchObject({ qty: 23, clientOrderIds: ['hand-1', 'b'] });
    expect(two!.price).toBeCloseTo((10 * 181 + 13 * 182) / 23, 4);
  });

  it("ignores buys, other symbols, sales before entry, bracket legs and the app's own orders", () => {
    const noise = [
      fill({ side: 'BUY' }),
      fill({ symbol: 'MRVL' }),
      fill({ filledAt: entered - 60_000 }),
      fill({ comboType: 'STOP_LOSS' }),
      fill({ clientOrderId: 'ours' }),
    ];
    expect(matchStockHandSale(exit, entered, noise, (id) => id === 'ours')).toBeNull();
  });

  it('refuses sales that overshoot or fall short of the booked quantity', () => {
    expect(matchStockHandSale(exit, entered, [fill({ filledQty: 50 })], none)).toBeNull();
    expect(matchStockHandSale(exit, entered, [fill({ filledQty: 20 })], none)).toBeNull();
  });
});
