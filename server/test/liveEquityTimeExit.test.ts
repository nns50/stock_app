import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  const { batchFromSingle } = await import('./helpers/webullOrderStatusMock');
  const webullOrderStatus = vi.fn();
  return {
    ...actual,
    webullPlaceOrder: vi.fn(),
    webullOrderStatus,
    webullOrderStatusBatch: batchFromSingle(webullOrderStatus),
    webullCancelOrder: vi.fn(),
    listWebullOpenOrders: vi.fn(),
  };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import {
  webullPlaceOrder,
  webullOrderStatus,
  webullCancelOrder,
  listWebullOpenOrders,
  WebullOrderStatus,
} from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { createPosition, listPositions } from '../src/db/positions';
import { createIntent, getIntent, listIntents, type OrderIntentRecord } from '../src/db/orders';
import { listPendingLiveOrders, getLiveOrder } from '../src/db/autotradeLiveOrders';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { evaluateRiskCheck } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';
import {
  attemptLiveEntry,
  reconcileLiveOrders,
  checkLiveEquityTimeExits,
  cancelLiveBracketExitLegs,
  checkLiveBracketProtection,
} from '../src/services/autotrading/liveExecute';

const mockGetProvider = vi.mocked(getProvider);
const mockAccountState = vi.mocked(webullAccountState);
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

function quoteReturning(prices: Record<string, number>): ReturnType<typeof getProvider> {
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getCandles: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getProvider>;
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
    sectorNotional: 0,
    maxSectorExposurePct: 20,
    candidateSector: null,
    correlationThreshold: 0.7,
    marketAtrPct: null,
    regimeAtrThresholdPct: 3,
    regimeSizeCutPct: 0,
  });
  await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);
  const entryIntentId = listIntents()[0].id;
  // The quantity actually ORDERED, which post-probation/cap adjustments can be
  // smaller than the raw suggestion. The broker can't fill more than was
  // ordered, so mocking the suggestion here would make the fixture describe an
  // impossible fill — one reconcile now (correctly) refuses to book in full.
  const quantity = getIntent(entryIntentId)!.quantity;

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
  mockOpenOrders.mockReset();
  // Default: no resting orders at the broker, so a triggered force-close finds
  // nothing to cancel and proceeds. Tests exercising the cancel path override.
  mockOpenOrders.mockResolvedValue(noOpenOrders);
  mockCancelOrder.mockResolvedValue({ ok: true });
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

  it('cancels the resting exit leg (by its own id) and places a fresh closing order once cleared', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockOpenOrders
      .mockResolvedValueOnce({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-1' })] }) // scan finds the resting stop
      .mockResolvedValueOnce(noOpenOrders); // re-scan after cancel: cleared
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    const outcomes = await checkLiveEquityTimeExits();

    expect(mockCancelOrder).toHaveBeenCalledWith('ACC1', 'STOP-1'); // cancelled by the leg's OWN id
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: true });

    const exitRow = listPendingLiveOrders().find((o) => o.role === 'exit');
    expect(exitRow).toMatchObject({ symbol: 'AAPL', positionId: position.id });

    // The closing order sells (long -> sell), not buys, and closes the FULL quantity.
    const placedIntent = mockPlaceOrder.mock.calls[0][1];
    expect(placedIntent).toMatchObject({ symbol: 'AAPL', side: 'sell', openClose: 'close', quantity });
  });

  it('closes without cancelling anything when the broker shows no resting exit order (bracket already gone)', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus); // no filled leg either
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    const outcomes = await checkLiveEquityTimeExits();

    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: true });
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });

  it('an AMBIGUOUS close stays pending, so the next tick cannot place a second one', async () => {
    // Worse here than on entry: the bracket has already been cancelled by this
    // point, so treating an unknown outcome as a rejection would empty
    // pendingExitPositionIds and the next tick would place a SECOND close
    // against a position whose first close may already have filled — for a long
    // that means selling twice and ending up short.
    const { position, quantity } = await openAgedLivePosition(30);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    mockCancelOrder.mockResolvedValue({ ok: true });
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Request timed out', ambiguous: true });

    const outcomes = await checkLiveEquityTimeExits();
    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: false });
    expect(outcomes[0].reason ?? '').toMatch(/unknown/i);

    // Second tick: the recorded exit order keeps this position out of the sweep.
    mockPlaceOrder.mockClear();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DUP-CLOSE' });
    await checkLiveEquityTimeExits();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('never cancels the protective bracket when the close would be blocked (kill switch)', async () => {
    // The bug: the bracket was cancelled and confirmed cleared BEFORE the close
    // was evaluated, so any blocking guardrail left a real position with no stop
    // at the broker and no closing order — and it could not self-heal, because a
    // rejected intent never becomes a pending exit order, so the next tick did it
    // again. The kill switch is the easiest trigger, which made "stop trading"
    // the gesture most likely to strip a position's protection.
    const { position, quantity } = await openAgedLivePosition(30);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-1' })] });
    mockCancelOrder.mockResolvedValue({ ok: true });
    setAutotradeConfig({ killSwitch: true });

    const outcomes = await checkLiveEquityTimeExits();

    // The stop stays where it is, and no close is placed.
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(outcomes.every((o) => o.requested === false)).toBe(true);
    expect(listPositions({ status: 'open' })).toHaveLength(1);
    void position;
  });

  it('does not close (double-up risk) when a resting exit leg does not clear after cancel', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-STUCK' })] }); // both scans still show it
    mockCancelOrder.mockResolvedValue({ ok: true });
    // The close is now evaluated (quote, account state, guardrails) BEFORE the
    // bracket is cancelled, so these have to be set for the test to reach the
    // cancel step it is actually about.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: false });
    expect(outcomes[0].reason).toMatch(/did not clear after cancel/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('fails closed (no new order) when the broker open orders cannot be read', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockOpenOrders.mockResolvedValue({ ok: false, orders: [], error: 'Webull open-orders failed (500)' });
    // The close is now evaluated (quote, account state, guardrails) BEFORE the
    // bracket is cancelled, so these have to be set for the test to reach the
    // cancel step it is actually about.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('backs off without placing a new order when a bracket leg raced the cancel and already filled', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockOpenOrders.mockResolvedValue(noOpenOrders); // the filled leg is terminal — not in open orders
    // The close is now evaluated (quote, account state, guardrails) BEFORE the
    // bracket is cancelled, so these have to be set for the test to reach the
    // cancel step it is actually about.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
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

// ---------------------------------------------------------------------------
// An empty restingExitOrders() result is a FILTER result, not a fact: it means
// "nothing matched", which is produced both by a genuinely clear exit side and
// by a real resting stop the lenient open-order parsing couldn't read. Those
// have opposite consequences — the second places a close alongside a working
// stop, and filling both leaves a long flipped short, tracked nowhere until a
// later broker sync imports the result as an orphan. These cover the ways of
// not seeing a leg that must NOT be read as "the bracket is gone".
// ---------------------------------------------------------------------------
describe('cancelLiveBracketExitLegs — absence of evidence', () => {
  const bracketEntry = (over: Partial<Parameters<typeof createIntent>[0]> = {}): OrderIntentRecord =>
    createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 100,
        bracket: { stopLossPrice: 95, takeProfitPrice: 110 },
        ...over,
      },
      `cid-${Math.random()}`,
    );

  it('refuses when a resting order carried no readable symbol', async () => {
    // The symbol filter is what produced "nothing on AAPL"; if a resting order's
    // symbol wouldn't parse, that order could be the stop.
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [{ clientOrderId: 'X', side: 'sell', status: 'WORKING' }], // no symbol
    });
    const r = await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no readable symbol/i);
    expect(mockOrderStatus).not.toHaveBeenCalled();
  });

  it('refuses when a resting order on the symbol has an unreadable side', async () => {
    // normalizeSide returns undefined for a value it doesn't recognize, and
    // restingExitOrders requires a POSITIVE side match — so an exit leg whose
    // side field changed name or format silently drops out of the filter.
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [{ clientOrderId: 'X', symbol: 'AAPL', side: undefined, status: 'WORKING' }],
    });
    const r = await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be identified/i);
  });

  it('refuses when an exit-side order has no client order id to cancel it by', async () => {
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [{ symbol: 'AAPL', side: 'sell', status: 'WORKING' }], // no clientOrderId
    });
    const r = await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be identified/i);
  });

  it('refuses when the race check itself could not be run', async () => {
    // A bracket WAS placed, so seeing none of its legs is contradictory. The
    // combo status is the only other witness; failing to read it leaves the
    // question open rather than answering it "safe".
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: false, found: false, error: 'Webull down' } as WebullOrderStatus);
    const r = await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/raced the close/i);
  });

  it('still allows the close when the list is clean and the broker just has no record', async () => {
    // An entry old enough to hit maxHoldDays has very likely aged out of order
    // history, so `found: false` must stay allowable — blocking on it would
    // break the close for exactly the positions this path serves.
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    expect(await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1')).toMatchObject({ ok: true });
  });

  it('ignores TERMINAL orders that could not be parsed — they cannot fill', async () => {
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [
        { status: 'CANCELLED' }, // unparseable, but terminal
        { status: 'FILLED', symbol: undefined, side: undefined },
      ],
    });
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    expect(await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1')).toMatchObject({ ok: true });
  });

  it('skips the race check entirely for an entry that never had a bracket', async () => {
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    const r = await cancelLiveBracketExitLegs(bracketEntry({ bracket: undefined }), 'ACC1');
    expect(r).toMatchObject({ ok: true });
    expect(mockOrderStatus).not.toHaveBeenCalled(); // nothing to have missed
  });

  it('refuses when the post-cancel re-scan cannot be read', async () => {
    // The re-scan is the entire proof the cancel took effect — an unparseable
    // one filters down to empty, which looks exactly like success.
    mockOpenOrders
      .mockResolvedValueOnce({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-1' })] })
      .mockResolvedValueOnce({ ok: true, orders: [{ clientOrderId: 'STOP-1', status: 'WORKING' }] }); // symbol lost
    mockCancelOrder.mockResolvedValue({ ok: true });
    const r = await cancelLiveBracketExitLegs(bracketEntry(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not confirm they cleared/i);
  });

  it('blocks the whole force-close end to end, leaving the position and its stop alone', async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [{ clientOrderId: 'MYSTERY', symbol: 'AAPL', status: 'WORKING' }], // side unreadable
    });

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open' })).toHaveLength(1);
    // And it is journaled, so the ambiguity alert can surface it.
    expect(
      listAutotradeEvents({ stage: 'execution', actions: ['live_time_exit_cancel_failed'] }).length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A bracket is submitted as one request and its acceptance is never verified
// per-leg — the only per-leg signal is combo_type, which WebullOrderLeg marks
// unconfirmed. So if Webull takes the entry and drops the exits, the position
// is naked while the ledger still shows a stop price. This asks the question
// the open-orders endpoint CAN answer, and only reports.
// ---------------------------------------------------------------------------
describe('checkLiveBracketProtection', () => {
  /** The protection check ignores positions younger than its grace period. */
  const aged = async () => {
    const { position, quantity } = await openAgedLivePosition(30);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    return position;
  };
  const unprotectedFlags = () => listAutotradeEvents({ stage: 'execution', actions: ['live_position_unprotected'] });

  it('reports a position whose stop is resting at the broker as protected', async () => {
    const position = await aged();
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [openOrder({ clientOrderId: 'STOP-1' })] });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes).toEqual([expect.objectContaining({ positionId: position.id, protectedAtBroker: true })]);
    expect(unprotectedFlags()).toHaveLength(0);
  });

  it('flags a position with NO resting exit order — the naked case', async () => {
    const position = await aged();
    mockOpenOrders.mockResolvedValue(noOpenOrders);

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ positionId: position.id, protectedAtBroker: false });
    expect(outcomes[0].unknown).toBeUndefined();
    const flag = unprotectedFlags();
    expect(flag).toHaveLength(1);
    expect(flag[0].detail ?? '').toMatch(/no resting sell order/i);
    // Reports only — it must never place anything to "fix" this.
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('says UNKNOWN rather than unprotected when the list cannot be parsed', async () => {
    // Same guard the cancel path uses. Calling a parse miss "unprotected" would
    // cry wolf, and this alert is only useful if it is believed.
    const position = await aged();
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [{ clientOrderId: 'X', side: 'sell', status: 'WORKING' }], // no symbol
    });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ positionId: position.id, protectedAtBroker: false });
    expect(outcomes[0].unknown).toMatch(/no readable symbol/i);
    expect(unprotectedFlags()).toHaveLength(0); // not claimed as naked
  });

  it('says nothing when the broker cannot be reached', async () => {
    await aged();
    mockOpenOrders.mockResolvedValue({ ok: false, orders: [], error: 'Webull down' });
    expect(await checkLiveBracketProtection()).toEqual([]);
    expect(unprotectedFlags()).toHaveLength(0);
  });

  it('skips a freshly-opened position until the grace period elapses', async () => {
    const position = await aged();
    db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(Date.now(), position.id);
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    expect(await checkLiveBracketProtection()).toEqual([]);
  });

  it('journals once per day, not once per tick', async () => {
    await aged();
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    await checkLiveBracketProtection();
    await checkLiveBracketProtection();
    await checkLiveBracketProtection();
    expect(unprotectedFlags()).toHaveLength(1);
  });

  it('ignores a position held in a DIFFERENT account', async () => {
    // A cash + margin pair on one login is the ordinary case. Comparing every
    // account's positions against ONE account's resting orders reports the
    // other account's healthy positions as naked, and an alert that fires on
    // healthy positions trains you to ignore the one that matters.
    const position = await aged();
    db.prepare('UPDATE positions SET account_id = ? WHERE id = ?').run('OTHER-ACCT', position.id);
    mockOpenOrders.mockResolvedValue(noOpenOrders); // ACC1 has nothing resting

    expect(await checkLiveBracketProtection()).toEqual([]);
    expect(unprotectedFlags()).toHaveLength(0);
  });

  it('still checks an unassigned position when only ONE account is known', async () => {
    // Legacy rows predate the account column. With a single account they can
    // only belong to it, so they are still checkable — same rule
    // closePositionsFromPreview uses for the mirror-image decision.
    const position = await aged();
    db.prepare('UPDATE positions SET account_id = NULL WHERE id = ?').run(position.id);
    mockOpenOrders.mockResolvedValue(noOpenOrders);

    expect(await checkLiveBracketProtection()).toHaveLength(1);
    expect(unprotectedFlags()).toHaveLength(1);
  });

  it('leaves an unassigned position alone once a SECOND account is known', async () => {
    const position = await aged();
    db.prepare('UPDATE positions SET account_id = NULL WHERE id = ?').run(position.id);
    // A second account exists in the journal — we can no longer say which one
    // the legacy row belongs to, so we cannot judge whether its stop is missing.
    createPosition({
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 1,
      entryPrice: 1,
      entryDate: '2026-01-02',
      accountId: 'OTHER-ACCT',
    });
    mockOpenOrders.mockResolvedValue(noOpenOrders);

    expect(await checkLiveBracketProtection()).toEqual([]);
    expect(unprotectedFlags()).toHaveLength(0);
    void position;
  });

  it('ignores a position that was never opened with a bracket', async () => {
    const position = await aged();
    // Strip the bracket from its entry intent.
    db.prepare('UPDATE order_intents SET is_bracket = 0 WHERE id = ?').run(position.sourceIntentId);
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    expect(await checkLiveBracketProtection()).toEqual([]);
  });
});
