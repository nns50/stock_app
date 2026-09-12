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
  checkLivePerLotSecondLots: vi.fn().mockResolvedValue([]),
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
  // The loop reads this to scope the options seed to the account it trades
  // (2026-09-04 account-scoping fix); neutral here for the same reason.
  getLiveOptionsPortfolioSnapshot: vi.fn(() => ({
    today: '2026-09-04',
    openPositions: [],
    openRisk: 0,
    openPositionsCount: 0,
    dailyPnl: 0,
    consecutiveLosses: 0,
    tradesToday: 0,
  })),
}));
vi.mock('../src/providers/webull/positions', () => ({ runWebullPositionsSync: vi.fn() }));
// Deterministic regime for the at-entry-context threading assertions below —
// the real computeMarketRegime would score MockProvider candles (and scan the
// seeded universe for breadth) inside every loop test.
vi.mock('../src/services/marketRegime', () => ({
  computeMarketRegime: vi.fn(async () => ({ label: 'neutral' })),
}));
// The ML regime reading (services/mlRegime.ts) has its own end-to-end coverage
// (mlRegime.test.ts); here it is a stub the tick mirrors, so the tests below
// assert the WIRING — the summary carries what the read returned, and a read
// that throws costs the tick nothing but a journaled stage failure.
vi.mock('../src/services/mlRegime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/mlRegime')>();
  return { ...actual, getMarketRegime: vi.fn(async () => actual.getMarketRegime({ source: 'off' })) };
});
vi.mock('../src/services/autotrading/moversPromotion', () => ({ processMoversForPromotion: vi.fn() }));
vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/executionGuards')>();
  return { ...actual, checkSessionWindow: vi.fn(), getMarketAtrPct: vi.fn(), getMarketRangePct: vi.fn() };
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
  checkLivePerLotSecondLots,
} from '../src/services/autotrading/liveExecute';
import {
  runLiveOptionsExecution,
  checkLiveOptionsExits,
  reconcileLiveOptionsOrders,
  syncLiveOptionsPositionsFromBroker,
} from '../src/services/autotrading/liveOptionsExecute';
import { runWebullPositionsSync } from '../src/providers/webull/positions';
import { processMoversForPromotion } from '../src/services/autotrading/moversPromotion';
import { checkSessionWindow, getMarketAtrPct, getMarketRangePct } from '../src/services/autotrading/executionGuards';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { runAutotradeLoopTick, startAutotradeLoop, stopAutotradeLoop } from '../src/services/autotrading/loop';
import { getLastTick } from '../src/db/autotradeLastTick';
import { getMarketRegime, MlRegimeReading } from '../src/services/mlRegime';
import { ScreenCandidate } from '../src/services/autotrading/screen';
import { TradeSignal } from '../src/services/autotrading/decide';
import { initDb, db } from '../src/db';
import { addMacroEvent } from '../src/db/macroEvents';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import {
  getDailyBaseline,
  markGiveBackArmed,
  saveDailyBaseline,
  markDailyTargetReached,
} from '../src/db/dailyBaseline';
import { etToday } from '../src/util/marketDate';
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
const mockCheckPerLotSecondLots = vi.mocked(checkLivePerLotSecondLots);
const mockLiveOptionsExecute = vi.mocked(runLiveOptionsExecution);
const mockCheckLiveOptionsExits = vi.mocked(checkLiveOptionsExits);
const mockReconcileLiveOptions = vi.mocked(reconcileLiveOptionsOrders);
const mockOptionsPositionsSync = vi.mocked(syncLiveOptionsPositionsFromBroker);
const mockPositionsSync = vi.mocked(runWebullPositionsSync);
const mockMoversPromotion = vi.mocked(processMoversForPromotion);
const mockSessionWindow = vi.mocked(checkSessionWindow);
const mockMarketAtr = vi.mocked(getMarketAtrPct);
const mockMarketRange = vi.mocked(getMarketRangePct);
const mockLogEvent = vi.mocked(logAutotradeEvent);
const mockGetMarketRegime = vi.mocked(getMarketRegime);

function candidate(symbol: string, atrPct: number | null): ScreenCandidate {
  return {
    symbol,
    direction: 'long' as const,
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
      relVolPace: null,
      avgVolume: null,
      volume: null,
      gapPct: null,
      weeklyMaShort: null,
      symbolLookbackReturnPct: null,
      benchmarkLookbackReturnPct: null,
      sentimentNetScore: null,
    },
    discoverySource: 'universe',
    relVolPace: null,
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
    underlyingPrice: 100,
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

/** What every executor is handed on a tick with nothing known about the regime
 *  (effectiveRisk.ts's NO_TICK_REGIME): the test suite's source is `off`. */
const noRegime = { mlRegime: null, todayRangePct: null, effectiveRegime: 'unknown' };

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  // Test files share ONE SQLite file and run serially (see vitest.config.ts),
  // so a file that ends with a non-default config poisons whichever runs next.
  // liveOptionsExecute's short-dated tests leave optionsMinDte/MaxDte at 0/2,
  // which reached the assertions here as a 0-2 DTE window where 7-60 was
  // expected. Clearing both singletons on entry makes this file independent of
  // whatever ran before it, rather than fixing one leak at its source and
  // waiting for the next.
  db.exec('DELETE FROM autotrade_config');
  // The daily baseline is likewise a persisted singleton, and the banked-day
  // test below marks it reached — sticky by design. Without this every test
  // after it would inherit a halted day and see no entries at all.
  db.exec('DELETE FROM autotrade_daily_baseline');
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
  mockCheckPerLotSecondLots.mockReset().mockResolvedValue([]);
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
  mockMarketRange.mockReset().mockResolvedValue(null);
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

describe('runAutotradeLoopTick — one failing stage must not take down the rest', () => {
  // The tick body is try/finally with NO catch, so before 2026-09-05 a throw in
  // any of the six uncaught stages abandoned everything below it. The six
  // uncaught ones were the worst possible choice: both live reconciles and both
  // live exit sweeps. A better-sqlite3 write error inside the equity time-exit
  // would have skipped the live OPTIONS exit sweep, the equity sync and every
  // entry that tick — and a persistent one would have disabled them
  // indefinitely while the loop still looked like it was running.
  //
  // Exits not running is the worst failure mode this system has: positions sit
  // past the conditions meant to close them, in real money.
  it('still runs the live OPTIONS exit sweep when the equity time exit throws', async () => {
    // Session closed so the tick stops before screening — every exit stage runs
    // BEFORE that gate, which is the contract being checked here.
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    mockCheckLiveTimeExits.mockRejectedValue(new Error('better-sqlite3: database is locked'));
    mockCheckLiveOptionsExits.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();

    expect(mockCheckLiveOptionsExits).toHaveBeenCalledTimes(1);
    expect(summary.liveTimeExitsRequested).toBe(0); // failed stage counts zero, not stale
  });

  it('still reaches the exits when the live order reconcile throws', async () => {
    // Reconcile is the FIRST live stage, so a throw there used to abandon the
    // entire remainder of the tick.
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    mockReconcileLive.mockRejectedValue(new Error('broker payload unparseable'));
    mockCheckLiveOptionsExits.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();

    expect(mockCheckLiveTimeExits).toHaveBeenCalledTimes(1);
    expect(mockCheckLiveOptionsExits).toHaveBeenCalledTimes(1);
    expect(summary.liveOrdersReconciled).toBe(0);
  });

  it('JOURNALS the failure, so a stage failing every tick is not silent', async () => {
    // console.error alone goes to a hosted log nobody reads, which made a stage
    // failing on every tick look exactly like a stage with nothing to do.
    mockSessionWindow.mockReturnValue({ ok: false, reason: 'Market is closed' });
    mockCheckLiveOptionsExits.mockRejectedValue(new Error('boom'));

    await runAutotradeLoopTick();

    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'loop_stage_failed',
        detail: expect.objectContaining({ loopStage: 'live options exits', reason: 'boom' }),
      }),
    );
  });
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    mockMoversPromotion.mockReturnValue({ recorded: ['AAPL'], promoted: ['AAPL'], atCap: [] });

    const summary = await runAutotradeLoopTick();

    expect(summary.moversAutoPromoted).toBe(1);
  });

  // The consumer half of the movers-observability fix (2026-09-02): screen.ts
  // now CARRIES the discovery counts and any fetch error out, but that proves
  // nothing about whether the loop reads them. Zero auto-promotions in 2+
  // weeks was a fetch that worked (35 movers) whose gappers didn't survive
  // screening (1 candidate) — and no vantage point in the app could tell that
  // apart from a broken provider. These assert the pair reaches the summary.
  it('carries the movers fetched-vs-survived pair into the tick summary', async () => {
    // The live shape on 2026-09-02, scaled down: many movers fetched, exactly
    // one of them surviving screening alongside the universe names.
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2), { ...candidate('WETO', 2), discoverySource: 'movers' as const }],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 35, scannedCount: 36, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    mockMoversPromotion.mockReturnValue({ recorded: ['WETO'], promoted: [], atCap: [] });

    const summary = await runAutotradeLoopTick();

    expect(summary.moversDiscovered).toBe(35);
    expect(summary.moversCandidates).toBe(1);
    expect(summary.moversFetchError).toBeNull();
  });

  it('still reports the movers pair when auto-promotion itself throws', async () => {
    // The diagnostic must not go dark in the exact case it exists for.
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [{ ...candidate('WETO', 2), discoverySource: 'movers' as const }],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 35, scannedCount: 36, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    mockMoversPromotion.mockImplementation(() => {
      throw new Error('db is locked');
    });

    const summary = await runAutotradeLoopTick();

    expect(summary.moversAutoPromoted).toBe(0);
    expect(summary.moversDiscovered).toBe(35);
    expect(summary.moversCandidates).toBe(1);
  });

  it('journals movers_fetch_failed once per day and surfaces the reason on the summary', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: 'webull session expired' },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    mockMoversPromotion.mockReturnValue({ recorded: [], promoted: [], atCap: [] });

    const summary = await runAutotradeLoopTick();
    expect(summary.moversFetchError).toBe('webull session expired');

    const failures = () => mockLogEvent.mock.calls.filter((c) => c[0].action === 'movers_fetch_failed');
    expect(failures()).toHaveLength(1);
    expect(failures()[0][0].detail).toMatchObject({ message: 'webull session expired' });

    // The loop runs every 60s; an outage lasting a session would otherwise
    // write ~390 identical rows. The SECOND tick with the same failure must
    // still report it on the summary but must not re-journal it.
    const second = await runAutotradeLoopTick();
    expect(second.moversFetchError).toBe('webull session expired');
    expect(failures()).toHaveLength(1);
  });

  it('defaults moversAutoPromoted to 0 when nothing was promoted this cycle', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(mockDecide).toHaveBeenCalledWith([candidate('AAPL', 2)], {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
      maxStopDistancePct: 0,
    });
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], emptySeed, 2, 'neutral', noRegime);
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    await runAutotradeLoopTick();

    // Not re-fetched a second time for sizing — the SAME reading already
    // computed for the volatility filter is threaded through to execution.
    expect(mockMarketAtr).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], emptySeed, 2, 'neutral', noRegime);
  });

  it('threads the configured screening/decision thresholds through, not the hardcoded legacy defaults', async () => {
    setAutotradeConfig({
      minRelVol: 3,
      minPrice: 5,
      minAvgVolume: 500_000,
      moversDiscoveryEnabled: false,
      minSignalScore: 55,
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    await runAutotradeLoopTick();

    expect(mockSessionWindow).toHaveBeenCalledWith(30);
    expect(mockScreen).toHaveBeenCalledWith({
      config: {
        filters: {
          minRelVol: 3,
          minChangePct: 0,
          minPrice: 5,
          minAvgVolume: 500_000,
          minScore: 55,
          requireWeeklyTrendAlignment: true,
        },
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
        momentumIntradayOnly: false,
        relVolUsePaceScoring: false,
        relVolPaceTarget: 2.5,
        benchmarkSymbol: 'SPY',
        relativeStrengthLookbackDays: 20,
      },
      earningsBlackoutDays: 0,
      minRelVolPace: 0,
      directionMode: 'long',
      moversEnabled: false,
    });
    expect(mockDecide).toHaveBeenCalledWith([candidate('AAPL', 2)], {
      stopAtrMultiple: 2.5,
      targetRMultiple: 3,
      maxStopDistancePct: 0,
    });
  });

  it("threads tradeDirection through to runAutotradeScreen's directionMode", async () => {
    setAutotradeConfig({ tradeDirection: 'both' });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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

  it('mirrors the ML regime reading on the tick summary and the persisted last tick', async () => {
    // The read runs before the entry gates, so even a skipped tick carries it.
    setAutotradeConfig({ enabled: false, liveTradingEnabled: false });
    const reading: MlRegimeReading = {
      regime: 'high_vol_bearish',
      label: 'High Volatility/Bearish',
      candidate: 'high_vol_bearish',
      probabilities: { high_vol_bearish: 0.91, low_vol_bullish: 0.02, sideways: 0.07 },
      predictedNext: null,
      asOf: '2026-09-03',
      etDate: '2026-09-04',
      features: null,
      source: 'fred',
      stale: false,
      drift: false,
      driftScore: -2,
      driftP5: -4.7,
      modelVersion: 'test',
      switched: false,
      heldBelowThreshold: false,
      threshold: 0.6,
      previous: null,
      rows: 250,
      logLikelihood: -70,
      computedAt: 0,
    };
    mockGetMarketRegime.mockResolvedValueOnce(reading);

    const summary = await runAutotradeLoopTick();

    expect(summary.mlRegime).toEqual({
      regime: 'high_vol_bearish',
      label: 'High Volatility/Bearish',
      source: 'fred',
      asOf: '2026-09-03',
      stale: false,
      drift: false,
      probability: 0.91,
    });
    expect(getLastTick()?.summary.mlRegime).toEqual(summary.mlRegime);
  });

  it('hands the executors the ML regime label when the reading is known and fresh, null when stale (2026-09-08)', async () => {
    const reading: MlRegimeReading = {
      regime: 'high_vol_bearish',
      label: 'High Volatility/Bearish',
      candidate: 'high_vol_bearish',
      probabilities: { high_vol_bearish: 0.91, low_vol_bullish: 0.02, sideways: 0.07 },
      predictedNext: null,
      asOf: '2026-09-03',
      etDate: '2026-09-04',
      features: null,
      source: 'fred',
      stale: false,
      drift: false,
      driftScore: -2,
      driftP5: -4.7,
      modelVersion: 'test',
      switched: false,
      heldBelowThreshold: false,
      threshold: 0.6,
      previous: null,
      rows: 250,
      logLikelihood: -70,
      computedAt: 0,
    };
    const screenResult = {
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    };
    mockScreen.mockResolvedValue(screenResult);
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

    mockGetMarketRegime.mockResolvedValueOnce(reading);
    await runAutotradeLoopTick();
    expect(mockExecute).toHaveBeenLastCalledWith([{ signal: signal('AAPL') }], emptySeed, 2, 'neutral', {
      mlRegime: 'high_vol_bearish',
      todayRangePct: null,
      effectiveRegime: 'high_vol_bearish',
    });

    // A stale reading stamps nothing — never a guess.
    mockGetMarketRegime.mockResolvedValueOnce({
      ...reading,
      regime: 'unknown',
      label: 'Unknown',
      stale: true,
      reason: 'stale',
    });
    await runAutotradeLoopTick();
    expect(mockExecute).toHaveBeenLastCalledWith([{ signal: signal('AAPL') }], emptySeed, 2, 'neutral', noRegime);
  });

  it('a shock day promotes the tick to High Vol for every executor and journals market_shock_detected once (2026-09-08)', async () => {
    setAutotradeConfig({ mlRegimeEnabled: true, regimeShockRangeRatio: 1.5, mlRegimeSizeCutPct: 35 });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockMarketAtr.mockResolvedValue(1);
    mockMarketRange.mockResolvedValue(3.2); // 3.2× a normal full day, on a 1.5 ratio

    await runAutotradeLoopTick();
    // The model read nothing (source off) — the nowcast alone makes the tick High Vol,
    // and the executors get the SAME inputs the loop derived it from.
    const promoted = { mlRegime: null, todayRangePct: 3.2, effectiveRegime: 'high_vol_bearish' };
    expect(mockExecute).toHaveBeenLastCalledWith([{ signal: signal('AAPL') }], emptySeed, 1, 'neutral', promoted);
    expect(mockOptionsExecute).toHaveBeenLastCalledWith([], 1, 'neutral', promoted);
    const shocks = () => mockLogEvent.mock.calls.filter((c) => c[0].action === 'market_shock_detected');
    expect(shocks()).toHaveLength(1);
    expect(shocks()[0][0]).toMatchObject({
      stage: 'execution',
      detail: { rangePct: 3.2, marketAtrPct: 1, ratio: 1.5, modelRegime: 'unknown', cutPct: 35 },
    });

    // A second tick the same day is promoted again but journaled once.
    await runAutotradeLoopTick();
    expect(mockExecute).toHaveBeenLastCalledWith([{ signal: signal('AAPL') }], emptySeed, 1, 'neutral', promoted);
    expect(shocks()).toHaveLength(1);

    // With the nowcast off the range is not even fetched, and nothing is promoted.
    setAutotradeConfig({ regimeShockRangeRatio: 0 });
    mockMarketRange.mockClear();
    await runAutotradeLoopTick();
    expect(mockMarketRange).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenLastCalledWith([{ signal: signal('AAPL') }], emptySeed, 1, 'neutral', noRegime);
  });

  it('hands decide the regime-tightened target under a fresh High-Vol reading with the overlay on, and the full one otherwise (2026-09-08)', async () => {
    setAutotradeConfig({ mlRegimeEnabled: true, mlRegimeTargetTightenPct: 30, targetRMultiple: 2 });
    const reading: MlRegimeReading = {
      regime: 'high_vol_bearish',
      label: 'High Volatility/Bearish',
      candidate: 'high_vol_bearish',
      probabilities: { high_vol_bearish: 0.91, low_vol_bullish: 0.02, sideways: 0.07 },
      predictedNext: null,
      asOf: '2026-09-03',
      etDate: '2026-09-04',
      features: null,
      source: 'fred',
      stale: false,
      drift: false,
      driftScore: -2,
      driftP5: -4.7,
      modelVersion: 'test',
      switched: false,
      heldBelowThreshold: false,
      threshold: 0.6,
      previous: null,
      rows: 250,
      logLikelihood: -70,
      computedAt: 0,
    };
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    mockGetMarketRegime.mockResolvedValueOnce(reading);
    await runAutotradeLoopTick();
    expect(mockDecide).toHaveBeenLastCalledWith(expect.anything(), {
      stopAtrMultiple: 1.5,
      maxStopDistancePct: 0,
      targetRMultiple: 1.4,
    });

    // Stale → unknown → the full target.
    mockGetMarketRegime.mockResolvedValueOnce({
      ...reading,
      regime: 'unknown',
      label: 'Unknown',
      stale: true,
      reason: 'stale',
    });
    await runAutotradeLoopTick();
    expect(mockDecide).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ targetRMultiple: 2 }));

    // Overlay off → the full target, whatever the model reads.
    setAutotradeConfig({ mlRegimeEnabled: false });
    mockGetMarketRegime.mockResolvedValueOnce(reading);
    await runAutotradeLoopTick();
    expect(mockDecide).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ targetRMultiple: 2 }));
  });

  it("scales the day's goal by the sizer's own factor, journals once, and freezes once the guard arms (2026-09-08)", async () => {
    setAutotradeConfig({
      mlRegimeEnabled: true,
      mlRegimeSizeCutPct: 35,
      targetDailyGainPct: 3,
      giveBackArmPct: 2,
      giveBackFloorPct: 1,
      accountEquityUsd: 10_000,
    });
    const reading: MlRegimeReading = {
      regime: 'high_vol_bearish',
      label: 'High Volatility/Bearish',
      candidate: 'high_vol_bearish',
      probabilities: { high_vol_bearish: 0.91, low_vol_bullish: 0.02, sideways: 0.07 },
      predictedNext: null,
      asOf: '2026-09-03',
      etDate: '2026-09-04',
      features: null,
      source: 'fred',
      stale: false,
      drift: false,
      driftScore: -2,
      driftP5: -4.7,
      modelVersion: 'test',
      switched: false,
      heldBelowThreshold: false,
      threshold: 0.6,
      previous: null,
      rows: 250,
      logLikelihood: -70,
      computedAt: 0,
    };
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    const scaledEvents = () => mockLogEvent.mock.calls.filter((c) => c[0].action === 'daily_goal_scaled');

    // A fresh High-Vol reading with the overlay on: the goal follows the 35% cut.
    mockGetMarketRegime.mockResolvedValueOnce(reading);
    await runAutotradeLoopTick();
    expect(getDailyBaseline()).toMatchObject({ goalScale: 0.65 });
    expect(getDailyBaseline()?.goalScaleReason).toMatch(/ML regime High Volatility\/Bearish \(35% cut/);
    expect(scaledEvents()).toHaveLength(1);
    expect(scaledEvents()[0][0].detail).toMatchObject({
      factor: 0.65,
      effective: { targetPct: 1.95, giveBackArmPct: 1.3, giveBackFloorPct: 0.65 },
    });

    // Same reading next tick: no second write, no second event.
    mockGetMarketRegime.mockResolvedValueOnce(reading);
    await runAutotradeLoopTick();
    expect(scaledEvents()).toHaveLength(1);

    // The guard arms; a switch to Sideways no longer moves the line.
    markGiveBackArmed(Date.now());
    mockGetMarketRegime.mockResolvedValueOnce({
      ...reading,
      regime: 'sideways',
      label: 'Sideways',
      candidate: 'sideways',
    });
    await runAutotradeLoopTick();
    expect(getDailyBaseline()).toMatchObject({ goalScale: 0.65 });
    expect(scaledEvents()).toHaveLength(1);
  });

  it('leaves the goal unscaled under an unknown reading or with the overlay off (2026-09-08)', async () => {
    setAutotradeConfig({ targetDailyGainPct: 3, accountEquityUsd: 10_000 });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);
    await runAutotradeLoopTick(); // source off -> unknown
    expect(getDailyBaseline()?.goalScale).toBeNull();
    expect(mockLogEvent.mock.calls.some((c) => c[0].action === 'daily_goal_scaled')).toBe(false);
  });

  it('a regime read that throws is journaled as a stage failure and the tick carries null', async () => {
    setAutotradeConfig({ enabled: false, liveTradingEnabled: false });
    mockGetMarketRegime.mockRejectedValueOnce(new Error('FRED is down'));

    const summary = await runAutotradeLoopTick();

    expect(summary.mlRegime).toBeNull();
    const stages = mockLogEvent.mock.calls
      .filter((c) => c[0].action === 'loop_stage_failed')
      .map((c) => (c[0].detail as { loopStage: string }).loopStage);
    expect(stages).toContain('ml regime read');
  });

  it('with the source off (the test suite), the tick reads unknown/source_off without I/O', async () => {
    setAutotradeConfig({ enabled: false, liveTradingEnabled: false });

    const summary = await runAutotradeLoopTick();

    expect(summary.mlRegime).toMatchObject({ regime: 'unknown', source: 'off', probability: null });
  });

  it('runs options paper execution alongside equity, seeding equity with options’ own pre-existing snapshot', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('AAPL', 2)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }], seed, 2, 'neutral', noRegime);
    // ...and options execution runs too, on its own decided signals.
    expect(mockOptionsExecute).toHaveBeenCalledWith([{ signal: optionSignal('AAPL') }], 2, 'neutral', noRegime);
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({
      signals: [
        {
          kind: 'single_leg',
          symbol: 'AAPL',
          side: 'call',
          underlyingPrice: 100,
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
      maxIvRvRatio: 0,
      entryConfig: {
        deltaMin: 0.3,
        deltaMax: 0.6,
        maxSpreadPct: 10,
        minOpenInterest: 100,
        minVolume: 10,
        minDaysToExpiration: 7,
        maxDaysToExpiration: 60,
        ivRankMax: 70,
        ivRankMin: 0,
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 1, scannedCount: 2, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('AAPL'), signal('GME')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    const summary = await runAutotradeLoopTick();

    // Equity decision still sees BOTH candidates — movers are unaffected there.
    expect(mockDecide).toHaveBeenCalledWith([universeCandidate, moverCandidate], {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
      maxStopDistancePct: 0,
    });
    // Options decision sees ONLY the universe-sourced one.
    expect(mockOptionsDecide).toHaveBeenCalledWith([universeCandidate], {
      strategyType: 'single_leg',
      maxIvRvRatio: 0,
      entryConfig: {
        deltaMin: 0.3,
        deltaMax: 0.6,
        maxSpreadPct: 10,
        minOpenInterest: 100,
        minVolume: 10,
        minDaysToExpiration: 7,
        maxDaysToExpiration: 60,
        ivRankMax: 70,
        ivRankMin: 0,
      },
    });
    expect(summary.optionsCandidatesConsidered).toBe(1);
  });

  it("drops an unaffordable underlying before the options decision spends the day's only slot on it", async () => {
    // Task #59. optionsMaxConcurrentPositions is 1, so a candidate whose ATM
    // contract the risk budget cannot buy does not merely waste a chain fetch
    // — it can consume the single options slot on a refusal that was certain
    // before the chain was read. Asserted HERE, at the consumer, and not only
    // in optionsAffordability.test.ts: a filter that computes a verdict and
    // then hands the unfiltered list on anyway passes every unit test it has.
    const cheap = { ...candidate('RIOT', 2), price: 21.91 };
    const dear = { ...candidate('META', 2), price: 650.81 };
    setAutotradeConfig({
      optionsAffordabilityFilterEnabled: true,
      optionsAtmPremiumRatioPct: 1,
      accountEquityUsd: 5137.44,
      riskPerTradePct: 1.25,
      optionsDisasterStopPct: 70,
      methodWeightingEnabled: false,
    });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [cheap, dear],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('RIOT'), signal('META')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'RIOT', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    const summary = await runAutotradeLoopTick();

    // The ceiling is (5137.44 * 1.25 / 100) / 70 = $0.9174 per share, so at a
    // 1% assumed ratio META's $650.81 underlying implies $6.51 and cannot fit;
    // RIOT's $21.91 implies $0.22 and can.
    const optionsArgs = mockOptionsDecide.mock.calls.at(-1)?.[0];
    expect(optionsArgs?.map((c) => c.symbol)).toEqual(['RIOT']);
    expect(summary.optionsCandidatesConsidered).toBe(1);
    // Equity is untouched by the options affordability filter.
    expect(mockDecide).toHaveBeenCalledWith([cheap, dear], {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
      maxStopDistancePct: 0,
    });
  });

  it('leaves the options candidate list alone while the affordability filter is off', async () => {
    const cheap = { ...candidate('RIOT', 2), price: 21.91 };
    const dear = { ...candidate('META', 2), price: 650.81 };
    setAutotradeConfig({
      optionsAffordabilityFilterEnabled: false,
      accountEquityUsd: 5137.44,
    });
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [cheap, dear],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('RIOT'), signal('META')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'RIOT', ok: true }]);
    mockOptionsDecide.mockResolvedValue({ signals: [], skipped: [] });

    const summary = await runAutotradeLoopTick();

    expect(mockOptionsDecide.mock.calls.at(-1)?.[0]?.map((c) => c.symbol)).toEqual(['RIOT', 'META']);
    expect(summary.optionsCandidatesConsidered).toBe(2);
  });

  it('filters out a high-ATR candidate before Decision ever sees it', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('CALM', 2), candidate('WILD', 40)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [signal('CALM')], skipped: [] });
    mockExecute.mockResolvedValue([{ symbol: 'CALM', ok: true }]);

    const summary = await runAutotradeLoopTick();

    expect(mockDecide).toHaveBeenCalledWith(
      [candidate('CALM', 2)], // WILD excluded
      { stopAtrMultiple: 1.5, targetRMultiple: 2, maxStopDistancePct: 0 },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 2, moversCount: 0, scannedCount: 2, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
    });
    mockDecide.mockReturnValue({ signals: [], skipped: [] });
    mockExecute.mockResolvedValue([]);

    const summary = await runAutotradeLoopTick();
    expect(summary.candidatesPassedVolatility).toBe(0);
    expect(mockDecide).toHaveBeenCalledWith([], {
      stopAtrMultiple: 1.5,
      targetRMultiple: 2,
      maxStopDistancePct: 0,
    });
  });

  it('does not throw when a candidate has no computable ATR — it is excluded, not crashed on', async () => {
    mockScreen.mockResolvedValue({
      generatedAt: Date.now(),
      candidates: [candidate('NOATR', null)],
      excluded: [],
      skipped: [],
      errors: [],
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
      rejected: [],
      relVolMedian: null,
      discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
        rejected: [],
        relVolMedian: null,
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
        rejected: [],
        relVolMedian: null,
        discovery: { universeCount: 0, moversCount: 0, scannedCount: 0, moversError: null },
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
        rejected: [],
        relVolMedian: null,
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
      });
      mockDecide.mockReturnValue({ signals: [signal('AAPL')], skipped: [] });
    }

    // The second lot of a per-lot bracketed entry has to be REACHED by the loop.
    // Nothing else calls it, so without this the whole feature could ship,
    // configure, journal its plan and never place a single second order —
    // exactly the shape of the four dead values found on 2026-08-27.
    it('reaches the per-lot second-bracket check whenever live entries are active', async () => {
      setAutotradeConfig({ enabled: false, liveTradingEnabled: true, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      armScreenAndDecide();
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
      mockCheckPerLotSecondLots.mockResolvedValue([{ symbol: 'AAPL', positionId: 7, requested: true, quantity: 5 }]);

      const summary = await runAutotradeLoopTick();

      expect(mockCheckPerLotSecondLots).toHaveBeenCalledTimes(1);
      // And its outcome is CONSUMED, not just produced.
      expect(summary.perLotSecondLotsRequested).toBe(1);
    });

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
      expect(mockLiveExecute).toHaveBeenCalledWith(
        [{ signal: signal('AAPL') }],
        2,
        {
          dailyPnl: 0,
          consecutiveLosses: 0,
          tradesToday: 0,
        },
        'neutral',
        noRegime,
      );
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

    it('journals live_entries_halted when live stands down and paper keeps trading', async () => {
      // skippedReason only fires when NEITHER book is active. When live alone
      // stands down, paper trades and the live path used to journal NOTHING —
      // so the attribution found a paper entry with no live twin and no
      // journal row and filed it under `no_live_row`, "nothing the journal
      // explains". Fourteen of the ninety-seven unexplained entries on the
      // book were this, all on the three days the target banked. Banking the
      // day is the plan's goal, so it must not read as a leak.
      setAutotradeConfig({ enabled: true, liveTradingEnabled: false, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      armScreenAndDecide();
      mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      await runAutotradeLoopTick();

      const rows = vi
        .mocked(logAutotradeEvent)
        .mock.calls.map((c) => c[0])
        .filter((e) => e.action === 'live_entries_halted');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toMatchObject({ refused: 1, reason: 'live_trading_disabled' });
    });

    it('journals nothing when live stands down on a tick with no signals to refuse', async () => {
      // Matched by TIME, so the row has to be per tick — but a row on every
      // empty tick is 300 a day of noise. It mirrors entry_window_closed:
      // only when there was something to refuse.
      setAutotradeConfig({ enabled: true, liveTradingEnabled: false, liveAccountId: 'ACC1' });
      setTradingConfig({ enabled: true, killSwitch: false });
      armScreenAndDecide();
      mockDecide.mockReturnValue({ signals: [], skipped: [] });
      mockExecute.mockResolvedValue([]);

      await runAutotradeLoopTick();

      expect(
        vi
          .mocked(logAutotradeEvent)
          .mock.calls.map((c) => c[0])
          .some((e) => e.action === 'live_entries_halted'),
      ).toBe(false);
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
          rejected: [],
          relVolMedian: null,
          discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
        rejected: [],
        relVolMedian: null,
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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

      expect(mockLiveOptionsExecute).toHaveBeenCalledWith([{ signal: optionSignal('AAPL') }], 2, 'neutral', noRegime);
      expect(summary.liveOptionsEntriesOpened).toBe(1);
    });

    it('halts live OPTIONS entries on a banked day, the same as equity', async () => {
      // Until 2026-08-26 only equity carried the banked-day halt, so a day that
      // had already reached its 3% target kept opening options positions while
      // equity stood down — even though options P&L counts toward that same
      // target and draws on the same risk budget. Latent while contracts were
      // unaffordable on this account; short-dated options make them affordable.
      armLive();
      // PAPER must be on, and that is the whole point rather than a detail. With
      // paper off, a banked day makes liveStillActive false and the tick returns
      // early before options are reached — so the gap is invisible. Paper is the
      // always-on sanity track (it has no real account, so a banked day does not
      // halt it), which is exactly the everyday configuration in which live
      // options kept firing on a day that had already been won.
      setAutotradeConfig({
        enabled: true,
        liveOptionsEnabled: true,
        targetDailyGainPct: 3,
        accountEquityUsd: 2103.43,
      });
      saveDailyBaseline(etToday(), 2103.43);
      markDailyTargetReached(Date.now()); // sticky: the day is banked
      armScreenAndDecide();
      mockExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
      mockLiveExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);
      mockLiveOptionsExecute.mockResolvedValue([{ symbol: 'AAPL', ok: true }]);

      const summary = await runAutotradeLoopTick();

      expect(mockLiveOptionsExecute).not.toHaveBeenCalled();
      expect(mockLiveExecute).not.toHaveBeenCalled(); // equity halts too, as it always did
      expect(mockExecute).toHaveBeenCalled(); // ...but PAPER keeps running, which is why the tick got this far
      expect(summary.liveOptionsEntriesOpened).toBe(0);
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
          rejected: [],
          relVolMedian: null,
          discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
        rejected: [],
        relVolMedian: null,
        discovery: { universeCount: 1, moversCount: 0, scannedCount: 1, moversError: null },
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
