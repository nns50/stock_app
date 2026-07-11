import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return { ...actual, webullPlaceOrder: vi.fn(), webullOrderStatus: vi.fn(), webullCancelOrder: vi.fn() };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import {
  webullPlaceOrder,
  webullOrderStatus,
  webullCancelOrder,
  WebullOrderStatus,
} from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { listPositions } from '../src/db/positions';
import { listIntents } from '../src/db/orders';
import { listPendingLiveOrders, getLiveOrder } from '../src/db/autotradeLiveOrders';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { evaluateRiskCheck } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';
import {
  attemptLiveEntry,
  reconcileLiveOrders,
  checkLiveEquityTimeExits,
} from '../src/services/autotrading/liveExecute';

const mockGetProvider = vi.mocked(getProvider);
const mockAccountState = vi.mocked(webullAccountState);
const mockPlaceOrder = vi.mocked(webullPlaceOrder);
const mockOrderStatus = vi.mocked(webullOrderStatus);
const mockCancelOrder = vi.mocked(webullCancelOrder);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: 'AAPL',
    side: 'buy',
    entry: 100,
    stop: 95,
    target: 110,
    rMultiple: 2,
    rationale: 'fixture',
    score: 70,
    ...overrides,
  };
}

function quoteReturning(prices: Record<string, number>) {
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getCandles: vi.fn(async () => []),
  };
}

function accountStateWith(currentPositionQty: number) {
  return {
    ok: true,
    accountId: 'ACC1',
    state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty },
  };
}

function liveConfig(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    ...defaultAutotradeConfig(),
    accountEquityUsd: 100_000,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    maxHoldDays: 5,
    ...overrides,
  };
}

const origPlaceEnabled = config.trading.placeEnabled;

/** Places a real bracket entry and reconciles it to a materialized, tagged
 *  Position via the SAME codepath production uses (attemptLiveEntry ->
 *  reconcileLiveOrders), then backdates created_at so it reads as open
 *  `ageDays` days — the most realistic fixture for exercising
 *  checkLiveEquityTimeExits() against a real bracket OrderIntentRecord. */
async function openAgedLivePosition(ageDays: number) {
  mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
  mockAccountState.mockResolvedValue(accountStateWith(0) as Awaited<ReturnType<typeof webullAccountState>>);
  mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ENTRY' });
  const cfg = liveConfig();
  const okResult = evaluateRiskCheck(signal(), {
    equity: 100_000,
    dailyPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    openRisk: 0,
    openPositionsCount: 0,
    maxConcurrentPositions: 2,
    correlatedNotional: 0,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxTradesPerDay: 6,
  });
  await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);
  const entryIntentId = listIntents()[0].id;
  const quantity = okResult.sizing.suggestedQuantity;

  mockOrderStatus.mockResolvedValue({
    ok: true,
    found: true,
    status: 'FILLED',
    filledQty: quantity,
    filledPrice: 100.5,
    legs: [{ comboType: 'MASTER', status: 'FILLED' }],
  } as WebullOrderStatus);
  await reconcileLiveOrders();

  const position = listPositions({ status: 'open', symbol: 'AAPL' })[0];
  const backdated = Date.now() - ageDays * MS_PER_DAY;
  db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(backdated, position.id);

  mockGetProvider.mockReset();
  mockAccountState.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
  return { position: listPositions({ status: 'open', symbol: 'AAPL' })[0], entryIntentId, quantity };
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM trading_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM position_exits; DELETE FROM positions;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true;
  setAutotradeConfig(liveConfig());
  mockGetProvider.mockReset();
  mockAccountState.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
  mockCancelOrder.mockReset();
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

describe('checkLiveEquityTimeExits', () => {
  it('returns nothing when maxHoldDays is 0 (disabled)', async () => {
    await openAgedLivePosition(30);
    setAutotradeConfig({ maxHoldDays: 0 });
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('returns nothing when no liveAccountId is configured', async () => {
    await openAgedLivePosition(30);
    setAutotradeConfig({ liveAccountId: null });
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('returns nothing when order placement is disabled server-side', async () => {
    await openAgedLivePosition(30);
    config.trading.placeEnabled = false;
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('skips a position younger than maxHoldDays', async () => {
    await openAgedLivePosition(2); // maxHoldDays defaults to 5 in liveConfig()
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('cancels the resting bracket and places a fresh closing order once verified clear', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'CANCELLED' },
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    } as WebullOrderStatus);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    const outcomes = await checkLiveEquityTimeExits();

    expect(mockCancelOrder).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: true });

    const pending = listPendingLiveOrders();
    const exitRow = pending.find((o) => o.role === 'exit');
    expect(exitRow).toMatchObject({ symbol: 'AAPL', positionId: position.id });

    // The closing order sells (long -> sell), not buys, and closes the FULL quantity.
    const placedIntent = mockPlaceOrder.mock.calls[0][1];
    expect(placedIntent).toMatchObject({ symbol: 'AAPL', side: 'sell', openClose: 'close', quantity });
  });

  it('does not close and leaves the position open when the broker rejects the cancel', async () => {
    const { position } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: false, error: 'order already terminal' });

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('backs off without placing a new order when a bracket leg raced the cancel and already filled', async () => {
    const { position } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED' },
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    } as WebullOrderStatus);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const events = listAutotradeEvents({ symbol: 'AAPL' });
    const cancelFailedEvent = events.find((e) => e.action === 'live_time_exit_cancel_failed');
    expect(cancelFailedEvent).toBeTruthy();
    expect(JSON.parse(cancelFailedEvent!.detail!)).toMatchObject({ raced: true });
  });

  it('fails closed (no new order) when an exit leg still shows working after the cancel', async () => {
    const { position } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'WORKING' },
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    } as WebullOrderStatus);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('skips a position that already has an exit order in flight, without attempting another cancel', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'CANCELLED' },
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    } as WebullOrderStatus);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    const first = await checkLiveEquityTimeExits();
    expect(first).toHaveLength(1);
    expect(first[0].requested).toBe(true);

    mockCancelOrder.mockClear();
    const second = await checkLiveEquityTimeExits();
    expect(second).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].id).toBe(position.id); // still open, untouched
  });
});

describe('reconcileLiveOrders — time-exit closing orders', () => {
  it('closes the position once a time-exit closing order (role=exit) is reported FILLED', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'CANCELLED' },
        { comboType: 'STOP_PROFIT', status: 'CANCELLED' },
      ],
    } as WebullOrderStatus);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    await checkLiveEquityTimeExits();
    const exitIntentId = listPendingLiveOrders().find((o) => o.role === 'exit')!.intentId;

    // The closing order itself now reports FILLED at the broker.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledPrice: 101.75,
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOrders();

    expect(outcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ intentId: exitIntentId, action: 'exit_filled' })]),
    );
    expect(listPositions({ status: 'open', symbol: 'AAPL' })).toHaveLength(0);
    const closedPosition = listPositions({ status: 'closed', symbol: 'AAPL' })[0];
    expect(closedPosition.id).toBe(position.id);
    expect(closedPosition.exits[0]).toMatchObject({ exitPrice: 101.75 });
    expect(getLiveOrder(exitIntentId)?.positionId).toBe(position.id);
  });
});
