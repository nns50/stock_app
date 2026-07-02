import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Each stage already has its own dedicated test coverage (screen.ts ->
// autotradeScreen.test.ts, decide.ts -> autotradeDecide.test.ts, execute.ts ->
// autotradeExecute.test.ts, executionGuards.ts -> executionGuards.test.ts) —
// mocked here so these tests exercise ONLY loop.ts's own orchestration:
// stage ordering, the session-window skip, and how the volatility filter
// narrows what reaches Decision.
vi.mock('../src/services/autotrading/screen', () => ({ runAutotradeScreen: vi.fn() }));
vi.mock('../src/services/autotrading/decide', () => ({ runAutotradeDecision: vi.fn() }));
vi.mock('../src/services/autotrading/execute', () => ({ runPaperExecution: vi.fn(), checkPaperExits: vi.fn() }));
vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/executionGuards')>();
  return { ...actual, checkSessionWindow: vi.fn(), getMarketAtrPct: vi.fn() };
});
vi.mock('../src/db/autotradeEvents', () => ({ logAutotradeEvent: vi.fn() }));

import { runAutotradeScreen } from '../src/services/autotrading/screen';
import { runAutotradeDecision } from '../src/services/autotrading/decide';
import { runPaperExecution, checkPaperExits } from '../src/services/autotrading/execute';
import { checkSessionWindow, getMarketAtrPct } from '../src/services/autotrading/executionGuards';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { runAutotradeLoopTick, startAutotradeLoop, stopAutotradeLoop } from '../src/services/autotrading/loop';
import { ScreenCandidate } from '../src/services/autotrading/screen';
import { TradeSignal } from '../src/services/autotrading/decide';
import { initDb } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';

const mockScreen = vi.mocked(runAutotradeScreen);
const mockDecide = vi.mocked(runAutotradeDecision);
const mockExecute = vi.mocked(runPaperExecution);
const mockCheckExits = vi.mocked(checkPaperExits);
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

beforeAll(() => initDb());
beforeEach(() => {
  mockScreen.mockReset();
  mockDecide.mockReset();
  mockExecute.mockReset();
  mockCheckExits.mockReset().mockResolvedValue([]);
  mockSessionWindow.mockReset().mockReturnValue({ ok: true });
  mockMarketAtr.mockReset().mockResolvedValue(2);
  mockLogEvent.mockReset();
  // runAutotradeLoopTick's own enabled/killSwitch gate (unlike everything else
  // in this file) hits the REAL db/autotradeConfig, not a mock — default it to
  // "armed" so existing tests below still exercise the entries path; the
  // gating tests further down override this explicitly.
  setAutotradeConfig({ enabled: true, killSwitch: false });
  stopAutotradeLoop();
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
    expect(mockDecide).toHaveBeenCalledWith([candidate('AAPL', 2)]);
    expect(mockExecute).toHaveBeenCalledWith([{ signal: signal('AAPL') }]);
    expect(summary.ranEntries).toBe(true);
    expect(summary.candidatesScreened).toBe(1);
    expect(summary.candidatesPassedVolatility).toBe(1);
    expect(summary.signalsGenerated).toBe(1);
    expect(summary.entriesOpened).toBe(1);
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

    expect(mockDecide).toHaveBeenCalledWith([candidate('CALM', 2)]); // WILD excluded
    expect(summary.candidatesScreened).toBe(2);
    expect(summary.candidatesPassedVolatility).toBe(1);
    const volEvent = mockLogEvent.mock.calls.find((c) => c[0].action === 'excluded_volatility');
    expect(volEvent?.[0].symbol).toBe('WILD');
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
    expect(mockDecide).toHaveBeenCalledWith([]);
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

  it('still checks exits, but skips new entries, when auto-trading is disabled', async () => {
    setAutotradeConfig({ enabled: false });
    mockCheckExits.mockResolvedValue([{ symbol: 'AAPL', closed: false }]);
    const summary = await runAutotradeLoopTick();
    expect(summary.exitsChecked).toBe(1);
    expect(summary.ranEntries).toBe(false);
    expect(summary.skippedReason).toMatch(/disabled/i);
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
});
