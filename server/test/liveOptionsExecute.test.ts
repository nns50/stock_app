import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({
  webullAccountState: vi.fn(),
  webullAccountType: vi.fn(),
}));
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
vi.mock('../src/providers/webull/positions', async (importOriginal) => {
  // contractKey is kept REAL (a pure, deterministic function this file's new
  // tests want to actually exercise, not mock away) — only the network call
  // is mocked.
  const actual = await importOriginal<typeof import('../src/providers/webull/positions')>();
  return { ...actual, previewWebullPositions: vi.fn() };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState, webullAccountType } from '../src/providers/webull/accountState';
import { webullPlaceOrder, webullOrderStatus, WebullOrderStatus } from '../src/providers/webull/orders';
import { previewWebullPositions } from '../src/providers/webull/positions';
import { initDb, db } from '../src/db';
import { UNKNOWN_PLACEMENT_RETIRE_GRACE_MS } from '../src/services/trading/reconcile';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listIntents, createIntent } from '../src/db/orders';
import { recordLiveOrder } from '../src/db/autotradeLiveOrders';
import { getLiveOptionsOrder, listPendingLiveOptionsOrders } from '../src/db/autotradeLiveOptionsOrders';
import {
  createLiveOptionsPosition,
  getLiveOptionsPosition,
  listOpenLiveOptionsPositions,
} from '../src/db/autotradeLiveOptionsPositions';
import * as liveOptionsPositionsDb from '../src/db/autotradeLiveOptionsPositions';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from '../src/services/autotrading/optionsRiskCheck';
import { DebitSpreadOptionsSignal, SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';
import {
  attemptLiveOptionsEntry,
  buildLiveOptionsTradingConfig,
  getOptionsProbationStatus,
  getLiveOptionsPortfolioSnapshot,
  runLiveOptionsExecution,
  checkLiveOptionsExits,
  reconcileLiveOptionsOrders,
  syncLiveOptionsPositionsFromBroker,
} from '../src/services/autotrading/liveOptionsExecute';
import { closeLiveOptionsAutotradePosition } from '../src/services/trading/closePosition';

const mockGetProvider = vi.mocked(getProvider);
const mockPreviewPositions = vi.mocked(previewWebullPositions);
const mockAccountState = vi.mocked(webullAccountState);
const mockAccountType = vi.mocked(webullAccountType);
const mockPlaceOrder = vi.mocked(webullPlaceOrder);
const mockOrderStatus = vi.mocked(webullOrderStatus);

function optionSignal(overrides: Partial<SingleLegOptionsSignal> = {}): SingleLegOptionsSignal {
  return {
    kind: 'single_leg',
    symbol: 'AAPL',
    side: 'call',
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2024-06-21',
    dte: 21,
    premium: 3,
    delta: 0.45,
    ivRank: 50,
    maxLossPerContract: 300,
    rationale: 'test fixture',
    score: 70,
    ...overrides,
  };
}

function spreadSignal(overrides: Partial<DebitSpreadOptionsSignal> = {}): DebitSpreadOptionsSignal {
  return {
    kind: 'debit_spread',
    symbol: 'AAPL',
    side: 'call',
    expiration: '2024-06-21',
    dte: 21,
    ivRank: 50,
    longContractSymbol: 'AAPL-long',
    longStrike: 100,
    longPremium: 3,
    longDelta: 0.45,
    shortContractSymbol: 'AAPL-short',
    shortStrike: 110,
    shortPremium: 1,
    shortDelta: 0.2,
    width: 10,
    netDebit: 2,
    maxLossPerContract: 200,
    maxProfitPerContract: 800,
    rationale: 'test fixture',
    score: 70,
    ...overrides,
  };
}

/** `mark` is a live two-sided quote; `last` alone models an illiquid contract
 *  with no bid/ask, where the only number available is an old trade print. */
type ContractFixture = { side: 'call' | 'put'; strike: number; mark?: number; last?: number };

function chainsFor(fixtures: Record<string, ContractFixture | ContractFixture[]>) {
  return {
    getOptionsChain: vi.fn(async (symbol: string, expiration: string) => {
      const fx = fixtures[symbol];
      if (!fx) throw new Error(`no mock chain for ${symbol}`);
      const list = Array.isArray(fx) ? fx : [fx];
      const contracts = list.map((f, i) => ({
        symbol: `${symbol}-opt-${i}`,
        underlying: symbol,
        type: f.side,
        strike: f.strike,
        ...(f.mark !== undefined ? { mark: f.mark } : {}),
        ...(f.last !== undefined ? { last: f.last } : {}),
        expiration,
      }));
      return {
        underlying: symbol,
        expiration,
        underlyingPrice: 100,
        calls: contracts.filter((c) => c.type === 'call'),
        puts: contracts.filter((c) => c.type === 'put'),
      };
    }),
    getCandles: vi.fn(async () => []),
  };
}

const okAccountState = {
  ok: true,
  accountId: 'ACC1',
  state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty: 0 },
};

/** For a sell-to-close: the guardrails' naked_short check needs
 *  currentPositionQty to reflect the ALREADY-HELD long being closed (see
 *  tradingGuardrails.test.ts's own "does not flag a sell that merely reduces
 *  a long" precedent) — 0 (okAccountState's default, correct for an ENTRY)
 *  would make a close look like opening a naked short. */
function holdingAccountState(qty: number) {
  return { ...okAccountState, state: { ...okAccountState.state, currentPositionQty: qty } };
}

function liveConfig(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    ...defaultAutotradeConfig(),
    accountEquityUsd: 100_000,
    liveAccountId: 'ACC1',
    liveTradingEnabled: true,
    liveEnabledAt: Date.now(),
    liveOptionsEnabled: true,
    liveOptionsEnabledAt: Date.now(),
    liveOptionsMaxOrderUsd: 50_000,
    liveOptionsMaxDailyLossUsd: 5_000,
    liveOptionsMaxOrdersPerDay: 20,
    ...overrides,
  };
}

const okResult = (signal: SingleLegOptionsSignal | DebitSpreadOptionsSignal): OptionsRiskCheckResult =>
  evaluateOptionsRiskCheck(signal, {
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

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM trading_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM autotrade_live_options_positions; DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM webull_miss_streak;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true;
  mockGetProvider.mockReset();
  mockPreviewPositions.mockReset();
  mockAccountState.mockReset();
  mockAccountType.mockReset();
  mockPlaceOrder.mockReset();
  mockOrderStatus.mockReset();
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

describe('buildLiveOptionsTradingConfig', () => {
  it('requires BOTH liveTradingEnabled and liveOptionsEnabled, ANDed with the human enabled toggle', () => {
    setTradingConfig({ enabled: true });
    expect(
      buildLiveOptionsTradingConfig(liveConfig({ liveTradingEnabled: true, liveOptionsEnabled: true })).enabled,
    ).toBe(true);
    expect(
      buildLiveOptionsTradingConfig(liveConfig({ liveTradingEnabled: false, liveOptionsEnabled: true })).enabled,
    ).toBe(false);
    expect(
      buildLiveOptionsTradingConfig(liveConfig({ liveTradingEnabled: true, liveOptionsEnabled: false })).enabled,
    ).toBe(false);
    setTradingConfig({ enabled: false });
    expect(
      buildLiveOptionsTradingConfig(liveConfig({ liveTradingEnabled: true, liveOptionsEnabled: true })).enabled,
    ).toBe(false);
  });

  it('combines both kill switches (OR)', () => {
    setTradingConfig({ killSwitch: true });
    expect(buildLiveOptionsTradingConfig(liveConfig({ killSwitch: false })).killSwitch).toBe(true);
    setTradingConfig({ killSwitch: false });
    expect(buildLiveOptionsTradingConfig(liveConfig({ killSwitch: true })).killSwitch).toBe(true);
  });

  it('maps the dedicated liveOptions* caps, not the equity live caps', () => {
    const cfg = buildLiveOptionsTradingConfig(
      liveConfig({ liveMaxOrderUsd: 111, liveOptionsMaxOrderUsd: 7_777, liveOptionsMaxDailyLossUsd: 333 }),
    );
    expect(cfg.maxOrderUsd).toBe(7_777);
    expect(cfg.maxDailyLossUsd).toBe(333);
  });

  it('falls back maxExposureUsd to 0 when equity is unset, failing closed', () => {
    expect(buildLiveOptionsTradingConfig(liveConfig({ accountEquityUsd: null })).maxExposureUsd).toBe(0);
  });
});

describe('getOptionsProbationStatus', () => {
  it('is inactive when liveOptionsEnabled has never been turned on', () => {
    const status = getOptionsProbationStatus(liveConfig({ liveOptionsEnabledAt: null }));
    expect(status.active).toBe(false);
    expect(status.multiplier).toBe(1);
  });

  it('is active with the configured multiplier when under the trade threshold', () => {
    const cfg = liveConfig({ liveOptionsProbationTrades: 5, liveOptionsProbationSizeMultiplier: 0.4 });
    const status = getOptionsProbationStatus(cfg);
    expect(status.active).toBe(true);
    expect(status.multiplier).toBe(0.4);
    expect(status.tradesRemaining).toBe(5);
  });

  it('counts only entry-role intents placed at/after liveOptionsEnabledAt', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });
    const enabledAt = Date.now() - 1000;
    const cfg = liveConfig({ liveOptionsEnabledAt: enabledAt, liveOptionsProbationTrades: 5 });
    await attemptLiveOptionsEntry(optionSignal(), okResult(optionSignal()), 'MODERATE', cfg);

    const status = getOptionsProbationStatus(cfg);
    expect(status.tradesPlaced).toBe(1);
    expect(status.tradesRemaining).toBe(4);
  });
});

describe('attemptLiveOptionsEntry — stale marks', () => {
  // `mark ?? last` made a live two-sided quote and a possibly-days-old trade
  // print indistinguishable at every call site. Entries are optional, so the
  // cheap correct move is to decline rather than commit real money at a limit
  // derived from a print nobody is currently quoting behind.
  it('refuses a single-leg entry priced only off a last trade', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(
      chainsFor({ AAPL: { side: 'call', strike: 100, last: 2.5 } }) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    const sig = optionSignal();

    const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/last-trade price/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listIntents()).toHaveLength(0); // refused before an intent is even created
  });

  it('still opens on a real two-sided mark', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(
      chainsFor({ AAPL: { side: 'call', strike: 100, mark: 2.5 } }) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });
    const sig = optionSignal();

    expect((await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig())).ok).toBe(true);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });
});

describe('attemptLiveOptionsEntry', () => {
  it('refuses when TRADING_ENABLED is off — no intent, no broker call', async () => {
    config.trading.placeEnabled = false;
    const sig = optionSignal();
    const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TRADING_ENABLED/);
    expect(listIntents()).toHaveLength(0);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('refuses with no liveAccountId configured', async () => {
    const sig = optionSignal();
    const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig({ liveAccountId: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/liveAccountId/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('refuses when the underlying already has an open live options position', async () => {
    createLiveOptionsPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-existing',
      strike: 95,
      expiration: '2024-06-21',
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    const sig = optionSignal();
    const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already has an open live options position/i);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('skips (no order) when the probation-adjusted quantity rounds to 0', async () => {
    const sig = optionSignal();
    const r = await attemptLiveOptionsEntry(
      sig,
      okResult(sig),
      'MODERATE',
      liveConfig({ liveOptionsProbationSizeMultiplier: 0.001 }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rounded to 0/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  describe('single_leg', () => {
    it('fails closed on a quote-fetch failure — no intent, no broker call', async () => {
      mockGetProvider.mockReturnValue(chainsFor({}) as never);
      const sig = optionSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Quote fetch failed/);
      expect(listIntents()).toHaveLength(0);
    });

    it('creates a rejected intent but never calls the broker when guardrails block', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      const sig = optionSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig({ killSwitch: true }));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Guardrails blocked/);
      expect(mockPlaceOrder).not.toHaveBeenCalled();
      const intents = listIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].state).toBe('rejected');
    });

    it('fills at a freshly-fetched mark (with a marketable buffer), places a plain SINGLE order, and records the entry', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });

      const sig = optionSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(true);
      expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
      // Never fetches account type for a single-leg order (only spreads need it).
      expect(mockAccountType).not.toHaveBeenCalled();

      const [, placedIntent] = mockPlaceOrder.mock.calls[0];
      expect(placedIntent.assetKind).toBe('option');
      expect(placedIntent.optionType).toBe('call');
      expect(placedIntent.strike).toBe(100);
      expect(placedIntent.expiration).toBe('2024-06-21');
      expect(placedIntent.orderType).toBe('limit');
      expect(placedIntent.limitPrice).toBe(4.2); // mark 4 + 5% marketable buffer
      expect(placedIntent.optionStrategy).toBeUndefined(); // plain SINGLE, no VERTICAL legs

      const intents = listIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].state).toBe('acknowledged');
      expect(intents[0].brokerOrderId).toBe('WB-1');

      const meta = getLiveOptionsOrder(intents[0].id);
      expect(meta).toMatchObject({ symbol: 'AAPL', role: 'entry', kind: 'single_leg', positionId: null });

      const events = listAutotradeEvents({});
      expect(events.some((e) => e.action === 'live_options_order_placed')).toBe(true);
    });

    it('does NOT place a second entry for a symbol with a working (unfilled) entry order — cross-tick double-open guard', async () => {
      // Regression (hardening audit, CRITICAL): a live options position
      // materializes only when a full fill reconciles, so an entry order still
      // working across a loop-tick boundary was invisible to the
      // open-position-only dedup — the next tick re-emitted the same signal and
      // placed a SECOND real order. attemptLiveOptionsEntry now also blocks on a
      // pending ENTRY order for the symbol (mirroring the exit-side dedup).
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });

      const sig = optionSignal();
      const first = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(first.ok).toBe(true);

      const second = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(second.ok).toBe(false);
      expect(second.reason).toMatch(/already in flight/);
      expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // never reached the broker a second time
      expect(listIntents()).toHaveLength(1);
    });

    it('transitions to rejected and logs a failure event on broker rejection, with no order metadata recorded', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: false, error: 'insufficient funds' });

      const sig = optionSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(false);
      expect(listIntents()[0].state).toBe('rejected');
      expect(listAutotradeEvents({}).some((e) => e.action === 'live_options_entry_failed')).toBe(true);
      expect(getLiveOptionsOrder(listIntents()[0].id)).toBeUndefined();
    });

    it('dispatches a notification when a channel is configured', async () => {
      const origNotifications = { ...config.notifications };
      config.notifications.slackWebhookUrl = 'http://slack.test';
      try {
        mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
        mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
        mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-1' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

        const sig = optionSignal();
        await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());

        expect(fetchSpy).toHaveBeenCalledWith('http://slack.test', expect.objectContaining({ method: 'POST' }));
        const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string) as { text: string };
        expect(body.text).toMatch(/LIVE OPTIONS BUY.*AAPL/);
      } finally {
        Object.assign(config.notifications, origNotifications);
        vi.restoreAllMocks();
      }
    });

    it('records the risk of the contracts actually ORDERED, not the pre-probation size', async () => {
      // For options the premium IS the risk, and unlike equity (whose position
      // risk is re-derived from the real fill) this figure is STORED and read
      // for the position's whole life by the aggregate-risk gate. Recording the
      // uncut amount made every live options position claim 2x its true risk at
      // the default 0.5x probation, blocking entries that were within budget.
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-RISK' });

      const sig = optionSignal();
      await attemptLiveOptionsEntry(
        sig,
        okResult(sig),
        'MODERATE',
        liveConfig({ liveOptionsProbationSizeMultiplier: 0.5 }),
      );
      const orderedQty = mockPlaceOrder.mock.calls[0][1].quantity;
      const recorded = getLiveOptionsOrder(listIntents()[0].id)!;
      const approved = okResult(sig);
      const rawQty =
        'suggestedContracts' in approved.sizing
          ? approved.sizing.suggestedContracts
          : approved.sizing.suggestedQuantity;
      // Scaled in proportion to the contracts actually ordered, rather than
      // recording the full pre-probation budget.
      expect(orderedQty).toBeLessThan(rawQty);
      expect(recorded.riskAmount).toBeCloseTo((approved.approvedRiskAmount * orderedQty) / rawQty, 6);
      expect(recorded.riskAmount).toBeLessThan(approved.approvedRiskAmount);
    });

    it('sizes the entry down by the probation multiplier when active', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-2' });

      const sig = optionSignal();
      await attemptLiveOptionsEntry(
        sig,
        okResult(sig),
        'MODERATE',
        liveConfig({ liveOptionsProbationSizeMultiplier: 0.5 }),
      );
      const halved = mockPlaceOrder.mock.calls[0][1].quantity;

      // Two INDEPENDENT sizing measurements on the same symbol: clear the first
      // order so the cross-tick double-open guard (which now blocks a second
      // entry while the first is still working/unmaterialized) doesn't skip the
      // second measurement.
      db.exec('DELETE FROM autotrade_live_options_orders; DELETE FROM order_events; DELETE FROM order_intents;');
      mockPlaceOrder.mockClear();
      await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig({ liveOptionsEnabledAt: null }));
      const full = mockPlaceOrder.mock.calls[0][1].quantity;

      expect(halved).toBe(Math.floor(full * 0.5));
    });
  });

  describe('debit_spread', () => {
    it('fails closed when either leg fails to quote — no intent, no broker call', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never); // short strike (110) missing
      const sig = spreadSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Quote fetch failed/);
      expect(listIntents()).toHaveLength(0);
    });

    it('rejects when the net debit has vanished at fill (long <= short)', async () => {
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 1 }, // long, now cheaper than the short
            { side: 'call', strike: 110, mark: 1.5 },
          ],
        }) as never,
      );
      const sig = spreadSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Net debit vanished/);
      expect(mockPlaceOrder).not.toHaveBeenCalled();
    });

    it('fetches account type (spreads only) and blocks a non-margin account', async () => {
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3 },
            { side: 'call', strike: 110, mark: 1 },
          ],
        }) as never,
      );
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockAccountType.mockResolvedValue('INDIVIDUAL_CASH');

      const sig = spreadSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Guardrails blocked/);
      expect(r.reason).toMatch(/margin/i);
      expect(mockAccountType).toHaveBeenCalledWith('ACC1');
      expect(mockPlaceOrder).not.toHaveBeenCalled();
    });

    it('places one VERTICAL combo order (long buy + short sell) sized at the net debit, and records the entry', async () => {
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3 },
            { side: 'call', strike: 110, mark: 1 },
          ],
        }) as never,
      );
      mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
      mockAccountType.mockResolvedValue('INDIVIDUAL_MARGIN');
      mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-3' });

      const sig = spreadSignal();
      const r = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
      expect(r.ok).toBe(true);
      expect(mockAccountType).toHaveBeenCalledWith('ACC1');

      const [, placedIntent] = mockPlaceOrder.mock.calls[0];
      expect(placedIntent.optionStrategy).toBe('VERTICAL');
      expect(placedIntent.side).toBe('buy'); // net debit
      expect(placedIntent.limitPrice).toBe(2.1); // net debit (3-1=2) + 5% buffer
      expect(placedIntent.optionLegs).toEqual([
        { side: 'buy', optionType: 'call', strike: 100, expiration: '2024-06-21' },
        { side: 'sell', optionType: 'call', strike: 110, expiration: '2024-06-21' },
      ]);

      const intents = listIntents();
      expect(intents[0].state).toBe('acknowledged');
      const meta = getLiveOptionsOrder(intents[0].id);
      expect(meta).toMatchObject({ symbol: 'AAPL', role: 'entry', kind: 'debit_spread' });
    });
  });
});

describe('getLiveOptionsPortfolioSnapshot', () => {
  it('reflects open live options positions in openRisk/openPositionsCount', () => {
    createLiveOptionsPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-x',
      strike: 100,
      expiration: '2024-06-21',
      quantity: 2,
      entryPrice: 3,
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const snap = getLiveOptionsPortfolioSnapshot();
    expect(snap.openPositionsCount).toBe(1);
    expect(snap.openRisk).toBe(600);
    expect(snap.dailyPnl).toBe(0); // nothing closed
  });
});

describe('runLiveOptionsExecution', () => {
  it('skips a candidate whose underlying already has an open live options position', async () => {
    createLiveOptionsPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-existing',
      strike: 95,
      expiration: '2024-06-21',
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    setAutotradeConfig(liveConfig());
    const outcomes = await runLiveOptionsExecution([{ signal: optionSignal() }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/already has an open/i) });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('risk-checks then places passing candidates, updating the running total across the batch', async () => {
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: { side: 'call', strike: 100, mark: 4 },
        MSFT: { side: 'call', strike: 300, mark: 5 },
      }) as never,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-9' });
    setAutotradeConfig(liveConfig());

    const outcomes = await runLiveOptionsExecution([
      { signal: optionSignal({ symbol: 'AAPL' }) },
      { signal: optionSignal({ symbol: 'MSFT', contractSymbol: 'MSFT-fixture', strike: 300 }) },
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
  });

  it('counts a pending (unmaterialized) live EQUITY order against the combined budget — blocking an options entry a position-only seed would allow', async () => {
    // Regression (hardening audit, HIGH): a live fill becomes a `positions` row
    // only on a LATER reconcile tick, so an equity order placed earlier in the
    // SAME tick has no position row yet. Seeding the options batch from a
    // position-only snapshot let it re-spend the equity batch's just-committed
    // headroom (combined open risk up to 2x maxAggregateOpenRiskPct). The seed
    // now folds in pending orders of BOTH books via combinedLiveOpenRisk().
    setAutotradeConfig(liveConfig());
    // A pending equity order (position_id NULL) whose risk alone blows the
    // aggregate-risk budget — invisible to the old position-only seed.
    const intent = createIntent(
      {
        symbol: 'MSFT',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 100,
        referencePrice: 100,
      },
      'CID-EQ-PENDING',
    );
    recordLiveOrder({
      intentId: intent.id,
      symbol: 'MSFT',
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 1_000_000,
      riskProfile: 'MODERATE',
    });

    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-BLOCK' });

    const outcomes = await runLiveOptionsExecution([{ signal: optionSignal() }]);
    expect(outcomes[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/risk check/i) });
    expect(mockPlaceOrder).not.toHaveBeenCalled(); // the pending equity risk left no room
  });
});

function openLivePosition(overrides: Partial<Parameters<typeof createLiveOptionsPosition>[0]> = {}) {
  const input = {
    symbol: 'AAPL',
    side: 'call' as const,
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2030-01-18', // comfortably outside the exit window unless overridden
    quantity: 2,
    entryPrice: 3,
    riskAmount: 600,
    riskProfile: 'MODERATE' as const,
    rationale: 'fixture',
    ...overrides,
  };
  const pos = createLiveOptionsPosition(input);
  // By default the broker reports the opened contract as held (999), so the exit
  // path's held-qty naked-short cap is a no-op — a test that wants a partial or
  // absent holding overrides mockPreviewPositions after opening.
  mockPreviewPositions.mockResolvedValue(
    previewOf([{ symbol: input.symbol, optionType: input.side, strike: input.strike, expiration: input.expiration }]),
  );
  return pos;
}

describe('checkLiveOptionsExits', () => {
  it('places no order when TRADING_ENABLED is off, even for an already-triggered position', async () => {
    // Regression: unlike equity (whose exits are 100% broker-bracket-driven —
    // reconcileLiveOrders() only ever observes a fill, never places one), this
    // function places a brand-new real closing order — it needs the SAME
    // deploy-level env check attemptLiveOptionsEntry() already has, or a deploy
    // with TRADING_ENABLED unset would still let a triggered position's close
    // reach the broker.
    config.trading.placeEnabled = false;
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05' }); // long past — triggers regardless of "today"
    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('returns nothing when no liveAccountId is configured', async () => {
    setAutotradeConfig({ liveAccountId: null });
    expect(await checkLiveOptionsExits()).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('returns nothing when no positions are open', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    expect(await checkLiveOptionsExits()).toEqual([]);
  });

  it('leaves a position open (no order) when comfortably outside the time-exit window', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    openLivePosition({ expiration: '2030-01-18' }); // far out
    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled(); // no quote needed unless the trigger fires
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('places a real SELL-to-close order for a single-leg position past the trigger, and records the exit', async () => {
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05' }); // long past — triggers regardless of "today"
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT-1' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(mockAccountType).not.toHaveBeenCalled(); // single-leg — no margin gate needed

    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    expect(placedIntent.side).toBe('sell');
    expect(placedIntent.openClose).toBe('close');
    expect(placedIntent.limitPrice).toBe(4.75); // mark 5 - 5% marketable buffer (sell below mark)
    expect(placedIntent.optionType).toBe('call');
    expect(placedIntent.strike).toBe(100);

    const meta = getLiveOptionsOrder(outcomes[0].intentId!);
    expect(meta).toMatchObject({ role: 'exit', kind: 'single_leg', positionId: pos.id });

    const events = listAutotradeEvents({});
    expect(events.some((e) => e.action === 'live_options_exit_placed')).toBe(true);
  });

  it('caps the exit quantity to the broker-held size (no naked short after an unbooked partial fill)', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05', quantity: 10 });
    // The ledger still shows 10 — a prior close partially filled 4 then
    // cancelled and was never booked — but the broker really holds only 6.
    // Selling the stale 10 would short 4 (uncovered short call = unbounded risk).
    mockPreviewPositions.mockResolvedValue(
      previewOf([{ symbol: 'AAPL', optionType: 'call', strike: 100, expiration: '2024-06-05', quantity: 6 }]),
    );
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(holdingAccountState(6) as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT-CAP' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    expect(placedIntent.quantity).toBe(6); // capped to broker-held, NOT the stale ledger 10
  });

  it('skips the exit (no order) when the broker shows 0 contracts held', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05', quantity: 10 });
    mockPreviewPositions.mockResolvedValue(previewOf([])); // broker holds nothing matching
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/0 contracts held/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('fails closed (no order) when the broker positions can not be read', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05' });
    mockPreviewPositions.mockResolvedValue({ ok: false, error: 'timeout' } as Awaited<
      ReturnType<typeof previewWebullPositions>
    >);
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockPlaceOrder.mockClear();

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0].requested).toBe(false);
    expect(outcomes[0].reason).toMatch(/Broker positions unavailable/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('closes a single-leg position even when the broker-reported currentPositionQty is contaminated by an unrelated holding', async () => {
    // Regression: an adversarial review found webullAccountState()'s
    // currentPositionQty sums ALL same-symbol positions (stock and every
    // option contract alike, no asset-type/strike/expiration filter) — so
    // trusting it directly for the naked_short check can fail OPEN (an
    // unrelated stock position masking a real desync) as easily as it can
    // fail closed. okAccountState's currentPositionQty is 0 here — if the
    // fix (feeding the guardrail our OWN ledger quantity, not the broker's
    // aggregate) weren't in place, a sell of pos.quantity contracts against
    // a reported 0 would compute a NEGATIVE resultingQty and get wrongly
    // blocked as a naked short.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT-CONTAM' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(getLiveOptionsOrder(outcomes[0].intentId!)).toMatchObject({ positionId: pos.id });
  });

  it('places one VERTICAL closing combo (flipped legs) for a debit-spread position past the trigger', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({
      kind: 'debit_spread',
      expiration: '2024-06-05',
      contractSymbol: 'AAPL-long',
      strike: 100,
      shortContractSymbol: 'AAPL-short',
      shortStrike: 110,
      entryPrice: 2,
      shortEntryPrice: 0,
    });
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: [
          { side: 'call', strike: 100, mark: 4 },
          { side: 'call', strike: 110, mark: 1 },
        ],
      }) as never,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockAccountType.mockResolvedValue('INDIVIDUAL_MARGIN');
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT-2' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0].requested).toBe(true);
    expect(mockAccountType).toHaveBeenCalledWith('ACC1');

    const [, placedIntent] = mockPlaceOrder.mock.calls[0];
    expect(placedIntent.optionStrategy).toBe('VERTICAL');
    expect(placedIntent.side).toBe('sell'); // net credit to close
    expect(placedIntent.limitPrice).toBe(2.85); // net value (4-1=3) - 5% buffer
    expect(placedIntent.optionLegs).toEqual([
      { side: 'sell', optionType: 'call', strike: 100, expiration: '2024-06-05' }, // long -> now sold
      { side: 'buy', optionType: 'call', strike: 110, expiration: '2024-06-05' }, // short -> now bought back
    ]);
  });

  it('does not place a second closing order for a position that already has one pending', async () => {
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT-3' });

    const first = await checkLiveOptionsExits();
    expect(first[0].requested).toBe(true);
    mockPlaceOrder.mockClear();

    const second = await checkLiveOptionsExits();
    expect(second).toEqual([]); // skipped entirely — still 'open' and an exit is already in flight
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listOpenLiveOptionsPositions().map((p) => p.id)).toContain(pos.id);
  });

  it('still places an exit priced off a last trade, but journals that it may not fill', async () => {
    // The opposite call to the entry path's: refusing here would guarantee the
    // drift-to-expiration the time exit exists to prevent. But a stale-high
    // print puts the sell limit above where the contract can actually be sold,
    // so the close can rest unfilled looking exactly like nothing happening —
    // hence journaled rather than left to be inferred.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue(
      chainsFor({ AAPL: { side: 'call', strike: pos.strike, last: 3 } }) as ReturnType<typeof getProvider>,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPreviewPositions.mockResolvedValue({
      ok: true,
      positions: [
        {
          symbol: 'AAPL',
          assetType: 'option',
          optionType: 'call',
          strike: pos.strike,
          expiration: pos.expiration,
          quantity: pos.quantity,
        },
      ],
    } as never);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT' });

    const outcomes = await checkLiveOptionsExits();

    expect(outcomes[0]).toMatchObject({ requested: true });
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
    const stale = listAutotradeEvents({ stage: 'execution', actions: ['live_options_exit_stale_quote'] });
    expect(stale).toHaveLength(1);
  });

  it('reports the reason and leaves the position open when the quote fetch fails after the trigger fires', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue({ getOptionsChain: vi.fn().mockRejectedValue(new Error('timeout')) } as never);

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ requested: false, reason: expect.stringMatching(/timeout/) });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('does not place a single-leg close when the contract marks at 0 (worthless/unquoted), leaving it open with a reason', async () => {
    // Regression (hardening audit): the exit path built its limit from a raw
    // mark with no validity guard, unlike the entry path. A near-worthless or
    // unquoted contract marks at 0 -> limitPrice 0 -> the limit_price>0
    // guardrail rejects the close EVERY cycle, so the position never
    // auto-closes and drifts to expiration -- the very thing the time-exit
    // exists to prevent. It must skip with a precise reason instead.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ requested: false, reason: expect.stringMatching(/No usable exit quote/) });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    // Still open — skipped this cycle, not stranded on an unplaceable $0 order.
    expect(listOpenLiveOptionsPositions().map((p) => p.id)).toContain(pos.id);
  });

  it('does not place a spread close when the quote is crossed (net value <= 0)', async () => {
    // Companion to the single-leg guard: a crossed/stale spread quote (short
    // leg marks >= long leg) makes netValue <= 0 -> limitPrice <= 0 -> rejected
    // every cycle. Skip with a reason instead of stranding the spread.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({
      kind: 'debit_spread',
      expiration: '2024-06-05',
      contractSymbol: 'AAPL-long',
      strike: 100,
      shortContractSymbol: 'AAPL-short',
      shortStrike: 110,
      entryPrice: 2,
      shortEntryPrice: 0,
    });
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: [
          { side: 'call', strike: 100, mark: 1 }, // long leg now worth LESS...
          { side: 'call', strike: 110, mark: 1.5 }, // ...than the short leg -> net <= 0
        ],
      }) as never,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ requested: false, reason: expect.stringMatching(/No usable exit quote/) });
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(listOpenLiveOptionsPositions().map((p) => p.id)).toContain(pos.id);
  });

  it("re-checks autotrade's own config fresh for EACH triggered position — engaging the kill switch mid-loop stops the next one, not just the next cycle", async () => {
    // Regression: an adversarial review found this function reused ONE stale
    // config snapshot across its whole per-tick loop, unlike
    // runLiveOptionsExecution() (entries), which already re-fetches fresh
    // config per-candidate — the same bug class liveExecute.ts's own
    // runLiveExecution() was fixed for on the equity entry side.
    setAutotradeConfig(liveConfig());
    openLivePosition({ symbol: 'AAPL', expiration: '2024-06-05' });
    openLivePosition({ symbol: 'MSFT', contractSymbol: 'MSFT-fixture', expiration: '2024-06-05' });
    // Both contracts are held at the broker (each openLivePosition only sets the
    // preview to its OWN contract, so set both here for this two-position case).
    mockPreviewPositions.mockResolvedValue(
      previewOf([
        { symbol: 'AAPL', optionType: 'call', strike: 100, expiration: '2024-06-05' },
        { symbol: 'MSFT', optionType: 'call', strike: 100, expiration: '2024-06-05' },
      ]),
    );
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: { side: 'call', strike: 100, mark: 5 },
        MSFT: { side: 'call', strike: 100, mark: 5 },
      }) as never,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockImplementationOnce(async () => {
      // Simulate the user engaging the kill switch while the FIRST position's
      // closing order is still in flight (the same real-world timing this
      // loop awaits real broker round-trips between positions for).
      setAutotradeConfig({ killSwitch: true });
      return { ok: true, orderId: 'WB-EXIT-A' };
    });

    const outcomes = await checkLiveOptionsExits();

    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.symbol === 'AAPL')?.requested).toBe(true); // placed before the kill switch was engaged
    const msft = outcomes.find((o) => o.symbol === 'MSFT');
    expect(msft?.requested).toBe(false); // blocked, not placed after the kill switch was engaged
    expect(msft?.reason).toMatch(/kill_switch/);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1); // MSFT never reached the broker at all
  });
});

describe('reconcileLiveOptionsOrders', () => {
  it('returns nothing when no liveAccountId is configured', async () => {
    setAutotradeConfig({ liveAccountId: null });
    expect(await reconcileLiveOptionsOrders()).toEqual([]);
    expect(mockOrderStatus).not.toHaveBeenCalled();
  });

  it('materializes a filled entry into a real live options position and links the metadata row', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-R1' });

    const sig = optionSignal();
    await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    const intentId = listIntents()[0].id;
    // Mock the contract count actually ORDERED — a broker cannot fill more than
    // was ordered, and reconcile now (correctly) refuses to book a fill that
    // claims otherwise rather than inflating the position.
    const orderedQty = listIntents()[0].quantity;

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: orderedQty,
      filledPrice: 4.1,
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOptionsOrders();
    expect(outcomes).toEqual([{ intentId, symbol: 'AAPL', changed: true, action: 'entry_filled' }]);

    const positions = listOpenLiveOptionsPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: 'AAPL',
      kind: 'single_leg',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      entryPrice: 4.1,
      quantity: orderedQty,
    });
    expect(getLiveOptionsOrder(intentId)?.positionId).toBe(positions[0].id);
  });

  it('materializes a filled exit by closing the referenced position, journaling the realized pnl', async () => {
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05', entryPrice: 3, quantity: 2 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-R2' });
    await checkLiveOptionsExits();
    const exitIntentId = listPendingLiveOptionsOrders().find((o) => o.role === 'exit')!.intentId;

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 2,
      filledPrice: 4.75,
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOptionsOrders();
    expect(outcomes).toEqual([{ intentId: exitIntentId, symbol: 'AAPL', changed: true, action: 'exit_filled' }]);
    expect(getLiveOptionsPosition(pos.id)).toMatchObject({
      status: 'closed',
      exitPrice: 4.75,
      exitReason: 'time_exit',
    });

    const closedEvent = listAutotradeEvents({}).find((e) => e.action === 'live_options_position_closed')!;
    // (4.75 - 3) * 2 * 100 = 350
    expect(JSON.parse(closedEvent.detail!)).toMatchObject({ exitPrice: 4.75, pnl: 350 });
  });

  it('materializes a MANUALLY-triggered exit with exitReason "manual", not the time_exit fallback above', async () => {
    // Regression coverage for the exit_reason column threaded through
    // db/autotradeLiveOptionsOrders.ts (2026-07-16): a human clicking "close"
    // on the Auto page goes through closeLiveOptionsAutotradePosition (the
    // SAME production entrypoint the route uses), not checkLiveOptionsExits'
    // own automatic trigger above — so the exit row it registers carries
    // exitReason: 'manual', and that value must survive all the way through
    // to the closed position's own stored field, not silently fall back to
    // materializeOptionsExitFill's 'time_exit' default (which exists only for
    // pre-migration rows that predate this column).
    setAutotradeConfig(liveConfig());
    setTradingConfig({
      enabled: true,
      killSwitch: false,
      maxOrderUsd: 100_000,
      maxExposureUsd: 100_000,
      maxSymbolPositionQty: 10_000,
      maxDailyLossUsd: 100_000,
    });
    const pos = openLivePosition({ expiration: '2030-01-18', entryPrice: 3, quantity: 2 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-MANUAL-1' });

    const closeResult = await closeLiveOptionsAutotradePosition(pos, 'ACC1', `SELL ${pos.quantity} AAPL`);
    expect(closeResult.placed).toBe(true);

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 2,
      filledPrice: 4.5,
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOptionsOrders();
    expect(outcomes.some((o) => o.action === 'exit_filled')).toBe(true);
    expect(getLiveOptionsPosition(pos.id)).toMatchObject({ status: 'closed', exitReason: 'manual' });
  });

  it('reports no change when the broker status has not moved', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-R3' });
    const sig = optionSignal();
    await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());

    mockOrderStatus.mockResolvedValue({ ok: true, found: true, status: 'WORKING' } as WebullOrderStatus);
    const outcomes = await reconcileLiveOptionsOrders();
    expect(outcomes[0].changed).toBe(false);
    expect(listOpenLiveOptionsPositions()).toEqual([]);
  });

  it('RETRIES a filled exit whose close threw on the first pass, instead of stranding the position forever', async () => {
    // Regression (hardening audit): reconcile transitioned the exit intent to
    // the terminal 'filled' state and then materialized the close in the SAME
    // pass. If closeLiveOptionsPosition() threw after that terminal transition
    // committed, the old isTerminal() short-circuit skipped the row on every
    // later pass — the position stayed 'open' in our ledger forever while flat
    // at the broker (polluting open-risk/budget, blocking new positions on the
    // symbol). Equity's exit path already retries; options now does too.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05', entryPrice: 3, quantity: 2 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-RETRY' });
    await checkLiveOptionsExits();
    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 2,
      filledPrice: 4.75,
    } as WebullOrderStatus);

    // First pass: the close throws AFTER the intent has committed to 'filled'.
    const closeSpy = vi.spyOn(liveOptionsPositionsDb, 'closeLiveOptionsPosition').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    const first = await reconcileLiveOptionsOrders();
    expect(first[0].error).toMatch(/failed to materialize/);
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('open'); // NOT closed — the close threw
    expect(listAutotradeEvents({}).some((e) => e.action === 'live_options_materialization_failed')).toBe(true);
    // The exit row is still pending, so it's retryable — not silently dropped.
    expect(listPendingLiveOptionsOrders().some((o) => o.role === 'exit')).toBe(true);

    // Second pass: the spy is exhausted (mockImplementationOnce) so the real
    // close runs. The retry branch must re-attempt it and finally close.
    closeSpy.mockRestore();
    const second = await reconcileLiveOptionsOrders();
    expect(second[0]).toMatchObject({ changed: true, action: 'exit_filled' });
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('closed');
  });
});

function previewOf(
  positions: Array<{
    symbol: string;
    optionType: 'call' | 'put';
    strike: number;
    expiration: string;
    quantity?: number;
  }>,
) {
  return {
    ok: true as const,
    accountId: 'ACC1',
    positions: positions.map((p) => ({
      assetType: 'option' as const,
      symbol: p.symbol,
      side: 'long' as const,
      quantity: p.quantity ?? 999, // held qty; high by default so the exit-qty cap is a no-op unless a test sets it
      entryPrice: 0,
      entryDate: '2024-01-01',
      optionType: p.optionType,
      strike: p.strike,
      expiration: p.expiration,
    })),
    unmapped: 0,
  };
}

function openSpreadPosition(overrides: Partial<Parameters<typeof createLiveOptionsPosition>[0]> = {}) {
  const input = {
    symbol: 'AAPL',
    side: 'call' as const,
    kind: 'debit_spread' as const,
    contractSymbol: 'AAPL-long',
    strike: 100,
    shortContractSymbol: 'AAPL-short',
    shortStrike: 110,
    shortEntryPrice: 1,
    expiration: '2030-01-18',
    quantity: 2,
    entryPrice: 3,
    riskAmount: 400,
    riskProfile: 'MODERATE' as const,
    rationale: 'fixture',
    ...overrides,
  };
  const pos = createLiveOptionsPosition(input);
  // Broker reports the LONG leg held by default (the leg the sell-to-close would
  // short) so the exit-qty cap is a no-op unless a test overrides it.
  mockPreviewPositions.mockResolvedValue(
    previewOf([{ symbol: input.symbol, optionType: input.side, strike: input.strike, expiration: input.expiration }]),
  );
  return pos;
}

describe('syncLiveOptionsPositionsFromBroker', () => {
  it('closes a single-leg position once Webull no longer holds the contract on 2 CONSECUTIVE syncs, pricing the exit from the current quote', async () => {
    const pos = openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'ACC1' });
    mockPreviewPositions.mockResolvedValue(previewOf([])); // broker holds nothing matching
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.5 } }) as never);

    // First miss isn't enough by itself — see the miss-streak debounce
    // describe block below for the flapping bug this guards against.
    const first = await syncLiveOptionsPositionsFromBroker('ACC1');
    expect(first).toMatchObject({ ok: true, checked: 1, closed: 0 });

    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: true, checked: 1, closed: 1, closedSymbols: ['AAPL'] });
    const closedPos = getLiveOptionsPosition(pos.id)!;
    expect(closedPos.status).toBe('closed');
    expect(closedPos.exitPrice).toBe(4.5);
    expect(closedPos.exitReason).toBe('manual'); // closest allowed value; detail.via distinguishes it
    const event = listAutotradeEvents({}).find((e) => e.action === 'live_options_position_closed');
    expect(JSON.parse(event!.detail!)).toMatchObject({ via: 'broker_sync', kind: 'single_leg', exitPrice: 4.5 });
  });

  it('leaves a single-leg position open while Webull still holds the contract', async () => {
    const pos = openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'ACC1' });
    mockPreviewPositions.mockResolvedValue(
      previewOf([{ symbol: 'AAPL', optionType: 'call', strike: 100, expiration: '2030-01-18' }]),
    );

    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: true, checked: 1, closed: 0 });
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
    expect(listAutotradeEvents({}).some((e) => e.action === 'live_options_position_closed')).toBe(false);
  });

  it('leaves a position open (retrying later) when the broker no longer holds it but no current quote can price the exit', async () => {
    openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'ACC1' });
    mockPreviewPositions.mockResolvedValue(previewOf([]));
    mockGetProvider.mockReturnValue(chainsFor({}) as never); // no chain for AAPL -> fetchContractMark throws

    await syncLiveOptionsPositionsFromBroker('ACC1'); // first miss — not confirmed yet, price never even consulted
    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: true, checked: 1, closed: 0 });
  });

  it('closes a debit spread only once BOTH legs are confirmed gone from the broker on 2 consecutive syncs, netting both legs into the exit P&L', async () => {
    const pos = openSpreadPosition({ accountId: 'ACC1' });
    mockPreviewPositions.mockResolvedValue(previewOf([])); // neither leg held
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: [
          { side: 'call', strike: 100, mark: 5 },
          { side: 'call', strike: 110, mark: 1.5 },
        ],
      }) as never,
    );

    await syncLiveOptionsPositionsFromBroker('ACC1'); // first miss — not confirmed yet
    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: true, checked: 1, closed: 1 });
    const closedPos = getLiveOptionsPosition(pos.id)!;
    expect(closedPos.status).toBe('closed');
    expect(closedPos.exitPrice).toBe(5);
    expect(closedPos.shortExitPrice).toBe(1.5);
    // netDebitAtEntry = 3 - 1 = 2; netCreditAtExit = 5 - 1.5 = 3.5; (3.5 - 2) * 2 * 100
    const event = listAutotradeEvents({}).find((e) => e.action === 'live_options_position_closed');
    expect(JSON.parse(event!.detail!)).toMatchObject({ via: 'broker_sync', kind: 'debit_spread', pnl: 300 });
  });

  it('leaves a debit spread open when only ONE leg is missing from the broker — ambiguous, not guessed', async () => {
    const pos = openSpreadPosition({ accountId: 'ACC1' });
    // Only the long leg (100 strike) still shows at the broker; the short
    // (110) doesn't -- a partial mismatch, deliberately left alone rather
    // than treated as evidence the whole spread closed.
    mockPreviewPositions.mockResolvedValue(
      previewOf([{ symbol: 'AAPL', optionType: 'call', strike: 100, expiration: '2030-01-18' }]),
    );

    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: true, checked: 1, closed: 0 });
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
  });

  // Regression for the reported cash/margin account bug (2026-07-17): a
  // position opened under one Webull account must never be closed by a
  // broker-truth sync against a DIFFERENT account, even if that other
  // account genuinely doesn't hold the contract.
  it('does NOT close a live options position that belongs to a DIFFERENT account', async () => {
    const pos = openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'CASH' });
    mockPreviewPositions.mockResolvedValue(previewOf([])); // MARGIN holds nothing — irrelevant, pos lives in CASH

    const result = await syncLiveOptionsPositionsFromBroker('MARGIN');

    expect(result).toMatchObject({ ok: true, checked: 0, closed: 0, closedSymbols: [] });
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
  });

  it('returns ok:false without touching any position when the broker preview itself fails', async () => {
    const pos = openLivePosition({ strike: 100, expiration: '2030-01-18' });
    mockPreviewPositions.mockResolvedValue({
      ok: false,
      accountId: 'ACC1',
      positions: [],
      unmapped: 0,
      error: 'Webull is not configured.',
    });

    const result = await syncLiveOptionsPositionsFromBroker('ACC1');

    expect(result).toMatchObject({ ok: false, checked: 0, closed: 0, error: 'Webull is not configured.' });
    expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
  });

  // Same flapping-close bug as equity's closePositionsFromPreview (see
  // webull_miss_streak's table comment, db/index.ts): a single incomplete/
  // flaky broker preview used to be enough to fabricate a close here too.
  describe('miss-streak debounce (flapping-close bug fix)', () => {
    it('does NOT close on a single missing observation', async () => {
      const pos = openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'ACC1' });
      mockPreviewPositions.mockResolvedValue(previewOf([]));
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.5 } }) as never);

      const result = await syncLiveOptionsPositionsFromBroker('ACC1');

      expect(result).toMatchObject({ ok: true, closed: 0 });
      expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
    });

    it('a confirmed "still held" sync in between resets the streak — a later single miss does not close it', async () => {
      const pos = openLivePosition({ strike: 100, expiration: '2030-01-18', accountId: 'ACC1' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.5 } }) as never);

      mockPreviewPositions.mockResolvedValue(previewOf([])); // miss #1
      await syncLiveOptionsPositionsFromBroker('ACC1');
      expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');

      mockPreviewPositions.mockResolvedValue(
        previewOf([{ symbol: 'AAPL', optionType: 'call', strike: 100, expiration: '2030-01-18' }]),
      ); // confirmed held
      await syncLiveOptionsPositionsFromBroker('ACC1');
      expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');

      mockPreviewPositions.mockResolvedValue(previewOf([])); // miss #1 again (streak was reset)
      const result = await syncLiveOptionsPositionsFromBroker('ACC1');
      expect(result).toMatchObject({ closed: 0 });
      expect(getLiveOptionsPosition(pos.id)!.status).toBe('open');
    });
  });
});

// ---------------------------------------------------------------------------
// Partial fills on the live OPTIONS path. Same shape as equity's, with the same
// sharp edge — a cancelled intent leaves listPendingLiveOptionsOrders() for
// good — but a different write shape: autotrade_live_options_positions holds
// ONE row per entry order, so later instalments blend into it.
// ---------------------------------------------------------------------------
describe('reconcileLiveOptionsOrders — partial fills', () => {
  async function placeEntry() {
    // Probation off, so the order carries enough contracts for a fill to be
    // split — with the default halving it sizes to a single contract, and a
    // one-contract order can't demonstrate a partial at all.
    const cfg = liveConfig({ liveOptionsProbationTrades: 0 });
    setAutotradeConfig(cfg);
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-OP1' });
    const sig = optionSignal();
    await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', cfg);
    const intentId = listIntents()[0].id;
    return { intentId, orderedQty: listIntents()[0].quantity };
  }

  const brokerSays = (status: string, filledQty: number, filledPrice: number) =>
    mockOrderStatus.mockResolvedValue({ ok: true, found: true, status, filledQty, filledPrice } as WebullOrderStatus);

  it('opens a position on a partially-filled contract count', async () => {
    const { orderedQty } = await placeEntry();
    expect(orderedQty).toBeGreaterThan(1); // the split below is only meaningful with room
    brokerSays('PARTIAL_FILLED', 1, 4.1);

    await reconcileLiveOptionsOrders();

    const open = listOpenLiveOptionsPositions();
    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(1);

    // A later instalment BLENDS into that same row — this table holds one
    // position per entry order, so a second row would have nothing to link it.
    brokerSays('FILLED', orderedQty, (1 * 4.1 + (orderedQty - 1) * 4.5) / orderedQty);
    await reconcileLiveOptionsOrders();

    const after = listOpenLiveOptionsPositions();
    expect(after).toHaveLength(1);
    expect(after[0].quantity).toBe(orderedQty);
    expect(after[0].entryPrice).toBeCloseTo((1 * 4.1 + (orderedQty - 1) * 4.5) / orderedQty, 4);
  });

  it('keeps an AMBIGUOUS options placement pending, and reconcile retires it if it never landed', async () => {
    // Same hazard as equity: a lost response is indistinguishable from a
    // rejection, and marking it terminal drops the intent out of the pending
    // set and the double-open guard, so the next cycle re-places the same real
    // order. The row is recorded even on an unknown outcome so it stays
    // pollable and keeps blocking a duplicate.
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Request timed out', ambiguous: true });

    const sig = optionSignal();
    const res = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    expect(res.ok).toBe(false);
    expect(res.reason ?? '').toMatch(/unknown/i);
    expect(listPendingLiveOptionsOrders()).toHaveLength(1);

    // A second cycle must not place another real order for the same symbol.
    mockPlaceOrder.mockClear();
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-DUP' });
    await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    expect(mockPlaceOrder).not.toHaveBeenCalled();

    // Broker has no record of it — but it was sent seconds ago, so absence is
    // not yet evidence: retiring now would free the slot the check above just
    // proved is what stops a duplicate real order.
    mockOrderStatus.mockResolvedValue({ ok: true, found: false } as WebullOrderStatus);
    await reconcileLiveOptionsOrders();
    expect(listPendingLiveOptionsOrders()).toHaveLength(1);

    // Once it has been outstanding past the grace period => retire, freeing the slot.
    db.prepare('UPDATE order_intents SET updated_at = ?').run(Date.now() - UNKNOWN_PLACEMENT_RETIRE_GRACE_MS - 1000);
    await reconcileLiveOptionsOrders();
    expect(listPendingLiveOptionsOrders()).toHaveLength(0);
    expect(listOpenLiveOptionsPositions()).toHaveLength(0);
  });

  it('a definite options refusal is still terminal', async () => {
    setAutotradeConfig(liveConfig());
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: false, error: 'Contract not tradable' });

    const sig = optionSignal();
    const res = await attemptLiveOptionsEntry(sig, okResult(sig), 'MODERATE', liveConfig());
    expect(res.reason ?? '').toMatch(/rejected/i);
    expect(listPendingLiveOptionsOrders()).toHaveLength(0);
  });

  it('a partially-filled EXIT shrinks the position instead of closing it', async () => {
    // The bug: the filled quantity was computed and then dropped — the exit
    // path closed the row unconditionally. A 3-contract close filling 1 booked
    // one contract's P&L, marked the position closed, and left the other 2 real
    // contracts with no ledger row: gone from listOpenLiveOptionsPositions, so
    // never re-priced, never re-exited, never reconciled, drifting to expiry.
    setAutotradeConfig(liveConfig());
    const pos = openLivePosition({ expiration: '2024-06-05', quantity: 3 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT1' });
    await checkLiveOptionsExits();
    expect(mockPlaceOrder).toHaveBeenCalled();

    // Only 1 of the 3 contracts fills.
    brokerSays('PARTIAL_FILLED', 1, 3.8);
    await reconcileLiveOptionsOrders();

    const open = listOpenLiveOptionsPositions();
    expect(open).toHaveLength(1); // still tracked
    expect(open[0].id).toBe(pos.id);
    expect(open[0].quantity).toBe(2); // the untouched contracts remain
    expect(open[0].status).toBe('open');
  });

  it('closes the position once the remainder of a partial exit fills', async () => {
    setAutotradeConfig(liveConfig());
    openLivePosition({ expiration: '2024-06-05', quantity: 3 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4 } }) as never);
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-EXIT2' });
    await checkLiveOptionsExits();

    brokerSays('PARTIAL_FILLED', 1, 3.8);
    await reconcileLiveOptionsOrders();
    expect(listOpenLiveOptionsPositions()[0].quantity).toBe(2);

    brokerSays('FILLED', 3, 3.8);
    await reconcileLiveOptionsOrders();
    expect(listOpenLiveOptionsPositions()).toHaveLength(0); // now genuinely closed
  });

  it('books a partial the broker reports as CANCELLED in one shot', async () => {
    // Booking on STATUS rather than reported quantity would lose these
    // contracts permanently — the intent is terminal, so it never returns to
    // the pending set.
    const { intentId } = await placeEntry();
    brokerSays('CANCELLED', 1, 4.25);

    await reconcileLiveOptionsOrders();

    const open = listOpenLiveOptionsPositions();
    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(1);
    expect(open[0].entryPrice).toBeCloseTo(4.25);
    expect(listPendingLiveOptionsOrders().some((o) => o.intentId === intentId)).toBe(false);
  });

  it('does not open a second position when the same fill is seen twice', async () => {
    await placeEntry();
    brokerSays('PARTIAL_FILLED', 1, 4.1);
    await reconcileLiveOptionsOrders();
    await reconcileLiveOptionsOrders();

    expect(listOpenLiveOptionsPositions()).toHaveLength(1);
    expect(listOpenLiveOptionsPositions()[0].quantity).toBe(1);
  });

  it('never opens a position larger than the contract count ordered', async () => {
    const { orderedQty } = await placeEntry();
    brokerSays('FILLED', orderedQty + 5, 4.1);

    await reconcileLiveOptionsOrders();

    const open = listOpenLiveOptionsPositions();
    expect(open[0].quantity).toBe(orderedQty);
    expect(open[0].entryPrice).toBeCloseTo(4.1); // average, not an inflated slice price
  });
});

describe('checkLiveOptionsExits — price-based exits (2026-07-26)', () => {
  // Every position here expires 2030-01-18 (openLivePosition's default), so
  // the always-on time exit can never be what fires — any trigger observed
  // is the stop-loss/take-profit path under test.

  it('places a stop-loss close when unrealized loss reaches optionsStopLossPct, and records the reason', async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50 }));
    const pos = openLivePosition({ entryPrice: 3 });
    // mark 1.4 → (1.4 - 3) / 3 = -53.3% ≤ -50% → stop fires
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.4 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SL-1' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(getLiveOptionsOrder(outcomes[0].intentId!)).toMatchObject({
      role: 'exit',
      positionId: pos.id,
      exitReason: 'stop_loss',
    });
    const placedEvent = listAutotradeEvents({}).find((e) => e.action === 'live_options_exit_placed')!;
    expect(JSON.parse(placedEvent.detail!)).toMatchObject({ exitReason: 'stop_loss' });
  });

  it('places a take-profit close when unrealized gain reaches optionsTakeProfitPct', async () => {
    setAutotradeConfig(liveConfig({ optionsTakeProfitPct: 80 }));
    const pos = openLivePosition({ entryPrice: 3 });
    // mark 5.5 → (5.5 - 3) / 3 = +83.3% ≥ +80% → take-profit fires
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5.5 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-TP-1' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(getLiveOptionsOrder(outcomes[0].intentId!)).toMatchObject({ exitReason: 'take_profit' });
  });

  it('fetches a quote but places nothing while the position sits inside both thresholds', async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50, optionsTakeProfitPct: 80 }));
    openLivePosition({ entryPrice: 3 });
    const provider = chainsFor({ AAPL: { side: 'call', strike: 100, mark: 2.7 } }); // -10%: neither rule
    mockGetProvider.mockReturnValue(provider as never);

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toEqual([]);
    expect(provider.getOptionsChain).toHaveBeenCalled(); // price rules DID evaluate
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('never fabricates a trigger when the evaluation quote is unavailable', async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50 }));
    openLivePosition({ entryPrice: 3 });
    mockGetProvider.mockReturnValue({
      getOptionsChain: vi.fn(async () => {
        throw new Error('provider down');
      }),
    } as never);

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes).toEqual([]); // price rules skipped this cycle; far-out expiry means no time exit either
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it('still evaluates off a last-trade-only price — a dying contract with no bid/ask is when the stop matters most', async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50 }));
    const pos = openLivePosition({ entryPrice: 3 });
    // No mark at all — only an old print at 0.9 → -70% → stop fires anyway.
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, last: 0.9 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SL-STALE' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(getLiveOptionsOrder(outcomes[0].intentId!)).toMatchObject({ exitReason: 'stop_loss' });
  });

  it('evaluates a debit spread on its NET basis, and ignores a crossed (non-positive) net quote', async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50 }));
    openLivePosition({
      kind: 'debit_spread',
      contractSymbol: 'AAPL-long',
      strike: 100,
      shortContractSymbol: 'AAPL-short',
      shortStrike: 110,
      entryPrice: 3,
      shortEntryPrice: 1, // entry net basis = 2
    });
    // Crossed/stale legs: net 0.9 - 1.0 <= 0 — would read as < -100% "loss";
    // must be treated as no quote, not a trigger.
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: [
          { side: 'call', strike: 100, mark: 0.9 },
          { side: 'call', strike: 110, mark: 1.0 },
        ],
      }) as never,
    );
    expect(await checkLiveOptionsExits()).toEqual([]);
    expect(mockPlaceOrder).not.toHaveBeenCalled();

    // Real quotes: net 1.6 - 0.8 = 0.8 → (0.8 - 2) / 2 = -60% ≤ -50% → stop fires.
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAPL: [
          { side: 'call', strike: 100, mark: 1.6 },
          { side: 'call', strike: 110, mark: 0.8 },
        ],
      }) as never,
    );
    mockAccountState.mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
    mockAccountType.mockResolvedValue('INDIVIDUAL_MARGIN');
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SL-SPREAD' });

    const outcomes = await checkLiveOptionsExits();
    expect(outcomes[0]).toMatchObject({ symbol: 'AAPL', requested: true });
    expect(getLiveOptionsOrder(outcomes[0].intentId!)).toMatchObject({ kind: 'debit_spread', exitReason: 'stop_loss' });
  });

  it("carries 'stop_loss' all the way onto the closed position once the fill reconciles", async () => {
    setAutotradeConfig(liveConfig({ optionsStopLossPct: 50 }));
    const pos = openLivePosition({ entryPrice: 3, quantity: 2 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.4 } }) as never);
    mockAccountState.mockResolvedValue(
      holdingAccountState(pos.quantity) as Awaited<ReturnType<typeof webullAccountState>>,
    );
    mockPlaceOrder.mockResolvedValue({ ok: true, orderId: 'WB-SL-FILL' });
    await checkLiveOptionsExits();
    const exitIntentId = listPendingLiveOptionsOrders().find((o) => o.role === 'exit')!.intentId;

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 2,
      filledPrice: 1.35,
    } as WebullOrderStatus);

    const outcomes = await reconcileLiveOptionsOrders();
    expect(outcomes).toEqual([{ intentId: exitIntentId, symbol: 'AAPL', changed: true, action: 'exit_filled' }]);
    expect(getLiveOptionsPosition(pos.id)).toMatchObject({
      status: 'closed',
      exitPrice: 1.35,
      exitReason: 'stop_loss',
    });
  });
});
