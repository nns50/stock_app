import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Each stage already has its own dedicated test coverage (screen.ts ->
// autotradeScreen.test.ts, decide.ts -> autotradeDecide.test.ts, execute.ts ->
// autotradeExecute.test.ts, executionGuards.ts -> executionGuards.test.ts) —
// mocked here so these tests exercise ONLY loop.ts's own orchestration:
// stage ordering, the session-window skip, and how the volatility filter
// narrows what reaches Decision.
vi.mock('../src/services/autotrading/screen', () => ({ runAutotradeScreen: vi.fn() }));
vi.mock('../src/services/autotrading/decide', () => ({ runAutotradeDecision: vi.fn() }));
vi.mock('../src/services/autotrading/optionsDecide', () => ({ runOptionsDecision: vi.fn() }));
vi.mock('../src/services/autotrading/execute', () => ({ runPaperExecution: vi.fn(), checkPaperExits: vi.fn() }));
vi.mock('../src/services/autotrading/optionsExecute', () => ({
  runOptionsPaperExecution: vi.fn(),
  checkOptionsPaperExits: vi.fn(),
  getOptionsPaperPortfolioSnapshot: vi.fn(),
  optionsSeedForEquity: vi.fn(),
}));
vi.mock('../src/services/autotrading/liveExecute', () => ({
  runLiveExecution: vi.fn(),
  reconcileLiveOrders: vi.fn(),
  syncAccountEquityFromBroker: vi.fn(),
  checkLiveEquityTimeExits: vi.fn(),
  checkLiveScaleIns: vi.fn(),
}));
vi.mock('../src/services/autotrading/liveOptionsExecute', () => ({
  runLiveOptionsExecution: vi.fn(),
  checkLiveOptionsExits: vi.fn(),
  reconcileLiveOptionsOrders: vi.fn(),
  syncLiveOptionsPositionsFromBroker: vi.fn(),
  // Cross-seeds the live OPTIONS book's P&L/streak/trade count into the live
  // EQUITY batch's risk gates; neutral here so these tests keep asserting the
  // wiring they are about.
  liveOptionsSeedForEquity: vi.fn(() => ({ dailyPnl: 0, consecutiveLosses: 0, tradesToday: 0 })),
}));
vi.mock('../src/providers/webull/positions', () => ({ runWebullPositionsSync: vi.fn() }));
vi.mock('../src/services/autotrading/moversPromotion', () => ({ processMoversForPromotion: vi.fn() }));
vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/executionGuards')>();
  return { ...actual, checkSessionWindow: vi.fn(), getMarketAtrPct: vi.fn() };
});
vi.mock('../src/db/autotradeEvents', () => ({
  logAutotradeEvent: vi.fn(),
  // maybeAlertLiveOrderFailures (called in the loop tick's finally) reads the
  // journal; no live failures in these tests -> empty -> no alert.
  listAutotradeEvents: vi.fn(() => []),
}));
// maybeAlertDailyDrawdownHalt (also called in the loop tick's finally) reads
// the dashboard snapshot — a real call would pull in execute.ts's own mocked
// (and incomplete) exports via dashboard.ts's own imports. dashboard.ts has
// its own full coverage (autotradeDashboard.test.ts); stubbed here to a
// harmless "no cap configured" shape so these orchestration-focused tests
// don't need to know anything about it.
vi.mock('../src/services/autotrading/dashboard', () => ({
  getAutotradeDashboard: vi.fn(() => ({ equity: null, dailyDrawdownHaltLevel: 0 })),
}));

import { runAutotradeScreen } from '../src/services/autotrading/screen';
import { runAutotradeDecision } from '../src/services/autotrading/decide';
import { runOptionsDecision } from '../src/services/autotrading/optionsDecide';
import { runPaperExecution, checkPaperExits } from '../src/services/autotrading/execute';
import {
  runOptionsPaperExecution,
  checkOptionsPaperExits,
  getOptionsPaperPortfolioSnapshot,
  optionsSeedForEquity,
} from '../src/services/autotrading/optionsExecute';
import {
  runLiveExecution,
  reconcileLiveOrders,
  syncAccountEquityFromBroker,
  checkLiveEquityTimeExits,
  checkLiveScaleIns,
} from '../src/services/autotrading/liveExecute';
import {
  runLiveOptionsExecution,
  checkLiveOptionsExits,
  reconcileLiveOptionsOrders,
  syncLiveOptionsPositionsFromBroker,
} from '../src/services/autotrading/liveOptionsExecute';
import { runWebullPositionsSync } from '../src/providers/webull/positions';
import { processMoversForPromotion } from '../src/services/autotrading/moversPromotion';
import { checkSessionWindow, getMarketAtrPct } from '../src/services/autotrading/executionGuards';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { runAutotradeLoopTick, startAutotradeLoop, stopAutotradeLoop } from '../src/services/autotrading/loop';
import { getLastTick } from '../src/db/autotradeLastTick';
import { ScreenCandidate } from '../src/services/autotrading/screen';
import { TradeSignal } from '../src/services/autotrading/decide';
import { initDb, db } from '../src/db';
import { addMacroEvent } from '../src/db/macroEvents';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { config } from '../src/config';

const mockScreen = vi.mocked(runAutotradeScreen);
const mockDecide = vi.mocked(runAutotradeDecision);
const mockOptionsDecide = vi.mocked(runOptionsDecision);
const mockExecute = vi.mocked(runPaperExecution);
const mockCheckExits = vi.mocked(checkPaperExits);
const mockOptionsExecute = vi.mocked(runOptionsPaperExecution);
const mockCheckOptionsExits = vi.mocked(checkOptionsPaperExits);
const mockGetOptionsSnapshot = vi.mocked(getOptionsPaperPortfolioSnapshot);
const mockOptionsSeed = vi.mocked(optionsSeedForEquity);
const mockLiveExecute = vi.mocked(runLiveExecution);
const mockReconcileLive = vi.mocked(reconcileLiveOrders);
const mockSyncEquity = vi.mocked(syncAccountEquityFromBroker);
const mockCheckLiveTimeExits = vi.mocked(checkLiveEquityTimeExits);
const mockCheckLiveScaleIns = vi.mocked(checkLiveScaleIns);
const mockLiveOptionsExecute = vi.mocked(runLiveOptionsExecution);
const mockCheckLiveOptionsExits = vi.mocked(checkLiveOptionsExits);
const mockReconcileLiveOptions = vi.mocked(reconcileLiveOptionsOrders);
const mockOptionsPositionsSync = vi.mocked(syncLiveOptionsPositionsFromBroker);
const mockPositionsSync = vi.mocked(runWebullPositionsSync);
const mockMoversPromotion = vi.mocked(processMoversForPromotion);
const mockSessionWindow = vi.mocked(checkSessionWindow);
const mockMarketAtr = vi.mocked(getMarketAtrPct);
const mockLogEvent = vi.mocked(logAutotradeEvent);

function candidate(symbol: string, atrPct: number | null): ScreenCandidate {
  return {
    symbol,
    price: 100,
    total: 70,
    passedFilters: true,
    filterReasons: [],
    components: [],
    indicators: {
      price: 100,
      changePct: 0,
      maShort: null,
      maLong: null,
      distShortPct: null,
      distLongPct: null,
      rsi: null,
      atr: 2,
      atrPct,
      relVolume: null,
      avgVolume: null,
      volume: null,
      gapPct: null,
    },
    discoverySource: 'universe',
  };
}

function signal(symbol: string): TradeSignal {
  return { symbol, side: 'buy', entry: 100, stop: 95, target: 110, rMultiple: 2, rationale: 'fixture', score: 70 };
}

function optionSignal(symbol: string) {
  return {
    kind: 'single_leg' as const,
    symbol,
    side: 'call' as const,
    contractSymbol: `${symbol}-fixture`,
    strike: 100,
    expiration: '2024-02-01',
    dte: 14,
    premium: 3,
    delta: 0.4,
    ivRank: 50,
    maxLossPerContract: 300,
    rationale: 'fixture',
    score: 70,
  };
}

const emptyOptionsSnapshot = {
  today: '2024-01-01',
  openPositions: [],
  openRisk: 0,
  openPositionsCount: 0,
  dailyPnl: 0,
  consecutiveLosses: 0,
  tradesToday: 0,
};

const emptySeed = {
  openRisk: 0,
  openPositionsCount: 0,
  dailyPnl: 0,
  consecutiveLosses: 0,
  tradesToday: 0,
  positions: [],
};

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  mockScreen.mockReset();
  mockDecide.mockReset();
  mockOptionsDecide.mockReset().mockResolvedValue({ signals: [], skipped: [] });
  mockExecute.mockReset();
  mockCheckExits.mockReset().mockResolvedValue([]);
  mockOptionsExecute.mockReset().mockResolvedValue([]);
  mockCheckOptionsExits.mockReset().mockResolvedValue([]);
  mockGetOptionsSnapshot.mockReset().mockReturnValue(emptyOptionsSnapshot);
  mockOptionsSeed.mockReset().mockReturnValue(emptySeed);
  mockLiveExecute.mockReset();
  mockReconcileLive.mockReset().mockResolvedValue([]);
  mockCheckLiveTimeExits.mockReset().mockResolvedValue([]);
  mockCheckLiveScaleIns.mockReset().mockResolvedValue([]);
  mockSyncEquity.mockReset().mockResolvedValue({ ok: false, error: 'No liveAccountId configured' });
  mockPositionsSync.mockReset().mockResolvedValue({
    ok: true,
    accountId: 'ACC1',
    closed: 0,
    closedSymbols: [],
    imported: 0,
    skipped: 0,
    unmapped: 0,
  });
  mockLiveOptionsExecute.mockReset();
  mockCheckLiveOptionsExits.mockReset().mockResolvedValue([]);
  mockReconcileLiveOptions.mockReset().mockResolvedValue([]);
  mockOptionsPositionsSync.mockReset().mockResolvedValue({ ok: true, checked: 0, closed: 0, closedSymbols: [] });
  mockMoversPromotion.mockReset().mockReturnValue({ recorded: [], promoted: [], atCap: [] });
  mockSessionWindow.mockReset().mockReturnValue({ ok: true });
  mockMarketAtr.mockReset().mockResolvedValue(2);
  mockLogEvent.mockReset();
  // runAutotradeLoopTick's own gates (unlike everything else in this file)
  // hit the REAL db/autotradeConfig and db/trading, not a mock — default to
  // "paper armed, live untouched/off" so existing tests below still exercise
  // the paper entries path; the gating tests further down override
  // explicitly. liveTradingEnabled/liveAccountId/liveOptionsEnabled/
  // optionsStrategyType are reset every test (not just left to their previous
  // test's value) since, unlike enabled/killSwitch, nothing else in this
  // shared beforeEach was resetting them — optionsStrategyType specifically
  // was a confirmed, reproduced flake: setAutotradeConfig() only PATCHES the
  // fields given, so a DIFFERENT test file (dbAutotradeConfig.test.ts,
  // routes.integration.test.ts) setting optionsStrategyType: 'debit_spread'
  // and never resetting it back leaks into whichever test here runs next in
  // the shared on-disk SQLite file, depending on vitest's file execution
  // order (confirmed non-alphabetical, not something to rely on staying
  // "before" this file).
  setAutotradeConfig({
    enabled: true,
    killSwitch: false,
    liveTradingEnabled: false,
    liveAccountId: null,
    liveOptionsEnabled: false,
    optionsStrategyType: 'single_leg',
    // Same reasoning as optionsStrategyType above — a test further down that
    // sets one of these to something non-default (to prove it's threaded
    // through, not hardcoded) would otherwise leak into every test that runs
    // after it in this file.
    minRelVol: 1.5,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    stopAtrMultiple: 1.5,
    targetRMultiple: 2,
    sessionBufferMinutes: 15,
    macroEventBlackoutHours: 0,
  });
  setTradingConfig({ enabled: false, killSwitch: false });
  config.trading.placeEnabled = true; // env master gate ON — see placeOrder.test.ts's own convention
  db.exec('DELETE FROM macro_events'); // checkMacroEventBlackout hits the REAL table, same as the session window
  stopAutotradeLoop();
});
afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

describe('runAutotradeLoopTick', () => {
  it('always checks exits, even when the session window blocks new entries', async () => {
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    const summary = await runAutotradeLoopTick();
    expect(mockCheckExits).toHaveBeenCalledTimes(1);
    expect(summary.exitsChecked).toBe(1);
    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toBe('Market is closed');
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('always checks options exits too, even when the session window blocks new entries', async () => {
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    mockCheckOptionsExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    const summary = await runAutotradeLoopTick();
    expect(mockCheckOptionsExits).toHaveBeenCalledTimes(1);
    expect(summary.optionsExitsChecked).toBe(1);
    expect(summary.optionsExitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(false);
  });

  it('always checks exits, even when a scheduled macro event blocks new entries (checked after the session window)', async () => {
    setAutotradeConfig({ macroEventBlackoutHours: 2 });
    addMacroEvent('FOMC decision', Date.now() + 30 * 60 * 1000); // 30 min out, within the 2h buffer
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    const summary = await runAutotradeLoopTick();
    expect(mockCheckExits).toHaveBeenCalledTimes(1);
    expect(summary.exitsChecked).toBe(1);
    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toMatch(/FOMC decision/);
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('does not block entries when macroEventBlackoutHours is 0 (default), even with a scheduled event', async () => {
    addMacroEvent('FOMC decision', Date.now());
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    const summary = await runAutotradeLoopTick();
    expect(summary.skippedReason).toBeUndefined();
    expect(mockScreen).toHaveBeenCalled();
  });

  it('does not block entries once outside the macro-event buffer window', async () => {
    setAutotradeConfig({ macroEventBlackoutHours: 1 });
    addMacroEvent('FOMC decision', Date.now() + 5 * 60 * 60 * 1000); // 5h out, outside the 1h buffer
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    const summary = await runAutotradeLoopTick();
    expect(summary.skippedReason).toBeUndefined();
    expect(mockScreen).toHaveBeenCalled();
  });

  it('checks the macro-event blackout only after the session window already passed', async () => {
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    setAutotradeConfig({ macroEventBlackoutHours: 2 });
    addMacroEvent('FOMC decision', Date.now());
    const summary = await runAutotradeLoopTick();
    // The session window's OWN reason wins — macro-event blackout is never
    // even evaluated once an earlier gate has already skipped the tick.
    expect(summary.skippedReason).toBe('Market is closed');
  });

  it('always reconciles live orders too, even when neither paper nor live can open new entries', async () => {
    setAutotradeConfig({ enabled: false }); // paper off, live never configured either
    mockReconcileLive.mockResolvedValue([
      { intentId: 1, symbol: 'AAPL', changed: true, action: 'exit_filled' },
      { intentId: 2, symbol: 'MSFT', changed: false },
    ]);
    const summary = await runAutotradeLoopTick();
    expect(mockReconcileLive).toHaveBeenCalledTimes(1);
    expect(summary.liveOrdersReconciled).toBe(2);
    expect(summary.livePositionsClosed).toBe(1);
    expect(summary.ranEntries).toBe(false);
  });

  it('always syncs account equity from the broker too, even when neither paper nor live can open new entries', async () => {
    setAutotradeConfig({ enabled: false }); // paper off, live never configured either
    const summary = await runAutotradeLoopTick();
    expect(mockSyncEquity).toHaveBeenCalledTimes(1);
    // log: false — mark-to-market drifts the balance on nearly every tick, so
    // the automatic sync must not flood Recent Activity with an equity_synced
    // entry every cycle the way the manual "Sync from Webull" button does.
    expect(mockSyncEquity).toHaveBeenCalledWith({ log: false });
    expect(summary.ranEntries).toBe(false);
  });

  it('a broker hiccup during the equity sync does not stop exits, reconcile, or entries from running', async () => {
    mockSyncEquity.mockRejectedValue(new Error('Webull timeout'));
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(true);
    expect(summary.entriesOpened).toBe(1);
  });

  it('backstops reconcileLiveOrders with a live position-truth sync against liveAccountId, every tick', async () => {
    // liveAccountId set but liveTradingEnabled left off — proves this runs
    // independent of whether live entries are actually active, same as the
    // equity sync above (the account id alone is enough; nothing here places
    // an order).
    setAutotradeConfig({ enabled: false, liveAccountId: 'ACC1' });
    const summary = await runAutotradeLoopTick();
    expect(mockPositionsSync).toHaveBeenCalledTimes(1);
    expect(mockPositionsSync).toHaveBeenCalledWith('ACC1');
    expect(summary.ranEntries).toBe(false);
  });

  it('skips the live position-truth sync when no liveAccountId is configured', async () => {
    setAutotradeConfig({ enabled: false }); // default beforeEach state: liveAccountId null
    await runAutotradeLoopTick();
    expect(mockPositionsSync).not.toHaveBeenCalled();
  });

  it('a broker hiccup during the live position-truth sync does not stop exits, reconcile, or entries from running', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockPositionsSync.mockRejectedValue(new Error('Webull timeout'));
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(true);
    expect(summary.entriesOpened).toBe(1);
  });

  it('backstops reconcileLiveOptionsOrders with a live options position-truth sync against liveAccountId, every tick', async () => {
    setAutotradeConfig({ enabled: false, liveAccountId: 'ACC1' });
    const summary = await runAutotradeLoopTick();
    expect(mockOptionsPositionsSync).toHaveBeenCalledTimes(1);
    expect(mockOptionsPositionsSync).toHaveBeenCalledWith('ACC1');
    expect(summary.ranEntries).toBe(false);
  });

  it('skips the live options position-truth sync when no liveAccountId is configured', async () => {
    setAutotradeConfig({ enabled: false });
    await runAutotradeLoopTick();
    expect(mockOptionsPositionsSync).not.toHaveBeenCalled();
  });

  it('a broker hiccup during the live options position-truth sync does not stop exits, reconcile, or entries from running', async () => {
    setAutotradeConfig({ liveAccountId: 'ACC1' });
    mockOptionsPositionsSync.mockRejectedValue(new Error('Webull timeout'));
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(true);
    expect(summary.entriesOpened).toBe(1);
  });

  it('runs the live options position-truth sync before checkLiveOptionsExits, so a just-closed position is not also handed a new exit order', async () => {
    setAutotradeConfig({ enabled: false, liveAccountId: 'ACC1' });
    const callOrder: string[] = [];
    mockOptionsPositionsSync.mockImplementation(async () => {
      callOrder.push('positionsSync');
      return { ok: true, checked: 0, closed: 0, closedSymbols: [] };
    });
    mockCheckLiveOptionsExits.mockImplementation(async () => {
      callOrder.push('checkExits');
      return [];
    });

    await runAutotradeLoopTick();

    expect(callOrder).toEqual(['positionsSync', 'checkExits']);
  });

  it('runs movers auto-promotion right after screening, with the screened candidates and the auto-promote config', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    await runAutotradeLoopTick();

    expect(mockMoversPromotion).toHaveBeenCalledTimes(1);
    expect(mockMoversPromotion).toHaveBeenCalledWith(
      [candidate('AAPL', 2)],
      expect.objectContaining({
        autoPromoteMoversEnabled: true,
        autoPromoteThreshold: 3,
        autoPromoteWindowDays: 10,
        autoPromoteMaxSymbols: 50,
      }),
    );
  });

  it('reflects newly-promoted symbols in the tick summary', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    mockMoversPromotion.mockReturnValue({ recorded: ['AAPL'], promoted: ['AAPL'], atCap: [] });

    const summary = await runAutotradeLoopTick();

    expect(summary.moversAutoPromoted).toBe(1);
  });

  it('defaults moversAutoPromoted to 0 when nothing was promoted this cycle', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();
    expect(summary.moversAutoPromoted).toBe(0);
  });

  it('does not run movers auto-promotion when the session window blocks new entries (screening never happens either)', async () => {
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    await runAutotradeLoopTick();
    expect(mockMoversPromotion).not.toHaveBeenCalled();
  });

  it('a hiccup in movers auto-promotion does not stop exits, decision, or entries from running', async () => {
    mockMoversPromotion.mockImplementation(() => {
      throw new Error('DB write failed');
    });
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(true);
    expect(summary.entriesOpened).toBe(1);
    expect(summary.moversAutoPromoted).toBe(0); // failed silently from the tick's perspective
  });

  it('screens, decides, and executes when the session window is open', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(mockDecide).toHaveBeenCalledWith([candidate('AAPL', 2)], { stopAtrMultiple: 1.5, targetRMultiple: 2 });
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], emptySeed, 2);
    expect(summary.ranEntries).toBe(true);
    expect(summary.candidatesScreened).toBe(1);
    expect(summary.candidatesPassedVolatility).toBe(1);
    expect(summary.signalsGenerated).toBe(1);
    expect(summary.entriesOpened).toBe(1);
  });

  it('fetches the market-ATR% reading exactly once per tick, reusing it for both the volatility hard-cutoff and regime-aware sizing (2026-07-16)', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    await runAutotradeLoopTick();

    // Not re-fetched a second time for sizing — the SAME reading already
    // computed for the volatility filter is threaded through to execution.
    expect(mockMarketAtr).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], emptySeed, 2);
  });

  it('threads the configured screening/decision thresholds through, not the hardcoded legacy defaults', async () => {
    setAutotradeConfig({
      minRelVol: 3,
      requireWeeklyTrendAlignment: true,
      maxTickerAtrPct: 25,
      maxMarketAtrPct: 8,
      stopAtrMultiple: 2.5,
      targetRMultiple: 3,
      sessionBufferMinutes: 30,
    });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    await runAutotradeLoopTick();

    expect(mockSessionWindow).toHaveBeenCalledWith(30);
    expect(mockScreen).toHaveBeenCalledWith({
      config: {
        filters: { minRelVol: 3, requireWeeklyTrendAlignment: true },
        weights: {
          momentum: 30,
          relativeVolume: 20,
          rsi: 15,
          volatility: 10,
          gap: 10,
          trend: 15,
          relativeStrength: 0,
          sentiment: 0,
        },
        benchmarkSymbol: 'SPY',
        relativeStrengthLookbackDays: 20,
      },
      earningsBlackoutDays: 0,
      directionMode: 'long',
    });
    expect(mockDecide).toHaveBeenCalledWith([candidate('AAPL', 2)], { stopAtrMultiple: 2.5, targetRMultiple: 3 });
  });

  it("threads tradeDirection through to runAutotradeScreen's directionMode", async () => {
    setAutotradeConfig({ tradeDirection: 'both' });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    await runAutotradeLoopTick();

    expect(mockScreen).toHaveBeenCalledWith(expect.objectContaining({ directionMode: 'both' }));
  });

  it('persists the completed tick as the "last tick" snapshot, retrievable via getLastTick()', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();
    const last = getLastTick();

    expect(last).not.toBeNull();
    expect(last?.summary).toEqual(summary);
  });

  it('persists a SKIPPED tick too — the skip reason is exactly what a stuck loop needs surfaced', async () => {
    setAutotradeConfig({ enabled: false, liveTradingEnabled: false });

    const summary = await runAutotradeLoopTick();

    expect(summary.skippedReason).toBe('Neither paper nor live auto-trading is active');
    expect(getLastTick()?.summary.skippedReason).toBe('Neither paper nor live auto-trading is active');
  });

  it('runs options paper execution alongside equity, seeding equity with options’ own pre-existing snapshot', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [optionSignal('AAPL')], skipped: [] });
    mockOptionsExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    const optSnapshot = { ...emptyOptionsSnapshot, openRisk: 500 };
    mockGetOptionsSnapshot.mockReturnValue(optSnapshot);
    const seed = { ...emptySeed, openRisk: 500 };
    mockOptionsSeed.mockReturnValue(seed);

    const summary = await runAutotradeLoopTick();

    // Equity's batch is seeded from options' pre-existing snapshot...
    expect(mockOptionsSeed).toHaveBeenCalledWith(optSnapshot);
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], seed, 2);
    // ...and options execution runs too, on its own decided signals.
    expect(mockOptionsExecute).toHaveBeenCalledWith([{ signal: optionSignal('AAPL') }], 2);
    expect(summary.optionsEntriesOpened).toBe(1);
  });

  it('does not run options paper execution when paper is inactive (options has no live path of its own)', async () => {
    setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
    setTradingConfig({ enabled: true, killSwitch: false });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [optionSignal('AAPL')], skipped: [] });

    const summary = await runAutotradeLoopTick();

    expect(mockLiveExecute).toHaveBeenCalledTimes(1); // live still ran
    expect(mockOptionsExecute).not.toHaveBeenCalled(); // but options paper execution did not
    expect(summary.optionsEntriesOpened).toBe(0);
  });

  it('also runs the options decision stage alongside the equity one, on the same volatility-filtered candidates', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({
      signals: [
        {
          kind: 'single_leg',
          symbol: 'AAPL',
          side: 'call',
          contractSymbol: 'AAPL-fixture',
          strike: 100,
          expiration: '2024-02-01',
          dte: 14,
          premium: 3,
          delta: 0.4,
          ivRank: 50,
          maxLossPerContract: 300,
          rationale: 'fixture',
          score: 70,
        },
      ],
      skipped: [],
    });

    const summary = await runAutotradeLoopTick();

    expect(mockOptionsDecide).toHaveBeenCalledWith([candidate('AAPL', 2)], {
      strategyType: 'single_leg',
      entryConfig: {
        deltaMin: 0.3,
        deltaMax: 0.6,
        maxSpreadPct: 10,
        minOpenInterest: 100,
        minVolume: 10,
        minDaysToExpiration: 7,
        maxDaysToExpiration: 60,
        ivRankMax: 70,
      },
    });
    expect(summary.optionsSignalsGenerated).toBe(1);
  });

  it('excludes movers-sourced candidates from the options decision, but not from the equity one', async () => {
    // Webull's premarket movers are essentially a different set of small-caps
    // every day, so a mover-sourced symbol almost never gets screened again —
    // real IV-rank history (one sample per calendar day screened) can never
    // reach the 15 samples the options decision wants for it. Confirmed
    // 2026-07-09 against a real run where every options rejection was
    // mover-shaped. Scoping options to the persistent universe list is where
    // that history can actually compound over time; equity autotrading keeps
    // using movers for momentum/breakout, unaffected.
    const universeCandidate = candidate('AAPL', 2);
    const moverCandidate = { ...candidate('GME', 2), discoverySource: 'movers' as const };
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [universeCandidate, moverCandidate],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 1, scannedCount: 2 },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL'), signal('GME')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    const summary = await runAutotradeLoopTick();

    // Equity decision still sees BOTH candidates — movers are unaffected there.
    expect(mockDecide).toHaveBeenCalledWith([universeCandidate, moverCandidate], {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
    });
    // Options decision sees ONLY the universe-sourced one.
    expect(mockOptionsDecide).toHaveBeenCalledWith([universeCandidate], {
      strategyType: 'single_leg',
      entryConfig: {
        deltaMin: 0.3,
        deltaMax: 0.6,
        maxSpreadPct: 10,
        minOpenInterest: 100,
        minVolume: 10,
        minDaysToExpiration: 7,
        maxDaysToExpiration: 60,
        ivRankMax: 70,
      },
    });
    expect(summary.optionsCandidatesConsidered).toBe(1);
  });

  it('filters out a high-ATR candidate before Decision ever sees it', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('CALM', 2), candidate('WILD', 40)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2 },
    });
    mockDecide.mockReturnValue({ signals: [signal('CALM')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'CALM', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(mockDecide).toHaveBeenCalledWith(
      [candidate('CALM', 2)], // WILD excluded
      { stopAtrMultiple: 1.5, targetRMultiple: 2 },
    );
    expect(summary.candidatesScreened).toBe(2);
    expect(summary.candidatesPassedVolatility).toBe(1);
    const volEvent = mockLogEvent.mock.calls.find((c) => c[0].action === 'excluded_volatility');
    expect(volEvent?.[0].symbol).toBe('WILD');
  });

  it('a raised maxTickerAtrPct lets through a candidate the default 15% would have excluded', async () => {
    setAutotradeConfig({ maxTickerAtrPct: 50 }); // WILD's 40% ATR now clears it
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('CALM', 2), candidate('WILD', 40)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2 },
    });
    mockDecide.mockReturnValue({ signals: [signal('CALM'), signal('WILD')], skipped: [] });
    mockExecute.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();

    expect(summary.candidatesPassedVolatility).toBe(2); // neither excluded this time
    expect(mockLogEvent.mock.calls.some((c) => c[0].action === 'excluded_volatility')).toBe(false);
  });

  it('excludes every candidate when the broad-market proxy is itself too volatile', async () => {
    mockMarketAtr.mockResolvedValue(50); // way above the default 5% cap
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('CALM', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();
    expect(summary.candidatesPassedVolatility).toBe(0);
    expect(mockDecide).toHaveBeenCalledWith([], { stopAtrMultiple: 1.5, targetRMultiple: 2 });
  });

  it('does not throw when a candidate has no computable ATR — it is excluded, not crashed on', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('NOATR', null)],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    const summary = await runAutotradeLoopTick();
    expect(summary.candidatesPassedVolatility).toBe(0);
  });

  it('rejects a second concurrent call while one is already in flight, instead of racing it', async () => {
    // The background scheduler can never overlap its OWN ticks (the next
    // setTimeout is only armed after the current one settles), but the
    // manual "run one cycle now" route calls this same function completely
    // independently — this is the scenario that actually matters.
    let resolveExits!: (v: []) => void;
    const slowExits = new Promise<[]>((resolve) => {
      resolveExits = resolve;
    });
    mockCheckExits.mockReturnValue(slowExits);
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    const firstCall = runAutotradeLoopTick(); // starts, blocks inside checkPaperExits()
    const secondSummary = await runAutotradeLoopTick(); // must return immediately, not wait for the first

    expect(secondSummary.skippedReason).toBe('A cycle is already running');
    expect(secondSummary.exitsChecked).toBe(0);
    expect(mockScreen).not.toHaveBeenCalled(); // never got anywhere near screening

    resolveExits([]); // let the first call proceed to completion
    const firstSummary = await firstCall;
    expect(firstSummary.skippedReason).not.toBe('A cycle is already running');

    // The guard releases once the first call finishes — a THIRD call afterward runs normally.
    mockCheckExits.mockResolvedValue([]);
    const thirdSummary = await runAutotradeLoopTick();
    expect(thirdSummary.skippedReason).not.toBe('A cycle is already running');
  });

  it('still checks exits, but skips new entries, when the kill switch is engaged', async () => {
    // The kill switch's resolved semantics (docs/AUTOTRADING_SPEC.md): halt new
    // entries immediately, but existing positions' stops/targets must remain
    // enforceable — in paper mode this loop IS that enforcement, so exits must
    // never be gated by it.
    setAutotradeConfig({ killSwitch: true });
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: true }]);
    const summary = await runAutotradeLoopTick();
    expect(mockCheckExits).toHaveBeenCalledTimes(1);
    expect(summary.exitsChecked).toBe(1);
    expect(summary.exitsClosed).toBe(1);
    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toMatch(/kill switch/i);
    expect(mockSessionWindow).not.toHaveBeenCalled(); // blocked before even checking the session window
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('still checks exits, but skips new entries, when auto-trading is disabled (and live is not configured either)', async () => {
    setAutotradeConfig({ enabled: false });
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: false }]);
    const summary = await runAutotradeLoopTick();
    expect(summary.exitsChecked).toBe(1);
    expect(summary.ranEntries).toBe(false);
    // Phase 8: the message now covers both paths, since live can be active
    // independently of paper's own `enabled` flag.
    expect(summary.skippedReason).toMatch(/neither paper nor live/i);
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('the kill switch blocks entries even when enabled is also true (kill switch wins)', async () => {
    setAutotradeConfig({ enabled: true, killSwitch: true });
    const summary = await runAutotradeLoopTick();
    expect(summary.skippedReason).toMatch(/kill switch/i);
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('aborts entries if the kill switch is engaged WHILE screening/deciding is still in flight, not just before the cycle starts', async () => {
    // Screening is network-bound (sector classification, market-ATR proxy) and
    // can take meaningful wall-clock time — the initial gate check only
    // protects against the kill switch being engaged before a cycle starts.
    // Simulate it being engaged mid-cycle via a side effect inside the mocked
    // screen call, since that's the earliest point after the initial gate.
    mockScreen.mockImplementation(async () => {
      setAutotradeConfig({ killSwitch: true });
      return {
        generatedAt: Date.now(),
        candidates: [candidate('AAPL', 2)],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
      };
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });

    const summary = await runAutotradeLoopTick();

    expect(mockScreen).toHaveBeenCalledTimes(1); // screening itself wasn't blocked
    expect(mockDecide).toHaveBeenCalledTimes(1); // nor was deciding — both are read-only
    expect(mockExecute).not.toHaveBeenCalled(); // but execution (the write stage) never ran
    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toMatch(/kill switch engaged mid-cycle/i);
    // The numbers from the stages that DID run before the abort are still reported.
    expect(summary.candidatesScreened).toBe(1);
    expect(summary.signalsGenerated).toBe(1);
  });

  it('aborts entries if auto-trading is disabled WHILE screening/deciding is still in flight', async () => {
    mockScreen.mockImplementation(async () => {
      setAutotradeConfig({ enabled: false });
      return {
        generatedAt: Date.now(),
        candidates: [],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 0, moversCount: 0, scannedCount: 0 },
      };
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });

    const summary = await runAutotradeLoopTick();

    expect(mockExecute).not.toHaveBeenCalled();
    expect(summary.skippedReason).toMatch(/disabled mid-cycle/i);
  });

  describe('Phase 8: paper and live execution are independent', () => {
    function armScreenAndDecide() {
      mockScreen.mockResolvedValue({
        generatedAt: Date.now(),
        candidates: [candidate('AAPL', 2)],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
      });
      mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    }

    it('runs live entries when paper is disabled but live is active', async () => {
      setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      armScreenAndDecide();
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockScreen).toHaveBeenCalledTimes(1); // screening ran — live alone was enough to justify it
      expect(mockExecute).not.toHaveBeenCalled(); // paper stayed off
      // Third arg cross-seeds the live OPTIONS book's P&L/streak/trade count
      // into equity's risk gates (mocked neutral above).
      expect(mockLiveExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], 2, {
        dailyPnl: 0,
        consecutiveLosses: 0,
        tradesToday: 0,
      });
      expect(summary.ranEntries).toBe(true);
      expect(summary.entriesOpened).toBe(0);
      expect(summary.liveEntriesOpened).toBe(1);
    });

    it('runs paper entries when live is not configured, without ever calling runLiveExecution', async () => {
      armScreenAndDecide();
      mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockLiveExecute).not.toHaveBeenCalled();
      expect(summary.entriesOpened).toBe(1);
      expect(summary.liveEntriesOpened).toBe(0);
    });

    it('runs BOTH when both are active', async () => {
      setAutotradeConfig({ enabled: true, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      armScreenAndDecide();
      mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockLiveExecute).toHaveBeenCalledTimes(1);
      expect(summary.entriesOpened).toBe(1);
      expect(summary.liveEntriesOpened).toBe(1);
    });

    it("does not activate live just because liveTradingEnabled is true — the human Trade page's own enabled must also be true", async () => {
      setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: false }); // human page's own master switch is off
      const summary = await runAutotradeLoopTick();
      expect(summary.ranEntries).toBe(false);
      expect(mockScreen).not.toHaveBeenCalled();
    });

    it("does not activate live when the human Trade page's OWN kill switch is engaged, even though autotrade's own kill switch is off", async () => {
      setAutotradeConfig({ enabled: false, killSwitch: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: true }); // the shared-broker defense-in-depth default
      const summary = await runAutotradeLoopTick();
      expect(summary.ranEntries).toBe(false);
      expect(mockScreen).not.toHaveBeenCalled();
    });

    it("autotrade's own kill switch blocks BOTH paper and live, not just paper", async () => {
      setAutotradeConfig({ enabled: true, killSwitch: true, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      const summary = await runAutotradeLoopTick();
      expect(summary.ranEntries).toBe(false);
      expect(summary.skippedReason).toMatch(/kill switch/i);
      expect(mockScreen).not.toHaveBeenCalled();
    });

    it('aborts only the LIVE path if live is disabled mid-cycle, while paper — still active — proceeds', async () => {
      setAutotradeConfig({ enabled: true, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      mockScreen.mockImplementation(async () => {
        setAutotradeConfig({ liveTradingEnabled: false }); // live disabled mid-cycle
        return {
          generatedAt: Date.now(),
          candidates: [candidate('AAPL', 2)],
          excluded: [],
          skipped: [],
          errors: [],
          discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
        };
      });
      mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
      mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockExecute).toHaveBeenCalledTimes(1); // paper still ran
      expect(mockLiveExecute).not.toHaveBeenCalled(); // live did not
      expect(summary.ranEntries).toBe(true);
      expect(summary.entriesOpened).toBe(1);
      expect(summary.liveEntriesOpened).toBe(0);
    });
  });

  describe('Task #70: live options is a checkbox nested under the live gate', () => {
    function armLive() {
      setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
    }
    function armScreenAndDecide() {
      mockScreen.mockResolvedValue({
        generatedAt: Date.now(),
        candidates: [candidate('AAPL', 2)],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
      });
      mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
      mockOptionsDecide.mockResolvedValue({ signals: [optionSignal('AAPL')], skipped: [] });
    }

    it('always reconciles live options orders and checks live options exits, even when nothing is active', async () => {
      setAutotradeConfig({ enabled: false }); // paper off, live never configured
      mockReconcileLiveOptions.mockResolvedValue([
        { intentId: 1, symbol: 'AAPL', changed: true, action: 'exit_filled' },
        { intentId: 2, symbol: 'MSFT', changed: false },
      ]);
      mockCheckLiveOptionsExits.mockResolvedValue([{ symbol: 'AAPL', requested: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockReconcileLiveOptions).toHaveBeenCalledTimes(1);
      expect(mockCheckLiveOptionsExits).toHaveBeenCalledTimes(1);
      expect(summary.liveOptionsOrdersReconciled).toBe(2);
      expect(summary.liveOptionsPositionsClosed).toBe(1);
      expect(summary.liveOptionsExitsRequested).toBe(1);
      expect(summary.ranEntries).toBe(false);
    });

    it('does NOT place live options entries just because liveTradingEnabled is true — liveOptionsEnabled must also be true', async () => {
      armLive();
      setAutotradeConfig({ liveOptionsEnabled: false }); // explicit, even though beforeEach already defaults this
      armScreenAndDecide();
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockLiveExecute).toHaveBeenCalledTimes(1); // equity live still ran
      expect(mockLiveOptionsExecute).not.toHaveBeenCalled(); // options live did not
      expect(summary.liveEntriesOpened).toBe(1);
      expect(summary.liveOptionsEntriesOpened).toBe(0);
    });

    it('places live options entries when liveOptionsEnabled is also true, alongside equity live', async () => {
      armLive();
      setAutotradeConfig({ liveOptionsEnabled: true });
      armScreenAndDecide();
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
      mockLiveOptionsExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockLiveOptionsExecute).toHaveBeenCalledWith([{ signal: optionSignal('AAPL') }], 2);
      expect(summary.liveOptionsEntriesOpened).toBe(1);
    });

    it("does not activate live options when the human Trade page's own enabled is off, even with liveOptionsEnabled true", async () => {
      setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1', liveOptionsEnabled: true });
      setTradingConfig({ enabled: false });
      const summary = await runAutotradeLoopTick();
      expect(summary.ranEntries).toBe(false);
      expect(mockLiveOptionsExecute).not.toHaveBeenCalled();
    });

    it('aborts only live options if liveOptionsEnabled is disabled mid-cycle, while equity live — still active — proceeds', async () => {
      armLive();
      setAutotradeConfig({ liveOptionsEnabled: true });
      mockScreen.mockImplementation(async () => {
        setAutotradeConfig({ liveOptionsEnabled: false }); // options disabled mid-cycle
        return {
          generatedAt: Date.now(),
          candidates: [candidate('AAPL', 2)],
          excluded: [],
          skipped: [],
          errors: [],
          discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
        };
      });
      mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
      mockOptionsDecide.mockResolvedValue({ signals: [optionSignal('AAPL')], skipped: [] });
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockLiveExecute).toHaveBeenCalledTimes(1); // equity live still ran
      expect(mockLiveOptionsExecute).not.toHaveBeenCalled(); // options live did not
      expect(summary.ranEntries).toBe(true);
      expect(summary.liveEntriesOpened).toBe(1);
      expect(summary.liveOptionsEntriesOpened).toBe(0);
    });
  });
});

describe('startAutotradeLoop / stopAutotradeLoop', () => {
  it('is idempotent — a second start before stop is a no-op', () => {
    expect(() => {
      startAutotradeLoop();
      startAutotradeLoop();
    }).not.toThrow();
  });

  it('stop clears state so a later start can run again', () => {
    startAutotradeLoop();
    stopAutotradeLoop();
    expect(() => startAutotradeLoop()).not.toThrow();
  });

  it('real cancellation: stopping the loop while a tick is mid-screen aborts that tick before it opens any entries', async () => {
    // Regression for a previously-documented gap: stopAutotradeLoop() used to
    // only reset the tickInFlight flag, which didn't stop a tick already in
    // flight from placing entries anyway. Simulates a stop call landing
    // during the network-bound screen step, mirroring this file's own
    // "gate changing mid-cycle" tests above (mockScreen mutating state from
    // within the mock, not after runAutotradeLoopTick() returns).
    mockScreen.mockImplementation(async () => {
      stopAutotradeLoop();
      return {
        generatedAt: Date.now(),
        candidates: [candidate('AAPL', 2)],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1 },
      };
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toMatch(/loop stopped mid-cycle/i);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(summary.entriesOpened).toBe(0);
  });
});
