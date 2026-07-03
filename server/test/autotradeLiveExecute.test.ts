import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return { ...actual, webullPlaceOrder: vi.fn(), webullOrderStatus: vi.fn() };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import { webullPlaceOrder, webullOrderStatus, WebullOrderStatus } from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listPositions } from '../src/db/positions';
import { getLiveOrder, listPendingLiveOrders } from '../src/db/autotradeLiveOrders';
import { listIntents } from '../src/db/orders';
import { evaluateRiskCheck, RiskCheckResult } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';
import {
  attemptLiveEntry,
  buildLiveTradingConfig,
  getProbationStatus,
  getLivePortfolioSnapshot,
  reconcileLiveOrders,
  runLiveExecution,
} from '../src/services/autotrading/liveExecute';

const mockGetProvider = vi.mocked(getProvider);
const mockAccountState = vi.mocked(webullAccountState);
const mockPlaceOrder = vi.mocked(webullPlaceOrder);
const mockOrderStatus = vi.mocked(webullOrderStatus);

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

const okAccountState = {
  ok: true,
  accountId: 'ACC1',
  state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty: 0 },
};

function liveConfig(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    ...defaultAutotradeConfig(),
    accountEquityUsd: 100_000,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    // Comfortably above the fixture signal's ~$20k notional (200 shares @
    // ~$100, sized from $100k equity at 1% risk / $5 stop) — these tests are
    // about the ENTRY/reconcile/probation flow, not the cap thresholds
    // themselves (buildLiveTradingConfig's own describe block covers those).
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    ...overrides,
  };
}

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM trading_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM position_exits; DELETE FROM positions;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true; // env master gate ON — see placeOrder.test.ts's own convention
  mockGetProvider.mockReset();
  mockAccountState.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

describe('buildLiveTradingConfig', () => {
  it("combines the human page's enabled with liveTradingEnabled (AND)", () => {
    setTradingConfig({ enabled: true });
    expect(buildLiveTradingConfig(liveConfig({ liveTradingEnabled: true })).enabled).toBe(true);
    expect(buildLiveTradingConfig(liveConfig({ liveTradingEnabled: false })).enabled).toBe(false);
    setTradingConfig({ enabled: false });
    expect(buildLiveTradingConfig(liveConfig({ liveTradingEnabled: true })).enabled).toBe(false);
  });

  it('combines both kill switches (OR) — either one blocks', () => {
    setTradingConfig({ killSwitch: false });
    expect(buildLiveTradingConfig(liveConfig({ killSwitch: false })).killSwitch).toBe(false);
    expect(buildLiveTradingConfig(liveConfig({ killSwitch: true })).killSwitch).toBe(true);
    setTradingConfig({ killSwitch: true });
    expect(buildLiveTradingConfig(liveConfig({ killSwitch: false })).killSwitch).toBe(true);
  });

  it('maps the autotrade-specific live caps, not the human trading_config caps', () => {
    setTradingConfig({ maxOrderUsd: 1_000, maxDailyLossUsd: 500 });
    const cfg = buildLiveTradingConfig(liveConfig({ liveMaxOrderUsd: 7_777, liveMaxDailyLossUsd: 333 }));
    expect(cfg.maxOrderUsd).toBe(7_777);
    expect(cfg.maxDailyLossUsd).toBe(333);
  });

  it('falls back maxExposureUsd to 0 when equity is unset, failing closed', () => {
    expect(buildLiveTradingConfig(liveConfig({ accountEquityUsd: null })).maxExposureUsd).toBe(0);
  });
});

describe('getProbationStatus', () => {
  it('is inactive when liveTradingEnabled has never been turned on', () => {
    const status = getProbationStatus(liveConfig({ liveEnabledAt: null }));
    expect(status.active).toBe(false);
    expect(status.multiplier).toBe(1);
  });

  it('is active with the configured multiplier when under the trade threshold', () => {
    const cfg = liveConfig({ liveProbationTrades: 5, liveProbationSizeMultiplier: 0.4 });
    const status = getProbationStatus(cfg);
    expect(status.active).toBe(true);
    expect(status.multiplier).toBe(0.4);
    expect(status.tradesRemaining).toBe(5);
  });
});

describe('attemptLiveEntry', () => {
  const okResult: RiskCheckResult = evaluateRiskCheck(
    signal(),
    {
      equity: 100_000,
      dailyPnl: 0,
      tradesToday: 0,
      consecutiveLosses: 0,
      openRisk: 0,
      openPositionsCount: 0,
      correlatedNotional: 0,
    },
    {
      riskPerTradePct: 1,
      maxDailyDrawdownPct: 3,
      stepDownAfterLosses: 2,
      stepDownSizeCutPct: 50,
      maxConcurrentPositions: 2,
      maxAggregateOpenRiskPct: 2,
      maxCorrelatedExposurePct: 6,
      maxTradesPerDay: 6,
    },
  );

  it('refuses when TRADING_ENABLED is off — no intent, no broker call, regardless of every other gate passing', async () => {
    config.trading.placeEnabled = false;
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TRADING_ENABLED/);
    expect(listIntents()).toHaveLength(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('refuses with no liveAccountId configured — no intent created, no broker call', async () => {
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig({ liveAccountId: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/liveAccountId/);
    expect(listIntents()).toHaveLength(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('skips (no order) when the probation-adjusted quantity rounds to 0', async () => {
    // suggestedQuantity is small for a $100k account at 1% risk / $5 stop, but
    // an aggressive multiplier drives it to 0 regardless of the base size.
    const cfg = liveConfig({ liveProbationSizeMultiplier: 0.001 });
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rounded to 0/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('fails closed on a quote-fetch failure — no intent, no broker call', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({}) as ReturnType<typeof getProvider>);
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Quote fetch failed/);
    expect(listIntents()).toHaveLength(0);
  });

  it('creates a rejected intent (audit trail) but never calls the broker when guardrails block', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    // Kill switch engaged -> guardrails must block regardless of everything else.
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig({ killSwitch: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Guardrails blocked/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const intents = listIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].state).toBe('rejected');
  });

  it('places a bracket order (entry + linked stop + target) and records autotrade_live_orders metadata on success', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });

    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(r.ok).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 110, stopLossPrice: 95 });
    expect(placedIntent.orderType).toBe('limit');

    const intents = listIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].state).toBe('acknowledged');
    expect(intents[0].brokerOrderId).toBe('WB-1');

    const meta = getLiveOrder(intents[0].id);
    expect(meta).toMatchObject({ symbol: 'AAPL', stopPrice: 95, targetPrice: 110 });

    const events = listAutotradeEvents({});
    expect(events.some((e) => e.action === 'live_order_placed')).toBe(true);
  });

  it('transitions to rejected and logs a failure event on broker rejection', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'insufficient funds' });

    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(r.ok).toBe(false);
    expect(listIntents()[0].state).toBe('rejected');
    expect(listAutotradeEvents({}).some((e) => e.action === 'live_entry_failed')).toBe(true);
    expect(getLiveOrder(listIntents()[0].id)).toBeUndefined(); // no metadata for a failed placement
  });

  it('sizes the entry down by the probation multiplier when active', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-2' });

    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig({ liveProbationSizeMultiplier: 0.5 }));
    const halved = mockPlaceOrder.mock.calls[0][1].quantity;

    mockPlaceOrder.mockClear();
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig({ liveEnabledAt: null })); // not in probation
    const full = mockPlaceOrder.mock.calls[0][1].quantity;

    expect(halved).toBe(Math.floor(full * 0.5));
  });
});

describe('runLiveExecution', () => {
  it('re-checks autotrade’s own config fresh for EACH candidate in a batch — engaging the kill switch mid-batch stops the next candidate, not just the next cycle', async () => {
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      liveAccountId: 'ACC1',
      liveTradingEnabled: true,
      liveEnabledAt: Date.now(),
      liveMaxOrderUsd: 50_000,
      liveMaxDailyLossUsd: 5_000,
      liveMaxOrdersPerDay: 20,
      killSwitch: false,
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockImplementationOnce(async () => {
      // Simulate the user hitting autotrade's OWN kill switch while this
      // first order is still in flight (the same real-world timing the
      // adversarial review flagged: this loop awaits real broker round-trips
      // between candidates in the same batch).
      setAutotradeConfig({ killSwitch: true });
      return { ok: true, orderId: 'WB-1' };
    });

    const outcomes = await runLiveExecution([
      { signal: signal({ symbol: 'AAPL' }) },
      { signal: signal({ symbol: 'MSFT' }) },
    ]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: true }); // placed before the kill switch was engaged
    expect(outcomes[1].ok).toBe(false); // MSFT: blocked, not placed after the kill switch was engaged
    expect(outcomes[1].reason).toMatch(/kill_switch/);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // MSFT never reached the broker at all
  });
});

describe('getLivePortfolioSnapshot', () => {
  function insertPosition(tags: string[], overrides: Partial<Record<string, unknown>> = {}) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, stop_price, target_price, created_at, updated_at)
       VALUES ('stock','AAPL','long',10,100,?,0,1,?,?,95,110,?,?)`,
    ).run(overrides.entryDate ?? '2026-07-02', overrides.status ?? 'open', JSON.stringify(tags), now, now);
  }

  it('only counts positions tagged autotrade, ignoring human-only "live" positions', () => {
    insertPosition(['live']); // human-placed live trade — must NOT count
    insertPosition(['live', 'autotrade']);
    const snap = getLivePortfolioSnapshot();
    expect(snap.openPositionsCount).toBe(1);
  });

  it('computes openRisk from the stop distance of open autotrade positions', () => {
    insertPosition(['live', 'autotrade']); // entry 100, stop 95, qty 10 -> risk 50
    const snap = getLivePortfolioSnapshot();
    expect(snap.openRisk).toBe(50);
  });
});

describe('reconcileLiveOrders', () => {
  it('returns nothing when no liveAccountId is configured', async () => {
    setAutotradeConfig({ liveAccountId: null });
    expect(await reconcileLiveOrders()).toEqual([]);
    expect(mockOrderStatus).not.toHaveBeenCalled();
  });

  it('materializes a filled entry into a real, tagged Position and links the metadata row', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-3' });
    const cfg = liveConfig();
    const okResult = evaluateRiskCheck(
      signal(),
      {
        equity: 100_000,
        dailyPnl: 0,
        tradesToday: 0,
        consecutiveLosses: 0,
        openRisk: 0,
        openPositionsCount: 0,
        correlatedNotional: 0,
      },
      {
        riskPerTradePct: 1,
        maxDailyDrawdownPct: 3,
        stepDownAfterLosses: 2,
        stepDownSizeCutPct: 50,
        maxConcurrentPositions: 2,
        maxAggregateOpenRiskPct: 2,
        maxCorrelatedExposurePct: 6,
        maxTradesPerDay: 6,
      },
    );
    await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);
    const intentId = listIntents()[0].id;

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOrders();
    expect(outcomes).toEqual([{ intentId, symbol: 'AAPL', changed: true, action: 'entry_filled' }]);

    const positions = listPositions({ status: 'open' });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: 'AAPL', stopPrice: 95, targetPrice: 110, sourceIntentId: intentId });
    expect(positions[0].tags).toEqual(expect.arrayContaining(['live', 'autotrade']));
    expect(getLiveOrder(intentId)?.positionId).toBe(positions[0].id);
  });

  it('closes the position when a bracket exit leg unambiguously reports FILLED', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-4' });
    const okResult = evaluateRiskCheck(
      signal(),
      {
        equity: 100_000,
        dailyPnl: 0,
        tradesToday: 0,
        consecutiveLosses: 0,
        openRisk: 0,
        openPositionsCount: 0,
        correlatedNotional: 0,
      },
      {
        riskPerTradePct: 1,
        maxDailyDrawdownPct: 3,
        stepDownAfterLosses: 2,
        stepDownSizeCutPct: 50,
        maxConcurrentPositions: 2,
        maxAggregateOpenRiskPct: 2,
        maxCorrelatedExposurePct: 6,
        maxTradesPerDay: 6,
      },
    );
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    // First reconcile: entry fills.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();
    expect(listPositions({ status: 'open' })).toHaveLength(1);

    // Second reconcile: the STOP_LOSS leg has now filled too.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED', filledPrice: 95 },
      ],
    } as WebullOrderStatus);
    const outcomes = await reconcileLiveOrders();
    expect(outcomes[0]).toMatchObject({ changed: true, action: 'exit_filled' });
    expect(listPositions({ status: 'open' })).toHaveLength(0);
    const closed = listPositions({ status: 'closed' });
    expect(closed[0].exits[0].exitPrice).toBe(95);
  });

  it('fails closed: an ambiguous leg response (no comboType at all) leaves the position open rather than guessing', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-5' });
    const okResult = evaluateRiskCheck(
      signal(),
      {
        equity: 100_000,
        dailyPnl: 0,
        tradesToday: 0,
        consecutiveLosses: 0,
        openRisk: 0,
        openPositionsCount: 0,
        correlatedNotional: 0,
      },
      {
        riskPerTradePct: 1,
        maxDailyDrawdownPct: 3,
        stepDownAfterLosses: 2,
        stepDownSizeCutPct: 50,
        maxConcurrentPositions: 2,
        maxAggregateOpenRiskPct: 2,
        maxCorrelatedExposurePct: 6,
        maxTradesPerDay: 6,
      },
    );
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    // No leg data at all this time (e.g. a transient/degraded response) — must
    // NOT be interpreted as an exit.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: undefined,
    } as WebullOrderStatus);
    const outcomes = await reconcileLiveOrders();
    expect(outcomes[0]).toMatchObject({ changed: false });
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });
});

describe('listPendingLiveOrders / terminal-state exclusion', () => {
  it('keeps a filled bracket entry pending (to keep checking exit legs) until its position actually closes', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-6' });
    const okResult = evaluateRiskCheck(
      signal(),
      {
        equity: 100_000,
        dailyPnl: 0,
        tradesToday: 0,
        consecutiveLosses: 0,
        openRisk: 0,
        openPositionsCount: 0,
        correlatedNotional: 0,
      },
      {
        riskPerTradePct: 1,
        maxDailyDrawdownPct: 3,
        stepDownAfterLosses: 2,
        stepDownSizeCutPct: 50,
        maxConcurrentPositions: 2,
        maxAggregateOpenRiskPct: 2,
        maxCorrelatedExposurePct: 6,
        maxTradesPerDay: 6,
      },
    );
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(listPendingLiveOrders()).toHaveLength(1); // acknowledged — still working, not yet filled

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();
    // The order_intents row itself now reads 'filled', but that only ever
    // reflects the MASTER/entry leg (see WebullOrderLeg's caveat) — a linked
    // STOP_LOSS/STOP_PROFIT exit leg could still be working, so this must
    // stay "pending" (i.e. still get polled) rather than being dropped the
    // moment the entry alone fills.
    expect(listPendingLiveOrders()).toHaveLength(1);

    // Now the STOP_LOSS leg fires too — the position actually closes.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED', filledPrice: 95 },
      ],
    } as WebullOrderStatus);
    await reconcileLiveOrders();
    expect(listPendingLiveOrders()).toHaveLength(0); // closed — nothing left to poll for
  });

  it('never records live-order metadata for a broker-rejected attempt (nothing to list as pending)', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'nope' });
    const okResult = evaluateRiskCheck(
      signal(),
      {
        equity: 100_000,
        dailyPnl: 0,
        tradesToday: 0,
        consecutiveLosses: 0,
        openRisk: 0,
        openPositionsCount: 0,
        correlatedNotional: 0,
      },
      {
        riskPerTradePct: 1,
        maxDailyDrawdownPct: 3,
        stepDownAfterLosses: 2,
        stepDownSizeCutPct: 50,
        maxConcurrentPositions: 2,
        maxAggregateOpenRiskPct: 2,
        maxCorrelatedExposurePct: 6,
        maxTradesPerDay: 6,
      },
    );
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(listIntents()).toHaveLength(1); // the rejected intent IS audited...
    expect(listPendingLiveOrders()).toHaveLength(0); // ...but was never tagged as autotrade's, since recordLiveOrder only runs on a successful placement
  });
});
