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
  matchSaleOutsideBracket,
  resetStockExitCorrectionState,
  STOCK_EXIT_CORRECTION_INTERVAL_MS,
} from '../src/services/autotrading/stockExitCorrection';
import { getLivePortfolioSnapshot } from '../src/services/autotrading/liveExecute';
import { collectExecutionFindings } from '../src/services/autotrading/edgeLeakScanData';
import { etDateTimeToMs, etToday } from '../src/util/marketDate';
import type { PositionExitReason } from '../src/db/positions';

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
function estimatedExit(
  positionId: number,
  exitDate: string,
  exitPrice = 205.0451,
  exitReason: PositionExitReason = 'manual',
) {
  addExit(positionId, {
    quantity: 161,
    exitPrice,
    exitDate,
    exitReason,
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

    // A working leg on the day of the close is the lists lagging, not a skip.
    expect(listAutotradeEvents({ actions: ['live_exit_correction_skipped'] })).toHaveLength(0);

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
    orderType: 'LIMIT',
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
    // Left an estimate for good, and said so: today's unmatched close was not.
    const skipped = listAutotradeEvents({ actions: ['live_exit_correction_skipped'] });
    expect(skipped.map((e) => JSON.parse(e.detail!))).toEqual([
      expect.objectContaining({ positionId: old.pos.id, cause: 'no_matching_sale' }),
    ]);
  });

  // LITE, 2026-09-21: the entry's legs never rested and the automatic re-arm
  // failed, so a bracket was placed by hand, and its stop filled. The entry's
  // own combo shows no filled leg, and the match read only NORMAL orders, so
  // the estimate stayed for good and nothing said so.
  it("books a stop filled in a bracket placed outside the entry's, as a stop", async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday());
    expect(getLivePortfolioSnapshot().consecutiveLosses).toBe(0);
    mockBatch.mockResolvedValue(cancelledBracket(key));
    mockEquityFills.mockResolvedValue({
      ok: true,
      fills: [handSale({ comboType: 'STOP_LOSS', orderType: 'STOP_LOSS', filledPrice: 204.37 })],
    });

    expect(await correctEstimatedStockExits('ACC1')).toBe(1);

    const fixed = getPosition(pos.id)!;
    expect(fixed.exits[0]).toMatchObject({ exitPrice: 204.37, exitReason: 'stop' });
    expect(fixed.exits[0].notes).toMatch(/placed outside the entry bracket/);
    const [row] = listAutotradeEvents({ actions: ['live_exit_corrected'] });
    expect(JSON.parse(row.detail!)).toMatchObject({
      source: 'outside_bracket',
      toPrice: 204.37,
      fromReason: 'manual',
      toReason: 'stop',
    });
    // The step-down's consumer reads the loss the fill proves.
    expect(getLivePortfolioSnapshot().consecutiveLosses).toBe(1);
    // And the leak scan counts it under its own label, read off the row the pass wrote.
    const findings = new Map(collectExecutionFindings(Date.now()).map((f) => [f.action, f]));
    expect(findings.get('live_exit_corrected|outside_bracket')?.count).toBe(1);
  });

  it("books a hand sale 'manual', even where the sync inferred a stop from the price", async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday(), 204.3, 'stop');
    mockBatch.mockResolvedValue(cancelledBracket(key));
    mockEquityFills.mockResolvedValue({ ok: true, fills: [handSale({ filledPrice: 204.35 })] });

    expect(await correctEstimatedStockExits('ACC1')).toBe(1);

    expect(getPosition(pos.id)!.exits[0]).toMatchObject({ exitPrice: 204.35, exitReason: 'manual' });
    const [row] = listAutotradeEvents({ actions: ['live_exit_corrected'] });
    expect(JSON.parse(row.detail!)).toMatchObject({ source: 'broker_history', fromReason: 'stop', toReason: 'manual' });
  });

  it('confirms an estimate the fill already matches, and never asks about it again', async () => {
    const { pos, key } = bracketedCoin();
    estimatedExit(pos.id, etToday(), 204.3701, 'stop');
    mockBatch.mockResolvedValue(combo(key, [stopLeg(), targetLeg()]));

    expect(await correctEstimatedStockExits('ACC1')).toBe(0);

    const row = getPosition(pos.id)!.exits[0];
    expect(row).toMatchObject({ exitPrice: 204.3701, exitReason: 'stop' });
    expect(row.notes).toMatch(/confirmed against the broker's actual fill/);
    expect(listSyncEstimatedExits()).toHaveLength(0);
    expect(listAutotradeEvents({ actions: ['live_exit_corrected', 'live_exit_correction_skipped'] })).toHaveLength(0);
    // A restart asks about every open estimate once more; this is not one.
    resetStockExitCorrectionState();
    await correctEstimatedStockExits('ACC1');
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  describe('an estimate left alone says why', () => {
    const skips = () =>
      listAutotradeEvents({ actions: ['live_exit_correction_skipped'] }).map(
        (e) => JSON.parse(e.detail!) as Record<string, unknown>,
      );

    it('a filled leg that does not cover the booked quantity, with the legs as evidence', async () => {
      const { pos, key } = bracketedCoin();
      estimatedExit(pos.id, etToday());
      mockBatch.mockResolvedValue(combo(key, [stopLeg({ filledQty: 100 }), targetLeg()]));
      await correctEstimatedStockExits('ACC1');
      const [row] = skips();
      expect(row).toMatchObject({ positionId: pos.id, cause: 'quantity_mismatch' });
      expect(row.legs).toContainEqual(
        expect.objectContaining({ comboType: 'STOP_LOSS', status: 'FILLED', filledQty: 100 }),
      );
      expect(getPosition(pos.id)!.exits[0].exitPrice).toBe(205.0451);
    });

    it('a close no set of fills adds up to, listing the sells it read', async () => {
      const day = etToday(Date.now() - 24 * 60 * 60 * 1000);
      const { pos, key } = bracketedCoin({ entryDate: day });
      estimatedExit(pos.id, day);
      mockBatch.mockResolvedValue(cancelledBracket(key));
      mockEquityFills.mockResolvedValue({
        ok: true,
        fills: [handSale({ filledQty: 100, filledAt: etDateTimeToMs(day, '10:30')! })],
      });
      await correctEstimatedStockExits('ACC1');
      const [row] = skips();
      expect(row).toMatchObject({ positionId: pos.id, cause: 'no_matching_sale' });
      expect(row.sells).toEqual([expect.objectContaining({ qty: 100, comboType: 'NORMAL', appOrder: false })]);
      // The scan reads the cause off the row the pass wrote.
      const findings = new Map(collectExecutionFindings(Date.now()).map((f) => [f.action, f]));
      expect(findings.get('live_exit_correction_skipped|no_matching_sale')?.count).toBe(1);
    });

    it('a leg still working from the day after the close, once a day', async () => {
      const t0 = Date.now();
      const day = etToday(t0 - 24 * 60 * 60 * 1000);
      const { pos, key } = bracketedCoin({ entryDate: day });
      estimatedExit(pos.id, day);
      mockBatch.mockResolvedValue(combo(key, [stopLeg({ status: 'WORKING', filledQty: 0 }), targetLeg()]));
      await correctEstimatedStockExits('ACC1', t0);
      await correctEstimatedStockExits('ACC1', t0 + STOCK_EXIT_CORRECTION_INTERVAL_MS);
      expect(skips()).toEqual([expect.objectContaining({ positionId: pos.id, cause: 'combo_working' })]);
      // Still asked about (the broker may yet finish it), and stated again the next day.
      await correctEstimatedStockExits('ACC1', t0 + 24 * 60 * 60 * 1000);
      expect(mockBatch).toHaveBeenCalledTimes(3);
      expect(skips()).toHaveLength(2);
    });

    it('an estimate whose entry order is gone from the record', async () => {
      const { pos, intent } = bracketedCoin({ materialized: true });
      estimatedExit(pos.id, etToday());
      // Only reachable with a record that lost its intent: the live order row
      // cascades with it, so this needs the materialized link and no FK.
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM order_intents WHERE id = ?').run(intent.id);
      db.pragma('foreign_keys = ON');
      await correctEstimatedStockExits('ACC1');
      expect(skips()).toEqual([expect.objectContaining({ positionId: pos.id, cause: 'entry_order_missing' })]);
      expect(mockBatch).not.toHaveBeenCalled();
    });
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
    // A failed read is not a skip: nothing is stated, and it is asked again.
    expect(listAutotradeEvents({ actions: ['live_exit_correction_skipped'] })).toHaveLength(0);
    mockBatch.mockResolvedValue(new Map([[key, { ok: true, found: false }]]));
    await correctEstimatedStockExits('ACC1', t0 + STOCK_EXIT_CORRECTION_INTERVAL_MS);
    await correctEstimatedStockExits('ACC1', t0 + 3 * STOCK_EXIT_CORRECTION_INTERVAL_MS);
    expect(mockBatch).toHaveBeenCalledTimes(2);
    // A restart asks once more, and the skip is still stated once.
    resetStockExitCorrectionState();
    await correctEstimatedStockExits('ACC1', t0 + 4 * STOCK_EXIT_CORRECTION_INTERVAL_MS);
    const skipped = listAutotradeEvents({ actions: ['live_exit_correction_skipped'] });
    expect(skipped.map((e) => JSON.parse(e.detail!))).toEqual([
      expect.objectContaining({ positionId: pos.id, cause: 'aged_out', exitPrice: 205.0451 }),
    ]);
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

describe('matchSaleOutsideBracket', () => {
  const entered = Date.parse('2026-09-22T14:13:00Z');
  const fill = (over: Partial<BrokerEquityFill> = {}): BrokerEquityFill => ({
    clientOrderId: 'hand-1',
    comboType: 'NORMAL',
    orderType: 'LIMIT',
    side: 'SELL',
    symbol: 'MRNA',
    filledQty: 23,
    filledPrice: 181.2,
    filledAt: entered + 15 * 60_000,
    ...over,
  });
  const exit = { symbol: 'MRNA', quantity: 23, exitDate: '2026-09-22' };
  const none = () => false;

  it('takes one sale of the whole quantity, or several adding up exactly, at their weighted price', () => {
    expect(matchSaleOutsideBracket(exit, entered, [fill()], none)).toMatchObject({
      price: 181.2,
      qty: 23,
      reason: 'manual',
      source: 'broker_history',
    });
    const two = matchSaleOutsideBracket(
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

  // LITE, 2026-09-21: the entry's legs never rested, the re-arm failed, and the
  // stop that filled was in a bracket placed by hand. Until this, only NORMAL
  // orders were candidates, so the fill that closed it could not be read.
  it("reads a stop or target filled in a bracket placed outside the entry's, with the reason it proves", () => {
    const stop = { comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' };
    expect(matchSaleOutsideBracket(exit, entered, [fill(stop)], none)).toMatchObject({
      reason: 'stop',
      source: 'outside_bracket',
    });
    // A combo label the history does not spell as a leg: the stop order type says it.
    expect(
      matchSaleOutsideBracket(exit, entered, [fill({ comboType: 'OCO', orderType: 'STOP_LOSS' })], none),
    ).toMatchObject({ reason: 'stop', source: 'outside_bracket' });
    expect(matchSaleOutsideBracket(exit, entered, [fill({ comboType: 'STOP_PROFIT' })], none)).toMatchObject({
      reason: 'target',
      source: 'outside_bracket',
    });
    // Part on a stop leg, the rest sold by hand: a mix is the operator's close.
    expect(
      matchSaleOutsideBracket(
        exit,
        entered,
        [
          fill({ ...stop, filledQty: 10 }),
          fill({ clientOrderId: 'b', filledQty: 13, filledAt: entered + 20 * 60_000 }),
        ],
        none,
      ),
    ).toMatchObject({ qty: 23, reason: 'manual', source: 'broker_history' });
  });

  it("ignores buys, other symbols, opening orders, the app's own orders, and fills outside the position's life", () => {
    const noise = [
      fill({ side: 'BUY' }),
      fill({ symbol: 'MRVL' }),
      fill({ filledAt: entered - 60_000 }),
      // The shares were gone when the sync booked the close on 09-22, so a
      // sale the next day belongs to a later position.
      fill({ filledAt: Date.parse('2026-09-23T14:00:00Z') }),
      fill({ comboType: 'MASTER' }),
      fill({ clientOrderId: 'ours' }),
    ];
    expect(matchSaleOutsideBracket(exit, entered, noise, (id) => id === 'ours')).toBeNull();
  });

  it('refuses sales that overshoot or fall short of the booked quantity', () => {
    expect(matchSaleOutsideBracket(exit, entered, [fill({ filledQty: 50 })], none)).toBeNull();
    expect(matchSaleOutsideBracket(exit, entered, [fill({ filledQty: 20 })], none)).toBeNull();
  });
});
