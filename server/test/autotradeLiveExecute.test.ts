import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, onTestFinished } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  const { batchFromSingle } = await import('./helpers/webullOrderStatusMock');
  const webullOrderStatus = vi.fn();
  return {
    ...actual,
    webullPlaceOrder: vi.fn(),
    // Defaults to the same result the unmocked call already produced in tests
    // (webullConfigured() is false here), so existing expectations are
    // unchanged — but it is now overridable by a test that needs the broker to
    // answer.
    listWebullOpenOrders: vi.fn(async () => ({ ok: false, orders: [], error: 'Webull is not configured.' })),
    // Same convention: defaults to what the unmocked call produced (Webull is
    // not configured in tests), overridable by the cases that need the broker
    // to accept a protective re-arm.
    webullPlaceStandaloneBracket: vi.fn(async () => ({ ok: false, error: 'Webull is not configured.' })),
    // Same again: the protection sweep now CANCELS a lone resting take-profit
    // so both legs can be re-armed together, and the cases that exercise that
    // need to say whether the broker accepted the cancel.
    webullCancelOrder: vi.fn(async () => ({ ok: false, error: 'Webull is not configured.' })),
    webullOrderStatus,
    webullOrderStatusBatch: batchFromSingle(webullOrderStatus),
    // Same convention: what the unmocked call answers in tests (Webull is not
    // configured), overridable by the cases that read a bracket leg by its own
    // id (#147).
    webullOrderDetail: vi.fn(async () => ({ ok: false, found: false, error: 'Webull is not configured.' })),
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
import type { AccountState } from '../src/services/trading/guardrails';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import {
  webullPlaceOrder,
  webullOrderStatus,
  listWebullOpenOrders,
  webullPlaceStandaloneBracket,
  webullCancelOrder,
  webullOrderDetail,
  buildStandaloneBracketRequest,
  WebullOrderStatus,
} from '../src/providers/webull/orders';
import { bumpMissStreak } from '../src/db/webullMissStreak';
import { initDb, db } from '../src/db';
import {
  setAutotradeConfig,
  getAutotradeConfig,
  defaultAutotradeConfig,
  AutotradeConfig,
} from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { etDateTimeToMs, etToday } from '../src/util/marketDate';
import { shortRefusedReason } from '../src/services/autotrading/refusedShorts';
import { parseDeclinedEntry } from '../src/services/autotrading/declinedEntry';
import { saveDailyBaseline } from '../src/db/dailyBaseline';
import { listAutotradeEvents, logAutotradeEvent } from '../src/db/autotradeEvents';
import { listPositions, createPosition, addExit } from '../src/db/positions';
import * as positionsDb from '../src/db/positions';
import {
  getLiveOrder,
  getLiveEntryOrderForPosition,
  listPendingLiveOrders,
  countLiveAddOns,
  recordLiveAddOnOrder,
  recordLiveExitOrder,
  recordLiveOrder,
  setLiveOrderPositionId,
} from '../src/db/autotradeLiveOrders';
import { advanceMaterialized, getIntent, listIntents, transitionIntent, createIntent } from '../src/db/orders';
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
  buyingPowerBasis,
  runLiveExecution,
  resetEquitySyncGuardState,
  syncAccountEquityFromBroker,
  adoptOrphanedLivePositions,
  checkLiveScaleIns,
  checkLiveBracketProtection,
  checkLiveEquityScaleOuts,
  checkLiveEquityStopAdjusts,
  checkLiveEquityTimeExits,
  entryIntentIdForPosition,
  cancelLiveBracketExitLegs,
} from '../src/services/autotrading/liveExecute';
import { createLiveOptionsPosition } from '../src/db/autotradeLiveOptionsPositions';
import { resetUnplaceableSymbols } from '../src/services/autotrading/unplaceableSymbols';
import { contractKey, runWebullPositionsSync } from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';
import { writeDailyHaltMarker } from '../src/services/autotrading/dailyHaltMarker';
import {
  holdMarketDirection,
  readMarketDirection,
  readMarketDirectionForTick,
  LATEST_DIRECTION_MAX_AGE_MS,
  type MarketDirectionReading,
} from '../src/services/autotrading/marketDirection';

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
    dayStartEquityUsd: 100_000,
    dailyHaltTripped: false,
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
    mlRegime: null,
    mlRegimeEnabled: false,
    mlRegimeSizeCutPct: 35,
    todayRangePct: null,
    regimeShockRangeRatio: 0,
    priorSameDayExits: 0,
    repeatEntrySizeCutPct: 0,
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
  // Module-level state: a symbol learned in one test must not leak into the next.
  resetUnplaceableSymbols();
  // …and the equity guard's corroboration state, which is the same class and
  // had no seam at all until 2026-09-12. THIS file is the only one that drives
  // the real syncAccountEquityFromBroker (autotradeLoop.test.ts mocks the whole
  // module), and it drives the 2026-08-27 rejection twice — so without this,
  // every later test IN THIS FILE inherits two-thirds of a confirmation at
  // $2,444.70, and a third reading near that level would be ACCEPTED rather
  // than refused. Acceptance-after-corroboration also rebases the day's
  // baseline, so the wrong outcome would not stay local to the assertion.
  resetEquitySyncGuardState();
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
  vi.mocked(webullPlaceStandaloneBracket).mockReset();
  // Back to the module mock's own default: Webull is not configured in tests,
  // so a re-arm fails with a KNOWN error unless a case says otherwise.
  vi.mocked(webullPlaceStandaloneBracket).mockResolvedValue({ ok: false, error: 'Webull is not configured.' });
  vi.mocked(webullCancelOrder).mockReset();
  vi.mocked(webullCancelOrder).mockResolvedValue({ ok: false, error: 'Webull is not configured.' });
  vi.mocked(webullOrderDetail).mockReset();
  vi.mocked(webullOrderDetail).mockResolvedValue({ ok: false, found: false, error: 'Webull is not configured.' });
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
  });

  // The day's loss budget, from maxDailyDrawdownPct over the day's OPENING
  // equity — NOT the stored liveMaxDailyLossUsd, which re-derives from
  // whatever net liquidation last re-anchored the caps. Both stored values
  // below are deliberately wrong-on-purpose so a regression to either shows.
  it('derives maxDailyLossUsd from the drawdown % and the day baseline, not the stored dollar cap', () => {
    saveDailyBaseline(etToday(), 50_000);
    const cfg = buildLiveTradingConfig(
      liveConfig({ accountEquityUsd: 10_000, liveMaxDailyLossUsd: 333, maxDailyDrawdownPct: 7.5 }),
    );
    // 7.5% of the day's opening 50,000 — not 7.5% of the 10,000 reading, and
    // not the stored 333.
    expect(cfg.maxDailyLossUsd).toBe(3_750);
  });

  it('falls back to the current reading when the day has no baseline yet', () => {
    db.prepare('DELETE FROM autotrade_daily_baseline').run();
    const cfg = buildLiveTradingConfig(liveConfig({ accountEquityUsd: 10_000, maxDailyDrawdownPct: 7.5 }));
    expect(cfg.maxDailyLossUsd).toBe(750);
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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

  // The slide the per-tick guard cannot see. Every step below 25%, the whole
  // day 84% — on 2026-09-15 that produced 143 `live_caps_reanchored` rows and
  // not one line saying the account had moved.
  it('journals once a day when net liquidation is a long way from where the day opened', async () => {
    saveDailyBaseline(etToday(), 3_699.78);
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 720.81, equitySyncMaxJumpPct: 25 });
    // Inside the per-tick guard (720.81 -> 591.81 is -17.9%), far outside the
    // day (-84%).
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 591.81 });

    await syncAccountEquityFromBroker();

    // Not rejected: the reading is real and is written.
    expect(getAutotradeConfig().accountEquityUsd).toBe(591.81);
    expect(listAutotradeEvents({ actions: ['equity_sync_rejected'] })).toHaveLength(0);

    const moved = listAutotradeEvents({ actions: ['equity_moved_far_from_open'] });
    expect(moved).toHaveLength(1);
    expect(JSON.parse(moved[0].detail!)).toMatchObject({
      openingEquityUsd: 3_699.78,
      currentEquityUsd: 591.81,
      movePct: -84.0,
      maxJumpPct: 25,
    });

    // Once a day, not once a tick — 180 ticks would otherwise bury it.
    await syncAccountEquityFromBroker();
    await syncAccountEquityFromBroker();
    expect(listAutotradeEvents({ actions: ['equity_moved_far_from_open'] })).toHaveLength(1);
  });

  it('says nothing when the day has moved a normal amount', async () => {
    saveDailyBaseline(etToday(), 10_000);
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 10_000, equitySyncMaxJumpPct: 25 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 10_900 });
    await syncAccountEquityFromBroker();
    expect(listAutotradeEvents({ actions: ['equity_moved_far_from_open'] })).toHaveLength(0);
  });

  it('starts the corroboration count over after a reset — the seam is load-bearing', async () => {
    // The guard promotes an out-of-band level after THREE consecutive readings
    // near it. That counter is module state with no table behind it, so before
    // 2026-09-12 it had no way to be cleared and simply carried on across every
    // test in this file. Two rejections in the case above leave it at 2 of 3:
    // the very next out-of-band reading near $2,444.70 — in a test written to
    // assert a refusal — would instead be ACCEPTED, written to config, and
    // would rebase the day's baseline through applyExternalCashFlow.
    setAutotradeConfig({ liveAccountId: 'ACC1', accountEquityUsd: 2_234.58, equitySyncMaxJumpPct: 5 });
    mockAccountState.mockResolvedValue({ ...okAccountState, netLiquidationUsd: 2_444.7 });

    await syncAccountEquityFromBroker({ log: false }); // 1 of 3
    await syncAccountEquityFromBroker({ log: false }); // 2 of 3
    resetEquitySyncGuardState();
    await syncAccountEquityFromBroker({ log: false }); // would be 3 of 3 without the reset

    // Still refused, and the equity untouched — the count restarted at 1.
    expect(getAutotradeConfig().accountEquityUsd).toBe(2_234.58);
    const rows = listAutotradeEvents({ actions: ['equity_sync_rejected'] });
    expect(rows).toHaveLength(3);
    expect(String(JSON.parse(rows[0].detail!).reason)).toMatch(/1\/3 at this level/);
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
    dayStartEquityUsd: 100_000,
    dailyHaltTripped: false,
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
    mlRegime: null,
    mlRegimeEnabled: false,
    mlRegimeSizeCutPct: 35,
    todayRangePct: null,
    regimeShockRangeRatio: 0,
    priorSameDayExits: 0,
    repeatEntrySizeCutPct: 0,
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

  // -------------------------------------------------------------------------
  // THE ENTRY PATH'S OWN GUARDS (2026-09-23, shorts pre-flight). Each one is
  // something the broker, not the ledger, knows at placement time.
  // -------------------------------------------------------------------------
  const guardRows = () =>
    listAutotradeEvents({ stage: 'execution', actions: ['live_entry_guard_refused'] }).map((e) =>
      JSON.parse(e.detail ?? '{}'),
    );
  const shorts = () => liveConfig({ liveAllowNakedShort: true });

  it('refuses a long whose quote is already at or below its stop, and journals it once a day', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94.9 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    const first = await attemptLiveEntry(signal({ stop: 95 }), okResult, 'MODERATE', liveConfig());
    const second = await attemptLiveEntry(signal({ stop: 95 }), okResult, 'MODERATE', liveConfig());

    expect(first).toMatchObject({ ok: false });
    expect(first.reason).toMatch(/through_stop/);
    expect(second.ok).toBe(false);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    // The declined-entry shape every refusal writes (journalDeclinedEntry), so
    // the replay can score it: the lean, not the order side, and the floor.
    expect(guardRows()).toEqual([
      expect.objectContaining({
        guard: 'through_stop',
        side: 'long',
        last: 94.9,
        stop: 95,
        liveMinSignalScore: liveConfig().liveMinSignalScore,
        liveEligible: expect.any(Boolean),
      }),
    ]);
  });

  it('refuses a short whose quote is already at or above its stop, and its row replays as a SHORT', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    const r = await attemptLiveEntry(signal({ side: 'sell', stop: 105, target: 90 }), okResult, 'MODERATE', shorts());

    expect(r.reason).toMatch(/through_stop/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    // THE CONSUMER: the declined-entry replay reads anything but 'short' as a
    // long, and the first version of this row wrote the order side, 'sell'.
    const [row] = listAutotradeEvents({ stage: 'execution', actions: ['live_entry_guard_refused'] });
    expect(parseDeclinedEntry(row)?.side).toBe('short');
  });

  it('never sends a short against shares the broker holds LONG — it would sell them as a plain SELL', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, currentPositionQty: 150 },
    } as Awaited<ReturnType<typeof webullAccountState>>);

    const r = await attemptLiveEntry(signal({ side: 'sell', stop: 105, target: 90 }), okResult, 'MODERATE', shorts());

    expect(r.reason).toMatch(/opposite_holding/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(guardRows()[0]).toMatchObject({ guard: 'opposite_holding', brokerPositionQty: 150 });
  });

  it('never sends a long against a short the broker holds — it would buy it back', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, currentPositionQty: -50 },
    } as Awaited<ReturnType<typeof webullAccountState>>);

    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    expect(r.reason).toMatch(/opposite_holding/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('still places a long beside a long the broker already holds — the same side is not a reversal', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, currentPositionQty: 150 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LONG-BESIDE' });

    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    expect(r.ok).toBe(true);
    expect(guardRows()).toEqual([]);
  });

  it('refuses a short when the holdings read failed, and lets a long through as before', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue({ ...okAccountState, positionsUnavailable: true } as Awaited<
      ReturnType<typeof webullAccountState>
    >);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LONG-UNREAD' });

    const short = await attemptLiveEntry(
      signal({ side: 'sell', stop: 105, target: 90 }),
      okResult,
      'MODERATE',
      shorts(),
    );
    const long = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());

    expect(short.reason).toMatch(/holding_unknown/);
    expect(long.ok).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });

  it('remembers a short the broker refused and does not send it again that day; a long in the name still goes', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValueOnce({ ok: false, error: 'This stock is not available to short' });

    const refused = await attemptLiveEntry(
      signal({ side: 'sell', stop: 105, target: 90 }),
      okResult,
      'MODERATE',
      shorts(),
    );
    const again = await attemptLiveEntry(
      signal({ side: 'sell', stop: 105, target: 90 }),
      okResult,
      'MODERATE',
      shorts(),
    );

    expect(refused.reason).toMatch(/Broker rejected/);
    expect(again.reason).toMatch(/short_refused_today/);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
    // Refused before the quote and the account are read, since it needs neither.
    expect(mockAccountState).toHaveBeenCalledTimes(1); // the refused attempt's read only
    expect(guardRows()[0]).toMatchObject({
      guard: 'short_refused_today',
      brokerReason: 'This stock is not available to short',
    });

    mockPlaceOrder.mockResolvedValueOnce({ ok: true, orderId: 'WB-LONG-AFTER' });
    const long = await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(long.ok).toBe(true);
  });

  it("does not hold a symbol's shorts for the day on a BUYING-POWER refusal — the learned ceiling handles that", async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValueOnce({
      ok: false,
      error: 'Buying power is insufficient. Please cancel open buy orders (if any) and try again.',
    });

    await attemptLiveEntry(signal({ side: 'sell', stop: 105, target: 90 }), okResult, 'MODERATE', shorts());

    expect(shortRefusedReason('AAPL', etToday())).toBeUndefined();
  });

  it('does not remember an UNANSWERED short — it may have gone through', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValueOnce({ ok: false, ambiguous: true, error: 'timeout' });

    await attemptLiveEntry(signal({ side: 'sell', stop: 105, target: 90 }), okResult, 'MODERATE', shorts());

    expect(guardRows()).toEqual([]);
    expect(shortRefusedReason('AAPL', etToday())).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PER-LOT BRACKETS (#26), asserted at the ENTRY — the flag has to change what
  // is actually ordered, not just what a planner returns.
  // -------------------------------------------------------------------------
  it('orders only the LARGER lot, at the NEAR target, when per-lot brackets are on', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LOT1' });

    const r = await attemptLiveEntry(
      signal(),
      okResult,
      'MODERATE',
      liveConfig({
        livePerLotBracketsEnabled: true,
        partialExitPct: 67,
        partialExitRMultiple: 0.25,
        targetRMultiple: 2,
      }),
    );
    expect(r.ok).toBe(true);

    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    // Signal is entry 100 / stop 95, so 1R = $5: the near target is 101.25 and
    // the full one is the signal's own 110. Asserting the PRICE, not the R,
    // because a bracket leg is a price and that is where a unit slip would land.
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 101.25, stopLossPrice: 95 });

    const planned = listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'] });
    expect(planned).toHaveLength(1);
    const plan = JSON.parse(planned[0].detail!) as {
      sizedQuantity: number;
      first: { quantity: number };
      second: { quantity: number; targetPrice: number };
    };
    // Derived, never hardcoded: the two lots must add back to what the risk
    // check sized, and the one ordered now must be the larger.
    expect(placedIntent.quantity).toBe(plan.first.quantity);
    expect(plan.first.quantity + plan.second.quantity).toBe(plan.sizedQuantity);
    expect(plan.first.quantity).toBeGreaterThanOrEqual(plan.second.quantity);
    expect(plan.second.targetPrice).toBe(110);
  });

  it('builds the RUNNER lot at the regime-tightened target, the same one decide.ts and the finish line use', async () => {
    // Found on the 2026-09-10 merge review. The loop hands decide.ts a target
    // already tightened by regimeAdjustedTargets, and stamps the factor on the
    // order row — but the per-lot split read autotradeCfg.targetRMultiple RAW,
    // so with both features on in a High-Vol tape the runner would have been
    // built at the full 2R while regime_target_factor on the row said 0.7. Two
    // derivations of one target, and a stamp the MFE ledger would have trusted.
    // Asserted at the PLAN the second lot is actually placed from, in price.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LOT1' });

    const cfg = liveConfig({
      livePerLotBracketsEnabled: true,
      partialExitPct: 67,
      partialExitRMultiple: 0.25,
      targetRMultiple: 2,
      mlRegimeEnabled: true,
      mlRegimeTargetTightenPct: 30,
    });
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg, null, null, 'high_vol_bearish', 0.7);
    expect(r.ok).toBe(true);

    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    // The partial lot's near target is partialExitRMultiple, which the tighten
    // does not touch: still 101.25 on a $5 R.
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 101.25, stopLossPrice: 95 });

    const planned = listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'] });
    expect(planned).toHaveLength(1);
    const plan = JSON.parse(planned[0].detail!) as { second: { targetR: number; targetPrice: number } };
    // 2R × (1 − 30/100) = 1.4R; entry 100 + 1.4 × $5 = 107 — not the raw 110.
    expect(plan.second.targetR).toBeCloseTo(1.4, 6);
    expect(plan.second.targetPrice).toBe(107);
  });

  it('leaves the runner at the full target when the overlay is on but the tick is not High Vol', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LOT1' });

    const cfg = liveConfig({
      livePerLotBracketsEnabled: true,
      partialExitPct: 67,
      partialExitRMultiple: 0.25,
      targetRMultiple: 2,
      mlRegimeEnabled: true,
      mlRegimeTargetTightenPct: 30,
    });
    // A Low-Vol stamp, and separately an unknown (null) one: neither tightens.
    await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg, null, null, 'low_vol_bullish', 1);
    const planned = listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'] });
    expect(planned).toHaveLength(1);
    expect(JSON.parse(planned[0].detail!).second.targetPrice).toBe(110);
  });

  it('is exactly today’s entry when the flag is off', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-FULL' });

    const cfg = liveConfig({ partialExitPct: 67 });
    const r = await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg);

    expect(r.ok).toBe(true);
    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    // Derived through probation, not hardcoded: live probation HALVES orders,
    // and six tests in this file once asserted a raw 200 and all failed at 100.
    const full = Math.floor(okResult.sizing.suggestedQuantity * getProbationStatus(cfg).multiplier);
    expect(placedIntent.quantity).toBe(full);
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 110, stopLossPrice: 95 });
    expect(listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'] })).toEqual([]);
  });

  it('falls back to a full-size entry when the R geometry cannot price a near target', async () => {
    // Zero-width risk: entry == stop. lotTargetPrice returns null, and a
    // half-built position is worse than today's behaviour, so the split is
    // abandoned rather than half-applied. The quote sits a cent above the stop:
    // AT the stop, the entry is refused outright (through_stop, 2026-09-23).
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100.01 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DEGENERATE' });

    const cfg = liveConfig({ livePerLotBracketsEnabled: true, partialExitPct: 67, partialExitRMultiple: 0.25 });
    const r = await attemptLiveEntry(signal({ entry: 100, stop: 100, target: 110 }), okResult, 'MODERATE', cfg);

    expect(r.ok).toBe(true);
    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    const full = Math.floor(okResult.sizing.suggestedQuantity * getProbationStatus(cfg).multiplier);
    expect(placedIntent.quantity).toBe(full);
    expect(placedIntent.bracket).toEqual({ takeProfitPrice: 110, stopLossPrice: 100 });
    expect(listAutotradeEvents({ stage: 'execution', actions: ['per_lot_entry_planned'] })).toEqual([]);
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

  it('journals the declined short once per symbol per day, with the numbers a later decision needs', async () => {
    // Task #61. Until 2026-09-10 the skip above left NO journal row, so the day
    // the operator asked "is it worth turning on shorting" (785 of 1,000
    // signals were SELL, 15 of 17 of those names closed below their open) the
    // journal could not say how many live-eligible shorts the live book had
    // declined, or which. Asserted at the EVENT, and asserted once-per-day: a
    // row per tick per symbol is how excluded_re became 31% of the table (#43).
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    const short = signal({ side: 'sell', entry: 100, stop: 105, target: 90 });

    await runLiveExecution([{ signal: short }]);
    await runLiveExecution([{ signal: short }]); // the next tick, same ET day

    const rows = listAutotradeEvents({ stage: 'execution', actions: ['live_short_skipped'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('AAPL');
    expect(JSON.parse(rows[0].detail!)).toMatchObject({
      score: short.score,
      entry: 100,
      stop: 105,
      target: 90,
      reason: 'liveAllowNakedShort is off',
    });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  // 2026-09-24: once per symbol per TAPE per day. A short first declined on a
  // mixed tape at 09:37 was never recorded again when the tape turned red at
  // 10:15, so the record could not say what a red-tape-only switch would have
  // taken. The row now also carries the tape and the ATR the next gate reads.
  it('journals the declined short once per tape per day, with the tape and the ATR on the row', async () => {
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    const short = signal({ side: 'sell', entry: 100, stop: 105, target: 90, atr: 8 });
    const tape = (indexChangePct: number, red: number, green: number) =>
      readMarketDirection({
        indexSymbol: 'SPY',
        indexChangePct,
        breadth: { red, green, flat: 500 - red - green, sample: 500 },
        indexPct: 0.2,
        breadthPct: 65,
      });
    const tick = (reading: ReturnType<typeof tape>) =>
      runLiveExecution([{ signal: short }], null, undefined, null, undefined, reading);

    await tick(tape(0.5, 360, 140)); // mixed
    await tick(tape(-0.35, 365, 135)); // red
    await tick(tape(-0.4, 370, 130)); // red again: already on record today

    const rows = listAutotradeEvents({ stage: 'execution', actions: ['live_short_skipped'] });
    const details = rows.map((r) => JSON.parse(r.detail!) as Record<string, unknown>);
    expect(details.map((d) => d.direction).sort()).toEqual(['mixed', 'red']);
    for (const d of details) {
      expect(d).toMatchObject({ side: 'short', atr: 8, entry: 100, stop: 105, heldBy: null });
      expect(d.rawDirection).toBe(d.direction);
    }
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  // 2026-09-10: this skip runs BEFORE the score floor, both cooldowns and the
  // risk check, so a row exists for every scoring short candidate rather than
  // for the ones live would actually have taken — 39 distinct symbols against
  // THREE above the floor on 2026-09-10, a 13x overstatement of the one number
  // task #21's enabling decision reads. The row now says which it is.
  it('stamps whether the declined short was LIVE-ELIGIBLE, with the floor it was judged against', async () => {
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: false, liveMinSignalScore: 72 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    await runLiveExecution([
      { signal: signal({ symbol: 'AAPL', side: 'sell', entry: 100, stop: 105, target: 90, score: 80 }) },
      { signal: signal({ symbol: 'MSFT', side: 'sell', entry: 100, stop: 105, target: 90, score: 65 }) },
    ]);

    const detailFor = (sym: string) =>
      JSON.parse(
        listAutotradeEvents({ stage: 'execution', actions: ['live_short_skipped'] }).find((e) => e.symbol === sym)!
          .detail!,
      ) as { liveEligible: boolean; liveMinSignalScore: number; score: number };

    expect(detailFor('AAPL')).toMatchObject({ score: 80, liveEligible: true, liveMinSignalScore: 72 });
    // Below the floor: journaled (the sub-floor short flow is still worth
    // seeing) but marked so it cannot be counted as flow live turned down.
    expect(detailFor('MSFT')).toMatchObject({ score: 65, liveEligible: false, liveMinSignalScore: 72 });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('journals nothing for a short that is actually allowed', async () => {
    setAutotradeConfig({ ...cfgFields, liveAllowNakedShort: true });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SHORT' });

    await runLiveExecution([{ signal: signal({ side: 'sell', entry: 100, stop: 105, target: 90 }) }]);

    expect(listAutotradeEvents({ stage: 'execution', actions: ['live_short_skipped'] })).toEqual([]);
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
// The build-then-refuse loop, one bound over. guardrails.ts refuses an entry on
// THREE dollar tests and until 2026-09-05 only buying power reached the sizer,
// so order_notional and account_exposure were still discovered after a
// full-size order had been built. Live journal, the four sessions after the
// buying-power fix: 23 blocks, 18 account_exposure, and the misses were tiny —
// DELL over its cap by $10.84, SNDK by $60, DG by $120 six times in eleven
// minutes.
//
// Asserted at the CONSUMER throughout: what reaches the broker, not what the
// sizer returns. A test on fundableMaxQuantity alone would have stayed green
// through the entire bug, because the value was correct and nobody read it.
describe('runLiveExecution — sizing to every dollar bound the guardrail applies', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
  };
  // The fixture signal sizes to 200 shares @ ~$100 = ~$20k of notional.
  const placedNotional = () => {
    // webullPlaceOrder(accountId, intent, clientOrderId) — the intent is arg 1.
    const intent = mockPlaceOrder.mock.calls[0][1] as { quantity: number; limitPrice?: number };
    return intent.quantity * (intent.limitPrice ?? 0);
  };

  it('trims the order to fit the per-order notional cap instead of being refused by it', async () => {
    // Cap well under the ~$20k the risk sizer wants. Before the fix the order
    // was built at 200 shares and the guardrail refused it on order_notional.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 10_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CAP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].ok, `expected an entry, got: ${outcomes[0].reason}`).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
    expect(placedNotional()).toBeLessThanOrEqual(10_000);
  });

  it('trims the order to the room left under the account exposure cap', async () => {
    // The DELL shape: an account already most of the way to its exposure cap.
    // Equity 100k at 17% = a $17,000 cap, with $9,000 already deployed — so
    // $8,000 of headroom against a signal that wants $10,050. Unbounded, the
    // guardrail would see $19,050 against the cap and refuse the entry.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 50_000, liveMaxExposurePct: 17 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, exposureUsd: 9_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXP' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].ok, `expected an entry, got: ${outcomes[0].reason}`).toBe(true);
    // Fits the headroom the guardrail will measure: 9_000 + notional <= 17_000.
    expect(9_000 + placedNotional()).toBeLessThanOrEqual(17_000);
  });

  // THE LEARNED CEILING, ASSERTED AT THE CONSUMER (2026-09-14).
  //
  // CLAUDE.md's rule: a test that exercises a value where it is COMPUTED proves
  // nothing about whether anything consumes it. buyingPowerBasis's own unit
  // tests would pass just as happily if `withDayBuyingPower` threw the ceiling
  // away — which is exactly how liveOptionsMaxOrderUsd was computed and
  // discarded on 2026-08-27. So these drive the whole live path and read the
  // QUANTITY that reached the broker.
  it('learns from a broker refusal and sizes the NEXT order under it', async () => {
    // The 09:57 shape: the broker refuses an order the app's figure said was
    // comfortably fundable. Before this, the next candidate was built just as
    // large and refused in turn — five times in one session, for zero entries.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);

    // Round 1: the broker refuses, in its own words.
    mockPlaceOrder.mockResolvedValue({
      ok: false,
      error: 'Buying power is insufficient. Please cancel open buy orders (if any) and try again.',
    });
    const refused = await runLiveExecution([{ signal: signal() }]);
    expect(refused[0].ok).toBe(false);
    const refusedNotional = placedNotional();
    expect(refusedNotional).toBeGreaterThan(0);

    // Round 2: same account, same signal, nothing else changed.
    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LEARNED' });
    const after = await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    expect(after[0].ok, `expected an entry, got: ${after[0].reason}`).toBe(true);
    // Strictly under what was refused — that is the whole mechanism. Nothing
    // was accepted yet today, so it is the blind 10% step, not a bisection.
    expect(placedNotional()).toBeLessThan(refusedNotional);
    // The blind 10% step, applied to the NOTIONAL and not to the pool: nothing
    // has been accepted yet today, so there is no lower bracket to bisect
    // against. Within one share of the step, since quantity is whole.
    expect(placedNotional()).toBeGreaterThan(refusedNotional * 0.9 - 2 * 100.5);
    expect(placedNotional()).toBeLessThanOrEqual(refusedNotional * 0.9);
  });

  it('bisects between the largest ACCEPTED and the smallest refused order', async () => {
    // Once one order has been accepted there is a lower bracket, so the next
    // attempt splits the difference instead of stepping blindly down.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100, NVDA: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);

    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });
    await runLiveExecution([{ signal: signal() }]);
    const accepted = placedNotional();

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);
    const refused = placedNotional();
    // The fixture sizes both the same, so force the brackets apart: the
    // refusal must be the LARGER of the two for a bisection to mean anything.
    expect(refused).toBeGreaterThanOrEqual(accepted);

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MID' });
    await runLiveExecution([{ signal: signal({ symbol: 'NVDA' }) }]);
    // Midpoint of the two brackets, not the blind step.
    expect(placedNotional()).toBeLessThanOrEqual((accepted + refused) / 2);
  });

  it('does nothing to sizing on a session with no refusal', async () => {
    // The guarantee that makes this safe to leave on: until the broker says
    // no, the order is exactly the size it would have been.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-A' });

    await runLiveExecution([{ signal: signal() }]);
    const first = placedNotional();
    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-B' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    expect(placedNotional()).toBeCloseTo(first, 2);
  });

  it('ignores a rejection that is NOT about buying power', async () => {
    // An unparseable symbol or a bad price must not teach a ceiling — that
    // would shrink every later order over an unrelated failure.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);

    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Order price is invalid' });
    await runLiveExecution([{ signal: signal() }]);
    const attempted = placedNotional();

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-UNRELATED' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    expect(placedNotional()).toBeCloseTo(attempted, 2);
  });

  it('leaves the order alone when the operator turns liveRefusalCeilingEnabled off', async () => {
    // The switch exists so a broker whose refusals turn out to mean something
    // else is a config change, not a deploy. Asserted at the CONSUMER: the
    // flag is read where the order is trimmed, not where the ceiling is
    // computed, so a test of the helper alone would prove nothing.
    setAutotradeConfig({
      ...cfgFields,
      liveMaxOrderUsd: 500_000,
      liveMaxExposurePct: 1_000,
      liveRefusalCeilingEnabled: false,
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });
    await runLiveExecution([{ signal: signal() }]);
    const refused = placedNotional();

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OFF' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    expect(placedNotional()).toBeCloseTo(refused, 2);
    expect(listAutotradeEvents({ actions: ['live_entry_ceiling_resized'] })).toHaveLength(0);
  });

  it('journals the trim with the brackets it was bisected from', async () => {
    // The lever has to be readable. A shrunk order that says only "buying
    // power" points the operator at a config field; there is no buying-power
    // field that can raise this, so the row names the refusal instead.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });
    await runLiveExecution([{ signal: signal() }]);

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LABEL' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    const rows = listAutotradeEvents({ actions: ['live_entry_ceiling_resized'] });
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as Record<string, number | null>;
    expect(detail.toQuantity).toBeLessThan(detail.fromQuantity as number);
    expect(detail.refusedUsd).toBeGreaterThan(0);
    expect(detail.acceptedUsd).toBeNull();
    expect(detail.ceilingUsd).toBeCloseTo((detail.refusedUsd as number) * 0.9, 2);
  });

  it('carries the learned ceiling onto the placed row without binding the pool with it', async () => {
    // The units split: buyingPower.usedUsd stays the POOL (unchanged by the
    // ceiling), learnedCeilingUsd is the ORDER NOTIONAL the broker will take.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 500_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000_000, dayBuyingPowerUsd: 2_000_000 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });
    await runLiveExecution([{ signal: signal() }]);

    mockPlaceOrder.mockReset();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ROW' });
    await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);

    const placed = listAutotradeEvents({ actions: ['live_order_placed'] });
    const detail = JSON.parse(placed[0].detail ?? '{}') as {
      buyingPower?: { usedUsd?: number; source?: string; learnedCeilingUsd?: number | null };
    };
    expect(detail.buyingPower?.source).toBe('day');
    expect(detail.buyingPower?.usedUsd).toBe(2_000_000);
    expect(detail.buyingPower?.learnedCeilingUsd).toBeGreaterThan(0);
  });

  it('values the order at the marketable limit, not the raw signal entry', async () => {
    // The two derivations of one quantity. The guardrail values an order at its
    // LIMIT price (entry × 1.005 for a buy); the sizer used signal.entry. Sized
    // to exactly the cap on the cheaper price, the order overshoots on the
    // dearer one — which is most of the distance in a $10.84 miss.
    setAutotradeConfig({ ...cfgFields, liveMaxOrderUsd: 10_000, liveMaxExposurePct: 1_000 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-VAL' });

    await runLiveExecution([{ signal: signal() }]);

    const intent = mockPlaceOrder.mock.calls[0][1] as { quantity: number; limitPrice: number };
    expect(intent.limitPrice).toBeGreaterThan(100); // marketable buy limit
    // Valued at the LIMIT — the price guardrails.ts will use — it still fits.
    expect(intent.quantity * intent.limitPrice).toBeLessThanOrEqual(10_000);
  });

  it('does not hand the second entry in a tick headroom the first already spent', async () => {
    // The same double-spend the buying-power decrement exists to prevent, one
    // bound over: without decrementing exposure per fill, both candidates size
    // against the full headroom and together blow the cap.
    setAutotradeConfig({
      ...cfgFields,
      liveMaxOrderUsd: 50_000,
      liveMaxExposurePct: 15, // $15,000 cap, nothing deployed — fits ONE $10,050 order
      maxConcurrentPositions: 5,
      maxAggregateOpenRiskPct: 50,
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAA: 100, BBB: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-TWO' });

    await runLiveExecution([{ signal: signal({ symbol: 'AAA' }) }, { signal: signal({ symbol: 'BBB' }) }]);

    const placed = mockPlaceOrder.mock.calls.map((call) => call[1] as { quantity: number; limitPrice: number });
    expect(placed.length).toBe(2);
    // The discriminating assertion. Totals alone are too loose to catch this —
    // two probation-halved orders fit under most caps by luck — but the SECOND
    // order can only be smaller if the first one's notional was taken out of
    // the headroom. Without the decrement both size against the full cap and
    // come out identical.
    expect(placed[1].quantity).toBeLessThan(placed[0].quantity);
    const total = placed.reduce((sum, i) => sum + i.quantity * i.limitPrice, 0);
    expect(total).toBeLessThanOrEqual(15_000);
  });
});

// WHICH BUYING-POWER FIGURE THE SIZER AIMED AT (2026-09-14).
//
// On the trial sizing's first session the broker refused BWIN for insufficient
// buying power while the sizer had a figure and was happy — the
// build-then-refuse loop buyingPowerSizing.ts exists to end, happening again.
// The account showed $13,822.77 of intraday buying power against $3,522.74 of
// equity, so the DAY field won; the broker then refused a $3,742 order with
// ~$6,282 already deployed. Nothing in the journal said which figure had been
// used, so all of it had to be inferred from outside the app.
describe('buyingPowerBasis — which figure won, and saying so', () => {
  const cfg = (over: Partial<AutotradeConfig> = {}) => ({ ...defaultAutotradeConfig(), ...over });
  const state = (over: Partial<AccountState> = {}) =>
    ({ buyingPowerUsd: 1_000, exposureUsd: 0, ...over }) as AccountState;

  it('reports the overnight figure when the broker offers no day figure', () => {
    const b = buyingPowerBasis(state({ buyingPowerUsd: 1_000 }), cfg());
    expect(b).toMatchObject({ usedUsd: 1_000, source: 'overnight', brokerDayUsd: null });
  });

  it('carries the CASH balance beside the margin figures', () => {
    // The number a purchase that cannot be margined has to fit inside. On
    // 2026-09-14 a $3,742 order was refused with the book flat and the day
    // figure at ~$13.8k; without cash on the row, a margin shortfall and a
    // cash shortfall look identical.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_990.49, cashBalanceUsd: 212.4 }),
      cfg(),
    );
    expect(b.cashBalanceUsd).toBe(212.4);
    expect(b.brokerDayUsd).toBe(13_990.49);
  });

  it('reports cash as null when the broker did not report it — never a fabricated 0', () => {
    expect(buyingPowerBasis(state({ buyingPowerUsd: 1_000 }), cfg()).cashBalanceUsd).toBeNull();
  });

  it('reports the DAY figure, and the exposure it was netted against', () => {
    // The live shape: a day figure several times equity, minus what is already
    // deployed. This is the number the sizer aims at.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_822.77, exposureUsd: 6_282 }),
      cfg(),
    );
    expect(b.source).toBe('day');
    expect(b.usedUsd).toBeCloseTo(7_540.77, 2);
    expect(b).toMatchObject({ overnightUsd: 1_000, brokerDayUsd: 13_822.77, exposureUsd: 6_282, ceilingUsd: null });
  });

  it('stays on the overnight figure when the day figure nets out smaller', () => {
    // Not a tie-break dressed as a day read: the day field only WINS when it
    // is strictly larger, so a journal row saying 'day' always means it moved
    // the number.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 9_000, dayBuyingPowerUsd: 13_822.77, exposureUsd: 6_282 }),
      cfg(),
    );
    expect(b).toMatchObject({ source: 'overnight', usedUsd: 9_000 });
  });

  it('reports the operator ceiling when liveDayBuyingPowerUsd caps the day figure', () => {
    // The lever that exists today for exactly this: a CAP, not a value.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_822.77, exposureUsd: 0 }),
      cfg({ liveDayBuyingPowerUsd: 7_045 }),
    );
    expect(b).toMatchObject({ source: 'day', usedUsd: 7_045, ceilingUsd: 7_045, brokerDayUsd: 13_822.77 });
  });

  // THE LEARNED CEILING (2026-09-14). Five opening orders refused by the broker
  // for insufficient buying power while the app's figure said there was plenty.
  // The row that named the mechanism, 09:57 ET: the book was FLAT (COIN and NOW
  // both sold), so exposureUsd was back to 0 and the day branch handed over the
  // whole $13,990.49 — and the broker refused $3,720.12. Closing a position
  // returns the app's exposure to zero; it does not return the broker's pool.
  //
  // Margin itself is real on this account and is NOT the bug: COIN and NOW were
  // held together, $6,249.48 against $3,497.62 of cash, 1.79x. A cash bound
  // would have refused NOW outright.
  it('CARRIES the learned ceiling without binding the pool with it', () => {
    // Units. `usedUsd` answers "how much pool is there"; `learnedCeilingUsd`
    // answers "how big an order will this broker take today". Different
    // quantities judged at different points, so the ceiling rides along here
    // and is applied to the finished order in liveExecute — after probation,
    // which would otherwise halve an order that was already trimmed to fit.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 3_658.24, dayBuyingPowerUsd: 13_990.49, exposureUsd: 0 }),
      cfg(),
      3_516.06,
    );
    expect(b).toMatchObject({ usedUsd: 13_990.49, source: 'day', learnedCeilingUsd: 3_516.06 });
  });

  it('reports a null learned ceiling until the broker has refused something', () => {
    const b = buyingPowerBasis(state({ buyingPowerUsd: 1_000, dayBuyingPowerUsd: 5_000 }), cfg());
    expect(b).toMatchObject({ usedUsd: 5_000, source: 'day', learnedCeilingUsd: null });
  });

  it('carries the CASH balance without deciding on it', () => {
    // Kept on the row from #600 for readability. Nothing reads it: margin is
    // real here, so a cash bound would be wrong.
    const b = buyingPowerBasis(
      state({ buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_990.49, cashBalanceUsd: 18.07 }),
      cfg(),
    );
    expect(b).toMatchObject({ usedUsd: 13_990.49, source: 'day', cashBalanceUsd: 18.07 });
  });
});

// The gap between the price the loop DECIDED at and the price it PLACES at.
//
// riskCheck sizes from signal.entry — what the screen saw — and placement then
// fetches a fresh quote several seconds later, after the batch has awaited a
// broker round-trip for every candidate before this one. The bracket's stop
// goes in at signal.stop regardless, so the drift lands on the position as
// risk nobody budgeted. On the seven live rows carrying plannedStopDistancePct
// the realized risk ran 1.00x-1.46x the planned figure, mean 1.09x, and not
// one below 1.00x.
describe('runLiveExecution — the entry is sized against the price it will pay', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
    // Out of the way: this block is about the risk bound, not the dollar caps.
    liveMaxOrderUsd: 10_000_000,
    liveMaxExposurePct: 100_000,
    maxAggregateOpenRiskPct: 100,
  };

  const placedIntent = () => mockPlaceOrder.mock.calls[0][1] as { quantity: number; limitPrice: number };
  const journaledDetail = () =>
    JSON.parse(listAutotradeEvents({ actions: ['live_entry_risk_resized'] })[0]?.detail ?? '{}') as Record<
      string,
      number
    >;

  beforeEach(() => {
    setAutotradeConfig(cfgFields);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DRIFT' });
  });

  it('cuts the order so an adverse drift cannot risk more than the check approved', async () => {
    // The SWKS shape, exaggerated so the arithmetic is unambiguous: the screen
    // decided at 100 with a stop at 95 (5.00/share of risk), and by placement
    // the quote is 104 — 9.00/share against the same stop. Unfixed, the sized
    // quantity goes in at nearly double the risk it was approved for.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 104 }));

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].ok, `expected an entry, got: ${outcomes[0].reason}`).toBe(true);
    const intent = placedIntent();
    // The budget the row itself names, so the assertion does not re-derive the
    // risk profile or the probation cut — both live in production code and a
    // test that recomputes them passes when they drift.
    const approved = journaledDetail().approvedRiskUsd;
    // THE assertion, at the consumer: what the order really risks against the
    // stop it is really sending, measured at the quote risk is realized at.
    expect(Math.abs(104 - 95) * intent.quantity).toBeLessThanOrEqual(approved);
    // And it genuinely had to shrink — a test that passes because nothing was
    // placed would assert nothing.
    expect(intent.quantity).toBeGreaterThan(0);
    expect(intent.quantity).toBeLessThan(journaledDetail().fromQuantity);
  });

  it('journals the re-size with both prices, so the drift is readable', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 104 }));

    await runLiveExecution([{ signal: signal() }]);

    const rows = listAutotradeEvents({ actions: ['live_entry_risk_resized'] });
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as Record<string, number>;
    expect(detail.signalEntry).toBe(100);
    expect(detail.riskBasisPrice).toBe(104);
    expect(detail.limitPrice).toBeCloseTo(104.52, 2);
    expect(detail.driftPct).toBeCloseTo(4, 2);
    expect(detail.toQuantity).toBeLessThan(detail.fromQuantity);
    // The number the budget was never asked about: what the UNRESIZED order
    // would have risked. Without it the row says a size changed but not why it
    // mattered.
    expect(detail.riskAtBasisUsd).toBeGreaterThan(detail.approvedRiskUsd);
  });

  it('does NOT size up when the drift is favourable', async () => {
    // A limit that came back cheaper would fund more shares at the same risk,
    // but those shares never passed the guardrails and were never counted
    // against the aggregate budget. Drifting our way simply risks less.
    // Two favourable quotes, one much more favourable than the other. If the
    // cap were applied as a max rather than a min, the cheaper one would fund
    // a far bigger order; under the min they are identical, because both are
    // held at the quantity the risk check approved. A single absolute number
    // here would only re-derive the risk profile and the probation cut.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 96 }));
    const near = await runLiveExecution([{ signal: signal() }]);
    expect(near[0].ok, `expected an entry, got: ${near[0].reason}`).toBe(true);
    const nearQty = placedIntent().quantity;

    mockPlaceOrder.mockClear();
    mockGetProvider.mockReturnValue(quoteReturning({ BBB: 95.5 }));
    const far = await runLiveExecution([{ signal: signal({ symbol: 'BBB' }) }]);
    expect(far[0].ok, `expected an entry, got: ${far[0].reason}`).toBe(true);

    expect(placedIntent().quantity).toBe(nearQty);
    expect(listAutotradeEvents({ actions: ['live_entry_risk_resized'] })).toHaveLength(0);
  });

  it('measures the entry-extension shadow at the PLACEMENT quote, not the screen price', async () => {
    // 2026-09-14. The shadow divided `signal.entry` — the price the screen saw
    // — by a session range fetched after the placement, from 5-minute bars
    // behind a 5-minute cache. Two different moments, divided by each other,
    // and five of the first 43 live rows landed OUTSIDE their own range (FCX
    // read 130.0% of it).
    //
    // The fixture is that shape at unambiguous numbers: the screen decided at
    // 100, the placement quote is 104, and the session bars top out at 102.
    // Measured at 100 the row reads 66.7% of range. Measured at the price the
    // order was really priced at — which printed ABOVE the bars, so the bars
    // are behind — it reads 100% with the staleness flagged beside it.
    const today = etToday(Date.now());
    const barAt = etDateTimeToMs(today, '10:00') as number;
    mockGetProvider.mockReturnValue({
      getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 104, timestamp: Date.now() })),
      getCandles: vi.fn(async () => [{ time: barAt, open: 96, high: 102, low: 96, close: 101, volume: 10_000 }]),
    } as unknown as ReturnType<typeof getProvider>);

    const outcomes = await runLiveExecution([{ signal: signal({ symbol: 'EXTN' }) }]);
    expect(outcomes[0].ok, `expected an entry, got: ${outcomes[0].reason}`).toBe(true);

    const rows = listAutotradeEvents({ actions: ['entry_extension_shadow'] });
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.price).toBe(104);
    expect(detail.priceBasis).toBe('placement_quote');
    // Both prices on the row, so a later reader can see the drift it was
    // computed despite rather than having to reconstruct it.
    expect(detail.signalEntry).toBe(100);
    // 66.7 is what the screen price would have read against these bars.
    expect(detail.pctOfRange).toBe(100);
    expect(detail.extendedRange).toBe('above');
    // The discriminator the leak scan joins on: without it the paper row
    // written in this same minute would overwrite this one.
    expect(detail.book).toBe('live');
  });

  it('journals WHICH buying-power figure the sizer aimed at', async () => {
    // The BWIN case: a day figure several times equity wins, the sizer aims at
    // it, and until 2026-09-14 nothing on the row said so — a "buying power is
    // insufficient" rejection was unreadable without it.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_822.77, exposureUsd: 6_282 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-BP' });

    await runLiveExecution([{ signal: signal() }]);

    const detail = JSON.parse(listAutotradeEvents({ actions: ['live_order_placed'] })[0]?.detail ?? '{}') as {
      buyingPower?: { source: string; usedUsd: number; brokerDayUsd: number; exposureUsd: number };
    };
    expect(detail.buyingPower?.source).toBe('day');
    expect(detail.buyingPower?.brokerDayUsd).toBe(13_822.77);
    expect(detail.buyingPower?.exposureUsd).toBe(6_282);
    expect(detail.buyingPower?.usedUsd).toBeCloseTo(7_540.77, 2);
  });

  it('journals the same basis on a BROKER refusal, beside the order it refused', async () => {
    // The row that actually reported the problem. "Aimed at X, refused at Y"
    // has to be readable from one row, or it is inferred from outside again.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: 1_000, dayBuyingPowerUsd: 13_822.77, exposureUsd: 6_282 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });

    await runLiveExecution([{ signal: signal() }]);

    const detail = JSON.parse(listAutotradeEvents({ actions: ['live_entry_failed'] })[0]?.detail ?? '{}') as {
      reason?: string;
      orderNotionalUsd?: number;
      buyingPower?: { source: string; usedUsd: number };
    };
    expect(detail.reason).toMatch(/Buying power is insufficient/);
    expect(detail.buyingPower?.source).toBe('day');
    expect(detail.orderNotionalUsd).toBeGreaterThan(0);
  });

  it('records the risk the ORDER carries, not the risk the check approved', async () => {
    // pendingLiveOrdersRisk() sums this column into the aggregate open-risk
    // budget, and the position inherits it at materialization. Handing either
    // the pre-drift figure understates a book that is already fuller than it
    // looks.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 104 }));

    await runLiveExecution([{ signal: signal() }]);

    const order = listPendingLiveOrders()[0];
    expect(order.riskAmount).toBeCloseTo(Math.abs(104 - 95) * placedIntent().quantity, 6);
  });
});

// Webull's market-data side and its trading side disagree about which symbols
// exist. BF.B and BRK.B quote fine — verified live, BRK.B at 506.03 with a full
// book — so they screen, score, pass every filter and reach placement, where
// the order API refuses them:
//   "Parameter error, invalid market,symbol,instrument_type, value: US,BF.B,EQUITY"
// Both are in the 528-name universe, and this happened 18 times in July. Each
// attempt costs a full pipeline plus a round-trip AND creates an order intent,
// so it also spends one of the day's maxOrdersPerDay allowance on a trade that
// could never happen.
describe('runLiveExecution — symbols the broker cannot parse', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxOrderUsd: 50_000,
    liveMaxExposurePct: 1_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
  };
  const PARSE_ERROR = 'Parameter error, invalid market,symbol,instrument_type, value: US,BF.B,EQUITY';

  it('learns from the rejection and skips the symbol without touching the broker again', async () => {
    setAutotradeConfig(cfgFields);
    mockGetProvider.mockReturnValue(quoteReturning({ 'BF.B': 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: PARSE_ERROR });

    const first = await runLiveExecution([{ signal: signal({ symbol: 'BF.B' }) }]);
    expect(first[0].ok).toBe(false);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);

    // Second pass: refused before any broker call at all.
    mockPlaceOrder.mockClear();
    mockAccountState.mockClear();
    const second = await runLiveExecution([{ signal: signal({ symbol: 'BF.B' }) }]);

    expect(second[0]).toMatchObject({ symbol: 'BF.B', ok: false });
    expect(second[0].reason).toMatch(/cannot trade this symbol/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  it('does not blocklist a symbol on an unrelated broker rejection', async () => {
    // A false positive here is worse than the bug: it would silently stop
    // trading a perfectly good name for the life of the process.
    setAutotradeConfig(cfgFields);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Buying power is insufficient.' });

    await runLiveExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    mockPlaceOrder.mockClear();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });

    const second = await runLiveExecution([{ signal: signal({ symbol: 'AAPL' }) }]);

    expect(second[0].ok).toBe(true); // still tried, and succeeded
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });
});

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

// The pure function computing intendedRewardR proves nothing about whether it
// reaches the journal, and the journal is the entire point of recording it —
// the Sept 5 review reads events, not return values. So assert it on the ROWS
// both journal sites write, per the standing consumer rule.
// The live book's refusals were the only ones NOT in the journal — every
// `blocked` row comes from the paper path or the manual preview route. So when
// live entries stopped, the reason had to be inferred from a dashboard gauge
// instead of read, and past explanations of "why live stopped trading" were
// read off PAPER rows.
// The loop kept handing a freed slot straight back to the name that had just
// failed to move: 4 of 26 live entries since 08-24 were same-day re-entries
// (ANF, ESTC, CRWD, DE). symbolCooldown cannot see it — it needs two LOSING
// closed trades and a stagnation scratch is not a loss.
// The reachability gate is LIVE-ONLY on purpose. It first shipped inside
// generateSignal, which sits ABOVE the paper/live split — loop.ts calls decide
// once and both books consume the same signals — so it silently filtered the
// PAPER control book too, leaving the experiment that depends on it with no
// counterfactual. Every other entry gate here is live-only for that reason.
// buyingPowerForSide returned undefined for ANY sell, so even after the
// sizer learned that an opening short consumes margin (PR #460), production
// handed it no figure and buyingPowerMaxQuantity read that as "no constraint".
// The guardrail still caught an unfundable short, but only after a full-size
// order had been built — the exact build-then-refuse loop the buying-power
// sizer exists to end.
describe('runLiveExecution — a SHORT entry is buying-power sized', () => {
  it('fetches buying power for a short once shorts are enabled', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, liveAllowNakedShort: true });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SHORT' });

    await runLiveExecution([{ signal: signal({ side: 'sell', stop: 105, target: 90 }) }]);

    // The broker WAS asked — previously it was skipped for every sell.
    expect(mockAccountState).toHaveBeenCalled();
  });

  it('still never calls the broker for a short while shorts are OFF', async () => {
    // The lazy-fetch optimization this guard originally protected: with
    // liveAllowNakedShort false the short-entry skip returns first, so a
    // disabled-shorts book pays for no round-trip.
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, liveAllowNakedShort: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NONE' });

    const outcomes = await runLiveExecution([{ signal: signal({ side: 'sell', stop: 105, target: 90 }) }]);

    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(outcomes[0].reason).toMatch(/liveAllowNakedShort is off/);
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  // The half the fix above missed. buyingPowerForSide (the READ) was corrected
  // to hand a short a figure; the batch loop's WRITE-BACK still decremented
  // only for `side === 'buy'`, on the premise that "sells free buying power".
  // That is true of a CLOSING sell and false of every signal reaching this
  // function — runLiveExecution is the ENTRY batch, where 'sell' means OPEN A
  // SHORT, which consumes margin exactly as a buy consumes cash. So a batch
  // that opened a short handed the NEXT candidate money the short had already
  // spent: the double-spend the decrement exists to prevent.
  const wideOpen = () => ({
    ...liveConfig(),
    levelExitsEnabled: false,
    liveAllowNakedShort: true,
    liveProbationTrades: 0,
    maxConcurrentPositions: 5,
    maxAggregateOpenRiskPct: 100,
    maxCorrelatedExposurePct: 1000,
    maxSectorExposurePct: 1000,
    maxTradesPerDay: 20,
    correlationThreshold: 1.1, // nothing counts as correlated
  });

  /** Short AAPL then long MSFT, against `bp` dollars of buying power. Every
   *  risk-check cap is opened wide so the buying-power decrement is the only
   *  thing that can affect the SECOND order. */
  async function shortThenLong(bp: number) {
    setAutotradeConfig(wideOpen());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, buyingPowerUsd: bp, exposureUsd: 0 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-BATCH' });

    await runLiveExecution([
      { signal: signal({ symbol: 'AAPL', side: 'sell', stop: 105, target: 90 }) },
      { signal: signal({ symbol: 'MSFT', side: 'buy' }) },
    ]);
    const orders = mockPlaceOrder.mock.calls.map((c) => c[1] as { symbol: string; quantity: number });
    return { short: orders.find((i) => i.symbol === 'AAPL'), long: orders.find((i) => i.symbol === 'MSFT') };
  }

  it('a filled SHORT spends buying power for the rest of the batch', async () => {
    // $100k equity at 1% risk over a $5 stop sizes 200 shares = $20,000 per
    // entry. $25,000 funds the short and leaves $5,000 — a quarter of what the
    // long wants, which the min-funded-size floor then declines rather than
    // take a token position. Before the fix the short decremented NOTHING, so
    // the long was sized against the untouched $25,000 and went out at full
    // size on money that was already committed.
    const { short, long } = await shortThenLong(25_000);

    expect(short?.quantity).toBe(200);
    expect(long, "the long must not go out on the short's money").toBeUndefined();
  });

  it('but does not block a long the account can genuinely afford — the control', async () => {
    // Same batch, $45,000: enough for both at full size. Without this pair the
    // test above would also pass if the decrement over-subtracted, or if
    // shorts had simply been broken in some other way.
    const { short, long } = await shortThenLong(45_000);

    expect(short?.quantity).toBe(200);
    expect(long?.quantity).toBe(200);
  });
});

describe('runLiveExecution — 1R must be reachable on the name', () => {
  // The fixture signal is entry 100 / stop 95, so 1R costs 5 in price terms.
  // Against a 0.7 bar the name needs ATR >= 7.14 to qualify.
  const lowAtr = () => ({ ...signal(), atr: 1 }); // 1R = 5x the daily range
  const goodAtr = () => ({ ...signal(), atr: 10 }); // 1R = 0.5x — comfortable

  it('refuses a name whose 1R costs more than its daily range', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, maxRiskAtrFraction: 0.7 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LOWATR' });

    const outcomes = await runLiveExecution([{ signal: lowAtr() }]);

    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(outcomes[0].reason).toMatch(/daily range/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const ev = listAutotradeEvents({ actions: ['risk_atr_unreachable_skipped'] });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].detail!)).toMatchObject({ maxRiskAtrFraction: 0.7 });
  });

  it('takes a name that can travel 1R', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, maxRiskAtrFraction: 0.7 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OKATR' });

    const outcomes = await runLiveExecution([{ signal: goodAtr() }]);
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(mockPlaceOrder).toHaveBeenCalled();
  });

  it('is off at 0, and imposes nothing when the signal carries no ATR', async () => {
    for (const sig of [
      { ...signal(), atr: 1 },
      { ...signal(), atr: null },
    ]) {
      db.exec('DELETE FROM order_intents; DELETE FROM autotrade_live_orders; DELETE FROM autotrade_events;');
      const frac = sig.atr === null ? 0.7 : 0; // no-ATR case keeps the gate ON
      setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, maxRiskAtrFraction: frac });
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OFF' });
      const outcomes = await runLiveExecution([{ signal: sig }]);
      expect(outcomes[0]).toMatchObject({ ok: true }); // never guesses a cap
    }
  });
});

describe('runLiveExecution — the market-direction gate (2026-09-23)', () => {
  // A reading built the way the loop builds one: SPY's move and the universe's
  // breadth, against the default bars (0.2% and 65%).
  const tape = (indexChangePct: number, red: number, green: number) =>
    readMarketDirection({
      indexSymbol: 'SPY',
      indexChangePct,
      breadth: { red, green, flat: 500 - red - green, sample: 500 },
      indexPct: 0.2,
      breadthPct: 65,
    });
  const RED = tape(-0.35, 365, 135); // 2026-09-23: 73% of 500 names red
  const GREEN = tape(0.9, 125, 375);
  const MIXED = tape(0.5, 360, 140); // 2026-08-27: SPY up, most names red

  function arm(overrides: Partial<AutotradeConfig> = {}) {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, marketDirectionGateEnabled: true, ...overrides });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MDG' });
  }
  const run = (sig: TradeSignal, reading: MarketDirectionReading | null) =>
    runLiveExecution([{ signal: sig }], null, undefined, null, undefined, reading);
  const skipRows = () => listAutotradeEvents({ actions: ['live_market_direction_skipped'] });

  it('refuses a long on a broad red day, with a row a replay can score', async () => {
    arm();
    const outcomes = await run(signal(), RED);

    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(outcomes[0].reason).toMatch(/^Market direction: Broad red market/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(skipRows()).toHaveLength(1);
    expect(JSON.parse(skipRows()[0].detail!)).toMatchObject({
      direction: 'red',
      rawDirection: 'red',
      heldBy: null,
      indexSymbol: 'SPY',
      indexChangePct: -0.35,
      redPct: 73,
      breadthSample: 500,
      indexPct: 0.2,
      breadthPct: 65,
      // The replay fields every declined entry carries (declinedEntry.ts).
      side: 'long',
      entry: 100,
      stop: 95,
      score: 70,
    });
  });

  it('takes the same long on a mixed day, on a green day, and with no reading', async () => {
    for (const reading of [MIXED, GREEN, null]) {
      db.exec('DELETE FROM order_intents; DELETE FROM autotrade_live_orders; DELETE FROM autotrade_events;');
      mockPlaceOrder.mockClear();
      arm();
      const outcomes = await run(signal(), reading);
      expect(outcomes[0], String(reading?.direction)).toMatchObject({ ok: true });
      expect(mockPlaceOrder).toHaveBeenCalled();
      expect(skipRows()).toHaveLength(0);
    }
  });

  // A held reading (2026-09-24) refuses exactly like a red one, and the row
  // says it was held, so the refusals a hold made can be counted apart.
  it('refuses a long on a reading HELD red, and the row says which hold', async () => {
    arm();
    const bandInput = {
      indexSymbol: 'SPY',
      breadth: { red: 365, green: 135, flat: 0, sample: 500 },
      indexPct: 0.2,
      breadthPct: 65,
      exitIndexPct: 0.1,
      exitBreadthPct: 60,
    };
    const entered = holdMarketDirection({ ...bandInput, indexChangePct: -0.35 }, null, 1, '2026-09-24');
    const held = holdMarketDirection(
      { ...bandInput, indexChangePct: -0.15, breadth: { red: 310, green: 190, flat: 0, sample: 500 } },
      entered.held,
      2,
      '2026-09-24',
    ).reading;
    expect(held.heldBy).toBe('hysteresis');

    const outcomes = await run(signal(), held);
    expect(outcomes[0].reason).toMatch(/^Market direction: Broad red market, held/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(JSON.parse(skipRows()[0].detail!)).toMatchObject({
      direction: 'red',
      rawDirection: 'mixed',
      heldBy: 'hysteresis',
      indexChangePct: -0.15,
      redPct: 62,
    });
  });

  it('refuses nothing while the gate is off, even on a red day — the reading alone moves no money', async () => {
    arm({ marketDirectionGateEnabled: false });
    const outcomes = await run(signal(), RED);
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(skipRows()).toHaveLength(0);
  });

  it('refuses a short on a broad green day, and leaves a short on a red day to the other gates', async () => {
    const short = signal({ side: 'sell', stop: 105, target: 90 });
    arm({ liveAllowNakedShort: true });
    const green = await run(short, GREEN);
    expect(green[0].reason).toMatch(/^Market direction: Broad green market/);
    expect(JSON.parse(skipRows()[0].detail!)).toMatchObject({ direction: 'green', side: 'short' });

    db.exec('DELETE FROM order_intents; DELETE FROM autotrade_live_orders; DELETE FROM autotrade_events;');
    arm({ liveAllowNakedShort: true });
    await run(short, RED);
    expect(skipRows()).toHaveLength(0);
  });
});

describe('runLiveExecution — same-session re-entry cooldown', () => {
  /** A closed autotrade position in `symbol`, exited `minutesAgo`. */
  function closedAgo(symbol: string, minutesAgo: number) {
    const now = Date.now();
    const exitAt = now - minutesAgo * 60_000;
    const info = db
      .prepare(
        `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, created_at, updated_at)
         VALUES ('stock',?,'long',10,100,'2026-09-01',0,1,'closed',?,?,?)`,
      )
      .run(symbol, JSON.stringify(['live', 'autotrade']), exitAt, exitAt);
    db.prepare(
      `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, exit_reason, created_at)
       VALUES (?,10,100.5,'2026-09-01',0,'time_exit',?)`,
    ).run(info.lastInsertRowid, exitAt);
  }

  it('refuses the reflexive re-entry and says why', async () => {
    closedAgo('AAPL', 39); // the real DE gap: exited, re-entered 39m later
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, symbolReentryCooldownMinutes: 90 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-REENTRY' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(outcomes[0].reason).toMatch(/Re-entry cooldown/);
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // never reached the broker
    const ev = listAutotradeEvents({ actions: ['symbol_reentry_cooldown_skipped'] });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].detail!)).toMatchObject({ symbol: 'AAPL', cooldownMinutes: 90 });
  });

  it('lets a genuine later setup through once the window passes', async () => {
    closedAgo('AAPL', 120);
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, symbolReentryCooldownMinutes: 90 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LATER' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(mockPlaceOrder).toHaveBeenCalled();
  });

  it('is off at 0 — the pre-2026-09-01 behaviour, unchanged', async () => {
    closedAgo('AAPL', 1);
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, symbolReentryCooldownMinutes: 0 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OFF' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);
    expect(outcomes[0]).toMatchObject({ ok: true });
  });

  it("does not gate on a HUMAN's trade in the same name", async () => {
    // A manual position is not the loop's thesis. Same symbol, same timing,
    // but tagged plain 'webull' — the loop must be free to take its own setup.
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, created_at, updated_at)
         VALUES ('stock','AAPL','long',10,100,'2026-09-01',0,1,'closed',?,?,?)`,
      )
      .run(JSON.stringify(['webull']), now - 60_000, now - 60_000);
    db.prepare(
      `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, exit_reason, created_at)
       VALUES (?,10,100.5,'2026-09-01',0,'manual',?)`,
    ).run(info.lastInsertRowid, now - 60_000);
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, symbolReentryCooldownMinutes: 90 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-HUMAN' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);
    expect(outcomes[0]).toMatchObject({ ok: true });
  });
});

describe('runLiveExecution — a live refusal is journaled with its reason', () => {
  /** An open, autotrade-tagged live position in some OTHER symbol, so it eats
   *  a concurrency slot without tripping runLiveExecution's own skipSymbols
   *  guard for the candidate under test. */
  function openLivePosition(symbol: string) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, source_intent_id, created_at, updated_at)
       VALUES ('stock',?,'long',10,100,'2026-09-01',0,1,'open',?,NULL,?,?)`,
    ).run(symbol, JSON.stringify(['live', 'autotrade']), now, now);
  }

  it('records WHICH rule refused the trade, not just that one did', async () => {
    // A cap of 1 with one position already open — the real shape of the
    // 2026-09-01 session. (A cap of 0 does NOT work as a fixture:
    // posIntMin1() clamps it back to the default, deliberately, since 0 would
    // silently block every entry forever.)
    openLivePosition('MSFT');
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, maxConcurrentPositions: 1 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NEVER' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();

    const blocked = listAutotradeEvents({ actions: ['live_risk_blocked'] });
    expect(blocked).toHaveLength(1);
    const detail = JSON.parse(blocked[0].detail!);
    // The whole point: the rule is named, readable without parsing `checks`.
    expect(detail.failedRules).toContain('max_concurrent_positions');
    expect(detail.checks.find((c: { rule: string }) => c.rule === 'max_concurrent_positions').passed).toBe(false);
  });

  it('does NOT collide with the paper book\u2019s own blocked rows', async () => {
    // A separate action, deliberately: folding live refusals in with paper's
    // would preserve exactly the ambiguity this exists to remove.
    openLivePosition('MSFT');
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, maxConcurrentPositions: 1 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    await runLiveExecution([{ signal: signal() }]);

    expect(listAutotradeEvents({ actions: ['blocked'] })).toHaveLength(0);
    expect(listAutotradeEvents({ actions: ['live_risk_blocked'] })).toHaveLength(1);
  });

  // 2026-09-23. The live halt tripped at 10:23; CRWD's target filled at 11:47
  // (+$382) and put the day back above the line; the loop bought VKTX at 11:49.
  // The halt's own notification says entries are blocked for the rest of the
  // day. Here the day's realized P&L is 0, far above any line, and the only
  // thing standing in the way is that the halt already tripped today.
  it('holds the day’s halt once it has tripped, even with the day back above the line', async () => {
    writeDailyHaltMarker({ pool: 'live', date: etToday(), dailyPnl: -2046.47, haltLevel: -1941.67 });
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NEVER' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const detail = JSON.parse(listAutotradeEvents({ actions: ['live_risk_blocked'] })[0].detail!);
    expect(detail.failedRules).toEqual(['daily_drawdown_halt']);
    expect(detail.checks.find((c: { rule: string }) => c.rule === 'daily_drawdown_halt').detail).toMatch(
      /halted for the rest of today/,
    );
  });

  it('a paper halt does not hold the live book', async () => {
    writeDailyHaltMarker({ pool: 'paper', date: etToday(), dailyPnl: -900, haltLevel: -800 });
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ ok: true });
  });

  it('stays quiet when the trade is APPROVED — the order event already says so', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(listAutotradeEvents({ actions: ['live_risk_blocked'] })).toHaveLength(0);
    expect(listAutotradeEvents({ actions: ['live_order_placed'] })).toHaveLength(1);
  });
});

// The daily order cap is per SLEEVE (2026-09-18): the options sleeve's entries
// used to count against liveMaxOrdersPerDay and, worse, the equity sleeve's
// against liveOptionsMaxOrdersPerDay (liveOptionsExecute.test.ts has that
// half). Pinned at the consumer — the guardrail verdict — not at the count.
describe('runLiveExecution — options orders do not spend the equity sleeve’s daily order cap (2026-09-18)', () => {
  /** An opening intent of the given kind that reached the broker today. */
  const placedToday = (assetKind: 'stock' | 'option', key: string) => {
    const i = createIntent(
      {
        symbol: 'NVDA',
        assetKind,
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 100,
        ...(assetKind === 'option' ? { optionType: 'call' as const, strike: 100, expiration: '2030-01-18' } : {}),
      },
      key,
    );
    for (const s of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
      transitionIntent(i.id, s);
    }
  };

  it('counts the equity sleeve’s own opening orders against liveMaxOrdersPerDay, not the options sleeve’s', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, liveMaxOrdersPerDay: 1 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });
    placedToday('option', 'opt0'); // an options entry earlier today: not this sleeve's

    expect((await runLiveExecution([{ signal: signal() }]))[0]).toMatchObject({ ok: true });
    expect(listAutotradeEvents({ actions: ['live_entry_blocked'] })).toHaveLength(0);

    // Its own placement is now the day's one stock order, and the cap is real.
    // Since 2026-09-24 it refuses before the order is built, not at placement.
    mockPlaceOrder.mockClear();
    const [second] = await runLiveExecution([{ signal: signal({ symbol: 'MSFT' }) }]);
    expect(second).toMatchObject({ ok: false, reason: 'Daily order cap: 1 placed vs 1/day' });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listAutotradeEvents({ actions: ['live_entry_blocked'] })).toHaveLength(0);
    const skipped = listAutotradeEvents({ actions: ['live_order_cap_skipped'] });
    expect(skipped.map((e) => e.symbol)).toEqual(['MSFT']);
  });

  // 2026-09-24. At the cap the guardrail refused every candidate, but only at
  // placement, after the order intent was written and the account re-read: the
  // options sleeve built 50 such intents in 32 minutes on 2026-09-23.
  it('at the cap, refuses before an intent is written or the account read, once a day per name', async () => {
    setAutotradeConfig({ ...liveConfig(), levelExitsEnabled: false, liveMaxOrdersPerDay: 2 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NEVER' });
    placedToday('stock', 'stk-a');
    placedToday('stock', 'stk-b');
    const intentsBefore = listIntents().length;
    mockAccountState.mockClear();

    const [out] = await runLiveExecution([{ signal: signal() }]);
    await runLiveExecution([{ signal: signal() }]); // the next tick, still at the cap

    expect(out).toMatchObject({ ok: false, reason: 'Daily order cap: 2 placed vs 2/day' });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listIntents()).toHaveLength(intentsBefore);
    // Only the batch's one buying-power read; no per-candidate account read.
    expect(mockAccountState.mock.calls.length).toBeLessThanOrEqual(2);
    const rows = listAutotradeEvents({ actions: ['live_order_cap_skipped'] });
    expect(rows).toHaveLength(1);
    // Replayable like every declined entry, and says which budget refused it.
    expect(JSON.parse(rows[0].detail!)).toMatchObject({
      ordersToday: 2,
      maxOrdersPerDay: 2,
      side: 'long',
      entry: expect.any(Number),
      stop: expect.any(Number),
      liveEligible: true,
    });
    expect(listAutotradeEvents({ actions: ['live_entry_blocked'] })).toHaveLength(0);
  });
});

describe('runLiveExecution — the level plan journals what the signal ASKED for', () => {
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

  it('journals the reach cap and breakout verdict, not just the level ones', async () => {
    // Consumer assertion for the 2026-09-01 reach cap: the Sept review reads
    // rows, so a field the plan computes and the journal drops is invisible.
    setAutotradeConfig({
      ...liveCfgFields,
      levelExitsEnabled: true,
      levelMinRewardR: 0, // isolate the journaling from the veto
      levelTargetReachAtrMultiple: 1,
    });
    // A quiet name: 40 bars in a tight 98-99 band, so ATR ~1 against a 100
    // entry. The 110 target asks for ten times a normal day's travel.
    // (providerWithWall returns only 13 bars, and atr() needs 14 periods —
    // with a null ATR the cap correctly does nothing, which is its own test
    // above but useless here.)
    const quiet = Array.from({ length: 40 }, () => ({ high: 99, low: 98, close: 98.5, volume: 1_000 }));
    mockGetProvider.mockReturnValue({
      getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 100, timestamp: Date.now() })),
      getCandles: vi.fn(async () => quiet),
    } as unknown as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-REACH' });

    await runLiveExecution([{ signal: signal() }]);

    const applied = listAutotradeEvents({ actions: ['level_exits_applied'] });
    expect(applied).toHaveLength(1);
    const detail = JSON.parse(applied[0].detail!);
    expect(detail.reachCapped).toBe(true);
    expect(detail.breakoutAllowed).toBe(false);
    // And the order that reached the broker carries the reachable target.
    const placed = mockPlaceOrder.mock.calls[0][1] as { bracket?: { takeProfitPrice: number } };
    expect(placed.bracket!.takeProfitPrice).toBeLessThan(110);
  });

  it('records it on a VETO — the population that says whether the floor is right', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: true, levelMinRewardR: 1 });
    mockGetProvider.mockReturnValue(providerWithWall({ AAPL: 100 }, 103));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-VETO2' });

    await runLiveExecution([{ signal: signal() }]);

    const detail = JSON.parse(listAutotradeEvents({ actions: ['level_veto'] })[0].detail!);
    expect(detail.intendedRewardR).toBe(2); // the fixture signal asks 2R (100/95/110)
    expect(detail.rewardR).toBeLessThan(detail.intendedRewardR);
  });

  it('records it on an APPLIED plan, so the cost of the adjustment is recoverable', async () => {
    setAutotradeConfig({ ...liveCfgFields, levelExitsEnabled: true, levelMinRewardR: 1 });
    mockGetProvider.mockReturnValue(providerWithWall({ AAPL: 100 }, 108));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-CAP2' });

    await runLiveExecution([{ signal: signal() }]);

    const detail = JSON.parse(listAutotradeEvents({ actions: ['level_exits_applied'] })[0].detail!);
    expect(detail.intendedRewardR).toBe(2);
    expect(detail.rewardR).toBeLessThan(2);
    // Both numbers on the same row is the requirement: either alone cannot
    // distinguish "a 2R signal cut to 1.5R" from "a 1.5R signal taken whole".
    expect(detail).toEqual(expect.objectContaining({ rewardR: expect.any(Number), intendedRewardR: 2 }));
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

    expect(outcomes[0]).toMatchObject({
      symbol: 'AAPL',
      ok: false,
      reason: 'Already has an open live position (manual)',
    });
    expect(outcomes[1]).toMatchObject({ symbol: 'MSFT', ok: true }); // not over-broadened to block everything
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // only MSFT ever reached the broker

    // …and it is JOURNALED (2026-09-12). This was the last silent refusal on
    // the entry path, so a paper entry the live book passed on for this reason
    // reached the attribution as `no_live_row` — pooled with a genuine
    // recording gap. `holder: 'manual'` is the part worth surfacing: a name the
    // operator holds by hand mutes every live signal on it, which is invisible
    // without this row.
    const rows = listAutotradeEvents({ actions: ['live_symbol_held_skipped'], limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('AAPL');
    expect(JSON.parse(rows[0].detail as string)).toMatchObject({ holder: 'manual' });
  });

  it('names an autotrade hold differently from a manual one — they are not the same finding', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, created_at, updated_at)
       VALUES ('stock','AAPL','long',10,100,'2026-07-01',0,1,'open',?,?,?)`,
    ).run(JSON.stringify(['autotrade', 'live']), now, now);

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
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    await runLiveExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    const rows = listAutotradeEvents({ actions: ['live_symbol_held_skipped'], limit: 20 });
    expect(JSON.parse(rows[0].detail as string)).toMatchObject({ holder: 'autotrade' });
  });

  it('journals the held-symbol skip once per day, not once per tick', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, created_at, updated_at)
       VALUES ('stock','AAPL','long',10,100,'2026-07-01',0,1,'open',?,?,?)`,
    ).run(JSON.stringify(['autotrade', 'live']), now, now);

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
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    // A held name is a steady-state condition: the loop refuses it on every
    // tick for the whole hold. One row a day, or the journal drowns.
    for (let i = 0; i < 4; i++) await runLiveExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    expect(listAutotradeEvents({ actions: ['live_symbol_held_skipped'], limit: 20 })).toHaveLength(1);
  });
});

describe('adoptOrphanedLivePositions', () => {
  const okCtx = {
    equity: 100_000,
    dayStartEquityUsd: 100_000,
    dailyHaltTripped: false,
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
    mlRegime: null,
    mlRegimeEnabled: false,
    mlRegimeSizeCutPct: 35,
    todayRangePct: null,
    regimeShockRangeRatio: 0,
    priorSameDayExits: 0,
    repeatEntrySizeCutPct: 0,
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
       VALUES ('stock',?,?,10,100,'2026-07-01',0,1,'open',?,?,?,?,?,?)`,
    ).run(
      symbol,
      overrides.side ?? 'long',
      JSON.stringify(tags),
      overrides.stopPrice ?? null,
      overrides.targetPrice ?? null,
      overrides.sourceIntentId ?? null,
      now,
      now,
    );
  }

  // 2026-09-04: bracket protection required source_intent_id, which an ADOPTED
  // position never has. From 2026-09-01 the live book was almost entirely
  // adopted (09-01 0/6 intent-linked, 09-02 1/11, 09-03 0/4, 09-04 1/9), so the
  // filter produced ZERO candidates and returned before ever querying the
  // broker. The naked-position alarm went quiet for ten days and read exactly
  // like "nothing is wrong". Adoption does establish the reverse link
  // (setLiveOrderPositionId), so the lookup must accept EITHER.
  // THE SAME SIDE (2026-09-23, shorts pre-flight): a buy fills a long and a
  // short sale fills a short, so an order is never the fill of a holding the
  // other way round — most likely the operator's own position in the name.
  it('does not adopt a SHORT holding for a pending LONG entry on the same symbol', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['webull'], { side: 'short' });

    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 0 });
    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].tags).not.toContain('autotrade');
  });

  it('adopts the same-side holding beside an opposite one', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['webull'], { side: 'short' });
    insertOrphan('AAPL', ['webull']);

    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 1 });
    const adopted = listPositions({ status: 'open', symbol: 'AAPL' }).filter((p) => p.tags.includes('autotrade'));
    expect(adopted.map((p) => p.side)).toEqual(['long']);
  });

  it('considers an ADOPTED position, which has no sourceIntentId but is linked via its entry order', async () => {
    await pendingEntryFor('AAPL');
    insertOrphan('AAPL', ['webull']);
    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 1 });

    const pos = listPositions({ status: 'open', symbol: 'AAPL' })[0];
    // The precondition that broke it: no source_intent_id on the adopted row.
    expect(pos.sourceIntentId).toBeNull();
    // ...but the entry order does point back at the position.
    expect(getLiveEntryOrderForPosition(pos.id)?.intentId).toBeGreaterThan(0);

    // Age past the protection grace window, which is measured from created_at.
    db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, pos.id);

    setAutotradeConfig({ liveAccountId: 'ACC1' });
    // The broker reports a resting SELL leg for AAPL, so the position reads as
    // protected. Which verdict it reaches is not the point — REACHING one is.
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [
        {
          clientOrderId: 'sl-1',
          comboOrderId: 'GRP-1',
          symbol: 'AAPL',
          side: 'sell',
          status: 'OPEN',
          orderType: 'STOP_LOSS',
          stopPrice: 95,
          quantity: 10,
        },
      ],
    });
    const outcomes = await checkLiveBracketProtection();
    // Reaching an outcome AT ALL is the assertion: before the fix the filter
    // yielded no candidates and the function returned [] without asking the
    // broker anything.
    expect(outcomes.map((o) => o.symbol)).toContain('AAPL');
  });

  // -------------------------------------------------------------------------
  // "Is THIS position's stop still there", not "is anything resting".
  //
  // This check used to accept ANY resting exit-side order as protection, and
  // the reason was written down: combo_type per leg was UNCONFIRMED (see
  // scripts/captureBrokerFields.ts Q3). Settled 2026-09-05 against 12 real
  // orders, so the precise question is answerable — and it matters, because a
  // bracket has TWO exit legs and only one of them is protection.
  // -------------------------------------------------------------------------
  async function agedProtectionCandidate(symbol = 'AAPL', heldAtBroker = 10) {
    await pendingEntryFor(symbol);
    insertOrphan(symbol, ['webull']);
    adoptOrphanedLivePositions();
    const pos = listPositions({ status: 'open', symbol })[0];
    db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, pos.id);
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    // From 2026-09-08 the alarm asks whether the shares are still HELD before
    // it pages, so every protection test has to say what the broker holds.
    // Defaulting to 10 keeps the existing cases meaning what they always meant:
    // a position that is really there, really missing its stop.
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      state: { ...okAccountState.state, currentPositionQty: heldAtBroker },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    return pos;
  }
  const restingLeg = (over: Record<string, unknown>) => ({
    clientOrderId: 'leg-1',
    comboOrderId: 'GRP-1',
    symbol: 'AAPL',
    side: 'sell' as const,
    status: 'OPEN',
    quantity: 10,
    ...over,
  });
  const unprotectedEvents = () =>
    listAutotradeEvents({ limit: 50 }).filter((e) => e.action === 'live_position_unprotected');

  it('reports a lone resting TARGET as UNPROTECTED — a take-profit is not a stop', async () => {
    // Reachable: cancelReplaceBracket cancels legs one at a time and returns
    // early if the second fails, journaling "the bracket may now be PARTLY
    // cancelled". That leaves exactly this state, and it used to read as
    // protected on every subsequent tick, so the standing alert never fired.
    await agedProtectionCandidate();
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [restingLeg({ comboType: 'STOP_PROFIT', orderType: 'LIMIT', limitPrice: 110 })],
    });

    const outcomes = await checkLiveBracketProtection();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', protectedAtBroker: false });
    expect(outcomes[0].unknown).toBeUndefined(); // positively identified, not a parse miss
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.restingExitLegs).toBe(1);
    expect(String(detail.reason)).toMatch(/TAKE-PROFIT leg is still resting.*but its STOP is not/s);
  });

  // -------------------------------------------------------------------------
  // NO RESTING STOP IS NOT THE SAME AS NAKED (2026-09-08).
  //
  // A bracket whose stop has just FILLED shows zero resting exit legs — exactly
  // what a bracket that was never accepted shows. On 09-08 this alarm paged on
  // SMCI at 13:52:45 telling the operator to re-arm protection by hand, and that
  // position's stop was booked 75 seconds later at 40.77. Nothing had ever been
  // unprotected.
  //
  // This is the pager. A false page on every stop fill trains the operator to
  // ignore the one case it exists for.
  // -------------------------------------------------------------------------
  it('does NOT page when the broker holds nothing — the stop filled, it is not naked', async () => {
    await agedProtectionCandidate('AAPL', 0);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', protectedAtBroker: false, heldAtBroker: 0 });
    expect(String(outcomes[0].unknown)).toMatch(/the position is closed, not unprotected/);
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('DOES page when the shares are still held and no stop rests', async () => {
    // The case the alarm exists for, and it must survive the fix above.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ protectedAtBroker: false, heldAtBroker: 10 });
    expect(unprotectedEvents()).toHaveLength(1);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.heldAtBroker).toBe(10);
    expect(String(detail.reason)).toMatch(/broker confirms 10 share\(s\) still held, so this is real/);
  });

  // -------------------------------------------------------------------------
  // Regression cover for two exit failures seen live in August 2026, both
  // already fixed in code but neither pinned by a test of its own. At the
  // sizing this book is moving to, an exit that cannot be placed is the
  // expensive kind of bug, so each gets one.
  // -------------------------------------------------------------------------
  it("finds an ADOPTED position's entry intent through the order row (CTVA, 2026-08-24)", () => {
    // positions.source_intent_id is only set when a fill materializes through
    // the create path; a position adopted from the broker never gets one. When
    // this was read alone, an adopted CTVA position failed its stagnation close
    // 21 ticks running with "No source intent on this position — cannot locate
    // its bracket to cancel", and later the naked-position alarm went quiet for
    // ten days on a book that had become almost entirely adopted.
    const intent = createIntent(
      {
        symbol: 'CTVA',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 5,
        orderType: 'limit',
        limitPrice: 60,
      },
      'CID-ADOPT',
    );
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'CTVA',
      side: 'long',
      quantity: 5,
      entryPrice: 60,
      entryDate: '2026-08-24',
      tags: ['live', 'autotrade'],
    });
    recordLiveOrder({
      intentId: intent.id,
      symbol: 'CTVA',
      stopPrice: 57,
      targetPrice: 66,
      riskAmount: 15,
      riskProfile: 'MODERATE',
      entryScore: 80,
    });
    // The reverse link adoption establishes, and the only one it establishes.
    setLiveOrderPositionId(intent.id, pos.id);

    expect(pos.sourceIntentId).toBeNull();
    expect(entryIntentIdForPosition(pos)).toBe(intent.id);
  });

  // -------------------------------------------------------------------------
  // RE-ARM, don't just page (2026-09-12).
  //
  // This check has been able to PROVE a position naked since the held-quantity
  // read went in: shares confirmed at the broker, zero resting stop. Its
  // response was a journal row telling a human to re-arm by hand, and GRMN sat
  // that way on 2026-08-25. The machinery to fix it already existed for the
  // scale-out's own rollback.
  // -------------------------------------------------------------------------
  /** The legs as the BROKER receives them: the intent run through the real
   *  request builder, which is the consumer of the side a caller passes. This
   *  test used to assert the intent's own `side: 'sell'`, which read as right
   *  and was the bug — bracketExit flips it, so every re-arm of a long went
   *  out as a BUY stop and a BUY take-profit (2026-09-12 to 2026-09-23). */
  const wireLegs = (call: Parameters<typeof webullPlaceStandaloneBracket>) => {
    const [, intent, target, stop] = call;
    return buildStandaloneBracketRequest(intent, target, stop)!.new_orders.map((o) => ({
      comboType: o.combo_type,
      side: o.side,
      price: o.order_type === 'LIMIT' ? o.limit_price : o.stop_price,
      quantity: o.quantity,
    }));
  };

  it("points the entry row at the re-armed bracket's own legs (#147)", async () => {
    // The entry bracket's legs are cancelled by the time a re-arm places new
    // ones, so the legs a later fill is looked up by must be the new ones.
    const pos = await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({
      ok: true,
      clientComboOrderId: 'GRP-REARM',
      legClientOrderIds: { takeProfit: 'TP-REARM', stopLoss: 'SL-REARM' },
    });

    await checkLiveBracketProtection();

    expect(getLiveEntryOrderForPosition(pos.id)).toMatchObject({
      takeProfitClientOrderId: 'TP-REARM',
      stopLossClientOrderId: 'SL-REARM',
    });
  });

  it('RE-ARMS a confirmed-naked position instead of only paging — with SELL legs under a long', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-REARM' });

    await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    const call = vi.mocked(webullPlaceStandaloneBracket).mock.calls[0];
    // What reaches Webull: a sell take-profit above and a sell stop below, the
    // same shape the broker accepted eleven times from the scale-out's rollback.
    expect(wireLegs(call)).toEqual([
      { comboType: 'STOP_PROFIT', side: 'SELL', price: '110', quantity: '10' },
      { comboType: 'STOP_LOSS', side: 'SELL', price: '95', quantity: '10' },
    ]);
    // Re-armed, so nobody is paged.
    expect(unprotectedEvents()).toHaveLength(0);
    const rearmed = listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearmed'] });
    expect(rearmed).toHaveLength(1);
    expect(JSON.parse(rearmed[0].detail ?? '{}')).toMatchObject({ stopPrice: 95, quantity: 10 });
  });

  it('protects a SHORT with BUY legs — the one helper serves both sides', async () => {
    // Shorts are off in production, so this is the side no live order has
    // exercised; the helper must still be right for it rather than right by
    // accident for the only side anyone has watched.
    //
    // The broker reads a short as a NEGATIVE quantity (accountState.ts signs
    // it). This case used to hand the sweep +10 for a short, a shape the
    // reader never returns, and passed while every real short that lost its
    // stop would have been paged and never re-armed (2026-09-23).
    const pos = await agedProtectionCandidate('AAPL', -10);
    db.prepare("UPDATE positions SET side = 'short', stop_price = 105, target_price = 90 WHERE id = ?").run(pos.id);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-SHORT' });

    await checkLiveBracketProtection();

    expect(wireLegs(vi.mocked(webullPlaceStandaloneBracket).mock.calls[0])).toEqual([
      { comboType: 'STOP_PROFIT', side: 'BUY', price: '90', quantity: '10' },
      { comboType: 'STOP_LOSS', side: 'BUY', price: '105', quantity: '10' },
    ]);
  });

  it('acts on nothing when the broker holds the OTHER way round — that holding is not this position', async () => {
    // A short row, and the broker reports 10 shares LONG: the operator's own
    // trade in the name, most likely. It confirms nothing about the short.
    const pos = await agedProtectionCandidate('AAPL', 10);
    db.prepare("UPDATE positions SET side = 'short', stop_price = 105, target_price = 90 WHERE id = ?").run(pos.id);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    const out = await checkLiveBracketProtection();

    expect(vi.mocked(webullPlaceStandaloneBracket)).not.toHaveBeenCalled();
    expect(out[0].heldAtBroker).toBeNull();
    const detail = JSON.parse(unprotectedEvents()[0].detail!);
    expect(detail).toMatchObject({ state: 'unconfirmed', heldAtBroker: null, brokerPositionQty: 10 });
    expect(detail.reason).toMatch(/holds 10 share\(s\) of AAPL the other way round \(long\), not this short/);
  });

  // -------------------------------------------------------------------------
  // A STOP CANNOT BE PLACED WHERE THE MARKET HAS ALREADY BEEN (2026-09-15).
  //
  // On 2026-09-14 12:13 ET, BWIN was confirmed naked, the re-arm above was
  // refused by the broker — "The stop price of the stop-loss order should be
  // higher than the current market price" — and the whole response was to page
  // a human. The position stayed unprotected through an afternoon, past the
  // stop that was the decision. It closed near flat, which was luck.
  //
  // Three facts must hold before this sells anything: shares confirmed held,
  // the re-arm ATTEMPTED AND REFUSED, and a quote fetched now through the
  // recorded stop. Every case below moves exactly one of them.
  // -------------------------------------------------------------------------
  const closeOrders = () =>
    mockPlaceOrder.mock.calls.filter(([, intent]) => (intent as { openClose?: string }).openClose === 'close');
  /** The close goes through the shared guardrails, so a case that expects one
   *  to reach the broker has to arm the live book — which is itself the proof
   *  that the kill switch and the enable flag still gate this path. */
  const armedForClose = () => {
    setAutotradeConfig({ liveTradingEnabled: true, killSwitch: false });
    // The close cancels the entry's bracket legs first, and that path reads the
    // combo status to rule out a leg racing the fill. `found: false` is the
    // ordinary answer for an order that has aged out of the broker's window.
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as Awaited<ReturnType<typeof webullOrderStatus>>);
  };

  // The same three facts for a SHORT (2026-09-23): the broker reads it as -10,
  // "through the stop" is a quote AT OR ABOVE it, and the close BUYS. Before
  // the sign was read by side, no short could ever reach this branch.
  it('CLOSES a naked SHORT that the market has run through, with a BUY for the shares short', async () => {
    const pos = await agedProtectionCandidate('AAPL', -10);
    db.prepare("UPDATE positions SET side = 'short', stop_price = 105, target_price = 90 WHERE id = ?").run(pos.id);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'stop through the market' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 106 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-BREACH-SHORT' });
    armedForClose();

    const outcomes = await checkLiveBracketProtection();

    // A marketable BUY limit: 106 plus the 0.5% buffer.
    expect(closeOrders()).toHaveLength(1);
    expect(closeOrders()[0][1]).toMatchObject({
      symbol: 'AAPL',
      side: 'buy',
      openClose: 'close',
      quantity: 10,
      limitPrice: 106.53,
    });
    expect(outcomes[0]).toMatchObject({ heldAtBroker: 10, breachClose: { requested: true, lastPrice: 106 } });
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('CLOSES a naked position whose stop the market has already passed, instead of paging', async () => {
    await agedProtectionCandidate('AAPL', 10); // stop 95, target 110
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    // The broker refuses the SELL stop because price is through it. (This mock
    // used to carry "…should be higher than the current market price", copied
    // from BWIN's refusal. That wording is the broker's rule for a BUY stop:
    // BWIN was never through its stop, the re-arm was sending the wrong side.
    // The wording here is illustrative; fact (2) is the refusal, not the text.)
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({
      ok: false,
      error: 'stop through the market',
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-BREACH' });
    armedForClose();

    const outcomes = await checkLiveBracketProtection();

    // A MARKETABLE LIMIT to sell, not a market order: 94 less the 0.5% buffer.
    expect(closeOrders()).toHaveLength(1);
    expect(closeOrders()[0][1]).toMatchObject({
      symbol: 'AAPL',
      side: 'sell',
      openClose: 'close',
      orderType: 'limit',
      quantity: 10,
      limitPrice: 93.53,
    });
    // Asserted at the CONSUMER — the outcome the loop reads, not the helper.
    expect(outcomes[0]).toMatchObject({ breachClose: { requested: true, lastPrice: 94 } });
    // One row tells the whole sequence, and nobody is paged.
    const placed = listAutotradeEvents({ limit: 50 }).filter((e) => e.action === 'live_time_exit_placed');
    expect(placed).toHaveLength(1);
    expect(JSON.parse(placed[0].detail ?? '{}')).toMatchObject({
      trigger: 'unprotected_breach',
      recordedStop: 95,
      lastPrice: 94,
      heldAtBroker: 10,
      rearmOutcome: 'stop through the market',
    });
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('PAGES rather than closing when the stop is still placeable — the re-arm failed for another reason', async () => {
    // The gate that keeps this from becoming "close any naked position". Price
    // is comfortably above the stop, so the position needs its stop back, not
    // an exit, and a re-arm that failed for some other reason is a human's
    // problem exactly as it was before.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'Rate limited.' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 96 }) as ReturnType<typeof getProvider>);

    const outcomes = await checkLiveBracketProtection();

    expect(closeOrders()).toHaveLength(0);
    expect(outcomes[0].breachClose).toBeUndefined();
    expect(unprotectedEvents()).toHaveLength(1);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}');
    expect(detail).toMatchObject({ rearmOutcome: 'Rate limited.' });
    // No close was attempted, so the page must not claim one failed.
    expect(detail.breachCloseFailed).toBeUndefined();
  });

  it('never closes a position whose stop was successfully re-armed', async () => {
    // Fact (2) removed. Even with price through the stop, a stop the broker
    // ACCEPTED is protection, and selling on top of it would race its own fill.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-OK' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);

    await checkLiveBracketProtection();

    expect(closeOrders()).toHaveLength(0);
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('never stacks a SECOND close on a position that already has one working', async () => {
    // The guard that matters most, and the reason it reads the DB rather than
    // an in-memory latch: a restart must not be able to sell the same shares
    // twice. For a long, overselling means flipping short.
    const pos = await agedProtectionCandidate('AAPL', 10);
    const rec = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 93,
      },
      'working-close-1',
    );
    recordLiveExitOrder({ intentId: rec.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId: pos.id });
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'stop through the market' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);

    await checkLiveBracketProtection();

    expect(closeOrders()).toHaveLength(0);
    // Still naked on paper, so the page stands — but nothing was sold twice.
    expect(unprotectedEvents()).toHaveLength(1);
  });

  it('pages rather than guessing when the quote cannot be read', async () => {
    // Fact (3) unavailable. Without a price there is no second source agreeing
    // with the broker, and acting on the refusal alone is the string dependency
    // this design exists to avoid.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'stop through the market' });
    mockGetProvider.mockReturnValue(quoteReturning({}) as ReturnType<typeof getProvider>); // throws for AAPL

    await checkLiveBracketProtection();

    expect(closeOrders()).toHaveLength(0);
    expect(unprotectedEvents()).toHaveLength(1);
  });

  it('will not close over an UNANSWERED re-arm — that bracket may be resting', async () => {
    // The hole found re-reading the diff rather than by a failing test. An
    // ambiguous placement (timeout, 429, 5xx) may well have gone through, with
    // a combo id we never learned. A close on top of it is two sells against
    // one position, and for a long an oversell flips it short — which is the
    // very reason the re-arm above refuses to RETRY an ambiguous placement.
    // Only an explicit refusal is evidence that no stop is resting.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, ambiguous: true, error: 'timeout' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NOPE' });
    armedForClose();

    const outcomes = await checkLiveBracketProtection();

    expect(closeOrders()).toHaveLength(0);
    expect(outcomes[0].breachClose).toBeUndefined();
    // Still paged, carrying the unanswered state so a human knows to look.
    expect(unprotectedEvents()).toHaveLength(1);
    expect(JSON.parse(unprotectedEvents()[0].detail ?? '{}')).toMatchObject({ rearmOutcome: 'unanswered' });
  });

  it('the kill switch stops EVERY order here — re-arm, cancel and close — and detection keeps running', async () => {
    // The split this sweep's header states: it RUNS regardless of the kill
    // switch, because a halted account still needs to know a position is naked,
    // but it cannot ACT. This test used to prove only the CLOSE was stopped
    // (the close runs the guardrails) while the re-arm above it went straight
    // to the broker — and did, through both of the operator's halts on
    // 2026-09-21 and 09-22. The assertion that matters is the first one.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValue({ ok: false, error: 'stop through the market' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NOPE' });
    armedForClose();
    setAutotradeConfig({ killSwitch: true });

    const outcomes = await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(closeOrders()).toHaveLength(0);
    // Detected and reported, just not acted on — and the report says why.
    expect(outcomes[0]).toMatchObject({ protectedAtBroker: false, heldAtBroker: 10, heldByKillSwitch: true });
    expect(unprotectedEvents()).toHaveLength(1);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}');
    expect(detail).toMatchObject({ heldByKillSwitch: true, rearmAttempted: false });
    expect(detail.breachCloseFailed).toBeUndefined();
    expect(String(detail.reason)).toMatch(/kill switch is engaged, so nothing was placed, cancelled or closed/);
  });

  it("the TRADE page's kill switch holds it too — both switches, one derivation", async () => {
    // buildLiveTradingConfig ORs the two switches for the guardrails; the sweep
    // reads the same function, so a halt from either page is a halt here.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    setTradingConfig({ killSwitch: true });

    const outcomes = await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ heldByKillSwitch: true });
  });

  it('re-arms on the first sweep after the switch is released', async () => {
    // Held, not forgotten: releasing the halt with the position still naked is
    // exactly when the app should put protection back.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    setAutotradeConfig({ killSwitch: true });
    await checkLiveBracketProtection();
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();

    setAutotradeConfig({ killSwitch: false });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-AFTER' });
    await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    expect(listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearmed'] })).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // ONE PAGE PER STATE, NOT PER POSITION (2026-09-23, from the #637 review).
  //
  // The unprotected row IS the page (liveFailureAlert's AMBIGUITY_ACTIONS), and
  // it was deduplicated per position per ET day whatever it said. A kill switch
  // now writes one reading "this is expected", so the halt used up the day's
  // page: release the switch, have the re-arm refused, and nothing was written
  // or sent while the position sat naked until the next ET day.
  // -------------------------------------------------------------------------
  const unprotectedStates = () =>
    unprotectedEvents()
      .map((e) => JSON.parse(e.detail ?? '{}') as { state?: string })
      .map((d) => d.state)
      .sort();

  it('a kill-switch report does not use up the page for the naked state after release', async () => {
    await agedProtectionCandidate('AAPL', 10); // stop 95, target 110
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    // Not through the stop, so a refused re-arm pages rather than closes.
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    setAutotradeConfig({ killSwitch: true });
    await checkLiveBracketProtection();
    expect(unprotectedStates()).toEqual(['kill_switch']);

    setAutotradeConfig({ killSwitch: false });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValue({ ok: false, error: 'Broker refused the bracket' });
    await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    expect(unprotectedStates()).toEqual(['kill_switch', 'naked']);
    const naked = unprotectedEvents()
      .map((e) => JSON.parse(e.detail ?? '{}') as Record<string, unknown>)
      .find((d) => d.state === 'naked');
    expect(naked).toMatchObject({ heldByKillSwitch: false, rearmOutcome: 'Broker refused the bracket' });
    expect(String(naked?.reason)).toMatch(/automatic re-arm failed \(Broker refused the bracket\)/);

    // The same state again the same day is still one row: the dedup holds per state.
    await checkLiveBracketProtection();
    expect(unprotectedStates()).toEqual(['kill_switch', 'naked']);
  });

  it('reads a row written before the state field existed by the fields it does carry', async () => {
    // Rows journaled between #637's deploy and this one name no state. Read by
    // position alone they would still suppress every later state; read by
    // their heldByKillSwitch flag they suppress only their own.
    const pos = await agedProtectionCandidate('AAPL', 10);
    logAutotradeEvent({
      symbol: 'AAPL',
      stage: 'execution',
      action: 'live_position_unprotected',
      detail: { positionId: pos.id, heldAtBroker: 10, heldByKillSwitch: true, exitWorking: false },
    });
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    setAutotradeConfig({ killSwitch: true });
    await checkLiveBracketProtection();
    expect(unprotectedEvents()).toHaveLength(1); // the legacy row already covers the halt

    setAutotradeConfig({ killSwitch: false });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValue({ ok: false, error: 'Broker refused the bracket' });
    await checkLiveBracketProtection();
    expect(unprotectedEvents()).toHaveLength(2);
    expect(unprotectedStates()).toContain('naked');
  });

  it('a FAILED holdings read is unconfirmed, not closed: it pages and acts on nothing', async () => {
    // accountState returns ok with a quantity of 0 when the balance answered and
    // the positions call did not, flagging positionsUnavailable. Read at face
    // value that was "the position is closed, not unprotected", so a naked
    // position went unreported for as long as the positions call kept failing.
    await agedProtectionCandidate('AAPL', 0);
    mockAccountState.mockResolvedValue({
      ...okAccountState,
      positionsUnavailable: true,
      state: { ...okAccountState.state, currentPositionQty: 0 },
    } as Awaited<ReturnType<typeof webullAccountState>>);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);
    armedForClose();

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ protectedAtBroker: false, heldAtBroker: null });
    expect(outcomes[0].unknown).toBeUndefined();
    // Unknown holdings never place, cancel or close, even with the price through the stop.
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(closeOrders()).toHaveLength(0);
    expect(unprotectedStates()).toEqual(['unconfirmed']);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.heldAtBroker).toBeNull();
    expect(String(detail.reason)).toMatch(/account read FAILED, so it is NOT confirmed/);
  });

  it('still pages when the close itself is rejected — the position really is naked', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'stop through the market' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 94 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Broker said no' });
    armedForClose();

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ breachClose: { requested: false, lastPrice: 94 } });
    expect(unprotectedEvents()).toHaveLength(1);
    expect(JSON.parse(unprotectedEvents()[0].detail ?? '{}')).toMatchObject({
      breachCloseFailed: expect.stringContaining('Broker said no'),
      lastPrice: 94,
    });
  });

  // -------------------------------------------------------------------------
  // THE STOP IS GONE AND THE TAKE-PROFIT STILL RESTS (rewritten 2026-09-23).
  //
  // This used to re-arm the stop ALONE, to avoid stacking a second take-profit
  // on the working one. The broker can never accept that: it counts shares
  // held MINUS shares resting exits already commit (committedProtectiveQuantity,
  // measured on FCX 2026-09-08), and the take-profit commits all of them. SNDK's
  // attempt on 2026-09-22 was refused. Cancel-then-place is the only order the
  // broker permits, so the sweep cancels the take-profit, and the next sweep —
  // finding nothing resting — re-arms both legs as one OCO pair.
  // -------------------------------------------------------------------------
  const lonelyTarget = () =>
    restingLeg({ clientOrderId: 'TGT-1', comboType: 'STOP_PROFIT', orderType: 'LIMIT', limitPrice: 110 });

  it('cancels a lonely take-profit, then re-arms BOTH legs on the next sweep', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders)
      .mockResolvedValueOnce({ ok: true, orders: [lonelyTarget()] })
      .mockResolvedValueOnce({ ok: true, orders: [] }); // next sweep: the cancel landed
    vi.mocked(webullCancelOrder).mockResolvedValueOnce({ ok: true });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-BOTH' });

    const first = await checkLiveBracketProtection();

    // Sweep 1: the take-profit is cancelled and NOTHING is placed over it.
    expect(webullCancelOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webullCancelOrder).mock.calls[0][1]).toBe('TGT-1');
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(first[0]).toMatchObject({ targetCancelled: ['TGT-1'] });
    const cancelledRows = listAutotradeEvents({
      stage: 'execution',
      actions: ['live_bracket_rearm_target_cancelled'],
    });
    expect(cancelledRows).toHaveLength(1);
    expect(JSON.parse(cancelledRows[0].detail ?? '{}')).toMatchObject({ cancelled: ['TGT-1'], heldAtBroker: 10 });
    // The repair is under way, so nobody is paged for it.
    expect(unprotectedEvents()).toHaveLength(0);

    await checkLiveBracketProtection();

    // Sweep 2: both legs, as one pair, on the SELL side.
    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    expect(wireLegs(vi.mocked(webullPlaceStandaloneBracket).mock.calls[0])).toEqual([
      { comboType: 'STOP_PROFIT', side: 'SELL', price: '110', quantity: '10' },
      { comboType: 'STOP_LOSS', side: 'SELL', price: '95', quantity: '10' },
    ]);
    const rearmed = listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearmed'] });
    expect(JSON.parse(rearmed[0].detail ?? '{}')).toMatchObject({ legsPlaced: 'stop+target' });
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('never places a stop ALONE over a resting take-profit — the order the broker refused on SNDK', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [lonelyTarget()] });
    vi.mocked(webullCancelOrder).mockResolvedValue({ ok: true });

    await checkLiveBracketProtection();
    await checkLiveBracketProtection(); // the cancel has not landed yet: still no placement

    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
  });

  it('pages, placing nothing, when the take-profit cannot be cancelled', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [lonelyTarget()] });
    vi.mocked(webullCancelOrder).mockResolvedValueOnce({ ok: false, error: 'order already filled' });

    const outcomes = await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(outcomes[0].breachClose).toBeUndefined();
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}');
    expect(String(detail.reason)).toMatch(/Cancelling the resting take-profit to make room for a stop failed/);
    expect(String(detail.reason)).toMatch(/order already filled/);
    // A failed CANCEL is not the broker refusing a stop at the recorded price,
    // so it must not stand in for fact (2) of the breach close.
    expect(detail.rearmAttempted).toBe(false);
  });

  it('cancels nothing it cannot classify', async () => {
    // A take-profit beside a leg this sweep cannot read. Cancelling it would be
    // a guess about somebody's order; the page says so instead.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [lonelyTarget(), restingLeg({ clientOrderId: 'ODD', comboType: 'NORMAL', orderType: 'MARKET' })],
    });

    await checkLiveBracketProtection();

    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(String(JSON.parse(unprotectedEvents()[0].detail ?? '{}').reason)).toMatch(/could not be classified/);
  });

  // -------------------------------------------------------------------------
  // A LIMIT IS NOT A TAKE-PROFIT UNTIL THE BROKER SAYS SO (2026-09-23, from the
  // #637 review). classifyExitLeg falls back to the order type, so any LIMIT
  // on the exit side reads as 'target'. The operator's own hand exit is exactly
  // that: engage the switch, cancel the bracket, rest a sell limit in Webull,
  // release the switch before it fills. The next sweep cancelled it within a
  // minute and re-armed the app's bracket over it, and paged nobody.
  // -------------------------------------------------------------------------
  const handExit = (comboType: string | undefined) =>
    restingLeg({ clientOrderId: 'HAND-1', comboType, orderType: 'LIMIT', limitPrice: 104 });

  it.each([
    ['NORMAL', 'NORMAL'],
    ['no label at all', undefined],
  ])("never cancels a LIMIT the broker does not label as a bracket's take-profit (%s)", async (_label, comboType) => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [handExit(comboType)] });

    const outcomes = await checkLiveBracketProtection();
    await checkLiveBracketProtection();

    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(outcomes[0].targetCancelled).toBeUndefined();
    expect(listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearm_target_cancelled'] })).toHaveLength(
      0,
    );
    // Paged, and the page says why nothing was done.
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}');
    expect(String(detail.reason)).toMatch(/not labelled as a bracket's take-profit/);
    expect(String(detail.reason)).toMatch(/may be orders placed by hand/);
    expect(detail.rearmAttempted).toBe(false);
  });

  it("cancels nothing when the app's own take-profit rests beside a LIMIT that is not labelled", async () => {
    // Cancelling only the app's leg buys nothing: the hand order still commits
    // the shares, so the broker would refuse the pair anyway, and the position
    // would lose the one exit the app had on it.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValue({ ok: true, orders: [lonelyTarget(), handExit('NORMAL')] });

    await checkLiveBracketProtection();

    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(String(JSON.parse(unprotectedEvents()[0].detail ?? '{}').reason)).toMatch(
      /1 resting limit order\(s\) on the sell side of AAPL are not labelled/,
    );
  });

  it("never cancels or stacks over a close the app already has working — the 'take-profit' may BE that close", async () => {
    // A timed exit's marketable limit reads as a LIMIT sell, which classifies
    // as a take-profit. Cancelling it would undo the app's own close; stacking
    // a bracket on it is refused as a reversal, or sells twice if both fill.
    const pos = await agedProtectionCandidate('AAPL', 10);
    const close = createIntent(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 99,
      },
      'working-close-tp',
    );
    recordLiveExitOrder({ intentId: close.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId: pos.id });
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [restingLeg({ clientOrderId: 'working-close-tp', comboType: undefined, orderType: 'LIMIT' })],
    });

    const outcomes = await checkLiveBracketProtection();

    expect(webullCancelOrder).not.toHaveBeenCalled();
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ exitWorking: true });
    expect(String(JSON.parse(unprotectedEvents()[0].detail ?? '{}').reason)).toMatch(/close the app placed/);
  });

  it('re-arms BOTH legs when nothing at all is resting', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-BOTH' });

    await checkLiveBracketProtection();

    const [, , target, stop] = vi.mocked(webullPlaceStandaloneBracket).mock.calls[0];
    expect(stop).toBe(95);
    expect(target).toBe(110);
    const rearmed = listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearmed'] });
    expect(JSON.parse(rearmed[0].detail ?? '{}')).toMatchObject({ legsPlaced: 'stop+target' });
  });

  it('pages when the re-arm FAILS, and says why', async () => {
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: false, error: 'rejected by broker' });

    await checkLiveBracketProtection();

    expect(unprotectedEvents()).toHaveLength(1);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.rearmOutcome).toBe('rejected by broker');
    expect(String(detail.reason)).toMatch(/automatic re-arm failed/);
  });

  it('never stacks a second bracket after an UNANSWERED re-arm', async () => {
    // Ambiguous means the bracket MAY be resting. Two stops against one
    // position is the accidental short.
    await agedProtectionCandidate('AAPL', 10);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({
      ok: false,
      ambiguous: true,
      error: 'timeout',
    });

    await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    const detail = JSON.parse(unprotectedEvents()[0].detail ?? '{}') as Record<string, unknown>;
    expect(detail.rearmOutcome).toBe('unanswered');
    expect(String(detail.reason)).toMatch(/UNANSWERED/);
  });

  it('does not re-arm when the broker holds nothing — there is nothing to protect', async () => {
    await agedProtectionCandidate('AAPL', 0);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    await checkLiveBracketProtection();

    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('pages on a PARTIAL fill — the shares that remain really have no stop', async () => {
    // 4 of 10 sold, 6 still held with nothing under them. Treating "quantity
    // changed" as "position closed" would leave those 6 silently naked.
    await agedProtectionCandidate('AAPL', 6);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    expect((await checkLiveBracketProtection())[0]).toMatchObject({ protectedAtBroker: false, heldAtBroker: 6 });
    expect(unprotectedEvents()).toHaveLength(1);
  });

  it('pages FAIL-LOUD when the account cannot be read, and says the held count is unconfirmed', async () => {
    // Not knowing is not the same as knowing it is fine. For a protection alarm
    // the safe direction is to wake someone — but the message must not claim a
    // confirmation it does not have.
    await agedProtectionCandidate('AAPL', 10);
    mockAccountState.mockResolvedValue({ ok: false, error: 'broker down' } as Awaited<
      ReturnType<typeof webullAccountState>
    >);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ protectedAtBroker: false, heldAtBroker: null });
    expect(unprotectedEvents()).toHaveLength(1);
    expect(String(JSON.parse(unprotectedEvents()[0].detail ?? '{}').reason)).toMatch(
      /account read FAILED, so it is NOT confirmed/,
    );
  });

  it('never asks the account about a position that still HAS its stop', async () => {
    // The read is lazy on purpose: one account call per position about to page,
    // not one per position per tick. Every healthy position returns before it.
    await agedProtectionCandidate('AAPL', 10);
    mockAccountState.mockClear();
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [restingLeg({ comboType: 'STOP_LOSS', orderType: 'STOP_LOSS', stopPrice: 95 })],
    });

    expect((await checkLiveBracketProtection())[0]).toMatchObject({ protectedAtBroker: true });
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  it('reports a resting STOP as protected', async () => {
    await agedProtectionCandidate();
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [restingLeg({ comboType: 'STOP_LOSS', orderType: 'STOP_LOSS', stopPrice: 95 })],
    });
    expect((await checkLiveBracketProtection())[0]).toMatchObject({ protectedAtBroker: true });
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('identifies the stop by order_type when combo_type did not parse', async () => {
    // The PR #467 failure shape: combo_type undefined on every leg. The
    // position is genuinely protected and must not be alarmed about.
    await agedProtectionCandidate();
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [
        restingLeg({ clientOrderId: 'a', comboType: undefined, orderType: 'STOP_LOSS', stopPrice: 95 }),
        restingLeg({ clientOrderId: 'b', comboType: undefined, orderType: 'LIMIT', limitPrice: 110 }),
      ],
    });
    expect((await checkLiveBracketProtection())[0]).toMatchObject({ protectedAtBroker: true });
    expect(unprotectedEvents()).toHaveLength(0);
  });

  it('stays SILENT when legs rest but none can be classified — a parse miss is not a naked position', async () => {
    // The cry-wolf guard. An alert that fires on healthy positions is worse
    // than no alert, which is why this takes the same "say nothing" path as
    // unreadableOpenOrders rather than reporting unprotected.
    await agedProtectionCandidate();
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({
      ok: true,
      orders: [restingLeg({ comboType: undefined, orderType: undefined })],
    });

    const outcomes = await checkLiveBracketProtection();
    expect(outcomes[0]).toMatchObject({ protectedAtBroker: false });
    expect(outcomes[0].unknown).toMatch(/none identifiable as stop or target/);
    expect(unprotectedEvents()).toHaveLength(0); // no alert on an unreadable book
  });

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

  // THE SAME SIDE (2026-09-23, shorts pre-flight). A buy's fill is a long, so
  // an untagged SHORT row in the name (the operator's own trade) is not it, and
  // adopting it would book this order's P&L with the sign reversed.
  it('does not adopt an untagged row on the OTHER side — the fill gets its own row', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SIDES' });
    const okResult = evaluateRiskCheck(signal(), baseRiskCtx());
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;

    const operatorsShort = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'short',
      quantity: 40,
      entryPrice: 101,
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

    const open = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(open).toHaveLength(2);
    const short = open.find((p) => p.id === operatorsShort.id)!;
    expect(short.tags).not.toContain('autotrade');
    const long = open.find((p) => p.id !== operatorsShort.id)!;
    expect(long).toMatchObject({ side: 'long', entryPrice: 100.5 });
    expect(getLiveOrder(intentId)?.positionId).toBe(long.id);
  });

  // The healing block writes six at-entry fields onto an untagged orphan, and
  // until 2026-09-04 entryComponents was the only one of the six written
  // WITHOUT an `adopted.X ??` preserve-existing prefix — so it was the only one
  // that could overwrite a real value with null. This pins the rule for all six
  // at the consumer: healing an orphan backfills what is missing and destroys
  // nothing. (Reachability is a separate question — see the comment on the line
  // itself. The asymmetry is worth closing regardless of whether a caller
  // currently walks into it.)
  it("backfills the orphan's missing at-entry fields without clobbering the ones it has", async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-KEEP' });
    // The ORDER carries no components — the only case where a missing
    // preserve-existing prefix actually destroys rather than merely duplicates.
    const sig = signal({ components: null });
    const okResult = evaluateRiskCheck(sig, baseRiskCtx());
    await attemptLiveEntry(sig, okResult, 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;
    expect(getLiveOrder(intentId)?.entryComponents).toBeNull();

    const existing = { momentum: 95.2, rsi: 94.2, trend: 100 };
    const imported = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: okResult.sizing.suggestedQuantity,
      entryPrice: 100.5,
      entryDate: '2026-08-24',
      tags: ['webull'],
      accountId: 'ACC1',
      entryComponents: existing,
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

    const healed = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(healed).toHaveLength(1);
    expect(healed[0].id).toBe(imported.id);
    // Kept, not overwritten with the order's null.
    expect(healed[0].entryComponents).toEqual(existing);
    // ...while the fields it genuinely lacked were still backfilled.
    expect(healed[0].entryScore).toBe(sig.score);
    expect(healed[0].stopPrice).toBe(95);
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

  // The whole chain, asserted at the END of it. The components are set on the
  // signal, carried onto the live order row, and only written to the position
  // when the fill materializes — three hops, any of which could drop them and
  // still leave every unit test green. entry_score already travels this path;
  // this proves the breakdown does too.
  //
  // Why it matters: measured over 22 modern trades, corr(entryScore, peak R)
  // = -0.083 and the higher-scoring half moved LESS. The total shows no edge.
  // Asking whether a COMPONENT does requires the breakdown joined to realized
  // outcomes, which is only possible if it lands here.
  it('carries the per-component scores from signal to the materialized position', async () => {
    const comps = { momentum: 81.2, relativeVolume: 64, rsi: 55.5, trend: 90 };
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-COMP' });

    const sig = signal({ components: comps });
    const okResult = evaluateRiskCheck(sig, baseRiskCtx());
    await attemptLiveEntry(sig, okResult, 'MODERATE', liveConfig());

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const pos = listPositions({ status: 'open', symbol: 'AAPL' }).find((p) => p.tags.includes('autotrade'));
    expect(pos, 'the fill should have materialized a position').toBeDefined();
    expect(pos!.entryComponents).toEqual(comps);
    expect(pos!.entryScore).toBe(sig.score); // and the total still travels too
  });

  // Task #62. The squeeze ratio is only worth computing if it survives to the
  // POSITION, because that is the only row a study can join to a realized
  // outcome. Signal -> order row -> position is three hops, and decide.ts's own
  // unit tests stay green if any of the last two drops it — the same shape the
  // component-breakdown test above exists for.
  it('carries the stop-cap forensics from signal to the materialized position', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SQUEEZE' });

    // A signal whose ATR stop was squeezed 4x into the cap — the IRD shape.
    const sig = signal({ stopSqueezeRatio: 4.2, plannedStopDistancePct: 2.5 });
    const okResult = evaluateRiskCheck(sig, baseRiskCtx());
    await attemptLiveEntry(sig, okResult, 'MODERATE', liveConfig());

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: okResult.sizing.suggestedQuantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const pos = listPositions({ status: 'open', symbol: 'AAPL' }).find((p) => p.tags.includes('autotrade'));
    expect(pos, 'the fill should have materialized a position').toBeDefined();
    expect(pos!.stopSqueezeRatio).toBe(4.2);
    expect(pos!.plannedStopDistancePct).toBe(2.5);
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
    });
    await attemptLiveEntry(signal(), okResult, 'MODERATE', cfg, 'risk-off', 2.5, 'sideways', 0.7);
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
    // The ML regime label (2026-09-08): recorded on the order row, carried to
    // the materialized position by the same path.
    expect(getLiveOrder(intentId)?.mlRegime).toBe('sideways');
    expect(positions[0].mlRegime).toBe('sideways');
    // The target tighten factor (2026-09-08) rides the same order row → position path.
    expect(getLiveOrder(intentId)?.regimeTargetFactor).toBe(0.7);
    expect(positions[0].regimeTargetFactor).toBe(0.7);
    expect(positions[0].entryTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it('closes the position when a bracket exit leg unambiguously reports FILLED', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-4' });
    const okResult = evaluateRiskCheck(signal(), {
      equity: 100_000,
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
    });

  // -------------------------------------------------------------------------
  // A filled bracket leg read by its own id (2026-09-24, #147). The order lists
  // show a filled leg 4m43s to 5m02s after the sync first misses the shares
  // (SMCI 09-23, GRML 09-24), past the sync's four-minute grace, so the sync
  // booked a quote. Order Detail by the leg's own id answers in seconds.
  // -------------------------------------------------------------------------
  describe('a bracket leg the lists have not shown filled yet (#147)', () => {
    const LEGS = { takeProfit: 'TP-LEG-147', stopLoss: 'SL-LEG-147' };
    const qty = () => entryResult().sizing.suggestedQuantity;
    const legRows = () => listAutotradeEvents({ actions: ['live_bracket_leg_from_detail'] });

    /** An entry placed with both legs' ids, filled, and its legs still
     *  resting in the lists' view of it. */
    const openWithRestingLegs = async () => {
      db.exec('DELETE FROM webull_miss_streak;');
      onTestFinished(() => {
        db.exec('DELETE FROM webull_miss_streak;');
      });
      setAutotradeConfig(liveConfig());
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as ReturnType<typeof getProvider>);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-147', legClientOrderIds: LEGS });
      await attemptLiveEntry(signal(), entryResult(), 'MODERATE', liveConfig());
      mockOrderStatus.mockResolvedValue({
        ok: true,
        found: true,
        status: 'FILLED',
        filledQty: qty(),
        filledPrice: 100,
        legs: [{ comboType: 'MASTER', status: 'FILLED' }],
      } as WebullOrderStatus);
      await reconcileLiveOrders();
      expect(listPositions({ status: 'open' })).toHaveLength(1);
      mockOrderStatus.mockResolvedValue({
        ok: true,
        found: true,
        status: 'FILLED',
        legs: [
          { comboType: 'MASTER', status: 'FILLED' },
          { comboType: 'STOP_PROFIT', status: 'WORKING', clientOrderId: LEGS.takeProfit },
          { comboType: 'STOP_LOSS', status: 'WORKING', clientOrderId: LEGS.stopLoss },
        ],
      } as WebullOrderStatus);
    };
    /** The sync found none of the shares on its last pass (or `held` of them). */
    const sharesMissed = (held = 0, pos = listPositions({ status: 'open' })[0]) =>
      bumpMissStreak('ACC1', contractKey(pos), held);
    /** What the ledger holds: the order was placed for less than the sizer's
     *  suggestion, so this, not qty(), is what a whole fill must cover. */
    const held = () => listPositions({ status: 'open' })[0].remainingQuantity;
    const skipRows = () => listAutotradeEvents({ actions: ['live_bracket_leg_detail_skipped'] });

    it("stores both legs' own ids on the entry row at placement", async () => {
      await openWithRestingLegs();
      expect(listPendingLiveOrders()[0]).toMatchObject({
        takeProfitClientOrderId: LEGS.takeProfit,
        stopLossClientOrderId: LEGS.stopLoss,
      });
    });

    it('books the stop at the fill Order Detail reports, once the sync has missed the shares', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 94.9, filledQty: qty() }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      const outcomes = await reconcileLiveOrders();

      expect(outcomes[0]).toMatchObject({ changed: true, action: 'exit_filled' });
      const [closed] = listPositions({ status: 'closed' });
      expect(closed.exits[0]).toMatchObject({ exitPrice: 94.9, exitReason: 'stop' });
      // The stop was asked first, answered, and the take-profit never was.
      expect(vi.mocked(webullOrderDetail).mock.calls.map((c) => c[1])).toEqual([LEGS.stopLoss]);
      expect(legRows()).toHaveLength(1);
      expect(JSON.parse(legRows()[0].detail ?? '{}')).toMatchObject({
        leg: 'stop',
        clientOrderId: LEGS.stopLoss,
        filledPrice: 94.9,
        missStreak: 1,
        listedLegs: ['STOP_PROFIT:WORKING', 'STOP_LOSS:WORKING'],
      });
    });

    it('books a filled take-profit as a target, from which of its ids answered', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.takeProfit
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 110.05, filledQty: qty() }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();

      const [closed] = listPositions({ status: 'closed' });
      expect(closed.exits[0]).toMatchObject({ exitPrice: 110.05, exitReason: 'target' });
    });

    it('does not ask while the broker still shows the shares', async () => {
      await openWithRestingLegs();
      await reconcileLiveOrders();
      expect(vi.mocked(webullOrderDetail)).not.toHaveBeenCalled();
      expect(listPositions({ status: 'open' })).toHaveLength(1);
    });

    it('books the fill once: a second tick finds the position closed and asks nothing (2026-09-25)', async () => {
      await openWithRestingLegs();
      const pos = listPositions({ status: 'open' })[0];
      sharesMissed();
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 94.9, filledQty: qty() }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();
      sharesMissed(0, pos);
      await reconcileLiveOrders();

      const [closed] = listPositions({ status: 'closed' });
      expect(closed.exits).toHaveLength(1);
      expect(vi.mocked(webullOrderDetail)).toHaveBeenCalledTimes(1);
    });

    it('does not ask while the broker still shows some of the shares (2026-09-25)', async () => {
      // A partial gap (a hand trim, a scale-out sold but not yet booked) is a
      // miss, but not a filled leg: the shares left still need their stop.
      await openWithRestingLegs();
      sharesMissed(Math.floor(held() / 2));
      await reconcileLiveOrders();
      expect(vi.mocked(webullOrderDetail)).not.toHaveBeenCalled();
      expect(listPositions({ status: 'open' })).toHaveLength(1);
    });

    it('books no leg that filled fewer shares than the ledger holds, and says why once (2026-09-25)', async () => {
      // Booked, it would be booked again the next tick while the gap stayed open.
      await openWithRestingLegs();
      sharesMissed();
      const part = held() - 10;
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 94.9, filledQty: part }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();
      sharesMissed();
      await reconcileLiveOrders();

      expect(listPositions({ status: 'open' })[0].exits).toHaveLength(0);
      expect(legRows()).toHaveLength(0);
      expect(skipRows()).toHaveLength(1);
      expect(JSON.parse(skipRows()[0].detail ?? '{}')).toMatchObject({
        leg: 'stop',
        filledQty: part,
        remainingQuantity: part + 10,
        reason: expect.stringMatching(/fewer shares/),
      });
      // Filled is filled: the target is never asked after it.
      expect(vi.mocked(webullOrderDetail).mock.calls.every((c) => c[1] === LEGS.stopLoss)).toBe(true);
    });

    it('books no fill reported with a price of 0, or none (2026-09-25)', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 0, filledQty: qty() }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();

      expect(listPositions({ status: 'open' })[0].exits).toHaveLength(0);
      expect(JSON.parse(skipRows()[0].detail ?? '{}').reason).toMatch(/no usable price/);
    });

    it('journals a lookup that fails, once a day, and books nothing from it (2026-09-25)', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockResolvedValue({ ok: false, found: false, error: 'HTTP 429' });

      await reconcileLiveOrders();
      sharesMissed();
      await reconcileLiveOrders();

      const rows = listAutotradeEvents({ actions: ['live_bracket_leg_detail_unresolved'] });
      // One per leg a day, however many ticks ask.
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].detail ?? '{}')).toMatchObject({ error: 'HTTP 429' });
      expect(listPositions({ status: 'open' })).toHaveLength(1);
    });

    it('does not spend a lookup on a position whose own close is already working (2026-09-25)', async () => {
      // A time exit or the end-of-day flatten cancels the legs and books
      // through its own order; the lookups per tick go to real leg fills.
      await openWithRestingLegs();
      const pos = listPositions({ status: 'open' })[0];
      const close = createIntent(
        {
          symbol: 'AAPL',
          assetKind: 'stock',
          side: 'sell',
          openClose: 'close',
          quantity: pos.remainingQuantity,
          orderType: 'limit',
          limitPrice: 95,
        },
        'working-close-147',
      );
      recordLiveExitOrder({ intentId: close.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId: pos.id });
      sharesMissed(0, pos);
      vi.mocked(webullOrderDetail).mockResolvedValue({ ok: true, found: true, status: 'FILLED', filledPrice: 94.9 });

      await reconcileLiveOrders();

      const asked = vi.mocked(webullOrderDetail).mock.calls.map((c) => c[1]);
      expect(asked).not.toContain(LEGS.stopLoss);
      expect(asked).not.toContain(LEGS.takeProfit);
    });

    it('asks for a scaled-out position: a scale-out already filled is not a working close (2026-09-25, on review)', async () => {
      // The reconcile's pending list keeps a FILLED exit row while its position
      // is open. Read as "a close is working", it skipped this position for the
      // rest of its life, and when the stop then filled the sync booked a quote:
      // the #147 defect, on every scaled-out trade. positionsWithWorkingClose
      // reads the intent's state, as the positions sync has since NOK (09-08).
      await openWithRestingLegs();
      const pos = listPositions({ status: 'open' })[0];
      const half = Math.floor(pos.remainingQuantity / 2);
      const scaleOut = createIntent(
        {
          symbol: 'AAPL',
          assetKind: 'stock',
          side: 'sell',
          openClose: 'close',
          quantity: half,
          orderType: 'limit',
          limitPrice: 102.5,
        },
        'scale-out-147',
      );
      for (const s of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(scaleOut.id, s);
      }
      advanceMaterialized(scaleOut.id, half, half * 102.5);
      recordLiveExitOrder({ intentId: scaleOut.id, symbol: 'AAPL', riskProfile: 'MODERATE', positionId: pos.id });
      addExit(pos.id, { quantity: half, exitPrice: 102.5, exitDate: etToday(), exitReason: 'partial' });
      const rest = listPositions({ status: 'open' })[0].remainingQuantity;
      expect(rest).toBe(pos.remainingQuantity - half);
      // Still pending: the list answers "what does the reconcile poll", not this.
      expect(listPendingLiveOrders().some((o) => o.role === 'exit' && o.intentId === scaleOut.id)).toBe(true);

      sharesMissed(0, pos);
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 97.1, filledQty: rest }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();

      expect(vi.mocked(webullOrderDetail).mock.calls.map((c) => c[1])).toContain(LEGS.stopLoss);
      const [closed] = listPositions({ status: 'closed' });
      expect(closed.exits.at(-1)).toMatchObject({ exitPrice: 97.1, exitReason: 'stop', quantity: rest });
    });

    it('says once a day when the broker does not know a leg id, and books nothing (2026-09-25, on review)', async () => {
      // Silent, an unknown id spent two lookups every tick without a trace.
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockResolvedValue({ ok: true, found: false });

      await reconcileLiveOrders();
      sharesMissed();
      await reconcileLiveOrders();

      const rows = listAutotradeEvents({ actions: ['live_bracket_leg_detail_unresolved'] });
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].detail ?? '{}').error).toMatch(/^not found/);
      expect(listPositions({ status: 'open' })).toHaveLength(1);
    });

    it('names a fill reported with no quantity as that, not as too few shares (2026-09-25, on review)', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === LEGS.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 94.9 }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();

      expect(listPositions({ status: 'open' })[0].exits).toHaveLength(0);
      expect(JSON.parse(skipRows()[0].detail ?? '{}').reason).toMatch(/no filled quantity/);
    });

    it("asks only the newest entry row's legs: an older row names legs a re-arm cancelled (2026-09-25, on review)", async () => {
      await openWithRestingLegs();
      const pos = listPositions({ status: 'open' })[0];
      // A scale-in's row, newer, carrying the legs the re-arm placed.
      const NEW = { takeProfit: 'TP-REARM-147', stopLoss: 'SL-REARM-147' };
      const add = createIntent(
        {
          symbol: 'AAPL',
          assetKind: 'stock',
          side: 'buy',
          openClose: 'open',
          quantity: 1,
          orderType: 'limit',
          limitPrice: 100,
          // A live add-on carries its own bracket (liveExecute's scale-in).
          bracket: { takeProfitPrice: 110, stopLossPrice: 95 },
        },
        'addon-147',
      );
      for (const st of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(add.id, st);
      }
      recordLiveAddOnOrder({
        intentId: add.id,
        symbol: 'AAPL',
        stopPrice: 95,
        targetPrice: 110,
        riskAmount: 5,
        riskProfile: 'MODERATE',
        addonOfPositionId: pos.id,
        legClientOrderIds: NEW,
      });
      setLiveOrderPositionId(add.id, pos.id);
      db.prepare('UPDATE autotrade_live_orders SET created_at = created_at + 1000 WHERE intent_id = ?').run(add.id);
      sharesMissed(0, pos);
      vi.mocked(webullOrderDetail).mockImplementation(async (_account, id) =>
        id === NEW.stopLoss
          ? { ok: true, found: true, status: 'FILLED', filledPrice: 94.9, filledQty: pos.remainingQuantity }
          : { ok: true, found: true, status: 'CANCELLED' },
      );

      await reconcileLiveOrders();

      const asked = vi.mocked(webullOrderDetail).mock.calls.map((c) => c[1]);
      expect(asked).toEqual([NEW.stopLoss]);
      expect(asked).not.toContain(LEGS.stopLoss);
    });

    it('books nothing on a leg the broker still reports working', async () => {
      await openWithRestingLegs();
      sharesMissed();
      vi.mocked(webullOrderDetail).mockResolvedValue({ ok: true, found: true, status: 'WORKING' });

      await reconcileLiveOrders();

      expect(listPositions({ status: 'open' })).toHaveLength(1);
      expect(legRows()).toHaveLength(0);
      expect(vi.mocked(webullOrderDetail).mock.calls.map((c) => c[1])).toEqual([LEGS.stopLoss, LEGS.takeProfit]);
    });
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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

// EVERY live entry currently reaches the `positions` table through adoption:
// Webull's positions feed beats reconcile to the fill, the generic sync imports
// the holding, and autotrade adopts it. That importer records entry_date as
// NULL by design — it reports an average cost for a lot, not an open date — and
// adoption never filled it in. So getLivePortfolioSnapshot()'s tradesToday,
// which counts `entryDate === today`, counted ZERO every single day, and
// maxTradesPerDay was inert: on 2026-08-31 five entries were placed against a
// cap of four, held back only by liveMaxOrdersPerDay counting ORDER rows.
//
// These assert at the CONSUMER — the snapshot figure and the risk rule that
// reads it — not merely that a column got written. A test that stopped at the
// column would have gone green while the cap stayed inert, which is the whole
// shape of this bug.
describe('adopted positions carry an entry stamp', () => {
  /** Place a real autotrade entry order and return its intent id. */
  async function placeEntry(symbol = 'AAPL') {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ [symbol]: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: `WB-${symbol}` });
    const result = evaluateRiskCheck(signal({ symbol }), baseRiskCtx());
    await attemptLiveEntry(signal({ symbol }), result, 'MODERATE', liveConfig());
    return { intentId: listIntents()[0].id, quantity: result.sizing.suggestedQuantity };
  }

  /** The real import path: the broker's positions feed reports the holding
   *  with no open date, exactly as mapWebullPosition() leaves it. */
  async function importBrokerHolding(symbol: string, quantity: number) {
    mockBrokerPositions([{ symbol, quantity, cost_price: 100, asset_type: 'stock' }]);
    await runWebullPositionsSync('ACC1');
    const [orphan] = listPositions({ status: 'open', symbol });
    // Guard the premise: if the importer ever starts stamping a date, this
    // whole describe is testing something that no longer happens.
    expect(orphan.entryDate).toBeNull();
    return orphan;
  }

  it('counts an adopted position toward tradesToday — the figure maxTradesPerDay reads', async () => {
    const { quantity } = await placeEntry();
    await importBrokerHolding('AAPL', quantity);

    expect(getLivePortfolioSnapshot().tradesToday).toBe(0); // nothing adopted yet
    expect(adoptOrphanedLivePositions().adopted).toBe(1);

    const snapshot = getLivePortfolioSnapshot();
    expect(snapshot.tradesToday).toBe(1); // was 0 forever, whatever the day did
    expect(listPositions({ status: 'open', symbol: 'AAPL' })[0].entryDate).toBe(snapshot.today);
  });

  it('makes the cap actually bind — the rule that was inert', async () => {
    const { quantity } = await placeEntry();
    await importBrokerHolding('AAPL', quantity);
    adoptOrphanedLivePositions();

    const { tradesToday } = getLivePortfolioSnapshot();
    // Drive the REAL rule with the REAL figure, at a cap of one. Before the
    // stamp this context carried tradesToday: 0 and the check passed, which is
    // precisely how a fifth entry got placed against a cap of four.
    const blocked = evaluateRiskCheck(signal({ symbol: 'MSFT' }), {
      ...baseRiskCtx(),
      tradesToday,
      maxTradesPerDay: 1,
    });
    expect(blocked.checks.find((c) => c.rule === 'max_trades_per_day')?.passed).toBe(false);
    expect(blocked.ok).toBe(false);

    // And it is the STAMP doing the work, not the cap being trivially small:
    // the same rule at a cap of two still lets the next entry through.
    const allowed = evaluateRiskCheck(signal({ symbol: 'MSFT' }), {
      ...baseRiskCtx(),
      tradesToday,
      maxTradesPerDay: 2,
    });
    expect(allowed.checks.find((c) => c.rule === 'max_trades_per_day')?.passed).toBe(true);
  });

  it('dates the entry from the ORDER, not from the tick that adopts it', async () => {
    // A reconcile or adoption pass runs a minute or more after the fill, and
    // can run far later if a tick was missed — dating by the pass would drift
    // every entry toward "later than it happened".
    //
    // The instant below is a FIXED PAST one (2026-08-24 was a Monday), not
    // today offset by a few hours: a stamp taken from the wall clock can never
    // produce it, on any day CI runs. An earlier draft of this test used the
    // day it was written and passed for the wrong reason.
    const placedAt = Date.parse('2026-08-24T10:17:00-04:00');
    const { intentId, quantity } = await placeEntry();
    db.prepare('UPDATE autotrade_live_orders SET created_at = ? WHERE intent_id = ?').run(placedAt, intentId);
    await importBrokerHolding('AAPL', quantity);

    adoptOrphanedLivePositions();

    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.entryDate).toBe('2026-08-24');
    expect(pos.entryTime).toBe('10:17');
    // Corollary worth stating: a stamp this old is correctly NOT today's
    // trade, so it must not inflate today's count either.
    expect(getLivePortfolioSnapshot().tradesToday).toBe(0);
  });

  it('stamps an untagged orphan that reconcile reaches before adoption does', async () => {
    // The other order of events: no adoption pass in between, so
    // materializeEntryFill() is the first thing to see the orphan and heals
    // the tag itself. It owes the same stamp.
    const { intentId, quantity } = await placeEntry();
    await importBrokerHolding('AAPL', quantity);

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: quantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.tags).toEqual(expect.arrayContaining(['autotrade'])); // healed, as before
    expect(getLiveOrder(intentId)?.positionId).toBe(pos.id);
    expect(pos.entryDate).toBe(getLivePortfolioSnapshot().today);
    expect(pos.entryTime).toMatch(/^\d{2}:\d{2}$/);
    expect(getLivePortfolioSnapshot().tradesToday).toBe(1);
  });

  it('stamps an already-tagged position reconcile links to — the branch that heals legacy rows', async () => {
    // A position adopted before this existed is autotrade-tagged already, so
    // the tag-healing branch is skipped entirely. It still has no stamp, and
    // reconcile catching up is the last chance to give it one.
    const { intentId, quantity } = await placeEntry();
    await importBrokerHolding('AAPL', quantity);
    adoptOrphanedLivePositions();
    const adoptedId = listPositions({ status: 'open', symbol: 'AAPL' })[0].id;
    // Re-open the gap exactly as a pre-fix row carries it: tagged, unstamped.
    db.prepare('UPDATE positions SET entry_date = NULL, entry_time = NULL WHERE id = ?').run(adoptedId);
    expect(getLivePortfolioSnapshot().tradesToday).toBe(0);

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: quantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    expect(listPositions({ status: 'open' })).toHaveLength(1); // still linked, not duplicated
    expect(listPositions({ status: 'open' })[0].id).toBe(adoptedId);
    expect(getLiveOrder(intentId)?.positionId).toBe(adoptedId);
    expect(getLivePortfolioSnapshot().tradesToday).toBe(1);
  });

  it('never overwrites an entry stamp the position already has', async () => {
    // A position that reached the table by a route which DOES know its open
    // date (the generic reconcile stamps one) must keep it. This heals a gap;
    // it does not restate a known truth in the adopter's own terms.
    const { intentId, quantity } = await placeEntry();
    mockBrokerPositions([{ symbol: 'AAPL', quantity, cost_price: 100, asset_type: 'stock' }]);
    await runWebullPositionsSync('ACC1');
    const orphanId = listPositions({ status: 'open', symbol: 'AAPL' })[0].id;
    db.prepare("UPDATE positions SET entry_date = '2026-08-24', entry_time = '09:41' WHERE id = ?").run(orphanId);

    adoptOrphanedLivePositions();
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: quantity,
      filledPrice: 100.5,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    } as WebullOrderStatus);
    await reconcileLiveOrders();

    const [pos] = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(pos.entryDate).toBe('2026-08-24'); // both adoption paths left it alone
    expect(pos.entryTime).toBe('09:41');
    expect(getLiveOrder(intentId)?.positionId).toBe(pos.id);
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
    });
    await attemptLiveEntry(signal(), okResult, 'MODERATE', liveConfig());
    expect(listIntents()).toHaveLength(1); // the rejected intent IS audited...
    expect(listPendingLiveOrders()).toHaveLength(0); // ...but was never tagged as autotrade's, since recordLiveOrder only runs on a successful placement
  });
});

/** The live options sleeve's day, as loop.ts threads it into the scale-in
 *  pass: nothing booked, so these cases judge the stock sleeve's day alone. */
const NO_OPTIONS_DAY = { dailyPnl: 0, consecutiveLosses: 0, tradesToday: 0 };

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
      expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([]);
      expect(vi.mocked(webullPlaceOrder)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkSessionWindow).mockReturnValue({ ok: true });
    }
  });

  const riskCtx = {
    equity: 100_000,
    dayStartEquityUsd: 100_000,
    dailyHaltTripped: false,
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
    mlRegime: null,
    mlRegimeEnabled: false,
    mlRegimeSizeCutPct: 35,
    todayRangePct: null,
    regimeShockRangeRatio: 0,
    priorSameDayExits: 0,
    repeatEntrySizeCutPct: 0,
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

    const outcomes = await checkLiveScaleIns(NO_OPTIONS_DAY);
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
    expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([]);
    expect(countLiveAddOns(pos.id)).toBe(0);
  });

  it('does nothing when liveMaxAddOns is 0', async () => {
    await openLivePosition({ ...SCALE_ON, liveMaxAddOns: 0 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([]);
  });

  it('stops adding once the liveMaxAddOns cap is reached', async () => {
    const { pos } = await openLivePosition({ ...SCALE_ON, liveMaxAddOns: 1 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD1' });
    await checkLiveScaleIns(NO_OPTIONS_DAY);
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
    const second = await checkLiveScaleIns(NO_OPTIONS_DAY);
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

    const outcomes = await checkLiveScaleIns(NO_OPTIONS_DAY);
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
    expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([]);
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

    const outcomes = await checkLiveScaleIns(NO_OPTIONS_DAY);
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Aggregate open-risk cap/);
    expect(countLiveAddOns(pos.id)).toBe(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // never reached the broker
    const blocked = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scale_in_blocked',
    );
    expect(JSON.parse(blocked!.detail!)).toMatchObject({ reason: 'max_aggregate_open_risk' });
  });

  it('refuses an add-on once the live halt has tripped today, with the day back above the line', async () => {
    // The same rule every entry runs (dailyHaltVerdict): an add-on adds real
    // risk, so a halted day refuses it for the rest of the day, not only while
    // the day's figure sits at or below the level (2026-09-23).
    const { pos } = await openLivePosition(SCALE_ON);
    writeDailyHaltMarker({ pool: 'live', date: etToday(), dailyPnl: -2046.47, haltLevel: -1941.67 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveScaleIns(NO_OPTIONS_DAY);
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Daily drawdown halt \(halted for the rest of today, tripped earlier/);
    expect(countLiveAddOns(pos.id)).toBe(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const blocked = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scale_in_blocked',
    );
    expect(JSON.parse(blocked!.detail!)).toMatchObject({ reason: 'daily_drawdown_halt', dailyPnl: 0 });
  });

  it('judges the add-on on the live pool, stock plus options, not the stock sleeve alone', async () => {
    // The stock sleeve's day is flat and would pass on its own; the options
    // sleeve's loss puts the live pool past any level. The add-on used to read
    // getLivePortfolioSnapshot() alone, so it placed here while every live
    // entry beside it was refused.
    const { pos } = await openLivePosition(SCALE_ON);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveScaleIns({ dailyPnl: -1_000_000, consecutiveLosses: 0, tradesToday: 0 });
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Daily drawdown halt/);
    expect(countLiveAddOns(pos.id)).toBe(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const blocked = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).find(
      (e) => e.action === 'live_scale_in_blocked',
    );
    expect(JSON.parse(blocked!.detail!)).toMatchObject({ reason: 'daily_drawdown_halt', dailyPnl: -1_000_000 });
  });

  // THE MARKET-DIRECTION GATE FOR ADDS (2026-09-24). An add-on is more shares
  // in the position's direction: a long add on a broad red day is the bet the
  // gate refuses as a fresh long. The add runs before the tick's screen, so it
  // reads the previous tick's reading — seeded here the way the loop leaves it.
  describe('the market-direction gate', () => {
    const RED_TAPE = {
      indexSymbol: 'SPY',
      indexChangePct: -0.35,
      breadth: { red: 365, green: 135, flat: 0, sample: 500 },
      indexPct: 0.2,
      breadthPct: 65,
      exitIndexPct: 0.1,
      exitBreadthPct: 60,
    };
    const GATE_ON = { ...SCALE_ON, marketDirectionGateEnabled: true };
    const addRows = () =>
      listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' }).filter(
        (e) => e.action === 'live_scale_in_direction_skipped',
      );

    it('refuses a long add-on on a broad red day, places nothing, and journals it once', async () => {
      const { pos } = await openLivePosition(GATE_ON);
      readMarketDirectionForTick(RED_TAPE, Date.now() - 130_000, etToday());
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
      mockPlaceOrder.mockClear();

      const outcomes = await checkLiveScaleIns(NO_OPTIONS_DAY);
      expect(outcomes).toEqual([
        {
          symbol: 'AAPL',
          positionId: pos.id,
          requested: false,
          reason: expect.stringMatching(/^Market direction: Broad red market .* a long add-on leans against it$/),
        },
      ]);
      expect(mockPlaceOrder).not.toHaveBeenCalled();
      expect(countLiveAddOns(pos.id)).toBe(0);
      expect(addRows()).toHaveLength(1);
      expect(JSON.parse(addRows()[0].detail!)).toMatchObject({
        positionId: pos.id,
        side: 'long',
        direction: 'red',
        rawDirection: 'red',
        heldBy: null,
        indexChangePct: -0.35,
        redPct: 73,
        readingAgeSec: expect.any(Number),
      });
      expect(JSON.parse(addRows()[0].detail!).readingAgeSec).toBeGreaterThanOrEqual(130);

      // The refusal stands every tick the reading does; the row is once a day.
      expect((await checkLiveScaleIns(NO_OPTIONS_DAY))[0].requested).toBe(false);
      expect(addRows()).toHaveLength(1);
    });

    it('places the add when the last reading is too old to stand for now', async () => {
      const { pos } = await openLivePosition(GATE_ON);
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });

      // A reading the loop took longer ago than LATEST_DIRECTION_MAX_AGE_MS is
      // a market it has not seen lately: it refuses nothing.
      readMarketDirectionForTick(RED_TAPE, Date.now() - LATEST_DIRECTION_MAX_AGE_MS - 60_000, etToday());
      expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([
        { symbol: 'AAPL', positionId: pos.id, requested: true },
      ]);
      expect(countLiveAddOns(pos.id)).toBe(1);
      expect(addRows()).toHaveLength(0);
    });

    it('lets the add through on a red day with the gate off', async () => {
      const { pos } = await openLivePosition(SCALE_ON);
      readMarketDirectionForTick(RED_TAPE, Date.now(), etToday());
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });

      expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([
        { symbol: 'AAPL', positionId: pos.id, requested: true },
      ]);
      expect(addRows()).toHaveLength(0);
    });

    it('lets the add through on a mixed market', async () => {
      const { pos } = await openLivePosition(GATE_ON);
      readMarketDirectionForTick({ ...RED_TAPE, indexChangePct: 0.1 }, Date.now(), etToday());
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });

      expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([
        { symbol: 'AAPL', positionId: pos.id, requested: true },
      ]);
    });
  });

  it('no-ops when the server placement master (TRADING_ENABLED) is off', async () => {
    await openLivePosition(SCALE_ON);
    config.trading.placeEnabled = false;
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    expect(await checkLiveScaleIns(NO_OPTIONS_DAY)).toEqual([]);
  });

  it('reconcile MERGES an add-on fill into the position (blended entry, bigger qty) — no duplicate row', async () => {
    const { pos, qty } = await openLivePosition(SCALE_ON);
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 105 }) as ReturnType<typeof getProvider>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-ADD' });
    await checkLiveScaleIns(NO_OPTIONS_DAY);

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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
      dayStartEquityUsd: 100_000,
      dailyHaltTripped: false,
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
      mlRegime: null,
      mlRegimeEnabled: false,
      mlRegimeSizeCutPct: 35,
      todayRangePct: null,
      regimeShockRangeRatio: 0,
      priorSameDayExits: 0,
      repeatEntrySizeCutPct: 0,
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
describe('runLiveExecution — end-of-day entry cutoff (2026-08-28)', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveMaxOrderUsd: 50_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
    endOfDayFlattenMinutes: 5,
  };
  const at = (hhmm: string) => Date.parse(`2026-08-28T${hhmm}:00-04:00`);
  afterEach(() => vi.useRealTimers());
  const atClock = (ms: number) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(ms);
  };

  it('names the symbols it refused, not just how many', async () => {
    // 2026-09-14, from the operator: Recent activity showed a run of batch
    // refusals with a dash in the Symbol column. These rows refuse the whole
    // tick BEFORE any candidate is examined, so they carry no symbol column —
    // but the signals are in hand when the row is written, and a bare count
    // cannot answer "what did I miss while the book was stood down", which is
    // the only question the row is ever read for.
    setAutotradeConfig(cfgFields);
    atClock(at('15:56'));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100, MSFT: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    await runLiveExecution([{ signal: signal() }, { signal: signal({ symbol: 'MSFT' }) }]);

    const detail = JSON.parse(listAutotradeEvents({ actions: ['entry_window_closed'] })[0].detail ?? '{}') as {
      refused: number;
      symbols: string[];
    };
    expect(detail.refused).toBe(2);
    expect(detail.symbols).toEqual(['AAPL', 'MSFT']);
  });

  it('refuses the batch inside the flatten window, without touching the broker', async () => {
    // The real 2026-08-28 case: ESTC opened 15:56:04, flattened 15:57:12.
    // Blocking before the broker read matters — a doomed batch should cost no
    // round-trip, the same reason the unplaceable-short skip exists.
    setAutotradeConfig(cfgFields);
    atClock(at('15:56'));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-LATE' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', ok: false });
    expect(outcomes[0].reason).toMatch(/past the 20m entry cutoff/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  it('journals the refusal with the candidate count', async () => {
    setAutotradeConfig(cfgFields);
    atClock(at('15:56'));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));

    await runLiveExecution([{ signal: signal() }, { signal: signal() }]);

    const ev = listAutotradeEvents({ actions: ['entry_window_closed'] });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail!)).toMatchObject({ refused: 2, minutesLeft: 4, cutoffMinutes: 20 });
  });

  it('still lets an entry through earlier in the session — proving the gate bites, not blocks all', async () => {
    // GAP opened 15:19 that same day and had a real 36-minute hold. If this
    // gate swallowed that too it would just be an afternoon shutdown.
    setAutotradeConfig(cfgFields);
    atClock(at('15:19'));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OK' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/entry cutoff/);
    expect(listAutotradeEvents({ actions: ['entry_window_closed'] })).toHaveLength(0);
  });

  it('is inert when the flatten is off', async () => {
    setAutotradeConfig({ ...cfgFields, endOfDayFlattenMinutes: 0 });
    atClock(at('15:59'));
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-NOFLAT' });

    const outcomes = await runLiveExecution([{ signal: signal() }]);

    expect(outcomes[0].reason ?? '').not.toMatch(/entry cutoff/);
  });
});

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
      ...(await checkLiveScaleIns(NO_OPTIONS_DAY)),
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

// ---------------------------------------------------------------------------
// Same-day re-entry size cut (#49) — asserted at the BROKER, not the sizer.
//
// The measurement, 2026-09-08 over 89 closed live-autotrade trades: first
// entries n=56 +$398.98 (mean +$7.12), repeats n=33 -$121.03 (mean -$3.67).
// A cut and not a block: the direction survives trimming, the magnitude does
// not (86% of the deficit is one DELL trade; drop the worst from each side and
// repeats are -$0.55 a trade).
//
// The whole point of this block is the WIRING. evaluateRiskCheck applying a
// cut it is handed is one fact; liveExecute counting real closed positions and
// handing it the right number is another, and only the second one moves money.
// effectiveRisk.ts's own history is why that distinction is written down: the
// repeatEntry factor was built by preFinishLineFactors and left out of
// effectiveRiskPct's product, with every unit test on the builder green.
// ---------------------------------------------------------------------------
describe('runLiveExecution — same-day re-entry size cut', () => {
  const cfgFields = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveMaxOrderUsd: 50_000,
    liveMaxExposurePct: 1_000,
    liveMaxDailyLossUsd: 5_000,
    liveMaxOrdersPerDay: 20,
    killSwitch: false,
  };

  /** A concluded autotrade trade in `symbol`, on `book`, exiting on `exitDate`.
   *  Exits a hair ABOVE entry on purpose: a loser would engage the
   *  consecutive-loss step-down and a second cut would then be doing the work
   *  this test attributes to the first. A near-scratch is also the exact shape
   *  of the stagnation exit that produces these repeats. */
  function concludedTrade(symbol: string, book: 'live' | 'paper', exitDate: string = etToday()) {
    const pos = createPosition({
      assetType: 'stock',
      symbol,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: exitDate,
      tags: ['autotrade', book],
    });
    addExit(pos.id, { quantity: 10, exitPrice: 100.01, exitDate });
    return pos;
  }

  async function enter(symbols: string[]) {
    mockGetProvider.mockReturnValue(quoteReturning(Object.fromEntries(symbols.map((s) => [s, 100]))));
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-REPEAT' });
    const outcomes = await runLiveExecution(symbols.map((sym) => ({ signal: signal({ symbol: sym }) })));
    for (const o of outcomes) expect(o.ok, `expected an entry, got: ${o.reason}`).toBe(true);
    return mockPlaceOrder.mock.calls.map((c) => (c[1] as { quantity: number }).quantity);
  }

  /** The size this signal reaches the broker at with NO same-day history.
   *  Measured, not hardcoded: live probation is also halving these orders, and
   *  a literal here would silently start asserting the probation factor the
   *  day either number moves. */
  async function fullSize() {
    const [qty] = await enter(['AAPL']);
    mockPlaceOrder.mockClear();
    db.exec(
      'DELETE FROM autotrade_live_orders; DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM position_exits; DELETE FROM positions;',
    );
    return qty;
  }

  it('sends a SMALLER order when this name already concluded a trade today', async () => {
    setAutotradeConfig({ ...cfgFields, repeatEntrySizeCutPct: 50 });
    const full = await fullSize();
    expect(full).toBeGreaterThan(1); // a 1-share baseline could not show a cut

    // Same config, same signal — the only change is AAPL's own history today.
    concludedTrade('AAPL', 'live');
    expect(await enter(['AAPL'])).toEqual([full / 2]);
  });

  it('loads the closed book for the cut even with the re-entry COOLDOWN off', async () => {
    // The two features share one listPositions read, behind an OR. Tying that
    // read to symbolReentryCooldownMinutes alone — which ships at 0 and is 0 in
    // production — would hand the cut an empty list and it would do nothing,
    // silently, exactly as configured. This is the assertion that catches it.
    setAutotradeConfig({ ...cfgFields, repeatEntrySizeCutPct: 50, symbolReentryCooldownMinutes: 0 });
    const full = await fullSize();
    concludedTrade('AAPL', 'live');
    expect(await enter(['AAPL'])).toEqual([full / 2]);
  });

  it('does not let a PAPER trade in the name cut the live size', async () => {
    // Paper is the control arm this finding gets re-measured against at ~60
    // repeats. If paper's own repeats size the live book down, the two arms
    // stop being independent and the re-measurement cannot settle anything.
    setAutotradeConfig({ ...cfgFields, repeatEntrySizeCutPct: 50 });
    const full = await fullSize();
    concludedTrade('AAPL', 'paper');
    expect(await enter(['AAPL'])).toEqual([full]);
  });

  it("does not let YESTERDAY's exit cut this morning's first entry", async () => {
    setAutotradeConfig({ ...cfgFields, repeatEntrySizeCutPct: 50 });
    const full = await fullSize();
    concludedTrade('AAPL', 'live', '2026-01-02');
    expect(await enter(['AAPL'])).toEqual([full]);
  });

  it('cuts only the name that repeated, not every candidate in the tick', async () => {
    setAutotradeConfig({
      ...cfgFields,
      repeatEntrySizeCutPct: 50,
      maxConcurrentPositions: 5,
      maxAggregateOpenRiskPct: 50,
      maxTradesPerDay: 20,
    });
    concludedTrade('AAA', 'live');
    const [aaa, bbb] = await enter(['AAA', 'BBB']);
    expect(aaa).toBe(bbb / 2); // AAA repeated; BBB is a first entry
  });

  it('ships OFF — a 0% cut leaves a repeat at full size', async () => {
    // The field lands at 0 and the operator picks the number. Until then the
    // live book must behave exactly as it did before this existed.
    setAutotradeConfig({ ...cfgFields, repeatEntrySizeCutPct: 0 });
    const full = await fullSize();
    concludedTrade('AAPL', 'live');
    expect(await enter(['AAPL'])).toEqual([full]);
  });
});

// ---------------------------------------------------------------------------
// A STOCK ORDER IS SHARES, NOT AN OPTION ON THE SAME NAME (2026-09-23).
//
// At 09:37 both sleeves bought MRNA: 129 shares and 3 calls. The generic broker
// sync imported both holdings as untagged ['webull'] rows under the symbol MRNA,
// and the stock order's fill was linked to the CALL — the newer row, the first a
// newest-first lookup reaches. The call entered the stock book with the shares'
// stop and target and was closed by the sync at an estimate: −$384 that never
// happened. The shares' real +$546 take-profit stayed untagged and uncounted,
// and the phantom tripped the −7.5% daily halt at 10:23 on a real day of about
// −4.3%.
//
// The same confusion ran through every read this sleeve makes by symbol: the
// broker's holding (shares plus contracts) and the open-orders list (an options
// close is a resting SELL LIMIT on the same symbol). Each case asserts at the
// CONSUMER — the row that got linked, the order that got cancelled, the verdict
// the sweep reached — and each fails on the code before the fix.
// ---------------------------------------------------------------------------
describe('a stock order is shares, not an option on the same name (MRNA, 2026-09-23)', () => {
  /** A holding as the generic broker sync imports it: untagged, no date. */
  function brokerRow(assetType: 'stock' | 'option', quantity: number, entryPrice: number) {
    return createPosition({
      assetType,
      symbol: 'MRNA',
      side: 'long',
      quantity,
      entryPrice,
      entryDate: null,
      tags: ['webull'],
      accountId: 'ACC1',
      ...(assetType === 'option' ? { optionType: 'call' as const, strike: 195, expiration: '2026-09-25' } : {}),
    });
  }

  /** The stock sleeve's MRNA order, placed and still working at the broker. */
  async function mrnaStockOrder() {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockGetProvider.mockReturnValue(quoteReturning({ MRNA: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MRNA' });
    const sig = signal({ symbol: 'MRNA' });
    const risk = evaluateRiskCheck(sig, baseRiskCtx());
    await attemptLiveEntry(sig, risk, 'MODERATE', liveConfig());
    // The ORDER's quantity (probation scales the sizer's), which is what fills.
    const intent = listIntents()[0];
    return { intentId: intent.id, quantity: intent.quantity };
  }

  const filled = (quantity: number) =>
    ({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: quantity,
      filledPrice: 100,
      legs: [{ comboType: 'MASTER', status: 'FILLED' }],
    }) as WebullOrderStatus;

  it('links the fill to the SHARES when the options sleeve holds a call on the same name', async () => {
    const { intentId, quantity } = await mrnaStockOrder();
    // Production's order: the shares imported first, the call after, so the
    // call is the NEWER row.
    const shares = brokerRow('stock', quantity, 100);
    const call = brokerRow('option', 3, 2.84);
    expect(call.id).toBeGreaterThan(shares.id);

    mockOrderStatus.mockResolvedValue(filled(quantity));
    await reconcileLiveOrders();

    expect(getLiveOrder(intentId)?.positionId).toBe(shares.id);
    // The stock book holds one position, and it is the shares.
    const book = listAutotradeLivePositions({ status: 'open' });
    expect(book.map((p) => p.id)).toEqual([shares.id]);
    expect(book[0].stopPrice).not.toBeNull();
    // The call is left exactly as the sync imported it: not the stock book's,
    // and carrying no stock stop or target.
    const callAfter = listPositions({ status: 'open' }).find((p) => p.id === call.id)!;
    expect(callAfter.tags).toEqual(['webull']);
    expect(callAfter.stopPrice).toBeNull();
    expect(callAfter.targetPrice).toBeNull();
    const linked = listAutotradeEvents({ actions: ['live_position_linked_to_adopted'], limit: 5 });
    expect(JSON.parse(linked[0].detail ?? '{}')).toMatchObject({ positionId: shares.id });
  });

  it('creates its own row rather than take the call when the shares are not imported yet', async () => {
    const { intentId, quantity } = await mrnaStockOrder();
    const call = brokerRow('option', 3, 2.84);

    mockOrderStatus.mockResolvedValue(filled(quantity));
    await reconcileLiveOrders();

    const book = listAutotradeLivePositions({ status: 'open' });
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ assetType: 'stock', quantity, sourceIntentId: intentId });
    expect(listPositions({ status: 'open' }).find((p) => p.id === call.id)?.tags).toEqual(['webull']);
  });

  it('the adoption pass adopts the shares and leaves the call alone', async () => {
    const { intentId, quantity } = await mrnaStockOrder();
    const shares = brokerRow('stock', quantity, 100);
    const call = brokerRow('option', 3, 2.84);

    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 1 });
    expect(getLiveOrder(intentId)?.positionId).toBe(shares.id);
    expect(listPositions({ status: 'open' }).find((p) => p.id === call.id)?.tags).toEqual(['webull']);
  });

  it('never adopts an option row for a stock order, even when it is the only row on the name', async () => {
    await mrnaStockOrder();
    brokerRow('option', 3, 2.84);
    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 0 });
    expect(listAutotradeLivePositions({ status: 'open' })).toHaveLength(0);
  });

  it('one order adopts one holding, not every untagged row on the name', async () => {
    const { quantity } = await mrnaStockOrder();
    brokerRow('stock', quantity, 100);
    brokerRow('stock', 10, 99); // a lot bought by hand while the order was working
    expect(adoptOrphanedLivePositions()).toEqual({ adopted: 1 });
    expect(listAutotradeLivePositions({ status: 'open' })).toHaveLength(1);
  });

  /** An adopted MRNA position past the protection grace window. */
  async function agedMrnaPosition() {
    const { quantity } = await mrnaStockOrder();
    brokerRow('stock', quantity, 100);
    adoptOrphanedLivePositions();
    const pos = listAutotradeLivePositions({ status: 'open' })[0];
    db.prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, pos.id);
    return { pos, quantity };
  }
  /** The broker's holdings read: `shares` of stock, and 3 calls beside them.
   *  Answers the way accountState.ts does — the stock instrument sees shares
   *  only, and a read with no instrument sees the per-underlying sum. */
  function brokerHolds(shares: number) {
    mockAccountState.mockImplementation(
      async (_account, _symbol, instrument) =>
        ({
          ...okAccountState,
          state: {
            ...okAccountState.state,
            currentPositionQty: instrument?.assetKind === 'stock' ? shares : shares + 3,
          },
        }) as Awaited<ReturnType<typeof webullAccountState>>,
    );
  }
  const optionsClose = {
    clientOrderId: 'opt-close',
    symbol: 'MRNA',
    side: 'sell' as const,
    status: 'OPEN',
    comboType: 'NORMAL',
    orderType: 'LIMIT',
    limitPrice: 2.15,
    quantity: 3,
    instrumentType: 'OPTION',
  };

  it('the protection sweep reads SHARES: a stop that filled while calls are held is closed, not naked', async () => {
    await agedMrnaPosition();
    brokerHolds(0);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [] });

    const outcomes = await checkLiveBracketProtection();

    expect(outcomes[0]).toMatchObject({ symbol: 'MRNA', heldAtBroker: 0 });
    expect(String(outcomes[0].unknown)).toMatch(/the position is closed, not unprotected/);
    // Nothing sent: a re-arm or a breach close here would be a SELL of shares
    // nobody holds, stopped only if the broker refuses it.
    expect(webullPlaceStandaloneBracket).not.toHaveBeenCalled();
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // the entry, and only the entry
  });

  it("the protection sweep does not read the options sleeve's close as the shares' take-profit", async () => {
    const { quantity } = await agedMrnaPosition();
    brokerHolds(quantity);
    vi.mocked(listWebullOpenOrders).mockResolvedValueOnce({ ok: true, orders: [optionsClose] });
    vi.mocked(webullPlaceStandaloneBracket).mockResolvedValueOnce({ ok: true, clientComboOrderId: 'GRP-REARM' });

    await checkLiveBracketProtection();

    // The shares are naked and nothing of theirs rests, so they are re-armed —
    // not held back behind a "take-profit" that is really the call's close.
    expect(webullPlaceStandaloneBracket).toHaveBeenCalledTimes(1);
    expect(webullCancelOrder).not.toHaveBeenCalled();
  });

  it("a time exit's bracket clear cancels the shares' legs and never the options sleeve's close", async () => {
    const { intentId, quantity } = await mrnaStockOrder();
    const leg = {
      comboOrderId: 'GRP-1',
      symbol: 'MRNA',
      side: 'sell' as const,
      status: 'OPEN',
      quantity,
      instrumentType: 'EQUITY',
    };
    const stop = { ...leg, clientOrderId: 'sl-1', comboType: 'STOP_LOSS', orderType: 'STOP_LOSS', stopPrice: 95 };
    const target = { ...leg, clientOrderId: 'tp-1', comboType: 'STOP_PROFIT', orderType: 'LIMIT', limitPrice: 110 };
    vi.mocked(listWebullOpenOrders)
      .mockResolvedValueOnce({ ok: true, orders: [stop, target, optionsClose] })
      // The re-scan: the shares' legs are gone; the call's close is still working.
      .mockResolvedValueOnce({ ok: true, orders: [optionsClose] });
    vi.mocked(webullCancelOrder).mockResolvedValue({ ok: true });

    const outcome = await cancelLiveBracketExitLegs(getIntent(intentId)!, 'ACC1');

    expect(outcome.ok).toBe(true);
    expect(
      vi
        .mocked(webullCancelOrder)
        .mock.calls.map((c) => c[1])
        .sort(),
    ).toEqual(['sl-1', 'tp-1']);
  });

  it("names the options sleeve's contract as the holder of a skipped name, not the operator", async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1', killSwitch: false });
    createLiveOptionsPosition({
      symbol: 'MRNA',
      side: 'call',
      contractSymbol: 'MRNA260925C00195000',
      strike: 195,
      expiration: '2026-09-25',
      quantity: 3,
      entryPrice: 2.84,
      riskAmount: 852,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      accountId: 'ACC1',
    });
    brokerRow('option', 3, 2.84);
    mockGetProvider.mockReturnValue(quoteReturning({ MRNA: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    const [outcome] = await runLiveExecution([{ signal: signal({ symbol: 'MRNA' }) }]);

    // The refusal is unchanged; only who it names is.
    expect(outcome).toMatchObject({ ok: false, reason: 'Already has an open live position (options_sleeve)' });
    const rows = listAutotradeEvents({ actions: ['live_symbol_held_skipped'], limit: 5 });
    expect(JSON.parse(rows[0].detail ?? '{}')).toMatchObject({ holder: 'options_sleeve' });
  });

  it('an option the operator holds by hand is still named manual', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1', killSwitch: false });
    brokerRow('option', 3, 2.84); // no options-sleeve position on MRNA
    mockGetProvider.mockReturnValue(quoteReturning({ MRNA: 100 }) as ReturnType<typeof getProvider>);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    await runLiveExecution([{ signal: signal({ symbol: 'MRNA' }) }]);

    const rows = listAutotradeEvents({ actions: ['live_symbol_held_skipped'], limit: 5 });
    expect(JSON.parse(rows[0].detail ?? '{}')).toMatchObject({ holder: 'manual' });
  });

  it('every holdings read in the stock sleeve names the stock instrument', () => {
    // A two-argument webullAccountState(account, symbol) is the per-underlying
    // aggregate. stockAccountState is the one way this file asks; this keeps a
    // seventh read from being written the old way.
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/autotrading/liveExecute.ts'), 'utf8');
    expect(src.match(/webullAccountState\(\s*[^,()]+,\s*[^,()]+\)/g) ?? []).toEqual([]);
  });
});
