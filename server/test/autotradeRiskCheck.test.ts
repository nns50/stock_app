import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition } from '../src/db/positions';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents, logAutotradeEvent } from '../src/db/autotradeEvents';
import { evaluateRiskCheck, RiskCheckContext, runAutotradeRiskCheck } from '../src/services/autotrading/riskCheck';
import { TradeSignal } from '../src/services/autotrading/decide';

function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: 'TEST',
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

// Matches the old MODERATE preset exactly (riskProfiles.ts's now-removed
// RISK_PROFILES.MODERATE) — every field below is a directly user-configured
// AutotradeConfig field now, but these test fixtures still exercise the same
// numbers.
function baseCtx(overrides: Partial<RiskCheckContext> = {}): RiskCheckContext {
  return {
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
    sectorNotional: 0,
    maxSectorExposurePct: 20,
    candidateSector: null,
    ...overrides,
  };
}

const findCheck = (result: ReturnType<typeof evaluateRiskCheck>, rule: string) =>
  result.checks.find((c) => c.rule === rule)!;

/** Mirrors riskCheck.ts's own (private) etDateStr() — getPortfolioSnapshot()
 *  buckets "today" in US/Eastern, not UTC, so a fixture built with
 *  toISOString() would be off by a day whenever this test happens to run
 *  between 8pm-midnight ET (already the next UTC calendar day). */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

describe('evaluateRiskCheck — pure evaluator', () => {
  it('passes a clean signal with no competing exposure', () => {
    const result = evaluateRiskCheck(signal(), baseCtx());
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('sizes exactly like computeRiskSizing at the profile risk %: 1% of $100k / $5 stop = 200 shares', () => {
    const result = evaluateRiskCheck(signal(), baseCtx());
    expect(result.sizing.suggestedQuantity).toBe(200);
    expect(result.sizing.riskOfPosition).toBe(1000); // 1% of 100,000
    expect(result.sizing.positionCost).toBe(20_000);
  });

  it('mirrors the sizing for a short (side: sell -> long: false)', () => {
    const result = evaluateRiskCheck(signal({ side: 'sell', entry: 100, stop: 105, target: 90 }), baseCtx());
    expect(result.sizing.suggestedQuantity).toBe(200); // same $5 stop distance
  });

  it('blocks everything when equity is not configured', () => {
    const result = evaluateRiskCheck(signal(), baseCtx({ equity: 0 }));
    expect(result.ok).toBe(false);
    expect(findCheck(result, 'equity_configured').passed).toBe(false);
    expect(result.sizing.suggestedQuantity).toBe(0);
  });

  it('blocks when the risk budget cannot size even one share', () => {
    // $10 equity * 1% = $0.10 risk budget; $5 stop distance -> 0 shares.
    const result = evaluateRiskCheck(signal(), baseCtx({ equity: 10 }));
    expect(result.ok).toBe(false);
    expect(findCheck(result, 'quantity').passed).toBe(false);
  });

  describe('step-down sizing', () => {
    it('is inactive below the consecutive-loss threshold', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ consecutiveLosses: 1 }));
      expect(result.stepDownActive).toBe(false);
      expect(result.sizing.suggestedQuantity).toBe(200); // full 1% sizing
      expect(findCheck(result, 'step_down_sizing').detail).toMatch(/inactive/);
    });

    it('cuts size by stepDownSizeCutPct once the threshold is reached', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ consecutiveLosses: 2 }));
      expect(result.stepDownActive).toBe(true);
      // 1% * (1 - 50%) = 0.5% of 100,000 = 500 risk budget / $5 stop = 100 shares
      expect(result.sizing.suggestedQuantity).toBe(100);
      expect(result.sizing.riskOfPosition).toBe(500);
      expect(findCheck(result, 'step_down_sizing').detail).toMatch(/active/);
    });

    it('stays active above the threshold, not just exactly at it', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ consecutiveLosses: 5 }));
      expect(result.stepDownActive).toBe(true);
    });
  });

  describe('regime-aware sizing (2026-07-16)', () => {
    it('is inactive when marketAtrPct is null (unknown, e.g. a fetch failure)', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ marketAtrPct: null, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(false);
      expect(result.sizing.suggestedQuantity).toBe(200); // full 1% sizing
      expect(findCheck(result, 'regime_sizing').detail).toMatch(/inactive/);
    });

    it('is inactive at or below the threshold, not just comfortably under it', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ marketAtrPct: 3, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(false);
      expect(result.sizing.suggestedQuantity).toBe(200);
    });

    it('cuts size by regimeSizeCutPct once marketAtrPct exceeds the threshold', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(true);
      // 1% * (1 - 30%) = 0.7% of 100,000 = 700 risk budget / $5 stop = 140 shares
      expect(result.sizing.suggestedQuantity).toBe(140);
      expect(result.sizing.riskOfPosition).toBe(700);
      expect(findCheck(result, 'regime_sizing').detail).toMatch(/active/);
    });

    it('stacks multiplicatively with step-down sizing when both are active', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ consecutiveLosses: 2, marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.stepDownActive).toBe(true);
      expect(result.regimeActive).toBe(true);
      // 1% * (1 - 50%) * (1 - 30%) = 0.35% of 100,000 = 350 / $5 stop = 70 shares
      expect(result.sizing.suggestedQuantity).toBe(70);
    });

    it('reports active with regimeSizeCutPct left at 0 (default) but applies no actual size change', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 0 }),
      );
      expect(result.regimeActive).toBe(true);
      expect(result.sizing.suggestedQuantity).toBe(200); // unchanged — same as full 1% sizing
    });
  });

  describe('daily drawdown halt', () => {
    it('passes when today is flat or positive', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ dailyPnl: 0 }));
      expect(findCheck(result, 'daily_drawdown_halt').passed).toBe(true);
    });

    it('passes just short of the halt level (3% of 100k = -3000)', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ dailyPnl: -2999 }));
      expect(findCheck(result, 'daily_drawdown_halt').passed).toBe(true);
    });

    it('blocks at or beyond the halt level', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ dailyPnl: -3000 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'daily_drawdown_halt').passed).toBe(false);
    });
  });

  describe('daily trade cap', () => {
    it('blocks at the profile max (MODERATE: 6/day)', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ tradesToday: 6 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_trades_per_day').passed).toBe(false);
    });

    it('passes just under the max', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ tradesToday: 5 }));
      expect(findCheck(result, 'max_trades_per_day').passed).toBe(true);
    });
  });

  describe('concurrent position cap', () => {
    it('blocks at the profile max (MODERATE: 2)', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ openPositionsCount: 2 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_concurrent_positions').passed).toBe(false);
    });
  });

  describe('CRITICAL: max aggregate open risk', () => {
    it('blocks a trade whose per-trade risk and position count are BOTH individually fine, purely because the aggregate would exceed the cap', () => {
      // MODERATE cap = 2% of 100k = $2000. One open position already carries
      // $1500 of risk (1 position, well under the 2-position cap). This new
      // trade's own risk is a completely normal $1000 (1% of equity) — but
      // 1500 + 1000 = 2500 > 2000, so it must block. This is the exact
      // scenario docs/AUTOTRADING_SPEC.md calls out as the reason this check
      // exists separately from the daily halt and the position-count cap.
      const result = evaluateRiskCheck(signal(), baseCtx({ openRisk: 1500, openPositionsCount: 1 }));
      expect(result.ok).toBe(false);
      const check = findCheck(result, 'max_aggregate_open_risk');
      expect(check.passed).toBe(false);
      // Every OTHER check still passes individually, proving this one check —
      // not a pile-up of unrelated failures — is what's blocking the trade.
      expect(result.checks.filter((c) => c.rule !== 'max_aggregate_open_risk').every((c) => c.passed)).toBe(true);
    });

    it('passes when the aggregate (existing + proposed) stays within the cap', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ openRisk: 900, openPositionsCount: 1 }));
      expect(findCheck(result, 'max_aggregate_open_risk').passed).toBe(true); // 900+1000=1900 <= 2000
    });

    it('passes at exactly the cap boundary', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ openRisk: 1000, openPositionsCount: 1 }));
      expect(findCheck(result, 'max_aggregate_open_risk').passed).toBe(true); // 1000+1000=2000 <= 2000
    });
  });

  describe('correlated-ticker exposure cap', () => {
    it("does NOT count the proposed trade's own notional — a lone, uncorrelated first trade never blocks on this", () => {
      // This trade's own position cost is $20,000 (200 sh * $100), which alone
      // would exceed MODERATE's 6%-of-equity ($6000) cap if it were wrongly
      // included in "correlated" exposure — a symbol is trivially "correlated"
      // with itself, so this check must be about EXISTING correlated capital.
      const result = evaluateRiskCheck(signal(), baseCtx({ correlatedNotional: 0 }));
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(true);
    });

    it('blocks when capital already correlated with this symbol exceeds the cap', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ correlatedNotional: 7000 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(false); // 7000 > 6000 cap
    });

    it('passes at exactly the cap boundary', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ correlatedNotional: 6000 }));
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(true);
    });
  });

  describe('sector exposure cap', () => {
    it('is skipped entirely (no rule added) when the candidate has no sector classification', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ candidateSector: null, sectorNotional: 999_999 }));
      expect(result.checks.find((c) => c.rule === 'max_sector_exposure')).toBeUndefined();
      expect(result.ok).toBe(true); // the huge sectorNotional never gets a chance to block anything
    });

    it("does NOT count the proposed trade's own notional — a lone position in its own sector never blocks on this", () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ candidateSector: 'Technology', sectorNotional: 0 }));
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(true);
    });

    it('blocks when capital already in this sector exceeds the cap', () => {
      // MODERATE-style fixture: 20% of $100k = $20,000 cap.
      const result = evaluateRiskCheck(signal(), baseCtx({ candidateSector: 'Technology', sectorNotional: 21_000 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(false);
      expect(findCheck(result, 'max_sector_exposure').detail).toMatch(/already in Technology/);
    });

    it('passes at exactly the cap boundary', () => {
      const result = evaluateRiskCheck(signal(), baseCtx({ candidateSector: 'Technology', sectorNotional: 20_000 }));
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(true);
    });

    it('is independent of the correlated-exposure cap — one can block while the other passes', () => {
      const result = evaluateRiskCheck(
        signal(),
        baseCtx({ correlatedNotional: 0, candidateSector: 'Technology', sectorNotional: 25_000 }),
      );
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(true);
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(false);
      expect(result.ok).toBe(false);
    });
  });

  it('every cap comes directly from ctx — evaluateRiskCheck takes no separate risk-profile argument at all', () => {
    // riskProfiles.ts's RISK_PROFILES/RiskProfileParams table is gone entirely
    // (2026-07-10) — every number evaluateRiskCheck uses is a plain field on
    // the ctx it's called with, so two identically-shaped ctx objects always
    // produce identical results regardless of what riskProfile string a
    // caller happens to have stored elsewhere (evaluateRiskCheck never even
    // sees it).
    const a = evaluateRiskCheck(signal(), baseCtx({ maxAggregateOpenRiskPct: 10 }));
    const b = evaluateRiskCheck(signal(), baseCtx({ maxAggregateOpenRiskPct: 10 }));
    expect(a.checks).toEqual(b.checks);
  });
});

describe('runAutotradeRiskCheck — batch orchestration', () => {
  beforeAll(() => initDb());
  beforeEach(() => {
    db.exec('DELETE FROM position_exits; DELETE FROM positions;');
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  });

  it('blocks every signal when equity has never been set', async () => {
    db.exec('DELETE FROM autotrade_config');
    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].checks[0].rule).toBe('equity_configured');
  });

  it('journals a passed result', async () => {
    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(true);
    const events = listAutotradeEvents({ stage: 'risk_check', symbol: 'AAPL' });
    expect(events[0].action).toBe('passed');
    expect(events[0].riskProfile).toBe('MODERATE');
  });

  it('journals a blocked result with the failing checks in detail', async () => {
    // Force a block via an already-huge open position (aggregate risk).
    createPosition({
      assetType: 'stock',
      symbol: 'OPEN1',
      side: 'long',
      quantity: 1000,
      entryPrice: 50,
      entryDate: '2026-01-01',
      stopPrice: 48.5, // $1.5 stop distance * 1000 = $1500 risk
      tags: ['autotrade'],
    });
    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(false);
    const events = listAutotradeEvents({ stage: 'risk_check', symbol: 'AAPL' });
    expect(events[0].action).toBe('blocked');
    expect(
      JSON.parse(events[0].detail!).checks.some((c: { rule: string }) => c.rule === 'max_aggregate_open_risk'),
    ).toBe(true);
  });

  it('reads real open positions from the journal for the concurrent-position and aggregate-risk counts', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'OPEN1',
      side: 'long',
      quantity: 100,
      entryPrice: 50,
      entryDate: '2026-01-01',
      stopPrice: 49,
      tags: ['autotrade'],
    });
    createPosition({
      assetType: 'stock',
      symbol: 'OPEN2',
      side: 'long',
      quantity: 100,
      entryPrice: 30,
      entryDate: '2026-01-01',
      stopPrice: 29,
      tags: ['autotrade'],
    });
    // MODERATE's concurrent-position cap is 2 — already at capacity.
    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].checks.find((c) => c.rule === 'max_concurrent_positions')?.passed).toBe(false);
  });

  it('ignores manually-placed (non-autotrade) positions entirely — they never count toward concurrent-position or aggregate-risk', async () => {
    // No 'autotrade' tag on either — same shape a human's own Trade-page
    // entries would have. Two of them (MODERATE's concurrent-position cap is
    // 2) each sized huge on risk too, specifically to prove neither is just
    // under the radar: if these counted, they alone would blow both caps
    // below on their own, the same confusion a real user hit in practice.
    createPosition({
      assetType: 'stock',
      symbol: 'MANUAL1',
      side: 'long',
      quantity: 1000,
      entryPrice: 50,
      entryDate: '2026-01-01',
      stopPrice: 40, // $10 stop distance * 1000 = $10,000 risk — 10% of equity alone
    });
    createPosition({
      assetType: 'stock',
      symbol: 'MANUAL2',
      side: 'long',
      quantity: 1000,
      entryPrice: 30,
      entryDate: '2026-01-01',
      stopPrice: 25,
    });
    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(true);
    expect(results[0].checks.find((c) => c.rule === 'max_concurrent_positions')?.passed).toBe(true);
    expect(results[0].checks.find((c) => c.rule === 'max_aggregate_open_risk')?.passed).toBe(true);
  });

  it('accumulates risk sequentially across a batch — signals that would each pass alone can jointly exhaust the cap', async () => {
    // MODERATE aggregate cap = 2% of 100k = $2000. Each signal below sizes to
    // exactly $1000 of risk on its own (1% of equity, $5 stop distance) — well
    // under the cap individually. Evaluated as a batch: #1 passes (0+1000<=2000,
    // running->1000), #2 passes at the boundary (1000+1000<=2000, running->2000),
    // #3 must block (2000+1000>2000) even though its OWN risk is identical to
    // the first two that passed — proving the batch doesn't just re-check a
    // static snapshot for every signal.
    const results = await runAutotradeRiskCheck([
      signal({ symbol: 'ONE' }),
      signal({ symbol: 'TWO' }),
      signal({ symbol: 'THREE' }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2].checks.find((c) => c.rule === 'max_aggregate_open_risk')?.passed).toBe(false);
  });

  it("computes daily P&L and a losing streak from today's closed trades", async () => {
    const p1 = createPosition({
      assetType: 'stock',
      symbol: 'LOSS1',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-01-01',
      tags: ['autotrade'],
    });
    db.prepare("UPDATE positions SET status = 'closed' WHERE id = ?").run(p1.id);
    const today = etDateStr();
    db.prepare(
      'INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, created_at) VALUES (?,?,?,?,0,?)',
    ).run(p1.id, 10, 90, today, Date.now()); // -$100 realized loss today

    const p2 = createPosition({
      assetType: 'stock',
      symbol: 'LOSS2',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-01-01',
      tags: ['autotrade'],
    });
    db.prepare("UPDATE positions SET status = 'closed' WHERE id = ?").run(p2.id);
    db.prepare(
      'INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, created_at) VALUES (?,?,?,?,0,?)',
    ).run(p2.id, 10, 85, today, Date.now() + 1); // another loss today, second in a row

    const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
    // 2 consecutive losses hits MODERATE's step-down trigger (2).
    expect(results[0].stepDownActive).toBe(true);
  });

  it('buckets dailyPnl and tradesToday by US/Eastern, not UTC, across the UTC-midnight boundary', async () => {
    // 11:30pm ET on Jul 3 is 3:30am UTC on Jul 4 (EDT = UTC-4) — a UTC-based
    // "today" would wrongly call this exit/order "yesterday." Regression for
    // a known gap (flagged during Phase 6's review): getPortfolioSnapshot()
    // used to bucket via toISOString() (UTC) for dailyPnl and a separate
    // server-local-time midnight for tradesToday — both wrong the same way.
    vi.useFakeTimers();
    const eveningEt = new Date('2026-07-03T23:30:00-04:00').getTime();
    vi.setSystemTime(eveningEt);
    try {
      const p1 = createPosition({
        assetType: 'stock',
        symbol: 'LATE1',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-07-01',
        tags: ['autotrade'],
      });
      db.prepare("UPDATE positions SET status = 'closed' WHERE id = ?").run(p1.id);
      db.prepare(
        'INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, created_at) VALUES (?,?,?,?,0,?)',
      ).run(p1.id, 10, 90, etDateStr(), Date.now()); // -$100, dated "today" in ET
      logAutotradeEvent({ symbol: 'LATE1', stage: 'execution', action: 'order_placed' });

      const results = await runAutotradeRiskCheck([signal({ symbol: 'AAPL' })]);
      const dailyHaltLevel = findCheck(results[0], 'daily_drawdown_halt').detail;
      expect(dailyHaltLevel).toMatch(/\$-100\.00/); // dailyPnl picked up the late exit (usd() formats as $-100.00)
      expect(findCheck(results[0], 'max_trades_per_day').detail).toMatch(/^1 placed/); // tradesToday picked up the late order
    } finally {
      vi.useRealTimers();
    }
  });
});
