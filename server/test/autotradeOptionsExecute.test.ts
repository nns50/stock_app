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
import { evaluateOptionsRiskCheck } from '../src/services/autotrading/optionsRiskCheck';
import { RiskCheckResult } from '../src/services/autotrading/riskCheck';
import { RISK_PROFILES } from '../src/services/autotrading/riskProfiles';
import { OptionsTradeSignal } from '../src/services/autotrading/optionsDecide';

const mockGetProvider = vi.mocked(getProvider);

function optionSignal(overrides: Partial<OptionsTradeSignal> = {}): OptionsTradeSignal {
  return {
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

/** Mock provider serving one chain per underlying symbol, with a single
 *  contract at the given strike/side/mark — enough for every test here,
 *  which never needs more than one qualifying contract per underlying. */
function chainsFor(fixtures: Record<string, { side: 'call' | 'put'; strike: number; mark: number }>) {
  return {
    getOptionsChain: vi.fn(async (symbol: string, expiration: string) => {
      const fx = fixtures[symbol];
      if (!fx) throw new Error(`no mock chain for ${symbol}`);
      const contract = {
        symbol: `${symbol}-opt`,
        underlying: symbol,
        type: fx.side,
        strike: fx.strike,
        mark: fx.mark,
        expiration,
      };
      return {
        underlying: symbol,
        expiration,
        underlyingPrice: 100,
        calls: fx.side === 'call' ? [contract] : [],
        puts: fx.side === 'put' ? [contract] : [],
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
  const okResult: RiskCheckResult = evaluateOptionsRiskCheck(
    optionSignal(),
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
    const blocked: RiskCheckResult = { ...okResult, ok: false };
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
    setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
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
    expect(seed.positions).toEqual([{ symbol: 'AAA', notional: 600 }]);
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
});
