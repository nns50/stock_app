import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn(), webullAccountType: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return {
    ...actual,
    webullPlaceOrder: vi.fn(),
    webullOrderStatus: vi.fn(),
    webullCancelOrder: vi.fn(),
    listWebullOpenOrders: vi.fn(),
  };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState, webullAccountType } from '../src/providers/webull/accountState';
import {
  webullPlaceOrder,
  webullOrderStatus,
  webullCancelOrder,
  listWebullOpenOrders,
} from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setTradingConfig } from '../src/db/trading';
import { createPosition, Position } from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import { getLiveOrder } from '../src/db/autotradeLiveOrders';
import { getLiveOptionsOrder } from '../src/db/autotradeLiveOptionsOrders';
import { createLiveOptionsPosition, LiveOptionsPosition } from '../src/db/autotradeLiveOptionsPositions';
import { closeLivePosition, closeLiveOptionsAutotradePosition } from '../src/services/trading/closePosition';

const mockGetProvider = vi.mocked(getProvider);
const mockAccountState = vi.mocked(webullAccountState);
const mockAccountType = vi.mocked(webullAccountType);
const mockPlaceOrder = vi.mocked(webullPlaceOrder);
const mockOrderStatus = vi.mocked(webullOrderStatus);
const mockCancelOrder = vi.mocked(webullCancelOrder);
const mockOpenOrders = vi.mocked(listWebullOpenOrders);

/** A resting broker open order (defaults to a working SELL on AAPL — a long's
 *  bracket exit leg). */
function openOrder(overrides: Partial<import('../src/providers/webull/orders').WebullOpenOrder> = {}) {
  return {
    clientOrderId: 'EXIT-1',
    brokerOrderId: 'WB-EXIT-1',
    symbol: 'AAPL',
    side: 'sell' as const,
    status: 'WORKING',
    comboType: 'STOP_LOSS',
    ...overrides,
  };
}
const noOpenOrders = { ok: true as const, orders: [] };

function quoteReturning(prices: Record<string, number>) {
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getOptionsChain: vi.fn(async () => ({
      calls: [{ strike: 200, mark: 5, last: 5 }],
      puts: [{ strike: 200, mark: 4, last: 4 }],
    })),
  };
}

function accountStateWith(currentPositionQty: number) {
  return {
    ok: true,
    accountId: 'ACC1',
    state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty },
  };
}

/** A chain with an arbitrary set of call/put marks, keyed by strike — unlike
 *  quoteReturning()'s single fixed strike, this lets a debit-spread test
 *  supply BOTH legs' marks from the SAME mocked getOptionsChain(). */
function chainWith(entries: Array<{ strike: number; type: 'call' | 'put'; mark: number }>) {
  return {
    getQuote: vi.fn(async () => {
      throw new Error('unexpected getQuote call — options closes price off the chain, not a stock quote');
    }),
    getOptionsChain: vi.fn(async () => ({
      calls: entries.filter((e) => e.type === 'call').map((e) => ({ strike: e.strike, mark: e.mark, last: e.mark })),
      puts: entries.filter((e) => e.type === 'put').map((e) => ({ strike: e.strike, mark: e.mark, last: e.mark })),
    })),
  };
}

function openLiveOptionsPos(
  overrides: Partial<Parameters<typeof createLiveOptionsPosition>[0]> = {},
): LiveOptionsPosition {
  return createLiveOptionsPosition({
    symbol: 'NVDA',
    side: 'call',
    contractSymbol: 'NVDA-fixture',
    strike: 200,
    expiration: '2026-12-19',
    quantity: 2,
    entryPrice: 4.5,
    riskAmount: 900,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    ...overrides,
  });
}

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM autotrade_live_options_positions; DELETE FROM trading_config; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM position_exits; DELETE FROM positions;',
  );
  config.trading.placeEnabled = true;
  setTradingConfig({
    enabled: true,
    killSwitch: false,
    maxOrderUsd: 100_000,
    maxExposureUsd: 100_000,
    maxSymbolPositionQty: 10_000,
    maxDailyLossUsd: 100_000,
  });
  mockGetProvider.mockReset();
  mockAccountState.mockReset();
  mockAccountType.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
  mockCancelOrder.mockReset();
  mockOpenOrders.mockReset();
  mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
  // Default: no resting orders at the broker, so a bracketed close finds nothing
  // to cancel and proceeds. Tests exercising the cancel path override this.
  mockOpenOrders.mockResolvedValue(noOpenOrders);
  mockCancelOrder.mockResolvedValue({ ok: true });
  mockOrderStatus.mockResolvedValue({ ok: true, found: false } as Awaited<ReturnType<typeof webullOrderStatus>>);
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

function longStock(overrides: Partial<Parameters<typeof createPosition>[0]> = {}): Position {
  return createPosition({
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 100,
    entryPrice: 90,
    entryDate: '2026-07-01',
    tags: ['live', 'autotrade'],
    ...overrides,
  });
}

/** A real bracket entry intent, so pos.sourceIntentId -> getIntent().isBracket
 *  reads true, matching how autotrade's own live equity entries are always
 *  placed (see liveExecute.ts's own header comment). */
function bracketEntryIntent(symbol = 'AAPL') {
  return createIntent(
    {
      symbol,
      assetKind: 'stock',
      side: 'buy',
      openClose: 'open',
      quantity: 100,
      orderType: 'limit',
      limitPrice: 90,
      bracket: { takeProfitPrice: 110, stopLossPrice: 85 },
    },
    `entry-${symbol}-${Math.random()}`,
  );
}

describe('closeLivePosition', () => {
  it('rejects an unconfirmed order — no broker call at all, not even a bracket cancel', async () => {
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });

    const r = await closeLivePosition(pos, 'ACC1', 'nope');

    expect(r).toMatchObject({ placed: false, reason: 'not_confirmed' });
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('closes a long with no bracket directly — sells the full remaining quantity, no cancel attempted', async () => {
    const pos = longStock({ tags: ['live'] }); // no sourceIntentId -> nothing to cancel
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-1' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(r).toMatchObject({ placed: true, reason: 'placed', bracketCancelled: undefined });
    expect(mockPlaceOrder.mock.calls[0][1]).toMatchObject({
      symbol: 'AAPL',
      side: 'sell',
      openClose: 'close',
      quantity: 100,
    });
  });

  it('closes a short by BUYING to cover — confirmation phrase and order side both flip', async () => {
    const pos = longStock({ side: 'short', tags: ['live'] });
    mockAccountState.mockResolvedValue(accountStateWith(0) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-2' });

    const wrongPhrase = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');
    expect(wrongPhrase).toMatchObject({ placed: false, reason: 'not_confirmed' });

    const r = await closeLivePosition(pos, 'ACC1', 'BUY 100 AAPL');
    expect(r).toMatchObject({ placed: true });
    expect(mockPlaceOrder.mock.calls[0][1]).toMatchObject({ side: 'buy', openClose: 'close', quantity: 100 });
  });

  it('cancels the resting exit leg found in the broker open orders (by its OWN id), then places the close', async () => {
    // The core of the ATAI fix: the stop/target legs each have their own
    // client_order_id (not the entry's), so we recover them from the live
    // open-orders list and cancel each by that id before closing.
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders
      .mockResolvedValueOnce({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-1' })] }) // scan finds the resting stop
      .mockResolvedValueOnce(noOpenOrders); // re-scan after cancel: cleared
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-3' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(mockCancelOrder).toHaveBeenCalledWith('ACC1', 'STOP-1'); // cancelled by the leg's OWN id
    expect(r).toMatchObject({ placed: true, bracketCancelled: true });
    expect(mockPlaceOrder.mock.calls[0][1]).toMatchObject({ side: 'sell', openClose: 'close', quantity: 100 });
  });

  it('closes when the broker shows no resting exit order — the bracket was already gone', async () => {
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders.mockResolvedValue(noOpenOrders); // nothing resting
    mockOrderStatus.mockResolvedValue({ ok: true, found: false }); // and no filled leg either
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-GONE' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(mockCancelOrder).not.toHaveBeenCalled(); // nothing to cancel
    expect(r).toMatchObject({ placed: true });
    expect(mockPlaceOrder.mock.calls[0][1]).toMatchObject({ side: 'sell', openClose: 'close', quantity: 100 });
  });

  it('blocks the close (double-up risk) when a resting exit leg does not clear after cancel', async () => {
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-STUCK' })] }); // both scans still show it
    mockCancelOrder.mockResolvedValue({ ok: true });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(r.error).toMatch(/did not clear after cancel/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('blocks the close when the broker open orders cannot be read (fail closed)', async () => {
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders.mockResolvedValue({ ok: false, orders: [], error: 'Webull open-orders failed (500)' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('only cancels EXIT-side orders — leaves an unrelated opposite-side resting order alone', async () => {
    const entry = bracketEntryIntent(); // a long: exit side is SELL
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [openOrder({ side: 'buy', clientOrderId: 'BUY-1' })] });
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-BUYLEFT' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(mockCancelOrder).not.toHaveBeenCalled(); // the resting BUY is not a long's exit leg
    expect(r).toMatchObject({ placed: true });
  });

  it('places NOTHING and reports the position is already closing when a stop/target raced (filled)', async () => {
    const entry = bracketEntryIntent();
    const pos = longStock({ sourceIntentId: entry.id });
    mockOpenOrders.mockResolvedValue(noOpenOrders); // the filled leg is terminal — not in open orders
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED' }, // raced — the stop filled
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(r.error).toMatch(/already closing/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('does not attempt a bracket cancel when the entry intent was never a bracket', async () => {
    const entry = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 100,
        orderType: 'limit',
        limitPrice: 90,
      },
      `entry-plain-${Math.random()}`,
    );
    const pos = longStock({ sourceIntentId: entry.id, tags: ['live'] });
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-4' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(r).toMatchObject({ placed: true, bracketCancelled: undefined });
  });

  it('builds a marketable-limit OPTION closing order (sell to close a long call) from a fresh mark', async () => {
    const pos = createPosition({
      assetType: 'option',
      symbol: 'NVDA',
      side: 'long',
      quantity: 2,
      entryPrice: 4.5,
      entryDate: '2026-07-01',
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
      tags: ['live'],
    });
    // currentPositionQty must reflect what's actually held (2 long contracts)
    // — selling to close against a reported 0 would trip the naked-short
    // guardrail, same reasoning liveOptionsExecute.ts's own
    // currentPositionQtyOverride exists to avoid for the real path.
    mockAccountState.mockResolvedValue(accountStateWith(2) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-OPT' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 2 NVDA');

    expect(r).toMatchObject({ placed: true });
    const placed = mockPlaceOrder.mock.calls[0][1];
    expect(placed).toMatchObject({
      symbol: 'NVDA',
      assetKind: 'option',
      side: 'sell',
      openClose: 'close',
      quantity: 2,
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
    });
    // Mark is 5 (mocked); selling to close prices BELOW the mark to guarantee a fill.
    expect(placed.limitPrice).toBeLessThan(5);
  });

  it('registers the exit with autotrade bookkeeping for an autotrade-tagged EQUITY position, so the maxHoldDays dedup guard sees it', async () => {
    const pos = longStock({ tags: ['live', 'autotrade'] });
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-5' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r.placed).toBe(true);
    const registered = getLiveOrder(r.intent!.id);
    expect(registered).toMatchObject({ role: 'exit', positionId: pos.id, symbol: 'AAPL' });
  });

  it('does NOT register a plain (non-autotrade) live equity close — the generic order reconcile handles it instead', async () => {
    const pos = longStock({ tags: ['live'] }); // no 'autotrade' tag
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-6' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r.placed).toBe(true);
    expect(getLiveOrder(r.intent!.id)).toBeUndefined();
  });

  it('never registers an OPTIONS close with autotrade bookkeeping, even if the position were somehow tagged autotrade', async () => {
    const pos = createPosition({
      assetType: 'option',
      symbol: 'NVDA',
      side: 'long',
      quantity: 1,
      entryPrice: 4.5,
      entryDate: '2026-07-01',
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
      tags: ['live', 'autotrade'],
    });
    mockAccountState.mockResolvedValue(accountStateWith(1) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE-OPT-2' });

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 1 NVDA');

    expect(r.placed).toBe(true);
    expect(getLiveOrder(r.intent!.id)).toBeUndefined();
  });

  it('does not register anything when placement itself is blocked (e.g. kill switch)', async () => {
    setTradingConfig({ enabled: true, killSwitch: true });
    const pos = longStock({ tags: ['live', 'autotrade'] });
    mockAccountState.mockResolvedValue(accountStateWith(100) as Awaited<ReturnType<typeof webullAccountState>>);

    const r = await closeLivePosition(pos, 'ACC1', 'SELL 100 AAPL');

    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(getLiveOrder(r.intent!.id)).toBeUndefined();
  });
});

describe('closeLiveOptionsAutotradePosition', () => {
  it('rejects an unconfirmed order — checked BEFORE building the intent, not just before placeOrder', async () => {
    const pos = openLiveOptionsPos();

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'nope');

    expect(r).toMatchObject({ placed: false, reason: 'not_confirmed' });
    // placeOrder() has its own independent confirmation re-check, so a
    // not_confirmed result alone doesn't prove THIS function's own early
    // check fired — mockGetProvider not being touched proves it returned
    // before buildLiveOptionsCloseIntent() ever fetched a quote.
    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('builds a marketable-limit SINGLE_LEG closing order (always a sell) from a fresh mark', async () => {
    const pos = openLiveOptionsPos({ side: 'call', strike: 200, quantity: 2, expiration: '2026-12-19' });
    mockGetProvider.mockReturnValue(
      chainWith([{ strike: 200, type: 'call', mark: 6 }]) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(accountStateWith(2) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OPT-CLOSE-1' });

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'SELL 2 NVDA');

    expect(r).toMatchObject({ placed: true });
    const placed = mockPlaceOrder.mock.calls[0][1];
    expect(placed).toMatchObject({
      symbol: 'NVDA',
      assetKind: 'option',
      side: 'sell',
      openClose: 'close',
      quantity: 2,
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
    });
    // Selling to close prices BELOW the mark to guarantee a fill.
    expect(placed.limitPrice).toBeLessThan(6);
  });

  it('builds a DEBIT_SPREAD closing order — fetches BOTH legs from the same chain, sells the spread net', async () => {
    const pos = openLiveOptionsPos({
      kind: 'debit_spread',
      side: 'call',
      strike: 200,
      shortContractSymbol: 'NVDA-short',
      shortStrike: 210,
      shortEntryPrice: 1,
      quantity: 3,
    });
    mockGetProvider.mockReturnValue(
      chainWith([
        { strike: 200, type: 'call', mark: 6 },
        { strike: 210, type: 'call', mark: 2 },
      ]) as ReturnType<typeof getProvider>,
    );
    mockAccountType.mockResolvedValue('MARGIN');
    mockAccountState.mockResolvedValue(accountStateWith(3) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OPT-CLOSE-SPREAD' });

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'SELL 3 NVDA');

    expect(r).toMatchObject({ placed: true });
    const placed = mockPlaceOrder.mock.calls[0][1];
    expect(placed).toMatchObject({
      symbol: 'NVDA',
      assetKind: 'option',
      side: 'sell',
      openClose: 'close',
      quantity: 3,
      optionStrategy: 'VERTICAL',
      optionLegs: [
        { side: 'sell', optionType: 'call', strike: 200, expiration: pos.expiration },
        { side: 'buy', optionType: 'call', strike: 210, expiration: pos.expiration },
      ],
    });
    // Net value is 6 - 2 = 4; selling the spread to close prices BELOW that.
    expect(placed.limitPrice).toBeLessThan(4);
  });

  it('registers exitReason "manual" UNCONDITIONALLY on success — every row here is autotrade\'s own', async () => {
    const pos = openLiveOptionsPos();
    mockGetProvider.mockReturnValue(
      chainWith([{ strike: 200, type: 'call', mark: 6 }]) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(accountStateWith(2) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OPT-CLOSE-2' });

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'SELL 2 NVDA');

    expect(r.placed).toBe(true);
    const registered = getLiveOptionsOrder(r.intent!.id);
    expect(registered).toMatchObject({
      role: 'exit',
      kind: 'single_leg',
      positionId: pos.id,
      symbol: 'NVDA',
      exitReason: 'manual',
    });
  });

  it('does not register anything when placement itself is blocked (e.g. kill switch)', async () => {
    setTradingConfig({ enabled: true, killSwitch: true });
    const pos = openLiveOptionsPos();
    mockGetProvider.mockReturnValue(
      chainWith([{ strike: 200, type: 'call', mark: 6 }]) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(accountStateWith(2) as Awaited<ReturnType<typeof webullAccountState>>);

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'SELL 2 NVDA');

    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(getLiveOptionsOrder(r.intent!.id)).toBeUndefined();
  });

  it('rejects with account_error and never calls placeOrder when the contract has no usable quote', async () => {
    const pos = openLiveOptionsPos();
    // No matching strike in the mocked chain -> fetchContractMark() throws
    // inside buildLiveOptionsCloseIntent(), before placeOrder() is ever reached.
    mockGetProvider.mockReturnValue(chainWith([]) as ReturnType<typeof getProvider>);

    const r = await closeLiveOptionsAutotradePosition(pos, 'ACC1', 'SELL 2 NVDA');

    expect(r).toMatchObject({ placed: false, reason: 'account_error' });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });
});
