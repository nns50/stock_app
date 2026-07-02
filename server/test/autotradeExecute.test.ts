import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { hasOpenPaperPosition, listPaperPositions, openPaperPosition } from '../src/db/autotradePaperPositions';
import * as paperPositionsDb from '../src/db/autotradePaperPositions';
import { attemptPaperEntry, checkPaperExits, runPaperExecution } from '../src/services/autotrading/execute';
import { evaluateRiskCheck, RiskCheckResult } from '../src/services/autotrading/riskCheck';
import { RISK_PROFILES } from '../src/services/autotrading/riskProfiles';
import { TradeSignal } from '../src/services/autotrading/decide';

const mockGetProvider = vi.mocked(getProvider);

function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: 'AAPL',
    side: 'buy',
    entry: 100,
    stop: 95,
    target: 110,
    rMultiple: 2,
    rationale: 'test fixture',
    score: 70,
    ...overrides,
  };
}

function quoteReturning(prices: Record<string, number>) {
  return {
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no mock quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: Date.now() };
    }),
    getCandles: vi.fn(async () => []), // no pre-existing correlated positions in most tests -> never called
  };
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
  setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  mockGetProvider.mockReset();
});

describe('attemptPaperEntry', () => {
  const okResult: RiskCheckResult = evaluateRiskCheck(
    signal(),
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

  it('fills at a freshly-fetched quote, not the signal price', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101.5 }) as never);
    const outcome = await attemptPaperEntry(signal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(true);
    expect(outcome.position!.entryPrice).toBe(101.5); // NOT signal.entry (100)
    expect(outcome.position!.status).toBe('open');
  });

  it('never fetches a quote or opens anything when the risk check did not pass', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101.5 }) as never);
    const blocked: RiskCheckResult = { ...okResult, ok: false };
    const outcome = await attemptPaperEntry(signal(), blocked, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(hasOpenPaperPosition('AAPL')).toBe(false);
  });

  it('is idempotent — skips a symbol that already has an open paper position', async () => {
    openPaperPosition({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 90,
      stopPrice: 85,
      targetPrice: 100,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101.5 }) as never);
    const outcome = await attemptPaperEntry(signal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/already/i);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('reports a quote-fetch failure without crashing or opening a position', async () => {
    mockGetProvider.mockReturnValue({
      getQuote: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    } as never);
    const outcome = await attemptPaperEntry(signal(), okResult, 'MODERATE');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/provider unavailable/);
    expect(hasOpenPaperPosition('AAPL')).toBe(false);
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(events[0].action).toBe('paper_entry_failed');
  });

  it('journals a paper_order_placed event', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101.5 }) as never);
    await attemptPaperEntry(signal(), okResult, 'MODERATE');
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    expect(events[0].action).toBe('paper_order_placed');
    expect(events[0].riskProfile).toBe('MODERATE');
  });
});

describe('runPaperExecution', () => {
  it('approves a clean signal with nothing else open', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101 }) as never);
    const outcomes = await runPaperExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    expect(hasOpenPaperPosition('AAPL')).toBe(true);
  });

  it('skips a candidate whose symbol already has an open paper position', async () => {
    openPaperPosition({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 90,
      stopPrice: 85,
      targetPrice: 100,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'already open',
    });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 101 }) as never);
    const outcomes = await runPaperExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].reason).toMatch(/already/i);
  });

  it('blocks the 3rd candidate on max_concurrent_positions (MODERATE caps at 2)', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ AAA: 100, BBB: 100, CCC: 100 }) as never);
    const outcomes = await runPaperExecution([
      { signal: signal({ symbol: 'AAA' }) },
      { signal: signal({ symbol: 'BBB' }) },
      { signal: signal({ symbol: 'CCC' }) },
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false]);
    expect(outcomes[2].reason).toMatch(/risk check/i);
    const blockedEvent = listAutotradeEvents({ stage: 'risk_check', symbol: 'CCC' })[0];
    expect(blockedEvent.action).toBe('blocked');
  });

  it('threads same-batch approvals into the running risk/count for the NEXT candidate in the same call', async () => {
    // AGGRESSIVE has room for 3, but the aggregate-open-risk cap (4.5% = $4500)
    // is what should bind once two $1500-risk positions (1.5% each) are already
    // running — proving the SECOND approval's risk is counted before the THIRD
    // candidate is evaluated, not just the pre-call snapshot.
    setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
    mockGetProvider.mockReturnValue(quoteReturning({ AAA: 100, BBB: 100, CCC: 100 }) as never);
    // 1.5% risk/trade * $100k = $1500 budget each; $10 stop distance -> 150 shares, $1500 risk.
    const sig = (sym: string) => signal({ symbol: sym, entry: 100, stop: 90, target: 130 });
    const outcomes = await runPaperExecution([{ signal: sig('AAA') }, { signal: sig('BBB') }, { signal: sig('CCC') }]);
    // Two $1500-risk trades = $3000 = 3% of equity, under 4.5%. The third would
    // push it to $4500 = exactly the cap -> still allowed (<=), so all three
    // pass here; the point is this must be computed, not thrown by a stale
    // snapshot. Assert on the actual accumulated risk instead of a hard block.
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const open = listPaperPositions({ status: 'open' });
    const totalRisk = open.reduce((s, p) => s + p.riskAmount, 0);
    expect(totalRisk).toBeCloseTo(4500, 5);
  });

  it("buckets dailyPnl by ET trading day, not UTC calendar day — a late-evening loss must not carry into the next trading day's drawdown halt", async () => {
    // checkPaperExits() runs around the clock, so a position genuinely can
    // close late in the evening. 2024-01-10T02:00:00Z is 2024-01-09 21:00 ET
    // (EST, UTC-5, no DST in January) — it belongs to Jan 9's trading day even
    // though its own ms timestamp already falls on Jan 10 in UTC.
    const lateEveningExitMs = Date.parse('2024-01-10T02:00:00Z');
    const stale = openPaperPosition({
      symbol: 'YEST',
      side: 'buy',
      quantity: 100,
      entryPrice: 100,
      stopPrice: 70,
      targetPrice: 130,
      riskAmount: 3000,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    // (70-100)*100 = -3000, exactly MODERATE's 3%-of-$100k daily-drawdown-halt level.
    db.prepare(
      "UPDATE autotrade_paper_positions SET status='closed', exit_price=70, exit_at=?, exit_reason='stop' WHERE id=?",
    ).run(lateEveningExitMs, stale.id);

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2024-01-10T15:00:00Z')); // 2024-01-10 10:00 ET — the NEXT trading day
    try {
      mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 100 }) as never);
      const outcomes = await runPaperExecution([{ signal: signal({ symbol: 'AAPL' }) }]);
      // If the stale Jan-9 loss were wrongly bucketed into "today" (Jan 10 UTC
      // calendar date), this clean candidate would be blocked by
      // daily_drawdown_halt — it must not be.
      expect(outcomes[0].ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a candidate with a non-finite/invalid quote price, without opening a position', async () => {
    mockGetProvider.mockReturnValue(quoteReturning({ BAD1: NaN, OK1: 100 }) as never);
    const outcomes = await runPaperExecution([
      { signal: signal({ symbol: 'BAD1' }) },
      { signal: signal({ symbol: 'OK1' }) },
    ]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].reason).toMatch(/invalid quote price/i);
    expect(outcomes[1].ok).toBe(true); // OK1 is unaffected by BAD1's bad quote
    expect(hasOpenPaperPosition('OK1')).toBe(true);
    expect(hasOpenPaperPosition('BAD1')).toBe(false);
  });

  it("isolates one candidate's genuine persistence failure (openPaperPosition itself throwing) — the rest of the batch still runs", async () => {
    // Distinct from the finite/positive quote check above: this exercises the
    // try/catch AROUND openPaperPosition() itself, for a failure that check
    // can't catch (e.g. a DB-layer error on an otherwise-valid quote).
    mockGetProvider.mockReturnValue(quoteReturning({ BAD1: 100, OK1: 100 }) as never);
    const openSpy = vi.spyOn(paperPositionsDb, 'openPaperPosition').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      const outcomes = await runPaperExecution([
        { signal: signal({ symbol: 'BAD1' }) },
        { signal: signal({ symbol: 'OK1' }) },
      ]);
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].reason).toMatch(/failed to record paper position/i);
      expect(outcomes[1].ok).toBe(true); // OK1 still opens despite BAD1's persistence failure
      expect(hasOpenPaperPosition('OK1')).toBe(true);
      expect(hasOpenPaperPosition('BAD1')).toBe(false);
      const failedEvent = listAutotradeEvents({ stage: 'execution', symbol: 'BAD1' })[0];
      expect(failedEvent.action).toBe('paper_entry_failed');
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('checkPaperExits', () => {
  function openPos(overrides: Partial<Parameters<typeof openPaperPosition>[0]> = {}) {
    return openPaperPosition({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      ...overrides,
    });
  }

  it('closes a long at the stop LEVEL (not the observed quote) once price is at/below it', async () => {
    openPos();
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 93 }) as never); // below stop
    const outcomes = await checkPaperExits();
    expect(outcomes[0].closed).toBe(true);
    expect(outcomes[0].position!.exitReason).toBe('stop');
    expect(outcomes[0].position!.exitPrice).toBe(95); // the stop LEVEL, not 93
  });

  it('closes a long at the target level once price is at/above it', async () => {
    openPos();
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 115 }) as never);
    const outcomes = await checkPaperExits();
    expect(outcomes[0].position!.exitReason).toBe('target');
    expect(outcomes[0].position!.exitPrice).toBe(110);
  });

  it('leaves a position open when price is between stop and target', async () => {
    openPos();
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 102 }) as never);
    const outcomes = await checkPaperExits();
    expect(outcomes[0].closed).toBe(false);
    expect(hasOpenPaperPosition('AAPL')).toBe(true);
  });

  it('mirrors stop/target correctly for a short (side: sell)', async () => {
    openPos({ side: 'sell', entryPrice: 100, stopPrice: 105, targetPrice: 90 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 106 }) as never); // above the short's stop
    const outcomes = await checkPaperExits();
    expect(outcomes[0].position!.exitReason).toBe('stop');
    expect(outcomes[0].position!.exitPrice).toBe(105);
  });

  it('does not close, and reports the reason, when the quote fetch fails', async () => {
    openPos();
    mockGetProvider.mockReturnValue({ getQuote: vi.fn().mockRejectedValue(new Error('timeout')) } as never);
    const outcomes = await checkPaperExits();
    expect(outcomes[0].closed).toBe(false);
    expect(outcomes[0].reason).toMatch(/timeout/);
    expect(hasOpenPaperPosition('AAPL')).toBe(true);
  });

  it('journals a paper_position_closed event with the realized pnl', async () => {
    openPos({ quantity: 10, entryPrice: 100, targetPrice: 110 });
    mockGetProvider.mockReturnValue(quoteReturning({ AAPL: 115 }) as never);
    await checkPaperExits();
    const events = listAutotradeEvents({ stage: 'execution', symbol: 'AAPL' });
    const closedEvent = events.find((e) => e.action === 'paper_position_closed')!;
    expect(JSON.parse(closedEvent.detail!)).toMatchObject({ exitReason: 'target', exitPrice: 110, pnl: 100 });
  });

  it('returns an empty array when nothing is open', async () => {
    expect(await checkPaperExits()).toEqual([]);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });
});
