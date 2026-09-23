import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { openPaperPosition } from '../src/db/autotradePaperPositions';
import { addSymbols } from '../src/db/universe';
import {
  hasOpenOptionsPaperPosition,
  listOptionsPaperPositions,
  openOptionsPaperPosition,
} from '../src/db/autotradeOptionsPaperPositions';
import * as optionsPaperPositionsDb from '../src/db/autotradeOptionsPaperPositions';
import {
  attemptOptionsPaperEntry,
  checkOptionsPaperExits,
  getOptionsPaperPortfolioSnapshot,
  optionsSeedForEquity,
  runOptionsPaperExecution,
  pendingOptionsPaperExit,
  resetOptionsPaperPendingExits,
} from '../src/services/autotrading/optionsExecute';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from '../src/services/autotrading/optionsRiskCheck';
import { sellableExitLimit } from '../src/services/autotrading/optionsExitPricing';
import { DebitSpreadOptionsSignal, SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';

const mockGetProvider = vi.mocked(getProvider);

function optionSignal(overrides: Partial<SingleLegOptionsSignal> = {}): SingleLegOptionsSignal {
  return {
    kind: 'single_leg',
    symbol: 'AAPL',
    side: 'call',
    underlyingPrice: 100,
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
    underlyingPrice: 100,
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

type ContractFixture = { side: 'call' | 'put'; strike: number; mark: number; bid?: number; ask?: number };

/** Mock provider serving one chain per underlying symbol. Each symbol maps to
 *  either a single contract fixture (the common case) or an array of them
 *  (for a debit spread's long + short strike in the SAME chain) — enough for
 *  every test here. */
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
        bid: f.bid,
        ask: f.ask,
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
    getCandles: vi.fn(async () => []), // no pre-existing correlated positions in most tests -> never called
  };
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_paper_positions; ' +
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM universe;',
  );
  setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  mockGetProvider.mockReset();
  // A decision left resting by one case must not fill in the next.
  resetOptionsPaperPendingExits();
});

/** What a close can be SOLD at off a chain that carries no bid: the mark
 *  buffered 5% and rounded down to the option tick — the same function the
 *  executor prices through, so these cases assert that it is CONSUMED there
 *  (the arithmetic itself is pinned in liveOptionsExecute.test.ts and in the
 *  pricing cases below with literal numbers). */
const sell = (mark: number): number => sellableExitLimit({ mark, fromLastTrade: false }).limitPrice;

/** A rule-driven exit is decided on one tick and filled on the next — see
 *  "HOW A PAPER EXIT IS PRICED" in optionsExecute.ts. Two checks, one result. */
async function decideThenFill() {
  const decided = await checkOptionsPaperExits();
  expect(decided[0]).toMatchObject({ closed: false, pending: true });
  return checkOptionsPaperExits();
}

describe('attemptOptionsPaperEntry', () => {
  const okResult: OptionsRiskCheckResult = evaluateOptionsRiskCheck(optionSignal(), {
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

  it('fills at a freshly-fetched contract mark, not the signal premium', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25 } }) as never);
    const outcome = await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(true);
    expect(outcome.position!.entryPrice).toBe(4.25); // NOT signal.premium (3)
    expect(outcome.position!.status).toBe('open');
    expect(outcome.position!.contractSymbol).toBe('AAPL-fixture');
  });

  it('never fetches a chain or opens anything when the risk check did not pass', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25 } }) as never);
    const blocked: OptionsRiskCheckResult = { ...okResult, ok: false };
    const outcome = await attemptOptionsPaperEntry(optionSignal(), blocked, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
  });

  it('is idempotent — skips an underlying that already has an open options paper position', async () => {
    openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'put',
      contractSymbol: 'AAPL-already-open',
      strike: 90,
      expiration: '2024-05-17',
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25 } }) as never);
    const outcome = await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/already/i);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('reports a chain-fetch failure without crashing or opening a position', async () => {
    mockGetProvider.mockReturnValue({
      getOptionsChain: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    } as never);
    const outcome = await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/provider unavailable/);
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(events[0].action).toBe('options_paper_entry_failed');
  });

  it('reports when the strike is no longer found in a fetched chain', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 105, mark: 1 } }) as never); // different strike
    const outcome = await attemptOptionsPaperEntry(optionSignal({ strike: 100 }), okResult, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no current quote/i);
  });

  it('journals an options_paper_order_placed event', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25 } }) as never);
    await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(events[0].action).toBe('options_paper_order_placed');
    expect(events[0].riskProfile).toBe('MODERATE');
  });

  // THE PAPER BOOK BUYS AT THE ASK (2026-09-18) — the price a buyer pays,
  // through the same helper the live entry is priced with, so the control arm
  // no longer fills at a midpoint nobody is offering. The mark stays the
  // fallback when the quote has no ask, and the row says which it was.
  it('fills at the ask when the chain quotes one, not the midpoint', async () => {
    mockGetProvider.mockReturnValue(
      chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25, bid: 4.1, ask: 4.4 } }) as never,
    );
    const outcome = await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(true);
    expect(outcome.position!.entryPrice).toBe(4.4);
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(JSON.parse(events[0].detail!)).toMatchObject({ entryPrice: 4.4, fillBasis: 'ask', quoteSource: 'chain' });
  });

  it('says the fill was at the mark when the quote has no ask', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.25 } }) as never);
    await attemptOptionsPaperEntry(optionSignal(), okResult, 'MODERATE');
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(JSON.parse(events[0].detail!)).toMatchObject({ entryPrice: 4.25, fillBasis: 'mark', quoteSource: 'chain' });
  });

  describe('debit spreads', () => {
    const spreadOkResult: OptionsRiskCheckResult = evaluateOptionsRiskCheck(spreadSignal(), {
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

    it('opens both legs at freshly-fetched marks, not the signal premiums', async () => {
      expect(spreadOkResult.ok).toBe(true);
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3.5 }, // long leg — NOT signal.longPremium (3)
            { side: 'call', strike: 110, mark: 1.25 }, // short leg — NOT signal.shortPremium (1)
          ],
        }) as never,
      );
      const outcome = await attemptOptionsPaperEntry(spreadSignal(), spreadOkResult, 'MODERATE');
      expect(outcome.ok).toBe(true);
      expect(outcome.position).toMatchObject({
        kind: 'debit_spread',
        contractSymbol: 'AAPL-long',
        strike: 100,
        entryPrice: 3.5,
        shortContractSymbol: 'AAPL-short',
        shortStrike: 110,
        shortEntryPrice: 1.25,
      });
      const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
      expect(events[0]).toMatchObject({ action: 'options_paper_order_placed' });
      expect(JSON.parse(events[0].detail!)).toMatchObject({ kind: 'debit_spread', netDebit: 2.25, fillBasis: 'mark' });
    });

    it('opens the long leg at its ask and the short leg at its bid when the chain quotes them (2026-09-18)', async () => {
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3.5, bid: 3.4, ask: 3.6 },
            { side: 'call', strike: 110, mark: 1.25, bid: 1.2, ask: 1.3 },
          ],
        }) as never,
      );
      const outcome = await attemptOptionsPaperEntry(spreadSignal(), spreadOkResult, 'MODERATE');
      expect(outcome.ok).toBe(true);
      expect(outcome.position).toMatchObject({ entryPrice: 3.6, shortEntryPrice: 1.2 });
      const detail = JSON.parse(listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' })[0].detail!);
      expect(detail).toMatchObject({ kind: 'debit_spread', fillBasis: 'ask', quoteSource: 'chain' });
      expect(detail.netDebit).toBeCloseTo(2.4, 10);
    });

    it('sizes by suggestedContracts (spreads), not suggestedQuantity', async () => {
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3 },
            { side: 'call', strike: 110, mark: 1 },
          ],
        }) as never,
      );
      const outcome = await attemptOptionsPaperEntry(spreadSignal(), spreadOkResult, 'MODERATE');
      expect(outcome.position!.quantity).toBe(
        'suggestedContracts' in spreadOkResult.sizing ? spreadOkResult.sizing.suggestedContracts : NaN,
      );
      expect(outcome.position!.quantity).toBeGreaterThan(0);
    });

    it('rejects the whole entry — no position opened — when only the short leg fails to quote', async () => {
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never); // no strike 110
      const outcome = await attemptOptionsPaperEntry(spreadSignal(), spreadOkResult, 'MODERATE');
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/no current quote/i);
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    });

    it('rejects the entry when the net debit has vanished/inverted between screening and fill', async () => {
      mockGetProvider.mockReturnValue(
        // Short leg now marks HIGHER than long — net debit would be negative.
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 1 },
            { side: 'call', strike: 110, mark: 1.5 },
          ],
        }) as never,
      );
      const outcome = await attemptOptionsPaperEntry(spreadSignal(), spreadOkResult, 'MODERATE');
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/net debit/i);
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    });
  });
});

describe('runOptionsPaperExecution', () => {
  it('approves a clean signal with nothing else open', async () => {
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);
    const outcomes = await runOptionsPaperExecution([{ signal: optionSignal() }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
  });

  it('skips a candidate whose underlying already has an open options paper position', async () => {
    openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-already-open',
      strike: 95,
      expiration: '2024-05-17',
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);
    const outcomes = await runOptionsPaperExecution([{ signal: optionSignal() }]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].reason).toMatch(/already/i);
  });

  it('combines with an already-open EQUITY paper position for max_concurrent_positions (MODERATE caps at 2)', async () => {
    openPaperPosition({
      symbol: 'EQAAA',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'equity fixture',
    });
    mockGetProvider.mockReturnValue(
      chainsFor({
        BBB: { side: 'call', strike: 100, mark: 1 }, // cheap premium -> tiny risk, won't trip aggregate-risk
        CCC: { side: 'call', strike: 100, mark: 1 },
      }) as never,
    );
    const outcomes = await runOptionsPaperExecution([
      { signal: optionSignal({ symbol: 'BBB', contractSymbol: 'BBB-opt' }) },
      { signal: optionSignal({ symbol: 'CCC', contractSymbol: 'CCC-opt' }) },
    ]);
    // 1 equity + BBB = 2 (at the cap, still allowed); 1 equity + BBB + CCC = 3 > 2 -> blocked.
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(outcomes[1].reason).toMatch(/risk check/i);
    const blockedEvent = listAutotradeEvents({ stage: 'risk_check', symbol: 'CCC' })[0];
    // The OPTIONS funnel's own action (task #53): 'blocked' is equity's, and
    // while both wrote it neither funnel's block count could be read alone.
    expect(blockedEvent.action).toBe('options_blocked');
  });

  it('combines with an already-open EQUITY position for max_aggregate_open_risk (MODERATE caps at 2% = $2000)', async () => {
    openPaperPosition({
      symbol: 'EQAAA',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 120,
      riskAmount: 2000, // already AT the 2%-of-$100k cap
      riskProfile: 'MODERATE',
      rationale: 'equity fixture',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);
    const outcomes = await runOptionsPaperExecution([{ signal: optionSignal() }]);
    expect(outcomes[0].ok).toBe(false);
    const blockedEvent = listAutotradeEvents({ stage: 'risk_check', symbol: 'AAPL' })[0];
    const checks = JSON.parse(blockedEvent.detail!).checks as { rule: string; passed: boolean }[];
    expect(checks.find((c) => c.rule === 'max_aggregate_open_risk')?.passed).toBe(false);
  });

  it('threads same-batch approvals into the running risk/count for the NEXT candidate in the same call', async () => {
    // riskPerTradePct/maxAggregateOpenRiskPct set explicitly (matching
    // AGGRESSIVE's OLD preset values) since riskProfile itself no longer
    // implies them — see riskProfiles.ts's header comment.
    setAutotradeConfig({
      riskProfile: 'AGGRESSIVE',
      maxConcurrentPositions: 3,
      riskPerTradePct: 1.5,
      maxAggregateOpenRiskPct: 4.5,
    });
    // 1.5% of $100k = $1500 risk budget/trade; a $10-premium contract ->
    // riskPerUnit = 10*100 = $1000/contract -> suggestedQuantity=1, risk=$1000/contract.
    mockGetProvider.mockReturnValue(
      chainsFor({
        AAA: { side: 'call', strike: 100, mark: 10 },
        BBB: { side: 'call', strike: 100, mark: 10 },
        CCC: { side: 'call', strike: 100, mark: 10 },
      }) as never,
    );
    const sig = (sym: string) => optionSignal({ symbol: sym, contractSymbol: `${sym}-opt`, premium: 10 });
    const outcomes = await runOptionsPaperExecution([
      { signal: sig('AAA') },
      { signal: sig('BBB') },
      { signal: sig('CCC') },
    ]);
    // AGGRESSIVE's aggregate cap is 4.5% = $4500. Two $1000-risk fills = $2000;
    // the third would be $3000, still <= $4500 -> all three should pass, proving
    // the running total is being threaded (not silently over-counted or reset).
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const open = listOptionsPaperPositions({ status: 'open' });
    expect(open).toHaveLength(3);
  });

  it('rejects a candidate whose contract is no longer quotable, without opening a position', async () => {
    mockGetProvider.mockReturnValue(
      chainsFor({
        BAD1: { side: 'call', strike: 999, mark: 1 }, // signal asks for strike 100 -> not found
        OK1: { side: 'call', strike: 100, mark: 3 },
      }) as never,
    );
    const outcomes = await runOptionsPaperExecution([
      { signal: optionSignal({ symbol: 'BAD1', contractSymbol: 'BAD1-opt', strike: 100 }) },
      { signal: optionSignal({ symbol: 'OK1', contractSymbol: 'OK1-opt' }) },
    ]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[1].ok).toBe(true);
    expect(hasOpenOptionsPaperPosition('OK1')).toBe(true);
    expect(hasOpenOptionsPaperPosition('BAD1')).toBe(false);
  });

  it("isolates one candidate's genuine persistence failure — the rest of the batch still runs", async () => {
    mockGetProvider.mockReturnValue(
      chainsFor({ BAD1: { side: 'call', strike: 100, mark: 3 }, OK1: { side: 'call', strike: 100, mark: 3 } }) as never,
    );
    const openSpy = vi.spyOn(optionsPaperPositionsDb, 'openOptionsPaperPosition').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      const outcomes = await runOptionsPaperExecution([
        { signal: optionSignal({ symbol: 'BAD1', contractSymbol: 'BAD1-opt' }) },
        { signal: optionSignal({ symbol: 'OK1', contractSymbol: 'OK1-opt' }) },
      ]);
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].reason).toMatch(/failed to record options paper position/i);
      expect(outcomes[1].ok).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('opens a debit-spread candidate alongside a single-leg one, and its risk carries into the running total', async () => {
    mockGetProvider.mockReturnValue(
      chainsFor({
        SPRD: [
          { side: 'call', strike: 100, mark: 3 },
          { side: 'call', strike: 110, mark: 1 },
        ],
        AAPL: { side: 'call', strike: 100, mark: 3 },
      }) as never,
    );
    const outcomes = await runOptionsPaperExecution([
      { signal: spreadSignal({ symbol: 'SPRD', longContractSymbol: 'SPRD-long', shortContractSymbol: 'SPRD-short' }) },
      { signal: optionSignal({ symbol: 'AAPL' }) },
    ]);
    expect(outcomes[0].ok).toBe(true);
    expect(hasOpenOptionsPaperPosition('SPRD')).toBe(true);
    const [sprd] = listOptionsPaperPositions({ symbol: 'SPRD' });
    expect(sprd).toMatchObject({ kind: 'debit_spread', riskAmount: sprd.quantity * 2 * 100 }); // net debit $2 x contracts x 100
    expect(outcomes[1].ok).toBe(true);
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
  });
});

describe('checkOptionsPaperExits', () => {
  function openPos(overrides: Partial<Parameters<typeof openOptionsPaperPosition>[0]> = {}) {
    return openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      expiration: '2024-06-21',
      quantity: 2,
      entryPrice: 3,
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2024-06-01T15:00:00Z'));
  });

  it('closes a position once days-to-expiration drops to the configured threshold (7d)', async () => {
    // 2024-06-08 anchored at 20:00 UTC is ~7 days from 2024-06-01 15:00 UTC.
    openPos({ expiration: '2024-06-05' }); // comfortably inside the 7-day window
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.1 } }) as never);
    const outcomes = await checkOptionsPaperExits();
    expect(outcomes[0].closed).toBe(true);
    expect(outcomes[0].position!.exitReason).toBe('time_exit');
    // The clock fired, not the mark, so it fills on its own tick — at what
    // the contract can be sold for, never at the midpoint.
    expect(outcomes[0].position!.exitPrice).toBe(sell(1.1));
    expect(outcomes[0].position!.exitFillBasis).toBe('mark');
  });

  it('leaves a position open when comfortably outside the time-exit window', async () => {
    openPos({ expiration: '2024-07-15' }); // ~44 days out
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 5 } }) as never);
    const outcomes = await checkOptionsPaperExits();
    expect(outcomes[0].closed).toBe(false);
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
    expect(mockGetProvider).not.toHaveBeenCalled(); // no quote needed unless the trigger fires
  });

  it('mirrors the trigger correctly for a put', async () => {
    openPos({ side: 'put', expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'put', strike: 100, mark: 0.5 } }) as never);
    const outcomes = await checkOptionsPaperExits();
    expect(outcomes[0].closed).toBe(true);
    expect(outcomes[0].position!.exitPrice).toBe(sell(0.5));
  });

  it('does not close, and reports the reason, when the quote fetch fails after the trigger fires', async () => {
    openPos({ expiration: '2024-06-05' });
    mockGetProvider.mockReturnValue({ getOptionsChain: vi.fn().mockRejectedValue(new Error('timeout')) } as never);
    const outcomes = await checkOptionsPaperExits();
    expect(outcomes[0].closed).toBe(false);
    expect(outcomes[0].reason).toMatch(/timeout/);
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
  });

  it('journals an options_paper_position_closed event with the realized pnl', async () => {
    openPos({ expiration: '2024-06-05', quantity: 2, entryPrice: 3 });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1 } }) as never);
    await checkOptionsPaperExits();
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    const closedEvent = events.find((e) => e.action === 'options_paper_position_closed')!;
    // (0.95 - 3) * 2 * 100 = -410: the fill is the sellable 0.95, the row
    // also says what the rule SAW (the 1.00 mark) and how it filled.
    expect(JSON.parse(closedEvent.detail!)).toMatchObject({
      exitReason: 'time_exit',
      exitPrice: sell(1),
      pnl: (sell(1) - 3) * 200,
      decisionMark: 1,
      fillBasis: 'mark',
      filledOn: 'same_tick',
    });
  });

  it('returns an empty array when nothing is open', async () => {
    expect(await checkOptionsPaperExits()).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  describe('stop-loss / take-profit (2026-07-16)', () => {
    it('closes via stop-loss once unrealized loss reaches the configured %, well outside the time-exit window', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 }); // ~44 days out -- time-exit can't fire
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.4 } }) as never); // -53%
      const outcomes = await decideThenFill();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('stop_loss');
      expect(outcomes[0].position!.exitPrice).toBe(sell(1.4));
    });

    it('closes via take-profit once unrealized gain reaches the configured %, well outside the time-exit window', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.6 } }) as never); // +53%
      const outcomes = await decideThenFill();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('take_profit');
    });

    it('takes profit at the tightened % for a position stamped High Vol with the overlay on, and at the full % otherwise (2026-09-08)', async () => {
      // 50% × (1 − 30%) = 35%: a +40% mark closes a High-Vol-stamped position…
      setAutotradeConfig({ optionsTakeProfitPct: 50, mlRegimeEnabled: true, mlRegimeTargetTightenPct: 30 });
      openPos({ expiration: '2024-07-15', entryPrice: 3, mlRegime: 'high_vol_bearish' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.2 } }) as never); // +40%
      const tightened = await decideThenFill();
      expect(tightened[0].closed).toBe(true);
      expect(tightened[0].position!.exitReason).toBe('take_profit');

      // …and leaves a Sideways-stamped one open at the same mark, whatever today reads.
      db.exec('DELETE FROM autotrade_options_paper_positions');
      openPos({ expiration: '2024-07-15', entryPrice: 3, mlRegime: 'sideways' });
      const untouched = await checkOptionsPaperExits();
      expect(untouched[0]).toMatchObject({ closed: false });
      expect(untouched[0].pending).toBeFalsy();
    });

    it('does not close when unrealized P&L is inside both configured bands', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50, optionsTakeProfitPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.3 } }) as never); // +10%
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(false);
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
    });

    it('fetches a quote every cycle once a price rule is configured, even outside the time-exit window', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.3 } }) as never);
      await checkOptionsPaperExits();
      expect(mockGetProvider).toHaveBeenCalled();
    });

    it('degrades to quote-free time-exit-only evaluation when a price rule is configured but the mark fetch fails, rather than throwing', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 }); // outside the time-exit window too
      mockGetProvider.mockReturnValue({ getOptionsChain: vi.fn().mockRejectedValue(new Error('timeout')) } as never);
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(false);
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
    });
  });

  describe('trailing stop / breakeven / partial profit-taking (2026-07-17)', () => {
    // openPos() defaults: entryPrice 3, quantity 2, expiration far outside any
    // time-exit window unless overridden -> gainPct = (mark - 3) / 3 * 100.

    it('does nothing when all five fields are left at their defaults (0/50)', async () => {
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.3 } }) as never); // +10%
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.stopFloorPct).toBeNull();
      expect(after.quantity).toBe(2);
    });

    it('leaves the floor deferring to the live stop-loss % (stays null) when a plain stop-loss is configured alongside breakeven, but breakeven has not triggered yet', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50, optionsBreakevenTriggerPct: 20 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.3 } }) as never); // +10%, below the 20% breakeven trigger
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.stopFloorPct).toBeNull();
    });

    it('moves the floor to breakeven (0%) once the trigger % is reached', async () => {
      setAutotradeConfig({ optionsBreakevenTriggerPct: 20 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.6 } }) as never); // exactly +20%
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.stopFloorPct).toBe(0);
    });

    it('never loosens an already-ratcheted floor when price pulls back below the trigger (but still above the floor)', async () => {
      setAutotradeConfig({ optionsBreakevenTriggerPct: 20 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.9 } }) as never); // +30% -> ratchets to 0
      await checkOptionsPaperExits();
      expect(listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!.stopFloorPct).toBe(0);

      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.1 } }) as never); // pulls back to ~+3.3%
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(false); // still above the 0% floor
      expect(listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!.stopFloorPct).toBe(0); // unchanged
    });

    it('trails the floor behind the best gain % once past the trailing-start %', async () => {
      setAutotradeConfig({ optionsTrailStartPct: 20, optionsTrailStopPct: 10 });
      const pos = openPos({ expiration: '2024-07-15' });
      // +30% -- comfortably past the 20% trailing-start trigger.
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.9 } }) as never);
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.stopFloorPct).toBe(20); // 30 - 10
    });

    it('ratchets the trailing floor against the best gain seen, not a later (still-above-floor) pullback', async () => {
      setAutotradeConfig({ optionsTrailStartPct: 20, optionsTrailStopPct: 10 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.9 } }) as never); // best +30% -> floor 20%
      await checkOptionsPaperExits();
      expect(listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!.stopFloorPct).toBe(20);

      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.75 } }) as never); // pulls back to +25%, still above the 20% floor
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(false);
      // Best gain stays 30% (never decreases), so the trailing candidate is still 20% either way.
      expect(listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!.stopFloorPct).toBe(20);
    });

    it('closes below the ratcheted floor once price gives back too much', async () => {
      setAutotradeConfig({ optionsTrailStartPct: 20, optionsTrailStopPct: 10 });
      openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.9 } }) as never); // best +30% -> floor 20%
      await checkOptionsPaperExits();

      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.5 } }) as never); // ~+16.7%, below the 20% floor
      const outcomes = await decideThenFill();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('stop_loss');
    });

    it('closes the configured percentage once at the partial-exit trigger, leaving the rest open', async () => {
      setAutotradeConfig({ optionsPartialExitTriggerPct: 20, optionsPartialExitPct: 50 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.6 } }) as never); // exactly +20%
      const outcomes = await checkOptionsPaperExits();

      expect(outcomes[0].closed).toBe(false); // the position itself stays open
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.quantity).toBe(1); // half of 2
      expect(after.partialExitTaken).toBe(true);
      expect(after.status).toBe('open');

      const events = listAutotradeEvents({ symbol: 'AAPL', stage: 'execution' });
      const partial = events.find((e) => e.action === 'options_paper_partial_exit')!;
      // A slice sells at what the contract can be sold for, on its own tick:
      // (3.42 - 3) * 1 * 100 = 42, not the 60 the 3.6 midpoint would claim.
      const detail = JSON.parse(partial.detail!);
      expect(detail).toMatchObject({ quantity: 1, exitPrice: sell(3.6), decisionMark: 3.6, fillBasis: 'mark' });
      expect(detail.pnl).toBeCloseTo((sell(3.6) - 3) * 100, 5);
    });

    it('does not re-fire the partial exit on a later cycle once already taken', async () => {
      setAutotradeConfig({ optionsPartialExitTriggerPct: 20, optionsPartialExitPct: 50 });
      const pos = openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.6 } }) as never);
      await checkOptionsPaperExits();
      expect(listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!.quantity).toBe(1);

      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3.9 } }) as never); // +30%, no other rule configured
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.quantity).toBe(1); // unchanged -- no second partial exit
    });

    it('lets a take-profit hit take priority over breakeven/trailing/partial-exit management', async () => {
      setAutotradeConfig({
        optionsTakeProfitPct: 20,
        optionsBreakevenTriggerPct: 10,
        optionsPartialExitTriggerPct: 10,
        optionsPartialExitPct: 50,
      });
      openPos({ expiration: '2024-07-15' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.5 } }) as never); // +50% -- past every trigger
      const decided = await checkOptionsPaperExits();
      expect(decided[0]).toMatchObject({ closed: false, pending: true });
      // Decided, not managed: no partial fired underneath the resting close.
      expect(listOptionsPaperPositions({ symbol: 'AAPL' })[0].quantity).toBe(2);
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('take_profit');
      expect(outcomes[0].position!.quantity).toBe(2); // the full original size, not partially reduced first
    });
  });

  describe('debit spreads', () => {
    function openSpreadPos(overrides: Partial<Parameters<typeof openOptionsPaperPosition>[0]> = {}) {
      return openOptionsPaperPosition({
        symbol: 'AAPL',
        side: 'call',
        kind: 'debit_spread',
        contractSymbol: 'AAPL-long',
        strike: 100,
        shortContractSymbol: 'AAPL-short',
        shortStrike: 110,
        shortEntryPrice: 1,
        expiration: '2024-06-21',
        quantity: 2,
        entryPrice: 3, // net debit at entry: 3 - 1 = 2
        riskAmount: 400, // 2 spreads x $2 net debit x 100
        riskProfile: 'MODERATE',
        rationale: 'fixture',
        ...overrides,
      });
    }

    it('closes both legs together at the sellable NET once the trigger fires', async () => {
      openSpreadPos({ expiration: '2024-06-05' });
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 8 },
            { side: 'call', strike: 110, mark: 0.5 },
          ],
        }) as never,
      );
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(true);
      // The net (8 - 0.5) buffered 5% is 7.125; roundOptionPrice settles the
      // half-cent to the nearest cent FIRST (sub-cent noise is not a price
      // choice — see optionTick.ts) and only snaps to the nickel below $3, so
      // the sellable net is 7.13. The short leg is stored at its own price and
      // the long at net + short, so the row's exit - shortExit IS the net —
      // one derivation, not two.
      const pos = outcomes[0].position!;
      expect(pos).toMatchObject({ exitReason: 'time_exit', shortExitPrice: 0.5 });
      expect(pos.exitPrice! - pos.shortExitPrice!).toBeCloseTo(7.13, 6);
    });

    it('journals the correct net-debit-based pnl for a closed spread', async () => {
      openSpreadPos({ expiration: '2024-06-05', quantity: 2, entryPrice: 3, shortEntryPrice: 1 });
      // net credit at exit: 8 - 0.5 = 7.5; net debit at entry: 3 - 1 = 2
      // pnl = (7.5 - 2) * 2 * 100 = 1100
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 8 },
            { side: 'call', strike: 110, mark: 0.5 },
          ],
        }) as never,
      );
      await checkOptionsPaperExits();
      const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
      const closedEvent = events.find((e) => e.action === 'options_paper_position_closed')!;
      // Net credit at exit is the SELLABLE net, 7.13 (see the case above):
      // (7.13 - 2) * 2 * 100 = 1026, not the 1100 the midpoints would claim.
      expect(JSON.parse(closedEvent.detail!).pnl).toBeCloseTo(1026, 6);
    });

    it('leaves the whole spread open when only the short leg fails to quote at the trigger', async () => {
      openSpreadPos({ expiration: '2024-06-05' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 8 } }) as never); // no strike 110
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(false);
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
    });

    it('evaluates stop-loss/take-profit against the NET DEBIT, not the long leg premium alone', async () => {
      // Net debit at entry: 3 - 1 = 2. A long-leg-only read of entryPrice=3
      // vs. currentPrice=3.6 would look like a mere +20% (no trigger at a
      // 50% band); the correct net-debit read is entry 2 -> current
      // (3.6 - 0.2) = 3.4, i.e. +70%, past the configured +50% take-profit.
      setAutotradeConfig({ optionsTakeProfitPct: 50 });
      openSpreadPos({ expiration: '2024-07-15', entryPrice: 3, shortEntryPrice: 1 });
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3.6 },
            { side: 'call', strike: 110, mark: 0.2 },
          ],
        }) as never,
      );
      const outcomes = await decideThenFill();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('take_profit');
    });

    it('ratchets the trailing floor from the NET DEBIT basis, not the long leg premium alone', async () => {
      // Net debit at entry: 3 - 1 = 2. A long-leg-only read of entryPrice=3 vs.
      // currentPrice=3.9 would look like a mere +30% (short of a 40% trigger);
      // the correct net-debit read is entry 2 -> current (3.9 - 0.2) = 3.7,
      // i.e. +85%, comfortably past it.
      setAutotradeConfig({ optionsTrailStartPct: 40, optionsTrailStopPct: 10 });
      const pos = openSpreadPos({ expiration: '2024-07-15', entryPrice: 3, shortEntryPrice: 1 });
      mockGetProvider.mockReturnValue(
        chainsFor({
          AAPL: [
            { side: 'call', strike: 100, mark: 3.9 },
            { side: 'call', strike: 110, mark: 0.2 },
          ],
        }) as never,
      );
      await checkOptionsPaperExits();
      const after = listOptionsPaperPositions({ symbol: 'AAPL' }).find((p) => p.id === pos.id)!;
      expect(after.stopFloorPct).toBeCloseTo(75, 5); // 85 - 10
    });
  });

  // -------------------------------------------------------------------------
  // HOW A PAPER EXIT IS PRICED (2026-09-17). The HOOD 0DTE call of 2026-09-11
  // is the worked example throughout: the ladder saw a 1.47 mark, the live
  // order at 1.40 never filled, the paper book booked +72% at 1.48. These cases
  // pin the fill model with LITERAL numbers on purpose — the `sell()` helper
  // above proves the executor consumes the shared pricing; these prove what
  // that pricing is.
  // -------------------------------------------------------------------------
  describe('how a paper exit is priced (2026-09-17)', () => {
    const hood = () =>
      openPos({ symbol: 'HOOD', contractSymbol: 'HOOD-0dte', expiration: '2024-07-15', entryPrice: 0.86, quantity: 1 });
    const chain = (mark: number, bid?: number, ask?: number) =>
      mockGetProvider.mockReturnValue(chainsFor({ HOOD: { side: 'call', strike: 100, mark, bid, ask } }) as never);

    it('the HOOD shape: a take-profit on a spike fills at the POST-spike price, not the spike', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60 });
      const pos = hood();
      chain(1.47); // +71% on the mark — the ladder fires
      const decided = await checkOptionsPaperExits();
      expect(decided[0]).toMatchObject({ symbol: 'HOOD', closed: false, pending: true });
      // 1.47 × 0.95 = 1.3965 → 1.40 to the cent → 1.40 sits on the nickel grid.
      expect(pendingOptionsPaperExit(pos.id)).toEqual({ rule: 'take-profit', restingLimit: 1.4 });
      expect(hasOpenOptionsPaperPosition('HOOD')).toBe(true);
      const decidedEv = listAutotradeEvents({ symbol: 'HOOD' }).find((e) => e.action === 'options_paper_exit_decided')!;
      expect(JSON.parse(decidedEv.detail!)).toMatchObject({ decisionMark: 1.47, restingLimit: 1.4, basis: 'mark' });

      // Next tick the spike is gone: mark 0.95, bid 0.90. The resting 1.40
      // could not have filled; the chase re-prices to the bid.
      vi.setSystemTime(Date.now() + 60_000);
      chain(0.95, 0.9, 1.0);
      const filled = await checkOptionsPaperExits();
      expect(filled[0].closed).toBe(true);
      const row = filled[0].position!;
      expect(row).toMatchObject({
        exitReason: 'take_profit',
        exitPrice: 0.9,
        exitDecisionMark: 1.47,
        exitFillBasis: 'bid',
      });
      expect(row.exitDecidedAt).toBeLessThan(row.exitAt!);
      const closedEv = listAutotradeEvents({ symbol: 'HOOD' }).find(
        (e) => e.action === 'options_paper_position_closed',
      )!;
      // +4.7% of premium, not +72%.
      const detail = JSON.parse(closedEv.detail!);
      expect(detail).toMatchObject({
        decisionMark: 1.47,
        restingLimit: 1.4,
        fillPrice: 0.9,
        fillBasis: 'bid',
        filledOn: 'next_tick',
      });
      expect(detail.pnl).toBeCloseTo(4, 6); // (0.90 - 0.86) x 100
      expect(pendingOptionsPaperExit(pos.id)).toBeNull();
    });

    it('a market that held or rose fills the resting limit, never a better price it did not have', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60 });
      hood();
      chain(1.47);
      await checkOptionsPaperExits();
      chain(1.6, 1.55, 1.65); // the move was real — but the order was out at 1.40
      const filled = await checkOptionsPaperExits();
      expect(filled[0].position!.exitPrice).toBe(1.4);
      expect(
        JSON.parse(
          listAutotradeEvents({ symbol: 'HOOD' }).find((e) => e.action === 'options_paper_position_closed')!.detail!,
        ),
      ).toMatchObject({ filledOn: 'next_tick', fillPrice: 1.4 });
    });

    it('a stop-loss on a down-spike fills at the low — a limit placed there filled at once', async () => {
      setAutotradeConfig({ optionsStopLossPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.4 } }) as never); // -53%
      await checkOptionsPaperExits();
      mockGetProvider.mockReturnValue(
        chainsFor({ AAPL: { side: 'call', strike: 100, mark: 2.0, bid: 1.95 } }) as never,
      ); // recovered
      const filled = await checkOptionsPaperExits();
      // min(1.33 → 1.30 on the nickel, 1.95) — the honest asymmetry of a resting sell.
      expect(filled[0].position!.exitPrice).toBe(sell(1.4));
    });

    it('a quote that cannot be had on the fill tick leaves the resting price standing, and says so', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60 });
      hood();
      chain(1.47);
      await checkOptionsPaperExits();
      mockGetProvider.mockReturnValue({ getOptionsChain: vi.fn().mockRejectedValue(new Error('timeout')) } as never);
      const filled = await checkOptionsPaperExits();
      expect(filled[0].closed).toBe(true);
      expect(filled[0].position!.exitPrice).toBe(1.4);
      expect(
        JSON.parse(
          listAutotradeEvents({ symbol: 'HOOD' }).find((e) => e.action === 'options_paper_position_closed')!.detail!,
        ),
      ).toMatchObject({ filledOn: 'next_tick_unquoted' });
    });

    it('a decision left over from a previous session fills at its DAY limit, labelled', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60 });
      hood();
      chain(1.47);
      await checkOptionsPaperExits();
      vi.setSystemTime(Date.parse('2024-06-03T15:00:00Z')); // the next ET session
      chain(0.2, 0.15, 0.25); // whatever the morning says is not what that order saw
      const filled = await checkOptionsPaperExits();
      expect(filled[0].position!.exitPrice).toBe(1.4);
      expect(
        JSON.parse(
          listAutotradeEvents({ symbol: 'HOOD' }).find((e) => e.action === 'options_paper_position_closed')!.detail!,
        ),
      ).toMatchObject({ filledOn: 'next_session' });
    });

    it("uses the chain's bid when it carries one, for a clock-driven exit too", async () => {
      openPos({ expiration: '2024-06-05' }); // inside the 7-day window: the DTE clock fires
      mockGetProvider.mockReturnValue(
        chainsFor({ AAPL: { side: 'call', strike: 100, mark: 1.1, bid: 1.05, ask: 1.15 } }) as never,
      );
      const out = await checkOptionsPaperExits();
      expect(out[0].closed).toBe(true);
      expect(out[0].position).toMatchObject({ exitPrice: 1.05, exitFillBasis: 'bid' });
      expect(
        JSON.parse(
          listAutotradeEvents({ symbol: 'AAPL' }).find((e) => e.action === 'options_paper_position_closed')!.detail!,
        ),
      ).toMatchObject({ filledOn: 'same_tick', fillBasis: 'bid' });
    });

    it('a pending close skips the rules on the fill tick — the decision that placed it stands', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60, optionsStopLossPct: 50 });
      hood();
      chain(1.47); // take-profit decided
      await checkOptionsPaperExits();
      chain(0.3, 0.25, 0.35); // -65%: the stop-loss would fire now — but the close is already out there
      const filled = await checkOptionsPaperExits();
      expect(filled[0].position!.exitReason).toBe('take_profit');
      expect(filled[0].position!.exitPrice).toBe(0.25);
    });

    it('forgets a pending decision on restart and simply decides again one tick later', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 60 });
      const pos = hood();
      chain(1.47);
      await checkOptionsPaperExits();
      resetOptionsPaperPendingExits(); // the process died
      const again = await checkOptionsPaperExits();
      expect(again[0]).toMatchObject({ closed: false, pending: true });
      expect(pendingOptionsPaperExit(pos.id)).toEqual({ rule: 'take-profit', restingLimit: 1.4 });
      const filled = await checkOptionsPaperExits();
      expect(filled[0].closed).toBe(true);
    });

    it('a debit spread sells its long leg into the bid and buys the short back at the ask', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 50 });
      openOptionsPaperPosition({
        symbol: 'AAPL',
        side: 'call',
        kind: 'debit_spread',
        contractSymbol: 'AAPL-long',
        strike: 100,
        shortContractSymbol: 'AAPL-short',
        shortStrike: 110,
        shortEntryPrice: 1,
        expiration: '2024-07-15',
        quantity: 2,
        entryPrice: 3,
        riskAmount: 400,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
      });
      const both = () =>
        mockGetProvider.mockReturnValue(
          chainsFor({
            AAPL: [
              { side: 'call', strike: 100, mark: 5, bid: 4.9, ask: 5.1 },
              { side: 'call', strike: 110, mark: 1, bid: 0.9, ask: 1.1 },
            ],
          }) as never,
        );
      both();
      await checkOptionsPaperExits(); // net mark 4 vs entry 2: +100%, decided
      both();
      const filled = await checkOptionsPaperExits();
      const pos = filled[0].position!;
      // Net = 4.9 - 1.1 = 3.8; stored as short 1.1 and long 3.8 + 1.1 = 4.9.
      expect(pos.shortExitPrice).toBeCloseTo(1.1, 6);
      expect(pos.exitPrice! - pos.shortExitPrice!).toBeCloseTo(3.8, 6);
      expect(pos.exitFillBasis).toBe('bid');
      expect(
        JSON.parse(
          listAutotradeEvents({ symbol: 'AAPL' }).find((e) => e.action === 'options_paper_position_closed')!.detail!,
        ).pnl,
      ).toBeCloseTo((3.8 - 2) * 200, 6);
    });
  });
});

describe('getOptionsPaperPortfolioSnapshot / optionsSeedForEquity', () => {
  it('sums open risk and maps positions to a PaperPortfolioSeed keyed by riskAmount', () => {
    openOptionsPaperPosition({
      symbol: 'AAA',
      side: 'call',
      contractSymbol: 'AAA-opt',
      strike: 100,
      expiration: '2024-06-21',
      quantity: 2,
      entryPrice: 3,
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const snapshot = getOptionsPaperPortfolioSnapshot();
    expect(snapshot.openRisk).toBe(600);
    expect(snapshot.openPositionsCount).toBe(1);
    const seed = optionsSeedForEquity(snapshot);
    expect(seed.openRisk).toBe(600);
    expect(seed.openPositionsCount).toBe(1);
    expect(seed.positions).toEqual([{ symbol: 'AAA', notional: 600, side: 'long' }]);
  });

  it('is empty when there are no options paper positions at all', () => {
    const snapshot = getOptionsPaperPortfolioSnapshot();
    expect(snapshot.openRisk).toBe(0);
    expect(snapshot.openPositionsCount).toBe(0);
    expect(snapshot.dailyPnl).toBe(0);
    expect(snapshot.consecutiveLosses).toBe(0);
    expect(snapshot.tradesToday).toBe(0);
    expect(optionsSeedForEquity(snapshot).positions).toEqual([]);
  });

  it("sums an open debit spread's riskAmount (net debit x contracts x 100) like any other position", () => {
    openOptionsPaperPosition({
      symbol: 'SPRD',
      side: 'call',
      kind: 'debit_spread',
      contractSymbol: 'SPRD-long',
      strike: 100,
      shortContractSymbol: 'SPRD-short',
      shortStrike: 110,
      shortEntryPrice: 1,
      expiration: '2024-06-21',
      quantity: 2,
      entryPrice: 3,
      riskAmount: 400,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const snapshot = getOptionsPaperPortfolioSnapshot();
    expect(snapshot.openRisk).toBe(400);
    expect(optionsSeedForEquity(snapshot).positions).toEqual([{ symbol: 'SPRD', notional: 400, side: 'long' }]);
  });

  it("folds a closed debit spread's net-debit-based pnl into dailyPnl, reading its OWN persisted shortExitPrice", () => {
    const pos = openOptionsPaperPosition({
      symbol: 'SPRD',
      side: 'call',
      kind: 'debit_spread',
      contractSymbol: 'SPRD-long',
      strike: 100,
      shortContractSymbol: 'SPRD-short',
      shortStrike: 110,
      shortEntryPrice: 1,
      expiration: '2024-06-21',
      quantity: 1,
      entryPrice: 3, // net debit 2
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    optionsPaperPositionsDb.closeOptionsPaperPosition(pos.id, {
      exitPrice: 6,
      shortExitPrice: 1,
      exitReason: 'time_exit',
    });
    // net credit at exit: 6 - 1 = 5; net debit at entry: 2 -> pnl = (5 - 2) * 1 * 100 = 300
    const snapshot = getOptionsPaperPortfolioSnapshot();
    expect(snapshot.dailyPnl).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Short-dated options on the PAPER book (2026-08-27,
// docs/SHORT_DATED_OPTIONS_SPEC.md). The ladder shipped on the live path a day
// earlier; this is the port, and paper is where it actually runs first.
// ---------------------------------------------------------------------------
describe('short-dated options — the paper book', () => {
  /** 10:30 ET Wednesday 2026-08-26 — mid-session, clear of every clock. */
  const EARLY = Date.parse('2026-08-26T14:30:00Z');
  /** 15:00 ET the same day — 60m to the close, inside a 120m hard exit and a
   *  210m entry cutoff. */
  const LATE = Date.parse('2026-08-26T19:00:00Z');
  /** The ET date EARLY falls on — a contract expiring here is 0DTE. */
  const TODAY = '2026-08-26';

  afterEach(() => vi.useRealTimers());
  const atClock = (ms: number) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(ms);
  };

  const shortDated = (over: Partial<Parameters<typeof setAutotradeConfig>[0]> = {}) =>
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      shortDatedOptionsEnabled: true,
      optionsMinDte: 0,
      optionsMaxDte: 2,
      optionsHardExitMinutesBeforeClose: 120,
      optionsNoEntryMinutesBeforeClose: 210,
      optionsUnderlyingStopPct: 0.5,
      optionsGiveBackArmPct: 40,
      optionsGiveBackPct: 50,
      optionsTakeProfitPct: 60,
      optionsStagnationMinutes: 30,
      optionsStagnationMinMovePct: 0.3,
      optionsDisasterStopPct: 70,
      ...over,
    });

  /** A 0DTE call opened `minutesAgo` before the clock, at 0.40 premium with
   *  the underlying at 100 — the spec's worked example. */
  function openShortDated(over: Partial<Parameters<typeof openOptionsPaperPosition>[0]> = {}, minutesAgo = 5) {
    const pos = openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-0dte',
      strike: 100,
      expiration: TODAY,
      quantity: 1,
      entryPrice: 0.4,
      riskAmount: 40,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      underlyingAtEntry: 100,
      ...over,
    });
    // openOptionsPaperPosition stamps entry_at from the wall clock, which the
    // fake timer has already moved — rewrite it so "held N minutes" is exact.
    db.prepare('UPDATE autotrade_options_paper_positions SET entry_at = ? WHERE id = ?').run(
      Date.now() - minutesAgo * 60_000,
      pos.id,
    );
    return pos;
  }

  /** chainsFor() deliberately has no getQuote — the ladder must survive that
   *  (it throws SYNCHRONOUSLY, which is the case that killed the live sweep).
   *  This adds one when a test needs the underlying to move. */
  const withQuote = (chains: ReturnType<typeof chainsFor>, last: number) => ({
    ...chains,
    getQuote: vi.fn(async () => ({ symbol: 'AAPL', last, change: 0, changePercent: 0 })),
  });

  it('stamps the underlying price at entry — the reference the stop measures against', async () => {
    shortDated();
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.41 } }) as never);
    const risk = evaluateOptionsRiskCheck(optionSignal({ underlyingPrice: 143.2 }), {
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
    const outcome = await attemptOptionsPaperEntry(optionSignal({ underlyingPrice: 143.2 }), risk, 'MODERATE');
    expect(outcome.ok).toBe(true);
    // Nothing else on the signal can stand in: strike and premium say where
    // the contract sits, not where the stock was when the thesis was formed.
    expect(outcome.position!.underlyingAtEntry).toBe(143.2);
  });

  describe('the DTE coupling that must not be split', () => {
    it('holds a 0DTE contract instead of round-tripping it on the next tick', async () => {
      // With the band at 0-2 DTE and the backstop still at 7 days, `dte <= 7`
      // is true from the moment of the fill: the loop buys a contract and
      // sells it seconds later, paying the round-trip spread, every time.
      atClock(EARLY);
      shortDated({ optionsStagnationMinutes: 0, optionsUnderlyingStopPct: 0 });
      openShortDated();
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.42 } }) as never);

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ symbol: 'AAPL', closed: false });
    });

    it('still applies the 7-day backstop with the flag off — proving the test above bites', async () => {
      atClock(EARLY);
      setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE', shortDatedOptionsEnabled: false });
      openShortDated();
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.42 } }) as never);

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ closed: true });
      expect(out[0]!.position!.exitReason).toBe('time_exit');
    });
  });

  describe('exits', () => {
    it('the hard clock fires late in the day even with no underlying quote at all', async () => {
      // Every other rule needs a premium or an underlying. This one must not:
      // a quote outage near the close is exactly when being stuck in a
      // decaying contract is worst. chainsFor() has no getQuote, so the
      // helper's synchronous throw is genuinely exercised here.
      atClock(LATE);
      shortDated();
      const pos = openShortDated();
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.9 } }) as never);

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ symbol: 'AAPL', closed: true });
      expect(out[0]!.position!.exitReason).toBe('time_exit');
      const ev = listAutotradeEvents({}).find((e) => e.action === 'short_dated_options_exit')!;
      expect(JSON.parse(ev.detail!)).toMatchObject({ rule: 'hard_time', book: 'paper', positionId: pos.id });
    });

    it('cuts on an adverse UNDERLYING move', async () => {
      atClock(EARLY);
      shortDated();
      openShortDated();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.24 } }), 99.4) as never,
      );

      const out = await decideThenFill();

      expect(out[0]!.position!.exitReason).toBe('stop_loss');
      const ev = listAutotradeEvents({}).find((e) => e.action === 'short_dated_options_exit')!;
      expect(JSON.parse(ev.detail!)).toMatchObject({ rule: 'underlying_stop', underlyingMovePct: -0.6 });
    });

    it('journals the peak the contract reached, which is what makes rule L5 answerable', async () => {
      // Asserted on the EVENT, not on the decision that produced it. The peak
      // was computed and returned all along; it simply never reached the
      // journal, so L5 ("was the give-back trail too tight?") could not be
      // evaluated from any of the 15 trades closed before 2026-09-09.
      atClock(EARLY);
      shortDated();
      openShortDated();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.24 } }), 99.4) as never,
      );

      await decideThenFill();

      const ev = listAutotradeEvents({}).find((e) => e.action === 'short_dated_options_exit')!;
      const detail = JSON.parse(ev.detail!) as { peakGainPct: number | null; peakPremium: number | null };
      expect(typeof detail.peakGainPct).toBe('number');
      expect(typeof detail.peakPremium).toBe('number');
    });

    it('does NOT cut when only theta has moved the premium — the whole point', async () => {
      // Underlying perfectly still, premium down 27% on decay alone. A 40%
      // premium stop would be minutes from firing here on nothing at all.
      atClock(EARLY);
      shortDated({ optionsStagnationMinutes: 0 });
      openShortDated();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.29 } }), 100) as never,
      );

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ closed: false });
    });

    it('banks a fading winner on the give-back trail', async () => {
      atClock(EARLY);
      shortDated();
      // Peaked at +62% (the spec's worked case), now +25%.
      openShortDated({ entryPrice: 0.4 });
      db.prepare('UPDATE autotrade_options_paper_positions SET best_basis_since_entry = 0.648').run();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.5 } }), 100.4) as never,
      );

      const out = await decideThenFill();

      expect(out[0]!.position!.exitReason).toBe('take_profit');
      const ev = listAutotradeEvents({}).find((e) => e.action === 'short_dated_options_exit')!;
      expect(JSON.parse(ev.detail!)).toMatchObject({ rule: 'give_back' });
    });

    it('records the peak on a cycle that does NOT exit — best_basis_since_entry is the high-water mark', async () => {
      // A give-back trail that only learns about peaks when it acts is
      // measuring the wrong thing. Paper reuses the column it already had for
      // its trailing stop rather than adding a peak_premium twin.
      atClock(EARLY);
      shortDated();
      const pos = openShortDated();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.55 } }), 100.3) as never,
      );

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ closed: false });
      expect(listOptionsPaperPositions({}).find((p) => p.id === pos.id)!.bestBasisSinceEntry).toBeCloseTo(0.55, 6);
    });

    it('cuts a position that has not started working before decay takes the rest', async () => {
      // stagnationExit.ts skips options because theta already prices the slot
      // — mild at 30 DTE, and at 0DTE exactly the reason to leave.
      atClock(EARLY);
      shortDated();
      openShortDated({}, 35);
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.36 } }), 100.1) as never,
      );

      const out = await checkOptionsPaperExits();

      expect(out[0]!.position!.exitReason).toBe('time_exit');
      const ev = listAutotradeEvents({}).find((e) => e.action === 'short_dated_options_exit')!;
      expect(JSON.parse(ev.detail!)).toMatchObject({ rule: 'stagnation' });
    });

    it('silences the 40% premium stop, which would otherwise fire on a flat tape', async () => {
      // The gap that made the whole priority order a fiction: production runs
      // optionsStopLossPct at 40, and a stop on the PREMIUM reaches that on
      // decay alone by early afternoon (-63% at 13:30 with the underlying
      // perfectly still). It would pre-empt the underlying stop on every
      // position, every day, with no adverse move whatsoever. Underlying flat,
      // premium -50%: nothing may fire but the ladder's own 70% backstop,
      // which this is deliberately short of.
      atClock(EARLY);
      shortDated({ optionsStopLossPct: 40, optionsStagnationMinutes: 0 });
      openShortDated();
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.2 } }), 100) as never,
      );

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ closed: false });
    });

    it('still applies the premium stop with the flag off — proving the test above bites', async () => {
      atClock(EARLY);
      setAutotradeConfig({
        accountEquityUsd: 100_000,
        riskProfile: 'MODERATE',
        shortDatedOptionsEnabled: false,
        optionsStopLossPct: 40,
      });
      // Far-dated, so the DTE backstop cannot be what closes it.
      openShortDated({ expiration: '2027-06-18' });
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.2 } }), 100) as never,
      );

      const out = await decideThenFill();

      expect(out[0]!.position!.exitReason).toBe('stop_loss');
    });

    it('leaves a legacy row with no underlyingAtEntry to the premium rules alone', async () => {
      // A position opened before the column existed: the stop and the
      // stagnation cut go quiet rather than inventing a reference.
      atClock(EARLY);
      shortDated();
      openShortDated({ underlyingAtEntry: null }, 35);
      mockGetProvider.mockReturnValue(
        withQuote(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.2 } }), 99.0) as never,
      );

      const out = await checkOptionsPaperExits();

      expect(out[0]).toMatchObject({ closed: false });
    });
  });

  describe('entry gates', () => {
    it('refuses new entries past the cutoff, and says why', async () => {
      atClock(LATE);
      shortDated();
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.4 } }) as never);

      const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

      expect(out[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/entry cutoff/) });
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
      expect(listAutotradeEvents({}).some((e) => e.action === 'short_dated_entry_window_closed')).toBe(true);
    });

    it('allows entries earlier in the session', async () => {
      atClock(EARLY);
      shortDated();
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.4 } }) as never);

      const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

      expect(out[0]?.reason ?? '').not.toMatch(/entry cutoff/);
    });

    it('allows only ONE short-dated position at a time', async () => {
      // Tighter than the shared concurrent cap on purpose: two 0DTE positions
      // can both go to zero inside the same half hour on one adverse move.
      atClock(EARLY);
      shortDated();
      openShortDated({ symbol: 'MSFT', contractSymbol: 'MSFT-0dte' });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.4 } }) as never);

      const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

      expect(out[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/max 1 at a time/) });
      expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    });

    it('applies neither gate while the flag is off', async () => {
      atClock(LATE);
      setAutotradeConfig({
        accountEquityUsd: 100_000,
        riskProfile: 'MODERATE',
        shortDatedOptionsEnabled: false,
        optionsNoEntryMinutesBeforeClose: 210,
      });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 0.4 } }) as never);

      const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

      expect(out[0]?.reason ?? '').not.toMatch(/entry cutoff/);
    });
  });
});

// ---------------------------------------------------------------------------
// The options book's own slot budget (2026-08-27).
//
// Options and equity share one combined budget by design — sound for RISK,
// and ruinous for SLOTS at a small cap. That session equity held both of the
// two slots all day while 184 options signals produced ZERO orders, every one
// refused "2 open vs cap 2". The paper options book is the evidence track the
// entire short-dated roll-out rests on, and it cannot produce evidence it is
// never given a slot to generate.
// ---------------------------------------------------------------------------
describe('short_dated_position_already_open — the max-1 gate is countable', () => {
  // Pin the clock. The short-dated ENTRY WINDOW gate (210m to the close) runs
  // BEFORE the max-1 gate, so on the real wall clock this whole block passes or
  // fails by time of day — it was written without this and slipped through CI,
  // then failed at 12:30 ET, exactly 210 minutes before the bell.
  // 2026-08-28T14:30:00Z is 10:30 ET: 330 minutes to the close, well inside.
  const MID_MORNING = Date.parse('2026-08-28T14:30:00Z');
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(MID_MORNING);
  });
  afterEach(() => vi.useRealTimers());

  // The tuning plan's F7 fires when this gate refuses >=5 candidates in a week.
  // It used to return silently, so the rule had nothing to count and a gate
  // throttling the book looked exactly like one that never fired.
  it('journals the refusal, with the candidate count F7 needs', async () => {
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 5,
      optionsMaxConcurrentPositions: 5, // room by every OTHER measure
      shortDatedOptionsEnabled: true,
    });
    openOptionsPaperPosition({
      symbol: 'MSFT',
      side: 'call',
      contractSymbol: 'MSFT-shortdated',
      strike: 400,
      expiration: '2026-08-28',
      quantity: 1,
      entryPrice: 3,
      riskAmount: 300,
      riskProfile: 'MODERATE',
      rationale: 'holds the one short-dated slot',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }, { signal: optionSignal() }]);

    expect(out.every((o) => !o.ok)).toBe(true);
    const ev = listAutotradeEvents({ actions: ['short_dated_position_already_open'] });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail!)).toMatchObject({ book: 'paper', refused: 2, openPositions: 1 });
  });

  it('journals nothing when the gate does not fire', async () => {
    // The common case. A rule that counts events must not count a quiet tick.
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 5,
      optionsMaxConcurrentPositions: 5,
      shortDatedOptionsEnabled: true,
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(listAutotradeEvents({ actions: ['short_dated_position_already_open'] })).toHaveLength(0);
  });
});

describe('optionsMaxConcurrentPositions — the options book gets its own slots', () => {
  /** Fill the EQUITY paper book to the shared cap, the way a normal morning
   *  does: equity runs first in the loop tick and takes what it needs. */
  function fillEquityBook(n = 2) {
    for (let i = 0; i < n; i += 1) {
      openPaperPosition({
        symbol: `EQ${i}`,
        side: 'buy',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        targetPrice: 110,
        riskAmount: 50,
        riskProfile: 'MODERATE',
        rationale: 'fills a slot',
      });
    }
  }

  it('is starved by a full equity book while the budget is shared — the 2026-08-27 failure', async () => {
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 2,
      optionsMaxConcurrentPositions: 0, // shared: the old behaviour
    });
    fillEquityBook(2);
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    const blocked = listAutotradeEvents({ actions: ['options_blocked'] });
    const rules = blocked.flatMap((e) =>
      JSON.parse(e.detail!)
        .checks.filter((c: { passed: boolean }) => !c.passed)
        .map((c: { rule: string }) => c.rule),
    );
    expect(rules).toContain('max_concurrent_positions');
  });

  it('opens anyway once the options book has slots of its own', async () => {
    // Same full equity book, same signal. Only the slot budget differs.
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 2,
      optionsMaxConcurrentPositions: 1,
    });
    fillEquityBook(2);
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ symbol: 'AAPL', ok: true });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
  });

  it('still enforces the options cap against the options book itself', async () => {
    // Its own budget is a budget, not an exemption.
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 5,
      optionsMaxConcurrentPositions: 1,
    });
    openOptionsPaperPosition({
      symbol: 'MSFT',
      side: 'call',
      contractSymbol: 'MSFT-open',
      strike: 400,
      expiration: '2026-09-18',
      quantity: 1,
      entryPrice: 3,
      riskAmount: 300,
      riskProfile: 'MODERATE',
      rationale: 'already holds the one options slot',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
  });

  it('leaves the combined RISK budget shared — only slots are split', async () => {
    // The money genuinely is shared. An equity book that has consumed the
    // aggregate risk cap must still block an options entry even when the
    // options book has a free slot.
    setAutotradeConfig({
      accountEquityUsd: 10_000,
      riskProfile: 'MODERATE',
      maxConcurrentPositions: 5,
      optionsMaxConcurrentPositions: 5,
      maxAggregateOpenRiskPct: 1, // $100 of room, total
    });
    openPaperPosition({
      symbol: 'HOG',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 120,
      riskAmount: 100, // eats the entire aggregate budget
      riskProfile: 'MODERATE',
      rationale: 'consumes the shared risk pool',
    });
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
  });
});

// Paper twin of liveOptionsExecute.test.ts's own-pool cases: the two books
// must agree by construction on WHICH positions the sector / correlated caps
// count, or paper stops being the control arm for the live options book.
describe('optionsOwnExposurePool — the paper options book measures concentration against its own positions', () => {
  const SECTOR = 'Information Technology';
  const failedRules = () =>
    listAutotradeEvents({ actions: ['options_blocked'] }).flatMap((e) =>
      (JSON.parse(e.detail!) as { checks: { rule: string; passed: boolean }[] }).checks
        .filter((c) => !c.passed)
        .map((c) => c.rule),
    );
  const exposurePoolOf = (action: string) =>
    (JSON.parse(listAutotradeEvents({ actions: [action] })[0].detail!) as { exposurePool: string }).exposurePool;

  /** Two same-sector paper equity positions, each 60% of a $100k account —
   *  120% of equity in one sector against an 80% cap — with a dime of stop
   *  distance each so their open RISK stays at $60 apiece. */
  function fillSectorWithStock() {
    addSymbols([
      { symbol: 'AAPL', sector: SECTOR },
      { symbol: 'AMD', sector: SECTOR },
      { symbol: 'LITE', sector: SECTOR },
    ]);
    for (const symbol of ['AMD', 'LITE']) {
      openPaperPosition({
        symbol,
        side: 'buy',
        quantity: 600,
        entryPrice: 100,
        stopPrice: 99.9,
        targetPrice: 110,
        riskAmount: 60,
        riskProfile: 'MODERATE',
        rationale: 'fills the sector',
      });
    }
  }
  const poolConfig = {
    accountEquityUsd: 100_000,
    riskProfile: 'MODERATE' as const,
    maxConcurrentPositions: 5,
    optionsMaxConcurrentPositions: 1,
    maxSectorExposurePct: 80,
    maxCorrelatedExposurePct: 80,
    maxAggregateOpenRiskPct: 10,
  };
  const armChain = () =>
    mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 3 } }) as never);

  it('is refused at ANY size while the pool is shared', async () => {
    setAutotradeConfig({ ...poolConfig, optionsOwnExposurePool: false });
    fillSectorWithStock();
    armChain();

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    expect(failedRules()).toContain('max_sector_exposure');
    expect(exposurePoolOf('options_blocked')).toBe('shared');
  });

  it('opens once the options book measures the pool against its own positions only', async () => {
    setAutotradeConfig({ ...poolConfig, optionsOwnExposurePool: true });
    fillSectorWithStock();
    armChain();

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ symbol: 'AAPL', ok: true });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(true);
    expect(exposurePoolOf('options_passed')).toBe('options_only');
  });

  it('leaves the aggregate RISK budget shared — an equity book that has spent it still refuses', async () => {
    setAutotradeConfig({ ...poolConfig, optionsOwnExposurePool: true, maxAggregateOpenRiskPct: 0.1 }); // $100 of room
    fillSectorWithStock(); // $120 already at risk
    armChain();

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    expect(failedRules()).toContain('max_aggregate_open_risk');
    expect(failedRules()).not.toContain('max_sector_exposure');
  });

  it('still counts its OWN options positions against the sector cap — a budget, not an exemption', async () => {
    // $500 of sector room; an open MSFT call in the same sector holds $600 of
    // premium (2 × $3 × 100). Two own slots so the slot cap stays out of it.
    setAutotradeConfig({
      ...poolConfig,
      optionsOwnExposurePool: true,
      maxSectorExposurePct: 0.5,
      optionsMaxConcurrentPositions: 2,
    });
    addSymbols([
      { symbol: 'AAPL', sector: SECTOR },
      { symbol: 'MSFT', sector: SECTOR },
    ]);
    openOptionsPaperPosition({
      symbol: 'MSFT',
      side: 'call',
      contractSymbol: 'MSFT-open',
      strike: 400,
      expiration: '2026-09-18',
      quantity: 2,
      entryPrice: 3,
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'holds $600 of premium in the sector',
    });
    armChain();

    const out = await runOptionsPaperExecution([{ signal: optionSignal() }]);

    expect(out[0]).toMatchObject({ ok: false });
    expect(hasOpenOptionsPaperPosition('AAPL')).toBe(false);
    expect(failedRules()).toContain('max_sector_exposure');
    expect(exposurePoolOf('options_blocked')).toBe('options_only');
  });
});
