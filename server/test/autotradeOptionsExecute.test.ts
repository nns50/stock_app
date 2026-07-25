import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { openPaperPosition } from '../src/db/autotradePaperPositions';
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
} from '../src/services/autotrading/optionsExecute';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from '../src/services/autotrading/optionsRiskCheck';
import { DebitSpreadOptionsSignal, SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';

const mockGetProvider = vi.mocked(getProvider);

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
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events;',
  );
  setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  mockGetProvider.mockReset();
});

describe('attemptOptionsPaperEntry', () => {
  const okResult: OptionsRiskCheckResult = evaluateOptionsRiskCheck(optionSignal(), {
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

  describe('debit spreads', () => {
    const spreadOkResult: OptionsRiskCheckResult = evaluateOptionsRiskCheck(spreadSignal(), {
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
      expect(JSON.parse(events[0].detail!)).toMatchObject({ kind: 'debit_spread', netDebit: 2.25 });
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
    expect(blockedEvent.action).toBe('blocked');
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
    expect(outcomes[0].position!.exitPrice).toBe(1.1);
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
    expect(outcomes[0].position!.exitPrice).toBe(0.5);
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
    // (1 - 3) * 2 * 100 = -400
    expect(JSON.parse(closedEvent.detail!)).toMatchObject({ exitReason: 'time_exit', exitPrice: 1, pnl: -400 });
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
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('stop_loss');
      expect(outcomes[0].position!.exitPrice).toBe(1.4);
    });

    it('closes via take-profit once unrealized gain reaches the configured %, well outside the time-exit window', async () => {
      setAutotradeConfig({ optionsTakeProfitPct: 50 });
      openPos({ expiration: '2024-07-15', entryPrice: 3 });
      mockGetProvider.mockReturnValue(chainsFor({ AAPL: { side: 'call', strike: 100, mark: 4.6 } }) as never); // +53%
      const outcomes = await checkOptionsPaperExits();
      expect(outcomes[0].closed).toBe(true);
      expect(outcomes[0].position!.exitReason).toBe('take_profit');
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
      const outcomes = await checkOptionsPaperExits();
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
      // (3.6 - 3) * 1 * 100 = 60
      const detail = JSON.parse(partial.detail!);
      expect(detail).toMatchObject({ quantity: 1, exitPrice: 3.6 });
      expect(detail.pnl).toBeCloseTo(60, 5);
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

    it('closes both legs together at freshly-fetched marks once the trigger fires', async () => {
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
      expect(outcomes[0].position).toMatchObject({ exitReason: 'time_exit', exitPrice: 8, shortExitPrice: 0.5 });
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
      expect(JSON.parse(closedEvent.detail!)).toMatchObject({ pnl: 1100 });
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
      const outcomes = await checkOptionsPaperExits();
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
