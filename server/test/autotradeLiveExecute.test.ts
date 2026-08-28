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
  };
});
vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));
// checkLiveScaleIns now enforces the session window itself (a scale-in places a
// real order that ADDS risk, and loop.ts runs it before its own session gate).
// These tests run at whatever wall-clock CI happens to be at, so pin the guard
// open by default; the closed case gets its own test below.
vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/executionGuards')>()),
  checkSessionWindow: vi.fn(() => ({ ok: true })),
}));

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import { webullPlaceOrder, webullOrderStatus, WebullOrderStatus } from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import {
  setAutotradeConfig,
  getAutotradeConfig,
  defaultAutotradeConfig,
  AutotradeConfig,
} from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listPositions, createPosition } from '../src/db/positions';
import * as positionsDb from '../src/db/positions';
import { getLiveOrder, listPendingLiveOrders, countLiveAddOns } from '../src/db/autotradeLiveOrders';
import { getIntent, listIntents, transitionIntent } from '../src/db/orders';
import { UNKNOWN_PLACEMENT_RETIRE_GRACE_MS } from '../src/services/trading/reconcile';
import { evaluateRiskCheck, RiskCheckResult } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';
import {
  attemptLiveEntry,
  buildLiveTradingConfig,
  getProbationStatus,
  getLivePortfolioSnapshot,
  listAutotradeLivePositions,
  reconcileLiveOrders,
  runLiveExecution,
  syncAccountEquityFromBroker,
  adoptOrphanedLivePositions,
  checkLiveScaleIns,
  checkLiveBracketProtection,
  checkLiveEquityScaleOuts,
  checkLiveEquityStopAdjusts,
  checkLiveEquityTimeExits,
} from '../src/services/autotrading/liveExecute';
import { runWebullPositionsSync } from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';

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

function quoteReturning(prices: Record<string, number>): ReturnType<typeof getProvider> {
  // Deliberately partial — only the members these tests exercise.
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getCandles: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getProvider>;
}

/** A provider whose daily bars carry a confirmed swing high at `wall`, so the
 *  level detector finds one piece of real overhead structure. Flat filler
 *  either side confirms the pivot; the last bars keep price near the entry. */
function providerWithWall(prices: Record<string, number>, wall: number): ReturnType<typeof getProvider> {
  const flat = (n: number) => Array.from({ length: n }, () => ({ high: 99, low: 98, close: 98.5, volume: 1_000 }));
  const bars = [...flat(6), { high: wall, low: wall - 1, close: wall - 0.5, volume: 5_000 }, ...flat(6)];
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getCandles: vi.fn(async () => bars),
  } as unknown as ReturnType<typeof getProvider>;
}

const okAccountState = {
  ok: true,
  accountId: 'ACC1',
  state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty: 0 },
};

/** The plain, everything-passes risk context the reconcile tests size against
 *  — same numbers the original inline fixture used. */
function baseRiskCtx() {
  return {
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
  };
}

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

/** Mocks the raw broker positions-list fetch — providers/webull/positions.ts's
 *  own fetchPositions(), one level below runWebullPositionsSync() — same
 *  pattern as webullPositions.test.ts's own mockPositions() helper. */
function mockBrokerPositions(rows: unknown) {
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  } as Response);
}

const origPlaceEnabled = config.trading.placeEnabled;
const origWebull = { ...config.webull };

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM trading_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      // runLiveExecution now seeds from the COMBINED live book (combinedLiveOpenRisk
      // reads the options positions/orders too), so a leaked open options position
      // from another test file would perturb this file's equity risk math.
      'DELETE FROM autotrade_live_options_positions; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM position_exits; DELETE FROM positions;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true; // env master gate ON — see placeOrder.test.ts's own convention
  mockGetProvider.mockReset();
  mockAccountState.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
  vi.mocked(priceMap).mockReset();
  vi.mocked(priceMap).mockImplementation(
    async (positions) => new Map(positions.map((p) => [p.id, { price: 100, stale: false, asOf: 0 }])),
  );
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
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

  it('scales maxExposureUsd by liveMaxExposurePct, which used to be pinned at 100', () => {
    // Pinned at exactly equity, this left no headroom whatsoever: on
    // 2026-08-27 two correctly-sized positions summed to $2,284 against a
    // $2,283.61 cap and the second was refused by 39 cents.
    const at = (pct: number) =>
      buildLiveTradingConfig(liveConfig({ accountEquityUsd: 2_283.61, liveMaxExposurePct: pct })).maxExposureUsd;
    expect(at(100)).toBeCloseTo(2_283.61, 2);
    expect(at(150)).toBeCloseTo(3_425.415, 2);
    expect(at(0)).toBe(0);
  });

  it('still fails closed at 0 equity however generous the percentage', () => {
    expect(buildLiveTradingConfig(liveConfig({ accountEquityUsd: null, liveMaxExposurePct: 400 })).maxExposureUsd).toBe(
      0,
    );
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

  it("doesn't count an order that expired unfilled toward the probation trade total", async () => {
    // Same "never became a real trade" category as rejected/cancelled — an
    // adversarial review found this one was missing from the exclusion list,
    // so an expired order was silently consuming probation slots.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-9' });
    const enabledAt = Date.now() - 1000;
    const cfg = liveConfig({ liveEnabledAt: enabledAt, liveProbationTrades: 5, liveProbationSizeMultiplier: 0.4 });
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
    const intentId = listIntents()[0].id;
    transitionIntent(intentId, 'expired', { detail: 'test: order timed out unfilled' });

    const status = getProbationStatus(cfg);
    expect(status.tradesPlaced).toBe(0);
    expect(status.active).toBe(true);
    expect(status.tradesRemaining).toBe(5);
  });
});

describe('syncAccountEquityFromBroker', () => {
  it('fails cleanly, without calling the broker, when no liveAccountId is configured', async () => {
    setAutotradeConfig({ liveAccountId: null });
    const result = await syncAccountEquityFromBroker();
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/liveAccountId/i) });
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  it('passes through a broker error without touching accountEquityUsd', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 50_000 });
    mockAccountState.mockResolvedValue({ ok: false, accountId: 'ACC1', error: 'Webull request failed (500)' });
    const result = await syncAccountEquityFromBroker();
    expect(result).toMatchObject({ ok: false, accountId: 'ACC1', error: 'Webull request failed (500)' });
    expect(getAutotradeConfig().accountEquityUsd).toBe(50_000);
  });

  it('fails cleanly when Webull returns no usable net liquidation value', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 50_000 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 0 });
    const result = await syncAccountEquityFromBroker();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/net liquidation/i);
    expect(getAutotradeConfig().accountEquityUsd).toBe(50_000); // unchanged, not silently zeroed
  });

  it('syncs accountEquityUsd from netLiquidationUsd and journals the change', async () => {
    // equitySyncMaxJumpPct: 0 disables the sanity guard — this case is about
    // the write and the journal entry, and its 50k -> 74k figure (chosen long
    // before the guard existed) is a 48% jump the guard would rightly refuse.
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 50_000, equitySyncMaxJumpPct: 0 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 74_123.45 });
    const result = await syncAccountEquityFromBroker();
    expect(result).toMatchObject({
      ok: true,
      accountId: 'ACC1',
      previousEquityUsd: 50_000,
      netLiquidationUsd: 74_123.45,
      buyingPowerUsd: okAccountState.state.buyingPowerUsd,
    });
    expect(getAutotradeConfig().accountEquityUsd).toBe(74_123.45);

    const events = listAutotradeEvents({ stage: 'config' });
    const synced = events.find((e) => e.action === 'equity_synced');
    expect(JSON.parse(synced?.detail ?? '{}')).toMatchObject({ from: 50_000, to: 74_123.45, accountId: 'ACC1' });
  });

  it('refuses a spurious reading, keeps the last confirmed equity, and journals the rejection', async () => {
    // The 2026-08-27 failure end to end: a $2,444.70 net-liquidation print
    // against a $2,234.58 account holding one position that moved cents. Left
    // unguarded it banked the day at a fictional +9.69% and halted live
    // entries for the rest of the session.
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 2_234.58, equitySyncMaxJumpPct: 5 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 2_444.7 });

    const result = await syncAccountEquityFromBroker();

    expect(result.ok).toBe(true); // not an error — the sync ran, the value was refused
    expect(getAutotradeConfig().accountEquityUsd).toBe(2_234.58); // last confirmed figure kept
    const rejected = listAutotradeEvents({ actions: ['equity_sync_rejected'] });
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0].detail!)).toMatchObject({
      rejectedUsd: 2_444.7,
      keptUsd: 2_234.58,
      maxJumpPct: 5,
    });
    // Journaled even though the per-tick sync passes log:false — a refused
    // reading is not mark-to-market drift, it is the thing worth seeing.
    const alsoWithLogOff = await syncAccountEquityFromBroker({ log: false });
    expect(alsoWithLogOff.ok).toBe(true);
    expect(listAutotradeEvents({ actions: ['equity_sync_rejected'] }).length).toBeGreaterThan(1);
  });

  it('does not journal an event when the synced value equals the current one', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 50_000 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 50_000 });
    const result = await syncAccountEquityFromBroker();
    expect(result.ok).toBe(true);
    const events = listAutotradeEvents({ stage: 'config' });
    expect(events.find((e) => e.action === 'equity_synced')).toBeUndefined();
  });

  it('{ log: false } still syncs the value but skips the journal entry, even though it changed', async () => {
    // The automatic per-tick sync (loop.ts) passes this — net liquidation
    // drifts with mark-to-market on nearly every once-a-minute check, so
    // logging on every change there would flood Recent Activity with noise.
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 50_000, equitySyncMaxJumpPct: 0 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 74_123.45 });
    const result = await syncAccountEquityFromBroker({ log: false });
    expect(result).toMatchObject({ ok: true, previousEquityUsd: 50_000, netLiquidationUsd: 74_123.45 });
    expect(getAutotradeConfig().accountEquityUsd).toBe(74_123.45); // still synced
    const events = listAutotradeEvents({ stage: 'config' });
    expect(events.find((e) => e.action === 'equity_synced')).toBeUndefined(); // but not journaled
  });
});

describe('attemptLiveEntry', () => {
  const okResult: RiskCheckResult = evaluateRiskCheck(signal(), {
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

  it('blocks a short signal via the naked-short guardrail by default — tradeDirection alone is not enough to place a live short', async () => {
    // Regression for the equity long+short feature: liveAllowNakedShort
    // (defaults false, same as guardrails.ts's own default) is the ONLY
    // thing standing between a short TradeSignal and a real broker order —
    // AutotradeConfig.tradeDirection just decides what the loop LOOKS for,
    // it doesn't bypass this real-money risk gate.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    const shortSignal = signal({ side: 'sell', stop: 105, target: 90 });

    const r = await attemptLiveEntry(shortSignal, okResult, 'MODERATE', liveConfig({ liveAllowNakedShort: false }));

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Guardrails blocked/);
    expect(r.reason).toMatch(/naked_short/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('places a short live order once liveAllowNakedShort is explicitly enabled', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SHORT' });
    const shortSignal = signal({ side: 'sell', stop: 105, target: 90 });

    const r = await attemptLiveEntry(shortSignal, okResult, 'MODERATE', liveConfig({ liveAllowNakedShort: true }));

    expect(r.ok).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
    const [, placedIntent, , isShort] = mockPlaceOrder.mock.calls[0];
    expect(placedIntent.side).toBe('sell');
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 90, stopLossPrice: 105 });
    // Opening a short from a flat account (currentPositionQty 0) — Webull's
    // own SHORT side, not a plain SELL, so its real-time locate/borrow check
    // runs at order time (see providers/webull/orders.ts).
    expect(isShort).toBe(true);
  });

  it('places a plain long entry with isShort false (never SHORT for a buy)', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LONG' });

    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    expect(r.ok).toBe(true);
    const [, , , isShort] = mockPlaceOrder.mock.calls[0];
    expect(isShort).toBe(false);
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

  it('does NOT place a second live order for a symbol that already has a working (unfilled) order — cross-tick double-open guard', async () => {
    // Regression (hardening audit, CRITICAL): a live position materializes only
    // when a FULL fill reconciles, so an entry still working across a loop-tick
    // boundary was invisible to the old open-positions-only dedup — the next
    // tick re-emitted the same signal and placed a SECOND real order (double
    // size, two OCO bracket pairs). attemptLiveEntry now blocks on ANY pending
    // (working / filled-unmaterialized / open) autotrade order for the symbol.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });

    const first = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(first.ok).toBe(true); // placed; intent 'acknowledged', no position row yet

    const second = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already in flight/);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // never reached the broker a second time
    expect(listIntents()).toHaveLength(1); // and no second intent was created
  });

  it('dispatches a notification (Slack/Discord/webhook) on a placed live order, when a channel is configured', async () => {
    const origNotifications = { ...config.notifications };
    config.notifications.slackWebhookUrl = 'http://slack.test';
    try {
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

      await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

      expect(fetchSpy).toHaveBeenCalledWith('http://slack.test', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string) as { text: string };
      expect(body.text).toMatch(/LIVE BUY.*AAPL/);
    } finally {
      Object.assign(config.notifications, origNotifications);
      vi.restoreAllMocks();
    }
  });

  it('never calls fetch when no notification channel is configured', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

    // Two INDEPENDENT sizing measurements on the same symbol: clear the first
    // order so the cross-tick double-open guard (which now blocks a second
    // entry while the first is still working/unmaterialized) doesn't skip the
    // second measurement.
    db.exec('DELETE FROM autotrade_live_orders; DELETE FROM order_events; DELETE FROM order_intents;');
    mockPlaceOrder.mockClear();
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig({ liveEnabledAt: null })); // not in probation
    const full = mockPlaceOrder.mock.calls[0][1].quantity;

    expect(halved).toBe(Math.floor(full * 0.5));
  });
});

// ---------------------------------------------------------------------------
// Funding capacity and unplaceable shorts (2026-08-27). Both came out of one
// session: 24 signals a tick, one position all day, and 48 live refusals of
// which 31 were shorts that liveAllowNakedShort could never have let through.
// ---------------------------------------------------------------------------
describe('runLiveExecution — funding capacity and unplaceable shorts', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
  };

  it('skips a short entry outright while naked shorts are off, without touching the broker', async () => {
    // It was reaching guardrails' naked_short rule at the very end, after a
    // correlation lookup, a sector lookup, a risk check and a broker
    // round-trip had all been spent on an order that was never placeable.
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SHORT' });

    const outcomes = await runLiveExecution([{ signal: signal({ side: 'sell', entry: 100, stop: 105, target: 90 }) }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(outcomes[0].reason).toMatch(/liveAllowNakedShort is off/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockAccountState).not.toHaveBeenCalled(); // never even loaded the account
  });

  it('lets the same short through to the broker once naked shorts are on', async () => {
    // The skip must be a consequence of the flag, not a new hard block —
    // otherwise turning shorts on would silently do nothing.
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: true });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SHORT-OK' });

    const outcomes = await runLiveExecution([{ signal: signal({ side: 'sell', entry: 100, stop: 105, target: 90 }) }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/liveAllowNakedShort is off/);
  });

  it('does not skip a LONG entry on the same flag', async () => {
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LONG' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/liveAllowNakedShort is off/);
  });

  // The fixture signal sizes to 2 shares at a $100.50 limit — a $201 notional
  // once probation (liveEnabledAt is set above) has halved it. The mocked
  // OVERNIGHT buying power below therefore has to sit UNDER $201, or both
  // halves of the pair pass whether or not the overlay exists. The first
  // version of this used $1,054.81 (the real broker figure that day) and was
  // vacuous for exactly that reason.
  const STARVED_OVERNIGHT_BP = 150;

  const starved = (dayBuyingPowerUsd?: number) =>
    ({
      ...okAccountState,
      state: {
        ...okAccountState.state,
        buyingPowerUsd: STARVED_OVERNIGHT_BP,
        exposureUsd: 1_227.84,
        ...(dayBuyingPowerUsd === undefined ? {} : { dayBuyingPowerUsd }),
      },
    }) as Awaited<ReturnType<typeof webullAccountState>>;

  it("funds an intraday entry from the broker's DAY buying power", async () => {
    // buyingPowerUsd is the overnight figure by design. This loop flattens
    // before the bell, so it is the one caller entitled to the day figure --
    // on 2026-08-27 that was $9,800.80 against $2,450.20 of equity, while
    // entries were refused for "$1,005.46 available".
    setAutotradeConfig({ ...cfgFields, accountEquityUsd: 2_283.61, liveDayBuyingPowerUsd: 0 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(starved(9_800.8));
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DTBP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/buying_power/);
    expect(mockPlaceOrder).toHaveBeenCalled();
  });

  it('blocks that SAME entry when the broker reports no day figure — proving the test above bites', async () => {
    // Identical account state; only dayBuyingPowerUsd is absent.
    setAutotradeConfig({ ...cfgFields, accountEquityUsd: 2_283.61, liveDayBuyingPowerUsd: 0 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(starved());
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NOBP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ ok: false });
    // Since 2026-08-28 the refusal happens in the SIZER rather than at the
    // guardrail: buying power now caps the quantity first, so $150 funds one
    // share and probation's halving rounds that to nothing. Either way the
    // entry never reaches the broker — which is what this pair exists to prove.
    expect(outcomes[0].reason).toMatch(/buying_power|rounded to 0/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('honours liveDayBuyingPowerUsd as a CEILING on what the broker offers', async () => {
    // $9,800.80 available, capped to $500 -- less than the notional, so the
    // entry is refused. The cap is the point: "never deploy more than this
    // intraday however much margin the broker extends".
    setAutotradeConfig({ ...cfgFields, accountEquityUsd: 2_283.61, liveDayBuyingPowerUsd: 500 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(starved(9_800.8));
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CAP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ ok: false });
    // Same move as the pair above — the ceiling now binds in the sizer.
    expect(outcomes[0].reason).toMatch(/buying_power|rounded to 0/);
  });

  it('never LOWERS the guardrail figure — a small cap cannot block an otherwise fundable order', async () => {
    setAutotradeConfig({ ...cfgFields, accountEquityUsd: 2_283.61, liveDayBuyingPowerUsd: 50 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, exposureUsd: 0, dayBuyingPowerUsd: 9_800.8 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MAX' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/buying_power/);
  });
});

// ---------------------------------------------------------------------------
// Level-aware exits (levelPlan.ts) wired into the live path. The operator's
// case, confirmed on real trades the same day: VALE was given a 2R target of
// 16.27 with resistance at 15.375 — 0.33R of actual headroom — and the stock
// topped at 15.22, never reaching even the capped target.
// ---------------------------------------------------------------------------
describe('runLiveExecution — level-aware exits', () => {
  const liveCfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
  };

  it('REJECTS a setup whose wall leaves less than the minimum reward — the VALE shape', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: true, levelMinRewardR: 1 });
    // Resistance at 103 against a 100 entry on a $5 risk: ~0.57R of headroom.
    mockGetProvider.mockReturnValue(providerWithWall({ AAPL: 100 }, 103));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-VETO' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(outcomes[0].reason).toMatch(/Level veto/);
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // never reached the broker
    const vetoes = listAutotradeEvents({ actions: ['level_veto'] });
    expect(vetoes).toHaveLength(1);
    expect(JSON.parse(vetoes[0].detail!)).toMatchObject({ atrTarget: 110, minRewardR: 1 });
  });

  it('caps the target short of the wall and places the order with the HONEST target', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: true, levelMinRewardR: 1 });
    // Resistance at 108: the 2R target of 110 is priced through it, but ~1.57R
    // of real headroom remains, so the trade is worth taking at a true target.
    mockGetProvider.mockReturnValue(providerWithWall({ AAPL: 100 }, 108));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CAP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);
    expect(outcomes[0]).toMatchObject({ ok: true });

    // The order that actually went to the broker carries the capped target.
    const placed = mockPlaceOrder.mock.calls[0][1] as { bracket?: { takeProfitPrice: number } };
    expect(placed.bracket!.takeProfitPrice).toBeLessThan(108);
    expect(placed.bracket!.takeProfitPrice).toBeLessThan(110); // not the ATR target
    const applied = listAutotradeEvents({ actions: ['level_exits_applied'] });
    expect(applied).toHaveLength(1);
    expect(JSON.parse(applied[0].detail!)).toMatchObject({ targetAdjusted: true });
  });

  it('leaves the ATR plan completely alone when the feature is off', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: false });
    mockGetProvider.mockReturnValue(providerWithWall({ AAPL: 100 }, 103)); // same close wall
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OFF' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);
    expect(outcomes[0]).toMatchObject({ ok: true }); // would have been vetoed if on
    const placed = mockPlaceOrder.mock.calls[0][1] as { bracket?: { takeProfitPrice: number } };
    expect(placed.bracket!.takeProfitPrice).toBe(110); // untouched ATR target
    expect(listAutotradeEvents({ actions: ['level_veto', 'level_exits_applied'] })).toHaveLength(0);
  });

  it('a candle fetch failure hands back the ATR plan rather than re-pricing on no data', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: true, levelMinRewardR: 1 });
    mockGetProvider.mockReturnValue({
      getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 100, timestamp: Date.now() })),
      getCandles: vi.fn(async () => {
        throw new Error('provider down');
      }),
    } as unknown as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NODATA' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);
    expect(outcomes[0]).toMatchObject({ ok: true });
    const placed = mockPlaceOrder.mock.calls[0][1] as { bracket?: { takeProfitPrice: number } };
    expect(placed.bracket!.takeProfitPrice).toBe(110); // untouched
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

  it('isolates a throwing candidate — one attempt throwing does not abort the rest of the batch', async () => {
    // Backstop (hardening audit): attemptLiveEntry normally returns an outcome,
    // but a rare unexpected throw (e.g. a DB write error mid-placement) must not
    // abort the remaining candidates. Here the FIRST candidate's placement
    // throws; the SECOND must still be attempted.
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
    mockPlaceOrder
      .mockRejectedValueOnce(new Error('disk I/O error')) // AAPL: unexpected throw
      .mockResolvedValue({ ok: true, orderId: 'WB-2' }); // MSFT: succeeds

    const outcomes = await runLiveExecution([
      { signal: signal({ symbol: 'AAPL' }) },
      { signal: signal({ symbol: 'MSFT' }) },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(outcomes[0].reason).toMatch(/unexpected error/i);
    expect(outcomes[1]).toMatchObject({ symbol: 'MSFT', ok: true }); // NOT aborted by AAPL's throw
    expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
  });

  it('skips a symbol with an open position that leaked in untagged (e.g. via the Webull position-sync backstop) — not just autotrade-tagged ones', async () => {
    // Same shape mapWebullPosition() produces for an orphaned import: real
    // shares held at the broker, but never routed through materializeEntryFill
    // (no 'autotrade' tag, no sourceIntentId). Before the fix, runLiveExecution's
    // skipSymbols only looked at snapshot.openPositions (tag-filtered), so this
    // wouldn't have been recognized as "already held" at all.
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, created_at, updated_at)
       VALUES ('stock','AAPL','long',10,100,'2026-07-01',0,1,'open',?,?,?)`,
    ).run(JSON.stringify(['webull']), now, now);

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
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-3' });

    const outcomes = await runLiveExecution([
      { signal: signal({ symbol: 'AAPL' }) }, // already "held" via the untagged row above
      { signal: signal({ symbol: 'MSFT' }) }, // genuinely free — must still go through
    ]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false, reason: 'Already has an open live position' });
    expect(outcomes[1]).toMatchObject({ symbol: 'MSFT', ok: true }); // not over-broadened to block everything
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // only MSFT ever reached the broker
  });
});

describe('adoptOrphanedLivePositions', () => {
  const okCtx = {
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
  };

  /** A still-pending (not yet reconciled/materialized) autotrade entry order —
   *  same setup listPendingLiveOrders' own describe block uses. */
  async function pendingEntryFor(symbol: string) {
    mockGetProvider.mockReturnValue(quoteReturning({ [symbol]: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: `WB-${symbol}` });
    const result = evaluateRiskCheck(signal({ symbol }), okCtx);
    await attemptLiveEntry(signal({ symbol }), result, 'MODERATE', liveConfig());
  }

  function insertOrphan(symbol: string, tags: string[], overrides: Partial<Record<string, unknown>> = {}) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, stop_price, target_price, source_intent_id, created_at, updated_at)
       VALUES ('stock',?,'long',10,100,'2026-07-01',0,1,'open',?,?,?,?,?,?)`,
    ).run(
      symbol,
      JSON.stringify(tags),
      overrides.stopPrice ?? null,
      overrides.targetPrice ?? null,
      overrides.sourceIntentId ?? null,
      now,
      now,
    );
  }

  it('adopts an orphaned webull-only position that matches a pending autotrade entry, backfilling its missing stop/target', async () => {
    await pendingEntryFor('AAPL'); // stop 95, target 110 (signal() fixture defaults)
    insertOrphan('AAPL', ['webull']); // no stop/target of its own — mapWebullPosition() never sets these

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 1 });
    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.tags).toEqual(expect.arrayContaining(['webull', 'live', 'autotrade']));
    expect(pos.stopPrice).toBe(95);
    expect(pos.targetPrice).toBe(110);
  });

  it('leaves an orphan alone when no pending entry matches its symbol', async () => {
    await pendingEntryFor('MSFT'); // pending, but for a DIFFERENT symbol
    insertOrphan('AAPL', ['webull']);

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 0 });
    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.tags).toEqual(['webull']); // untouched
  });

  it('never touches a position already tagged autotrade, even with a matching pending entry', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['live', 'autotrade']); // NOT the ['webull']-only shape this heals

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 0 });
  });

  it('does not overwrite an orphan that already has its own stop/target', async () => {
    await pendingEntryFor('AAPL'); // stop 95, target 110
    insertOrphan('AAPL', ['webull'], { stopPrice: 80, targetPrice: 130 }); // deliberately different

    adoptOrphanedLivePositions();

    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.stopPrice).toBe(80); // kept, not replaced by the matched order's 95
    expect(pos.targetPrice).toBe(130);
  });

  it('ignores a position without the webull tag, even if it matches a pending entry', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['some-other-tag']); // not the specific leaked-import shape

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 0 });
  });

  it('is a no-op with no orphans or no pending entries at all', () => {
    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 0 });
  });

  // Regression: a SECOND, distinct way a real autotrade fill can end up
  // untagged — services/trading/reconcile.ts's generic (human-Trade-page-
  // shaped) reconcile observing the fill before autotrade's own reconcile
  // does, tagging the position plain ['live'] (with sourceIntentId already
  // set, unlike the webull-import orphan shape above). Matched by
  // sourceIntentId, not symbol, since it's already precise.
  it('adopts a plain-"live"-tagged position with a matching sourceIntentId, matched precisely (not by symbol)', async () => {
    await pendingEntryFor('AAPL');
    const intentId = listIntents()[0].id;
    insertOrphan('AAPL', ['live'], { sourceIntentId: intentId }); // no stop/target of its own

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 1 });
    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.tags).toEqual(expect.arrayContaining(['live', 'autotrade']));
    expect(pos.stopPrice).toBe(95);
    expect(pos.targetPrice).toBe(110);
    expect(getLiveOrder(intentId)?.positionId).toBe(pos.id); // linked, unlike the webull-orphan path
  });

  it('does not adopt a plain-"live"-tagged position whose sourceIntentId matches no pending entry, even for the same symbol', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['live'], { sourceIntentId: 999_999 }); // unrelated/stale intent id

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 0 });
    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.tags).toEqual(['live']); // untouched
  });

  it('ignores a plain-"live"-tagged position with no sourceIntentId at all', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['live']); // sourceIntentId null — not this shape either

    const result = adoptOrphanedLivePositions();

    expect(result).toEqual({ adopted: 0 });
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

describe('listAutotradeLivePositions', () => {
  function insertPosition(symbol: string, tags: string[], overrides: Partial<Record<string, unknown>> = {}) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, stop_price, target_price, created_at, updated_at)
       VALUES ('stock',?,'long',10,100,?,0,1,?,?,95,110,?,?)`,
    ).run(symbol, overrides.entryDate ?? '2026-07-02', overrides.status ?? 'open', JSON.stringify(tags), now, now);
  }

  it('only returns positions tagged autotrade, ignoring human-only "live" positions', () => {
    insertPosition('AAPL', ['live']); // human-placed — must not appear
    insertPosition('MSFT', ['live', 'autotrade']);
    const positions = listAutotradeLivePositions();
    expect(positions.map((p) => p.symbol)).toEqual(['MSFT']);
  });

  it('filters by status', () => {
    insertPosition('AAPL', ['live', 'autotrade'], { status: 'closed' });
    insertPosition('MSFT', ['live', 'autotrade'], { status: 'open' });
    expect(listAutotradeLivePositions({ status: 'open' }).map((p) => p.symbol)).toEqual(['MSFT']);
    expect(listAutotradeLivePositions({ status: 'closed' }).map((p) => p.symbol)).toEqual(['AAPL']);
  });

  it('filters by symbol', () => {
    insertPosition('AAPL', ['live', 'autotrade']);
    insertPosition('MSFT', ['live', 'autotrade']);
    expect(listAutotradeLivePositions({ symbol: 'aapl' }).map((p) => p.symbol)).toEqual(['AAPL']);
  });

  it('caps results at the given limit', () => {
    insertPosition('AAA', ['live', 'autotrade']);
    insertPosition('BBB', ['live', 'autotrade']);
    insertPosition('CCC', ['live', 'autotrade']);
    expect(listAutotradeLivePositions({ limit: 2 })).toHaveLength(2);
  });

  it('returns an empty array when nothing is tagged autotrade', () => {
    insertPosition('AAPL', ['live']);
    expect(listAutotradeLivePositions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Found live 2026-08-24 (VALE). The broker position-sync can land BETWEEN the
// broker's fill and this reconcile, importing the real holding as a plain
// ['webull'] row. materializeEntryFill's duplicate guard only recognised
// orphans that adoptOrphanedLivePositions() had ALREADY retagged, so it saw no
// match and created a SECOND row for the same 81 real shares. The journal then
// read 162 against a broker holding of 81, and the sync's close-detection half
// "fixed" the excess by closing it at an estimated price — a trade that never
// happened, in the journal.
// ---------------------------------------------------------------------------
describe('reconcileLiveOrders vs a position-sync row for the same fill', () => {
  it('adopts an untagged broker-imported row instead of creating a duplicate position', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DUP' });
    const okResult = evaluateRiskCheck(signal(), baseRiskCtx());
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;

    // The position-sync beats our reconcile and imports the real holding
    // untagged — no sourceIntentId, since it came from the broker, not us.
    const imported = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: okResult.sizing.suggestedQuantity,
      entryPrice: 100.5,
      entryDate: '2026-08-24',
      tags: ['webull'],
      accountId: 'ACC1',
    });

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    // ONE position for one real fill — not two.
    const open = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(imported.id);
    // ...healed: tagged so autotrade-scoped risk/P&L can see it, bracket
    // levels backfilled from the order, and linked to the order metadata.
    expect(open[0].tags).toEqual(expect.arrayContaining(['live', 'autotrade']));
    expect(open[0].stopPrice).toBe(95);
    expect(open[0].targetPrice).toBe(110);
    expect(getLiveOrder(intentId)?.positionId).toBe(imported.id);
  });

  it('does not adopt a row belonging to a different account', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OTHER' });
    const okResult = evaluateRiskCheck(signal(), baseRiskCtx());
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100.5,
      entryDate: '2026-08-24',
      tags: ['webull'],
      accountId: 'OTHER-ACCOUNT',
    });
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    // The other account's holding is untouched; our fill gets its own row.
    const open = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(open).toHaveLength(2);
    expect(open.find((p) => p.accountId === 'OTHER-ACCOUNT')!.tags).not.toContain('autotrade');
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
    await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg, 'risk-off', 2.5);
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
    // Conviction grade (signal score 70 → B at the default 75/60 thresholds) is
    // carried from the order metadata onto the materialized position.
    expect(getLiveOrder(intentId)?.grade).toBe('B');
    expect(positions[0].grade).toBe('B');
    expect(getLiveOrder(intentId)?.positionId).toBe(positions[0].id);
    // At-entry context (2026-07-26) rides the same order-metadata path: raw
    // score, regime label, and market ATR% land on the position, and the
    // entry gets a real ET wall-clock time (from the order's placement
    // moment) so the Journal's time-of-day session buckets can see it.
    expect(positions[0].entryScore).toBe(70);
    expect(positions[0].marketRegime).toBe('risk-off');
    expect(positions[0].marketAtrPct).toBe(2.5);
    expect(positions[0].entryTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it('closes the position when a bracket exit leg unambiguously reports FILLED', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-4' });
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
    // The filled STOP_LOSS leg IS the exit reason — recorded, not inferred.
    expect(closed[0].exits[0].exitReason).toBe('stop');
  });

  /** Same approving risk-check attemptLiveEntry's own describe block uses. */
  const entryResult = (): RiskCheckResult =>
    evaluateRiskCheck(signal(), {
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

  it('keeps an AMBIGUOUS placement pending instead of rejecting it, so it cannot be re-placed', async () => {
    // A lost/timed-out response is indistinguishable from a rejection at the
    // client layer ({status: 0, ok: false}). Marking it rejected is terminal, so
    // the intent left listPendingLiveOrders AND the double-open guard, and the
    // next cycle placed the SAME real order again — double size, two brackets.
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Request timed out after 10000ms', ambiguous: true });

    const sig = signal();
    const first = await attemptLiveEntry(sig, entryResult(), 'MODERATE', liveConfig());
    expect(first.ok).toBe(false);
    expect(first.reason ?? '').toMatch(/unknown/i);
    expect(listPendingLiveOrders().map((o) => o.symbol)).toContain('AAPL');

    // A second cycle must NOT place another real order for the same symbol.
    mockPlaceOrder.mockClear();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DUP' });
    await attemptLiveEntry(sig, entryResult(), 'MODERATE', liveConfig());
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('a definite broker refusal is still terminal (not treated as unknown)', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Insufficient buying power' });

    const sig = signal();
    const res = await attemptLiveEntry(sig, entryResult(), 'MODERATE', liveConfig());
    expect(res.reason ?? '').toMatch(/rejected/i);
    expect(listPendingLiveOrders()).toHaveLength(0);
  });

  it('reconcile retires an unknown placement once the broker positively has no record of it', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'network error', ambiguous: true });
    const sig = signal();
    await attemptLiveEntry(sig, entryResult(), 'MODERATE', liveConfig());
    expect(listPendingLiveOrders()).toHaveLength(1);

    // Both endpoints answered and neither knows this client order id — but the
    // order was sent seconds ago, and the broker may simply not have recorded it
    // yet. Retiring here would free the dedup slot and let the next cycle place
    // the same real order again, which is the hole the ambiguous branch exists
    // to close.
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    await reconcileLiveOrders();
    expect(listPendingLiveOrders()).toHaveLength(1); // still held

    // Once it has been outstanding long enough that absence really is evidence.
    db.prepare('UPDATE order_intents SET updated_at = ?').run(Date.now() - UNKNOWN_PLACEMENT_RETIRE_GRACE_MS - 1000);
    await reconcileLiveOrders();

    expect(listPendingLiveOrders()).toHaveLength(0); // retired, slot released
    expect(listPositions({ status: 'open' })).toHaveLength(0); // and no phantom position
  });

  it('a fill arriving during the grace period is still booked, not waited out', async () => {
    // The grace period defers RETIRING, nothing else — an order that turns out
    // to have landed must resolve immediately whenever the broker says so.
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'network error', ambiguous: true });
    const placed = await attemptLiveEntry(signal(), entryResult(), 'MODERATE', liveConfig());
    const ordered = getIntent(placed.intentId!)!.quantity;

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: ordered,
      filledPrice: 100,
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    expect(getIntent(placed.intentId!)?.state).toBe('filled');
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('resolves an unknown placement that had actually filled', async () => {
    // The gap #337 left: it kept an ambiguous placement pending and resolvable
    // for "never landed" and "can't reach the broker", but not for the most
    // likely outcome of all. The intent sits at 'submitted', and FILLED is an
    // illegal transition from there, so canMove was false and the order was
    // skipped every tick — pending forever, holding the symbol's dedup slot,
    // with the real filled position never materialized into any ledger.
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Request timed out', ambiguous: true });
    const placed = await attemptLiveEntry(signal(), entryResult(), 'MODERATE', liveConfig());
    const ordered = getIntent(placed.intentId!)!.quantity;
    expect(getIntent(placed.intentId!)?.state).toBe('submitted'); // non-terminal, as designed

    // It did land after all, and filled before the first reconcile.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      brokerOrderId: 'WB-LATE',
      filledQty: ordered,
      filledPrice: 100,
    } as WebullOrderStatus);
    const outcomes = await reconcileLiveOrders();

    expect(outcomes[0]).toMatchObject({ changed: true, action: 'entry_filled' });
    expect(getIntent(placed.intentId!)?.state).toBe('filled');
    const positions = listPositions({ status: 'open' });
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('AAPL');
    expect(positions[0].quantity).toBe(ordered);
  });

  it('leaves an unknown placement pending while the broker cannot be reached', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'network error', ambiguous: true });
    const sig = signal();
    await attemptLiveEntry(sig, entryResult(), 'MODERATE', liveConfig());

    // Can't ask => say nothing. Retiring here would re-open the double-place hole.
    mockOrderStatus.mockResolvedValue({ ok: false, found: false, error: 'Webull down' } as WebullOrderStatus);
    await reconcileLiveOrders();
    expect(listPendingLiveOrders()).toHaveLength(1);
  });

  it("folds the live OPTIONS book into equity's daily-drawdown halt", async () => {
    // Paper combines both books and the live OPTIONS batch already folds equity
    // in; only this direction was missing. Without it a day of live options
    // losses left equity's halt unaware, so it kept opening full-size real
    // positions past the intended daily cap.
    setAutotradeConfig(liveConfig({ maxDailyDrawdownPct: 3 }));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SEED' });

    // Equity book is flat; the OPTIONS book is already past the 3% halt.
    const outcomes = await runLiveExecution([{ signal: signal() }], null, {
      dailyPnl: -4_000,
      consecutiveLosses: 0,
      tradesToday: 0,
    });

    expect(outcomes[0].ok).toBe(false);
    expect(mockPlaceOrder).not.toHaveBeenCalled();

    // Causation: the SAME candidate with a neutral options book is allowed, so
    // the block above came from the seed and not from some unrelated gate.
    const allowed = await runLiveExecution([{ signal: signal() }], null, {
      dailyPnl: 0,
      consecutiveLosses: 0,
      tradesToday: 0,
    });
    expect(allowed[0].ok).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });

  it('a partially-filled bracket exit leg books only what filled, leaving the rest open', async () => {
    // The leg's filledQty is parsed by the provider but was never passed on, so
    // a leg reporting FILLED on a partial quantity closed the WHOLE position:
    // P&L fabricated for shares that never sold, and the real remainder dropped
    // out of the ledger — invisible to the risk snapshot, to the time-exit
    // sweep, and to the scale-in loop, while the symbol became re-enterable.
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-PARTIAL-EXIT' });
    const res = evaluateRiskCheck(signal(), {
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
    await attemptLiveEntry(signal(), res, 'MODERATE', liveConfig());

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: res.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();
    const opened = listPositions({ status: 'open' })[0];
    expect(opened.quantity).toBeGreaterThan(1);

    // The stop leg fills for ONE share only.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: opened.quantity,
      filledPrice: 100,
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED', filledPrice: 95, filledQty: 1 },
      ],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const stillOpen = listPositions({ status: 'open' });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].remainingQuantity).toBe(opened.quantity - 1);
  });

  it('fails closed: an ambiguous leg response (no comboType at all) leaves the position open rather than guessing', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-5' });
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

  it("isolates a genuine persistence failure materializing an entry fill (createPosition itself throwing) — doesn't crash the reconcile pass", async () => {
    // Distinct from the broker-side checks above: this exercises the
    // try/catch ADDED AROUND materializeEntryFill() itself, for a failure
    // that can't be predicted from the broker response (e.g. a DB-layer
    // error). Before this fix, the intent transition to 'filled' had already
    // committed by the time createPosition() throws, and since
    // listPendingLiveOrders() only keeps polling a 'filled' intent while its
    // linked position is open, the fill would be silently lost forever.
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-7' });
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
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;

    const createSpy = vi.spyOn(positionsDb, 'createPosition').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      mockOrderStatus.mockResolvedValue({
        ok: true,
        found: true,
        status: 'FILLED',
        filledQty: okResult.sizing.suggestedQuantity,
        filledPrice: 100.5,
        legs: [{ comboType: 'MASTER', status: 'FILLED' }],
      } as WebullOrderStatus);

      const outcomes = await reconcileLiveOrders();
      expect(outcomes[0]).toMatchObject({ intentId, symbol: 'AAPL', changed: true });
      expect(outcomes[0].error).toMatch(/failed to materialize a position/i);
      expect(listPositions({ status: 'open' })).toHaveLength(0); // no Position was created

      const failedEvent = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' }).find(
        (e) => e.action === 'live_entry_materialization_failed',
      );
      expect(failedEvent).toBeDefined();
      expect(JSON.parse(failedEvent!.detail!)).toMatchObject({ intentId });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('treats two exit legs BOTH reporting FILLED as ambiguous, journals it, and leaves the position open', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-8' });
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
    expect(listPositions({ status: 'open' })).toHaveLength(1);

    // Both the STOP_LOSS and STOP_PROFIT legs report FILLED — shouldn't
    // happen under normal OCO semantics but isn't ruled out given this
    // response shape is unconfirmed against a live account (see
    // WebullOrderLeg's own caveat) — must not be guessed either way.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [
        { comboType: 'MASTER', status: 'FILLED' },
        { comboType: 'STOP_LOSS', status: 'FILLED', filledPrice: 95 },
        { comboType: 'STOP_PROFIT', status: 'FILLED', filledPrice: 110 },
      ],
    } as WebullOrderStatus);
    const outcomes = await reconcileLiveOrders();
    expect(outcomes[0]).toMatchObject({ changed: false });
    expect(outcomes[0].error).toMatch(/ambiguous/i);
    expect(listPositions({ status: 'open' })).toHaveLength(1); // left open, not guessed closed

    const ambiguousEvent = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' }).find(
      (e) => e.action === 'live_exit_ambiguous',
    );
    expect(ambiguousEvent).toBeDefined();
    expect(JSON.parse(ambiguousEvent!.detail!).legs).toEqual(expect.arrayContaining(['STOP_LOSS', 'STOP_PROFIT']));
  });
});

describe('reconcileLiveOrders + adoptOrphanedLivePositions interaction', () => {
  // Regression: reconcile's order-status poll can lag the broker's own
  // positions feed by a tick or more. adoptOrphanedLivePositions() heals the
  // resulting untagged orphan promptly — but until materializeEntryFill()
  // learned to recognize an already-adopted position, reconcile catching up
  // on a LATER tick created a genuine SECOND position for the same real
  // fill. The generic Webull sync's own close-detection half then "cleaned
  // up" the resulting doubled quantity by auto-closing the OLDER (adopted)
  // position with a FABRICATED estimated exit price — a real trade that
  // never happened, corrupting the journal.
  it('links reconcile catching up late to the already-adopted position instead of creating a duplicate', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-9' });
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
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;

    // Tick 1: order-status still working, but the broker's positions feed
    // already shows the shares held — the generic sync backstop imports an
    // orphan, and adoption heals it the same tick.
    mockOrderStatus.mockResolvedValue({ ok: true, found: true, status: 'Working' } as WebullOrderStatus);
    await reconcileLiveOrders();
    expect(listPositions({ status: 'open' })).toHaveLength(0);

    mockBrokerPositions([
      { symbol: 'AAPL', quantity: okResult.sizing.suggestedQuantity, cost_price: 100, asset_type: 'stock' },
    ]);
    await runWebullPositionsSync('ACC1');
    expect(adoptOrphanedLivePositions().adopted).toBe(1);

    const adopted = listPositions({ status: 'open' });
    expect(adopted).toHaveLength(1);
    expect(adopted[0].tags).toEqual(expect.arrayContaining(['webull', 'live', 'autotrade']));
    expect(adopted[0].sourceIntentId).toBeNull();
    const adoptedId = adopted[0].id;

    // Tick 2: order-status catches up and now reports FILLED.
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

    // No duplicate — still the SAME single position, now linked.
    const afterReconcile = listPositions({ status: 'open' });
    expect(afterReconcile).toHaveLength(1);
    expect(afterReconcile[0].id).toBe(adoptedId);
    expect(getLiveOrder(intentId)?.positionId).toBe(adoptedId);

    const linkedEvent = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' }).find(
      (e) => e.action === 'live_position_linked_to_adopted',
    );
    expect(linkedEvent).toBeDefined();

    // The sync running again must not see a doubled quantity and must not
    // false-close anything.
    const syncAgain = await runWebullPositionsSync('ACC1');
    expect(syncAgain.closed).toBe(0);
    expect(syncAgain.imported).toBe(0);
    expect(listPositions({ status: 'open' })).toHaveLength(1);
    expect(listAutotradeLivePositions({ status: 'open' })).toHaveLength(1);

    // And the bracket's exit leg still closes the LINKED position via the
    // precise fill-price path, not just the generic estimated-price backstop.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      legs: [{ comboType: 'STOP_PROFIT', status: 'FILLED', filledPrice: 110 }],
    } as WebullOrderStatus);
    const exitOutcomes = await reconcileLiveOrders();
    expect(exitOutcomes).toEqual([{ intentId, symbol: 'AAPL', changed: true, action: 'exit_filled' }]);
    expect(listPositions({ status: 'open' })).toHaveLength(0);
    const closed = listPositions({ status: 'closed' })[0];
    expect(closed.id).toBe(adoptedId);
    expect(closed.exits[0].exitPrice).toBe(110); // the real broker fill price, not an estimate
  });
});

describe('listPendingLiveOrders / terminal-state exclusion', () => {
  it('keeps a filled bracket entry pending (to keep checking exit legs) until its position actually closes', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-6' });
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
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(listIntents()).toHaveLength(1); // the rejected intent IS audited...
    expect(listPendingLiveOrders()).toHaveLength(0); // ...but was never tagged as autotrade's, since recordLiveOrder only runs on a successful placement
  });
});

describe('checkLiveScaleIns', () => {
  it('places no add-on outside the session window', async () => {
    // A scale-in adds real risk to an open real position. loop.ts calls this
    // BEFORE its own checkSessionWindow, behind isLiveEntryActive — which has no
    // market-hours term — and evaluateGuardrails only WARNS on a closed market.
    // So the gate has to live here or a real add-on can be submitted overnight.
    const { checkSessionWindow } = await import('../src/services/autotrading/executionGuards');
    // mockReturnValue (not Once): checkLiveScaleIns returns early on several
    // cheaper checks, so a queued one-shot could survive into the next test.
    vi.mocked(checkSessionWindow).mockReturnValue({ ok: false, reason: 'Market is closed' });
    try {
      expect(await checkLiveScaleIns()).toEqual([]);
      expect(vi.mocked(webullPlaceOrder)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkSessionWindow).mockReturnValue({ ok: true });
    }
  });

  const riskCtx = {
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
  };

  // Open a real live position through the entry -> reconcile flow, then set the
  // config the way each test wants for the scale-in pass. Entry 100, stop 95
  // (5-wide risk), target 110, ~200 shares (1% of $100k over $5). Filled at 100
  // so the position's entry is a clean 100 and 1R sits at 105.
  async function openLivePosition(overrides: Partial<AutotradeConfig> = {}) {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ENTRY' });
    const okResult = evaluateRiskCheck(signal(), riskCtx);
    const cfg = liveConfig(overrides);
    setAutotradeConfig(cfg);
    await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);
    // The quantity actually ORDERED — probation/cap adjustments can make this
    // smaller than the raw suggestion, and a broker can't fill more than was
    // ordered. Mocking the suggestion would describe an impossible fill, which
    // reconcile now (correctly) refuses to book in full.
    const orderedQty = listIntents()[0].quantity;
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: orderedQty,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();
    return { pos: listPositions({ status: 'open' })[0], qty: orderedQty };
  }

  const SCALE_ON = { liveScaleInEnabled: true, liveMaxAddOns: 2, addOnTriggerRMultiple: 1, addOnSizePct: 50 };

  it('places an add-on bracket when a live winner reaches the trigger', async () => {
    const { pos, qty } = await openLivePosition(SCALE_ON);
    // Price at +1R (105); the add is placed as its OWN bracket.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });

    const outcomes = await checkLiveScaleIns();
    expect(outcomes).toEqual([{ symbol: 'AAPL', positionId: pos.id, requested: true }]);
    expect(countLiveAddOns(pos.id)).toBe(1);

    // The add order carried a bracket (raised stop + the position's target).
    const addIntent = listIntents().find((i) => i.limitPrice && i.quantity === Math.floor(qty * 0.5));
    expect(addIntent?.isBracket).toBe(true);

    const scaled = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scaled_in',
    );
    expect(JSON.parse(scaled!.detail!)).toMatchObject({ positionId: pos.id, addQty: Math.floor(qty * 0.5) });
  });

  it('does nothing when the flag is off (even past the trigger)', async () => {
    const { pos } = await openLivePosition({ ...SCALE_ON, liveScaleInEnabled: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    expect(await checkLiveScaleIns()).toEqual([]);
    expect(countLiveAddOns(pos.id)).toBe(0);
  });

  it('does nothing when liveMaxAddOns is 0', async () => {
    await openLivePosition({ ...SCALE_ON, liveMaxAddOns: 0 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    expect(await checkLiveScaleIns()).toEqual([]);
  });

  it('stops adding once the liveMaxAddOns cap is reached', async () => {
    const { pos } = await openLivePosition({ ...SCALE_ON, liveMaxAddOns: 1 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD1' });
    await checkLiveScaleIns();
    expect(countLiveAddOns(pos.id)).toBe(1);

    // Merge the add-on so it's no longer "in flight", then a second attempt at a
    // higher price must still be capped at 1.
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 100,
      filledPrice: 105,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 112 }) as ReturnType<typeof getProvider>);
    const second = await checkLiveScaleIns();
    expect(second).toEqual([]);
    expect(countLiveAddOns(pos.id)).toBe(1);
  });

  it('fails closed (no add, journals the block) when guardrails reject the add', async () => {
    // Open with a normal cap so the ENTRY succeeds, THEN drop the per-order cap
    // below the add's ~$10.5k notional so the ADD specifically is blocked.
    const { pos } = await openLivePosition(SCALE_ON);
    setAutotradeConfig({ liveMaxOrderUsd: 5_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveScaleIns();
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Guardrails blocked/);
    expect(countLiveAddOns(pos.id)).toBe(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // never reached the broker
    const blocked = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scale_in_blocked',
    );
    expect(blocked).toBeTruthy();
  });

  it('does not fire below the trigger', async () => {
    await openLivePosition(SCALE_ON);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 103 }) as ReturnType<typeof getProvider>); // +0.6R
    expect(await checkLiveScaleIns()).toEqual([]);
  });

  it('fails closed (no add) when the add would exceed the aggregate open-risk cap', async () => {
    // The open position already carries ~$1000 risk (≈200sh × $5 stop). Drop the
    // aggregate cap below that so any add exceeds it — the risk LAYER (not just
    // the per-order guardrails) must block the pyramiding, exactly as it would a
    // fresh entry.
    const { pos } = await openLivePosition(SCALE_ON);
    setAutotradeConfig({ maxAggregateOpenRiskPct: 0.5 }); // cap = $500 on $100k equity
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveScaleIns();
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Aggregate open-risk cap/);
    expect(countLiveAddOns(pos.id)).toBe(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // never reached the broker
    const blocked = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scale_in_blocked',
    );
    expect(JSON.parse(blocked!.detail!)).toMatchObject({ reason: 'max_aggregate_open_risk' });
  });

  it('no-ops when the server placement master (TRADING_ENABLED) is off', async () => {
    await openLivePosition(SCALE_ON);
    config.trading.placeEnabled = false;
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    expect(await checkLiveScaleIns()).toEqual([]);
  });

  it('reconcile MERGES an add-on fill into the position (blended entry, bigger qty) — no duplicate row', async () => {
    const { pos, qty } = await openLivePosition(SCALE_ON);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });
    await checkLiveScaleIns();

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: Math.floor(qty * 0.5),
      filledPrice: 105,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const openNow = listPositions({ status: 'open' });
    expect(openNow).toHaveLength(1); // MERGED, not a second position
    const merged = openNow[0];
    expect(merged.id).toBe(pos.id);
    expect(merged.quantity).toBe(qty + Math.floor(qty * 0.5)); // 200 + 100
    // Blended: (100*200 + 105*100) / 300 = 101.6667
    expect(merged.entryPrice).toBeCloseTo(101.6667, 3);
  });
});

// ---------------------------------------------------------------------------
// Partial fills on the AUTOTRADE path. Same defect as the human path — booking
// only at a terminal `filled` — but with a sharper edge here: an intent that
// goes cancelled/rejected/expired leaves listPendingLiveOrders() for good, so a
// partial that is cancelled between two 60s ticks would never be booked by
// anything, ever. Real autotrade-opened shares, permanently invisible to the
// Auto page's risk and P&L accounting.
//
// autotrade_live_orders.position_id is a SINGLE column, so unlike the human
// ledger's independent lots, later instalments must BLEND into the one position
// the first instalment created.
// ---------------------------------------------------------------------------
describe('reconcileLiveOrders — partial fills', () => {
  async function placeEntry() {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-P1' });
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
    const intentId = listIntents()[0].id;
    return { intentId, orderedQty: getIntent(intentId)!.quantity };
  }

  const brokerSays = (status: string, filledQty: number, filledPrice: number) =>
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status,
      filledQty,
      filledPrice,
      legs: [{ comboType: 'MASTER', status }],
    } as WebullOrderStatus);

  it('opens a position on a partial fill instead of waiting for the order to complete', async () => {
    const { intentId, orderedQty } = await placeEntry();
    const part = Math.floor(orderedQty / 2);
    brokerSays('PARTIAL_FILLED', part, 100.5);

    await reconcileLiveOrders();

    const open = listPositions({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(part);
    expect(getLiveOrder(intentId)?.positionId).toBe(open[0].id);
    expect(getIntent(intentId)!.materializedQty).toBe(part);
  });

  it('BLENDS a later instalment into the same position rather than opening a second', async () => {
    const { intentId, orderedQty } = await placeEntry();
    const part = Math.floor(orderedQty / 2);
    brokerSays('PARTIAL_FILLED', part, 100);
    await reconcileLiveOrders();

    // Running average across the full order: half at 100, the rest at 102.
    const rest = orderedQty - part;
    brokerSays('FILLED', orderedQty, (part * 100 + rest * 102) / orderedQty);
    await reconcileLiveOrders();

    const open = listPositions({ status: 'open' });
    expect(open).toHaveLength(1); // one position, not two
    expect(open[0].quantity).toBe(orderedQty);
    // Blended cost basis reflects both instalments at their own prices.
    expect(open[0].entryPrice).toBeCloseTo((part * 100 + rest * 102) / orderedQty, 4);
    expect(getIntent(intentId)!.materializedQty).toBe(orderedQty);
  });

  it('books a partial that the broker reports as CANCELLED in one shot', async () => {
    // The order is cancelled between ticks, so reconcile never sees a
    // PARTIAL_FILLED status — only a CANCELLED response still carrying its
    // filled quantity. Booking on the STATUS rather than the reported quantity
    // would drop these shares permanently: the intent is terminal, so
    // listPendingLiveOrders() never returns it again.
    const { intentId, orderedQty } = await placeEntry();
    const part = Math.floor(orderedQty / 2);
    brokerSays('CANCELLED', part, 100.25);

    await reconcileLiveOrders();

    const open = listPositions({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(part);
    expect(open[0].entryPrice).toBeCloseTo(100.25);
    expect(getIntent(intentId)!.state).toBe('cancelled');
    // And it is genuinely gone from the polling set now.
    expect(listPendingLiveOrders().some((o) => o.intentId === intentId)).toBe(false);
  });

  it('does not double-book when the same fill is seen on two ticks', async () => {
    const { intentId, orderedQty } = await placeEntry();
    brokerSays('PARTIAL_FILLED', orderedQty / 2, 100);
    await reconcileLiveOrders();
    await reconcileLiveOrders();

    expect(listPositions({ status: 'open' })).toHaveLength(1);
    expect(listPositions({ status: 'open' })[0].quantity).toBe(orderedQty / 2);
    expect(getIntent(intentId)!.materializedQty).toBe(orderedQty / 2);
  });

  it('refuses to book, and journals it, when the reported quantity decreases', async () => {
    const { intentId, orderedQty } = await placeEntry();
    brokerSays('PARTIAL_FILLED', orderedQty, 100);
    await reconcileLiveOrders();

    brokerSays('PARTIAL_FILLED', Math.floor(orderedQty / 4), 100);
    await reconcileLiveOrders();

    // Still the original booking — nothing rewound, nothing added.
    expect(getIntent(intentId)!.materializedQty).toBe(orderedQty);
    expect(listPositions({ status: 'open' })[0].quantity).toBe(orderedQty);
    const journaled = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_fill_not_fully_materialized',
    );
    expect(journaled).toBeTruthy();
    expect(JSON.parse(journaled!.detail!).warning).toMatch(/decreased/i);
  });

  it('never opens a position larger than the order that was placed', async () => {
    const { intentId, orderedQty } = await placeEntry();
    brokerSays('FILLED', orderedQty * 2, 100);

    await reconcileLiveOrders();

    expect(listPositions({ status: 'open' })[0].quantity).toBe(orderedQty);
    // Priced at the reported average, NOT the full notional divided by the
    // clamped quantity (which would double it).
    expect(listPositions({ status: 'open' })[0].entryPrice).toBeCloseTo(100);
    expect(getIntent(intentId)!.materializedQty).toBe(orderedQty);
  });
});

describe('reconcileLiveOrders — booking and the materialization mark are atomic', () => {
  // The blend-vs-create discriminator for a later instalment is materializedQty
  // ("only ever advanced by this function"). If the Position commit survived a
  // crash but the mark's did not, the next tick would read materializedQty 0,
  // take the create branch, and book a SECOND real position for the SAME
  // broker fill. A temp trigger ABORTs exactly where advanceMaterialized
  // writes — a faithful mid-sequence crash — and the transaction must roll the
  // Position back with it; the retry then books exactly once.
  it('rolls the Position back when the mark update fails, then books exactly once on retry', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ATOM' });
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
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig(), null, null);
    const intentId = listIntents()[0].id;
    // Mock the share count actually ORDERED (probation sizing may have cut the
    // suggested size) — reconcile refuses to book more than was ordered.
    const orderedQty = listIntents()[0].quantity;
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: orderedQty,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);

    db.exec(
      `CREATE TEMP TRIGGER fail_advance BEFORE UPDATE OF materialized_qty ON order_intents
       BEGIN SELECT RAISE(ABORT, 'simulated crash before mark commit'); END`,
    );
    try {
      const outcomes = await reconcileLiveOrders();
      // The path's own catch converts the abort into an error outcome (and
      // journals it) rather than letting a reconcile throw kill the loop tick.
      expect(outcomes[0].error).toMatch(/failed to materialize a Position.*simulated crash/);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_advance');
    }
    // Nothing half-committed: no Position, mark unbooked, metadata unlinked.
    expect(listPositions()).toHaveLength(0);
    expect(getIntent(intentId)!.materializedQty).toBe(0);
    expect(getLiveOrder(intentId)?.positionId ?? null).toBeNull();

    // Next tick (trigger gone = process restarted): the SAME fill books once.
    const retry = await reconcileLiveOrders();
    expect(retry[0]).toMatchObject({ changed: true, action: 'entry_filled' });
    expect(listPositions()).toHaveLength(1);
    expect(getIntent(intentId)!.materializedQty).toBe(orderedQty);
  });
});

// ---------------------------------------------------------------------------
// A position the human opened by hand is NOT the loop's to close.
//
// Every acting path already scopes itself with listAutotradeLivePositions()
// (the 'autotrade' tag). That is five separate call sites honouring one
// convention with nothing enforcing it — add a sixth exit path, forget the
// filter, and the loop starts selling holdings it never opened, with no test
// to notice. This is the enforcement.
//
// Each case is PAIRED: the untagged position is left alone AND an
// autotrade-tagged one in the identical situation is acted on. Without the
// second half a filter that accidentally matched nothing would pass.
// ---------------------------------------------------------------------------
describe('manual positions are never auto-sold', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: null,
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
    // Force every time-based exit to want to fire right now.
    maxHoldDays: 1,
    endOfDayFlattenMinutes: 5,
  };

  /** A holding the human owns: real shares, broker-imported, no 'autotrade'
   *  tag and no sourceIntentId — the shape mapWebullPosition() produces. */
  function manualPosition(symbol = 'MANL') {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier,
         status, tags, stop_price, target_price, created_at, updated_at)
       VALUES ('stock',?,'long',10,100,'2026-07-01',0,1,'open',?,95,110,?,?)`,
    ).run(symbol, JSON.stringify(['webull', 'live']), now - 5 * 86_400_000, now);
    return symbol;
  }

  /** The same holding, but genuinely autotrade's. */
  function autotradePosition(symbol = 'AUTO') {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier,
         status, tags, stop_price, target_price, initial_stop_price, created_at, updated_at)
       VALUES ('stock',?,'long',10,100,'2026-07-01',0,1,'open',?,95,110,95,?,?)`,
    ).run(symbol, JSON.stringify(['webull', 'live', 'autotrade']), now - 5 * 86_400_000, now);
    return symbol;
  }

  beforeEach(() => {
    setAutotradeConfig(cfgFields);
    mockGetProvider.mockReturnValue(quoteReturning({ MANL: 100, AUTO: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MANUAL' });
  });

  it('listAutotradeLivePositions is the scope every acting path uses, and it excludes the manual one', () => {
    manualPosition();
    autotradePosition();
    const scoped = listAutotradeLivePositions({ status: 'open' }).map((p) => p.symbol);
    expect(scoped).toContain('AUTO');
    expect(scoped).not.toContain('MANL');
    // Both really are open — the manual one is excluded by TAG, not absence.
    expect(
      listPositions({ status: 'open' })
        .map((p) => p.symbol)
        .sort(),
    ).toEqual(['AUTO', 'MANL']);
  });

  it('the max-hold-days time exit closes the autotrade position and not the manual one', async () => {
    manualPosition();
    autotradePosition();
    const outcomes = await checkLiveEquityTimeExits();
    // Assert on what the rule CONSIDERED, not on what it managed to place: the
    // fixture has no source_intent_id, so AUTO's close fails at "cannot locate
    // its bracket to cancel". That is fine — reaching that failure proves the
    // rule selected it, which is precisely the half that must not happen to a
    // manual holding.
    const considered = outcomes.map((o) => o.symbol);
    expect(considered).toContain('AUTO'); // the pair's other half — the rule did run
    expect(considered).not.toContain('MANL');
    for (const call of mockPlaceOrder.mock.calls) expect(call[1].symbol).not.toBe('MANL');
  });

  it('scale-outs, stop ratchets, scale-ins and bracket protection all skip it too', async () => {
    manualPosition();
    setAutotradeConfig({ liveScaleOutEnabled: true, liveTrailingEnabled: true, liveScaleInEnabled: true });

    const touched = [
      ...(await checkLiveEquityScaleOuts()),
      ...(await checkLiveEquityStopAdjusts()),
      ...(await checkLiveScaleIns()),
      ...(await checkLiveBracketProtection()),
    ].map((o) => o.symbol);

    expect(touched).not.toContain('MANL');
    for (const call of mockPlaceOrder.mock.calls) expect(call[1].symbol).not.toBe('MANL');
  });

  it('is not adopted into autotrade without a matching pending entry order of its own', async () => {
    // Adoption is what would turn a manual holding INTO a managed one, after
    // which every rule above would rightly apply to it.
    manualPosition();
    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 0 });
    expect(listAutotradeLivePositions({ status: 'open' }).map((p) => p.symbol)).not.toContain('MANL');
  });

  it('and autotrade will not even OPEN a position in a symbol the human already holds', async () => {
    // The other half of the protection: no entry means no fill to reconcile,
    // so the reconciler can never mistake the human's shares for its own.
    manualPosition('AAPL');
    const outcomes = await runLiveExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });
});
