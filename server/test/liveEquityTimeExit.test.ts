import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
// checkLiveEquityScaleOuts refuses to trade outside the regular session (it is
// opportunistic profit-taking, not a protective exit). These tests run at
// whatever wall clock CI happens to be at, so pin the window OPEN — otherwise
// the scale-out suite passes during market hours and fails every evening, which
// is exactly what it did on the afternoon it was written. The closed case has
// its own test below that overrides this.
vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/executionGuards')>()),
  checkSessionWindow: vi.fn(() => ({ ok: true })),
}));
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
    webullReplaceOrder: vi.fn(),
    webullReplaceOrders: vi.fn(),
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
  webullReplaceOrder,
  webullReplaceOrders,
  listWebullOpenOrders,
  WebullOrderStatus,
} from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { createPosition, listPositions } from '../src/db/positions';
import { createIntent, getIntent, listIntents, type OrderIntentRecord } from '../src/db/orders';
import { listPendingLiveOrders, getLiveOrder, recordLiveExitOrder } from '../src/db/autotradeLiveOrders';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { checkSessionWindow } from '../src/services/autotrading/executionGuards';
import { evaluateRiskCheck } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';
import {
  checkLiveEquityScaleOuts,
  checkLiveEquityStopAdjusts,
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
const mockReplaceOrder = vi.mocked(webullReplaceOrder);
const mockReplaceOrders = vi.mocked(webullReplaceOrders);
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
  mockReplaceOrder.mockReset();
  mockReplaceOrders.mockReset();
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

  // -------------------------------------------------------------------------
  // Adopted positions (2026-08-24). A position the generic Webull sync imported
  // before autotrade reconciled its own fill gets retagged and LINKED via
  // autotrade_live_orders.position_id, but never gets positions.source_intent_id
  // (adoption deliberately can't patch it). The time-exit loop used to look up
  // the owning bracket ONLY through source_intent_id, so an adopted position
  // failed to close on every tick, forever. Production: an adopted CTVA
  // position triggered the stagnation exit and logged 21 identical
  // live_time_exit_failed events between 15:22 and 15:59 ET, never closing.
  // -------------------------------------------------------------------------
  it('closes an ADOPTED position (no source_intent_id) via its live-order link', async () => {
    const { position, quantity, entryIntentId } = await openAgedLivePosition(30);
    // Exactly what adoption leaves behind: the order->position link is set,
    // the position->intent back-reference is not.
    db.prepare('UPDATE positions SET source_intent_id = NULL WHERE id = ?').run(position.id);
    expect(listPositions({ status: 'open' })[0].sourceIntentId).toBeNull();
    expect(getLiveOrder(entryIntentId)?.positionId).toBe(position.id);

    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', positionId: position.id, requested: true });
    expect(mockPlaceOrder).toHaveBeenCalled();
    expect(listPendingLiveOrders().find((o) => o.role === 'exit')).toMatchObject({ positionId: position.id });
  });

  it('still reports a genuinely unlinked position as unclosable rather than guessing', async () => {
    const { position, entryIntentId } = await openAgedLivePosition(30);
    // Neither link survives: no back-reference AND no order pointing at it.
    db.prepare('UPDATE positions SET source_intent_id = NULL WHERE id = ?').run(position.id);
    db.prepare('UPDATE autotrade_live_orders SET position_id = NULL WHERE intent_id = ?').run(entryIntentId);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: false });
    expect(outcomes[0].reason).toMatch(/cannot locate its bracket/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// End-of-day flatten (2026-08-25). Two positions carried overnight from
// 2026-08-24 made the case: CTVA sold on the next open for -$0.91 after being
// +0.10R when the loop first wanted out, and GRMN's exit was ordered at a 293.52
// limit priced off the 294.99 opening print while the stock traded 289.85 —
// resting unfilled, about to be carried a second night by an exit that had
// already decided to leave.
// ---------------------------------------------------------------------------
describe('checkLiveEquityTimeExits — end-of-day flatten', () => {
  /** 15:58 ET on Monday 2026-08-25 — 2 minutes to the bell. */
  const INSIDE_WINDOW = Date.parse('2026-08-25T19:58:00Z');
  /** 11:00 ET the same day — mid-session. */
  const MID_SESSION = Date.parse('2026-08-25T15:00:00Z');

  afterEach(() => vi.useRealTimers());

  function atClock(ms: number) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(ms);
  }

  /** A resting exit order on its OWN intent, dated `createdAt` — what a limit
   *  placed earlier in the session and never filled looks like. */
  function staleExitFor(positionId: number, createdAt: number) {
    const rec = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 999, // far from the market: exactly why it never filled
      },
      `stale-exit-${positionId}`,
    );
    recordLiveExitOrder({ intentId: rec.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId });
    db.prepare('UPDATE autotrade_live_orders SET created_at = ? WHERE intent_id = ?').run(createdAt, rec.id);
  }

  async function readyToClose(quantity: number) {
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CLOSE' });
  }

  it('flattens a young, WORKING position — the decision is the clock, not the trade', async () => {
    // 0 days old and well in profit: neither maxHoldDays nor stagnation would
    // touch it. An overnight gap does not care that it is winning.
    const { position, quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 3 });
    await readyToClose(quantity);
    atClock(INSIDE_WINDOW);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: true });
    expect(mockPlaceOrder).toHaveBeenCalled();
    const journaled = listAutotradeEvents({ limit: 50 }).find((e) => e.action === 'live_time_exit_placed');
    expect(JSON.parse(journaled!.detail as string)).toMatchObject({ trigger: 'end_of_day', minutesLeft: 2 });
  });

  it('does nothing mid-session, however long the window is', async () => {
    await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 3 });
    atClock(MID_SESSION);
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('stays off at 0 minutes — the whole feature is opt-in', async () => {
    await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 0 });
    atClock(INSIDE_WINDOW);
    expect(await checkLiveEquityTimeExits()).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('REPLACES a resting exit placed before the window — the GRMN case', async () => {
    const { position, quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 3 });
    // A stale exit order from earlier in the session, still working at a price
    // the stock has left behind.
    staleExitFor(position.id, INSIDE_WINDOW - 60 * 60_000); // an hour before the window opened
    await readyToClose(quantity);
    atClock(INSIDE_WINDOW);

    const outcomes = await checkLiveEquityTimeExits();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ positionId: position.id, requested: true });
    const journaled = listAutotradeEvents({ limit: 50 }).find((e) => e.action === 'live_time_exit_placed');
    expect(JSON.parse(journaled!.detail as string)).toMatchObject({ trigger: 'end_of_day', replacedRestingExit: true });
  });

  it('does NOT replace again while its own fresh close is working', async () => {
    // cancelLiveBracketExitLegs cancels the stale order at the BROKER, but its
    // local intent row stays pending until a later reconcile observes that.
    // Without the freshness check this tick would place a third order against a
    // position that already has a live close working.
    const { position, quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 3 });
    staleExitFor(position.id, INSIDE_WINDOW - 60 * 60_000); // an hour before the window opened
    await readyToClose(quantity);
    atClock(INSIDE_WINDOW);

    await checkLiveEquityTimeExits(); // replaces once
    const afterFirst = mockPlaceOrder.mock.calls.length;
    const second = await checkLiveEquityTimeExits(); // must not replace again

    expect(second).toEqual([]);
    expect(mockPlaceOrder.mock.calls.length).toBe(afterFirst);
  });

  it('takes priority over maxHoldDays, so the journal names the real reason', async () => {
    const { quantity } = await openAgedLivePosition(30); // long past maxHoldDays too
    setAutotradeConfig({ maxHoldDays: 5, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 3 });
    await readyToClose(quantity);
    atClock(INSIDE_WINDOW);

    await checkLiveEquityTimeExits();

    const journaled = listAutotradeEvents({ limit: 50 }).find((e) => e.action === 'live_time_exit_placed');
    expect(JSON.parse(journaled!.detail as string)).toMatchObject({ trigger: 'end_of_day' });
  });

  it('runs even when every other time exit is disabled', async () => {
    // The early-return used to bail whenever maxHoldDays and stagnation were
    // both off, which would have made this feature unreachable on its own.
    const { quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({ maxHoldDays: 0, stagnationExitMinutes: 0, endOfDayFlattenMinutes: 5 });
    await readyToClose(quantity);
    atClock(INSIDE_WINDOW);
    expect(await checkLiveEquityTimeExits()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Live scale-out (2026-08-25). A live position otherwise exits on its stop, its
// 2R target, or a timer — and since the target is rarely reached in a session,
// most exit on the timer at whatever R they happen to be. This banks part of a
// winner at the R trigger.
//
// The ordering rule is the whole safety story: REDUCE the resting bracket legs
// to the remainder FIRST, then sell the difference. Selling first would leave a
// full-size bracket against a half-size holding, and a later stop fill would
// sell shares no longer owned — for a long, a SHORT nobody opened.
// ---------------------------------------------------------------------------
describe('checkLiveEquityScaleOuts', () => {
  const restingLeg = (cid: string) => openOrder({ clientOrderId: cid });

  /** A working exit order on its own intent, as a real close-in-flight looks. */
  function exitInFlightFor(positionId: number) {
    const rec = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 999,
      },
      `scaleout-inflight-${positionId}`,
    );
    recordLiveExitOrder({ intentId: rec.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId });
  }

  async function armed(atPrice: number) {
    const { position, quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({ liveScaleOutEnabled: true, partialExitRMultiple: 1.5, partialExitPct: 50 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: atPrice }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(accountStateWith(quantity) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SCALEOUT' });
    return { position, quantity };
  }

  it('does nothing while the flag is off, even at the trigger', async () => {
    await armed(200);
    setAutotradeConfig({ liveScaleOutEnabled: false });
    expect(await checkLiveEquityScaleOuts()).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockReplaceOrders).not.toHaveBeenCalled();
  });

  it('reduces BOTH resting legs in ONE request, before selling', async () => {
    // One request, not one per leg. The broker validates the OCO group's
    // balance per request, so reducing the take-profit without its stop-loss in
    // the same call is refused with "The number of take-profit orders and the
    // number of stop-loss orders must be the same" — which is what happened 89
    // times on 2026-09-02, and why no scale-out had ever executed.
    const { position, quantity } = await armed(200); // well past 1.5R
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [restingLeg('STOP-1'), restingLeg('TGT-1')] });
    mockReplaceOrders.mockResolvedValue({ ok: true });

    const out = await checkLiveEquityScaleOuts();

    expect(out[0]).toMatchObject({ positionId: position.id, requested: true });
    const keep = quantity - Math.floor(quantity / 2);
    expect(mockReplaceOrders).toHaveBeenCalledTimes(1);
    expect(mockReplaceOrders).toHaveBeenCalledWith('ACC1', [
      { clientOrderId: 'STOP-1', quantity: keep },
      { clientOrderId: 'TGT-1', quantity: keep },
    ]);
    // ...and the sell happened AFTER it. This ordering is the difference
    // between a scale-out and an accidental short.
    const lastReplace = Math.max(...mockReplaceOrders.mock.invocationCallOrder);
    expect(mockPlaceOrder.mock.invocationCallOrder[0]).toBeGreaterThan(lastReplace);
  });

  it('sells only the scale-out slice, leaving the rest running', async () => {
    const { quantity } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [restingLeg('STOP-1')] });
    mockReplaceOrders.mockResolvedValue({ ok: true });

    await checkLiveEquityScaleOuts();

    const placed = mockPlaceOrder.mock.calls[0][1];
    expect(placed).toMatchObject({ symbol: 'AAPL', side: 'sell', openClose: 'close' });
    expect(placed.quantity).toBe(Math.floor(quantity / 2));
    expect(placed.quantity).toBeLessThan(quantity);
  });

  it('ABANDONS the scale-out — selling nothing — when a leg cannot be reduced', async () => {
    // The position stays fully protected. This is the branch that must never
    // fall through to a sell.
    await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [restingLeg('STOP-1')] });
    mockReplaceOrders.mockResolvedValue({ ok: false, error: 'broker refused the modify' });

    const out = await checkLiveEquityScaleOuts();

    expect(out[0]).toMatchObject({ requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const ev = listAutotradeEvents({ limit: 50 }).find((e) => e.action === 'live_scale_out_blocked');
    expect(JSON.parse(ev!.detail as string).reason).toMatch(/Could not reduce the resting bracket/);
  });

  it('refuses when no resting leg can be read — an unknown bracket is not safe to resize', async () => {
    await armed(200);
    mockOpenOrders.mockResolvedValue(noOpenOrders);
    const out = await checkLiveEquityScaleOuts();
    expect(out[0]).toMatchObject({ requested: false });
    expect(out[0].reason).toMatch(/No readable resting exit leg/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('refuses when the open-order list cannot be read at all', async () => {
    await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: false, orders: [], error: 'broker unreachable' });
    const out = await checkLiveEquityScaleOuts();
    expect(out[0]).toMatchObject({ requested: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('skips a position that already has an exit order working', async () => {
    // Scaling out of a position on its way out would race that close for the
    // same shares.
    const { position } = await armed(200);
    exitInFlightFor(position.id);
    expect(await checkLiveEquityScaleOuts()).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('never scales out with the regular session closed', async () => {
    // Profit-taking into pre/after-hours liquidity pays a wide spread to bank
    // something that is not going anywhere until the open.
    await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [restingLeg('STOP-1')] });
    vi.mocked(checkSessionWindow).mockReturnValueOnce({ ok: false, reason: 'outside the regular session' });
    expect(await checkLiveEquityScaleOuts()).toEqual([]);
    expect(mockReplaceOrder).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('does not fire below the R trigger', async () => {
    await armed(100.5); // entry was 100.5 — 0R
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [restingLeg('STOP-1')] });
    expect(await checkLiveEquityScaleOuts()).toEqual([]);
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Live stop ratchet (2026-08-26). breakevenTriggerRMultiple / trailStartRMultiple
// / trailStopRMultiple ran in the PAPER path only — a live position kept the
// stop it was born with for life while all three read as active in the UI.
//
// The dangerous part is not the arithmetic (stopAdjust.test.ts covers that) but
// WHICH resting order gets replaced: a bracket rests as a STOP_LOSS stop and a
// STOP_PROFIT limit, and moving the wrong one would drag the TARGET onto the
// price and sell the position at a loss. Hence the tests below lean on
// identification and refusal, not on the R maths.
// ---------------------------------------------------------------------------
describe('checkLiveEquityStopAdjusts', () => {
  const stopLeg = (cid = 'STOP-1') => openOrder({ clientOrderId: cid, comboType: 'STOP_LOSS' });
  const targetLeg = (cid = 'TGT-1') => openOrder({ clientOrderId: cid, comboType: 'STOP_PROFIT' });

  /** An open live position at `price`, with trailing armed. Entry fills at
   *  100.5 with a stop at 95 (see signal()), so 1R is ~5.5. */
  async function armed(price: number, overrides: Partial<AutotradeConfig> = {}) {
    const { position, quantity } = await openAgedLivePosition(0);
    setAutotradeConfig({
      liveTrailingEnabled: true,
      breakevenTriggerRMultiple: 1,
      trailStartRMultiple: 1,
      trailStopRMultiple: 1.5,
      ...overrides,
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: price }) as ReturnType<typeof getProvider>);
    return { position, quantity };
  }

  const ratchetEvents = () => listAutotradeEvents({ limit: 50 }).filter((e) => e.action === 'live_stop_ratcheted');

  it('does nothing while the flag is off, even well past the trigger', async () => {
    // The three R settings are already non-zero in production, so this is the
    // check that stops a deploy arming live trailing stops by itself.
    await armed(200, { liveTrailingEnabled: false });
    expect(await checkLiveEquityStopAdjusts()).toEqual([]);
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  it('moves ONLY the STOP_LOSS leg, never the target', async () => {
    const { position } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg(), targetLeg()] });
    mockReplaceOrder.mockResolvedValue({ ok: true });

    const out = await checkLiveEquityStopAdjusts();

    expect(out[0]).toMatchObject({ positionId: position.id, adjusted: true, kind: 'trail' });
    expect(mockReplaceOrder).toHaveBeenCalledTimes(1);
    const [, cid, patch] = mockReplaceOrder.mock.calls[0];
    expect(cid).toBe('STOP-1');
    expect(patch).toHaveProperty('stopPrice');
    expect(patch).not.toHaveProperty('quantity'); // resizing is the scale-out's job
    // The target leg was not touched at all — moving it would sell the position.
    expect(mockReplaceOrder.mock.calls.some((c) => c[1] === 'TGT-1')).toBe(false);
  });

  it('records the new stop locally only AFTER the broker confirms', async () => {
    const { position } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg()] });
    mockReplaceOrder.mockResolvedValue({ ok: true });

    await checkLiveEquityStopAdjusts();

    const after = listPositions({ status: 'open', symbol: 'AAPL' })[0];
    expect(after.stopPrice).toBeGreaterThan(position.stopPrice!);
    expect(after.initialStopPrice).toBe(position.initialStopPrice); // denominator frozen
    expect(ratchetEvents()).toHaveLength(1);
  });

  it('leaves the ledger untouched when the broker refuses the replace', async () => {
    // The ledger must never claim protection the broker has not got.
    const { position } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg()] });
    mockReplaceOrder.mockResolvedValue({ ok: false, error: 'broker said no' });

    const out = await checkLiveEquityStopAdjusts();

    expect(out[0]).toMatchObject({ adjusted: false });
    const after = listPositions({ status: 'open', symbol: 'AAPL' })[0];
    expect(after.stopPrice).toBe(position.stopPrice); // unchanged
    expect(ratchetEvents()).toHaveLength(0);
    expect(listAutotradeEvents({ limit: 50 }).some((e) => e.action === 'live_stop_adjust_failed')).toBe(true);
  });

  it('does not claim the move on an AMBIGUOUS replace either', async () => {
    // We do not know whether it applied. Claiming it would be a guess about
    // real money; the next tick re-reads the leg and re-decides.
    const { position } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg()] });
    mockReplaceOrder.mockResolvedValue({ ok: false, ambiguous: true, error: 'timeout' });

    await checkLiveEquityStopAdjusts();

    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].stopPrice).toBe(position.stopPrice);
    const failed = listAutotradeEvents({ limit: 50 }).find((e) => e.action === 'live_stop_adjust_failed')!;
    expect(JSON.parse(failed.detail!)).toMatchObject({ ambiguous: true });
  });

  it('refuses when the stop leg cannot be positively identified', async () => {
    const { position } = await armed(200);
    // Two exit-side orders, neither labelled — combo_type did not parse. Acting
    // on a guess here is how the target gets moved onto the price.
    mockOpenOrders.mockResolvedValue({
      ok: true,
      orders: [
        openOrder({ clientOrderId: 'A', comboType: undefined }),
        openOrder({ clientOrderId: 'B', comboType: undefined }),
      ],
    });

    const out = await checkLiveEquityStopAdjusts();

    expect(out[0]).toMatchObject({ positionId: position.id, adjusted: false });
    expect(mockReplaceOrder).not.toHaveBeenCalled();
    expect(listAutotradeEvents({ limit: 50 }).some((e) => e.action === 'live_stop_adjust_blocked')).toBe(true);
  });

  it('refuses when two STOP_LOSS legs are resting — it will not guess which protects this lot', async () => {
    await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg('S1'), stopLeg('S2')] });

    const out = await checkLiveEquityStopAdjusts();

    expect(out[0]).toMatchObject({ adjusted: false, reason: expect.stringMatching(/ambiguous/i) });
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  /** A working close on its own intent — scoped here rather than reusing the
   *  scale-out block's identical helper, which is local to that describe. */
  function closeInFlightFor(positionId: number) {
    const rec = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 999,
      },
      `ratchet-inflight-${positionId}`,
    );
    recordLiveExitOrder({ intentId: rec.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId });
  }

  it('skips a position whose close is already working', async () => {
    const { position } = await armed(200);
    closeInFlightFor(position.id);
    expect(await checkLiveEquityStopAdjusts()).toEqual([]);
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  it('keeps the water mark current even on cycles that move nothing', async () => {
    // The trail hangs off this number; a tick that fails to record a new peak
    // is a peak the trail never gets to use.
    await armed(103); // ~0.45R — under every trigger
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg()] });

    await checkLiveEquityStopAdjusts();

    expect(mockReplaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].bestPriceSinceEntry).toBe(103);
  });

  it('never places a second replace for a stop already where it wants it', async () => {
    const { position } = await armed(200);
    mockOpenOrders.mockResolvedValue({ ok: true, orders: [stopLeg()] });
    mockReplaceOrder.mockResolvedValue({ ok: true });

    await checkLiveEquityStopAdjusts();
    const afterFirst = listPositions({ status: 'open', symbol: 'AAPL' })[0].stopPrice;
    mockReplaceOrder.mockClear();

    // Same price on the next tick: the stop is already there, so nothing to do.
    await checkLiveEquityStopAdjusts();
    expect(mockReplaceOrder).not.toHaveBeenCalled();
    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].stopPrice).toBe(afterFirst);
    expect(position.id).toBeGreaterThan(0);
  });
});
