import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({
  webullAccountState: vi.fn(),
  webullAccountType: vi.fn(),
}));
vi.mock('../src/providers/webull/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/orders')>();
  return { ...actual, webullPlaceOrder: vi.fn(), webullOrderStatus: vi.fn() };
});

import { config } from '../src/config';
import { getProvider } from '../src/providers';
import { webullAccountState, webullAccountType } from '../src/providers/webull/accountState';
import { webullPlaceOrder, webullOrderStatus, WebullOrderStatus } from '../src/providers/webull/orders';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { listIntents } from '../src/db/orders';
import { getLiveOptionsOrder, listPendingLiveOptionsOrders } from '../src/db/autotradeLiveOptionsOrders';
import {
  createLiveOptionsPosition,
  getLiveOptionsPosition,
  listOpenLiveOptionsPositions,
} from '../src/db/autotradeLiveOptionsPositions';
import * as liveOptionsPositionsDb from '../src/db/autotradeLiveOptionsPositions';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from '../src/services/autotrading/optionsRiskCheck';
import { RISK_PROFILES } from '../src/services/autotrading/riskProfiles';
import { DebitSpreadOptionsSignal, SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';
import {
  attemptLiveOptionsEntry,
  buildLiveOptionsTradingConfig,
  getOptionsProbationStatus,
  getLiveOptionsPortfolioSnapshot,
  runLiveOptionsExecution,
  checkLiveOptionsExits,
  reconcileLiveOptionsOrders,
} from '../src/services/autotrading/liveOptionsExecute';

const mockGetProvider = vi.mocked(getProvider);
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

type ContractFixture = { side: 'call' | 'put'; strike: number; mark: number };

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
        mark: f.mark,
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
  evaluateOptionsRiskCheck(
    signal,
    {
      equity: 100_000,
      dailyPnl: 0,
      tradesToday: 0,
      consecutiveLosses: 0,
      openRisk: 0,
      openPositionsCount: 0,
      correlatedNotional: 0,
    },
    RISK_PROFILES.MODERATE,
  );

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM trading_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM autotrade_live_options_positions; DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM position_exits; DELETE FROM positions;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true;
  mockGetProvider.mockReset();
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
});

function openLivePosition(overrides: Partial<Parameters<typeof createLiveOptionsPosition>[0]> = {}) {
  return createLiveOptionsPosition({
    symbol: 'AAPL',
    side: 'call',
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2030-01-18', // comfortably outside the exit window unless overridden
    quantity: 2,
    entryPrice: 3,
    riskAmount: 600,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    ...overrides,
  });
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

    mockOrderStatus.mockResolvedValue({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 2,
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
      quantity: 2,
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
