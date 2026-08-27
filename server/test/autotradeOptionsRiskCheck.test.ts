import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition } from '../src/db/positions';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { evaluateOptionsRiskCheck, runOptionsRiskCheck } from '../src/services/autotrading/optionsRiskCheck';
import { runAutotradeRiskCheck, RiskCheckContext } from '../src/services/autotrading/riskCheck';
import { DebitSpreadOptionsSignal, SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';
import { TradeSignal } from '../src/services/autotrading/decide';

function optionSignal(overrides: Partial<SingleLegOptionsSignal> = {}): SingleLegOptionsSignal {
  return {
    kind: 'single_leg',
    symbol: 'TEST',
    side: 'call',
    underlyingPrice: 100,
    contractSymbol: 'TEST-fixture',
    strike: 100,
    expiration: '2024-03-15',
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
    symbol: 'TEST',
    side: 'call',
    underlyingPrice: 100,
    expiration: '2024-03-15',
    dte: 21,
    ivRank: 50,
    longContractSymbol: 'TEST-long',
    longStrike: 100,
    longPremium: 3,
    longDelta: 0.45,
    shortContractSymbol: 'TEST-short',
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

function equitySignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: 'EQ',
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
    correlationThreshold: 0.7,
    marketAtrPct: null,
    regimeAtrThresholdPct: 3,
    regimeSizeCutPct: 0,
    ...overrides,
  };
}

const findCheck = (result: ReturnType<typeof evaluateOptionsRiskCheck>, rule: string) =>
  result.checks.find((c) => c.rule === rule)!;

/** Narrow the sizing union to the single-leg shape these assertions exercise. */
const sz = (result: ReturnType<typeof evaluateOptionsRiskCheck>) => {
  if (!('suggestedQuantity' in result.sizing)) throw new Error('expected single-leg sizing');
  return result.sizing;
};

describe('evaluateOptionsRiskCheck — pure evaluator', () => {
  it('passes a clean signal with no competing exposure', () => {
    const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx());
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('sizes by full premium paid (stopPrice: 0): 1% of $100k = $1000 budget / ($3 premium x 100) = 3 contracts', () => {
    const result = evaluateOptionsRiskCheck(optionSignal({ premium: 3 }), baseCtx());
    expect(sz(result).suggestedQuantity).toBe(3);
    expect(sz(result).riskOfPosition).toBe(900); // 3 contracts x $300 risk/contract
    expect(result.approvedRiskAmount).toBe(900);
    // A long option's notional IS its premium paid — no separate "position value"
    // beyond what was risked, unlike a stock where notional usually exceeds risk.
    expect(result.approvedNotional).toBe(900);
  });

  it('sizes identically for a long put (side is directional only, not a sizing input)', () => {
    const result = evaluateOptionsRiskCheck(optionSignal({ side: 'put', premium: 3 }), baseCtx());
    expect(sz(result).suggestedQuantity).toBe(3);
  });

  it('blocks everything when equity is not configured', () => {
    const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ equity: 0 }));
    expect(result.ok).toBe(false);
    expect(findCheck(result, 'equity_configured').passed).toBe(false);
    expect(sz(result).suggestedQuantity).toBe(0);
  });

  it('blocks when the risk budget cannot size even one contract', () => {
    // $10 equity * 1% = $0.10 budget; a $3 premium x 100 = $300/contract -> 0 contracts.
    const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ equity: 10 }));
    expect(result.ok).toBe(false);
    expect(findCheck(result, 'quantity').passed).toBe(false);
  });

  describe('step-down sizing', () => {
    it('cuts size by stepDownSizeCutPct once the consecutive-loss threshold is reached', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ consecutiveLosses: 2 }));
      expect(result.stepDownActive).toBe(true);
      // 0.5% of 100,000 = $500 budget / $300 per contract = 1 contract
      expect(sz(result).suggestedQuantity).toBe(1);
    });
  });

  describe('regime-aware sizing (2026-07-16)', () => {
    it('is inactive when marketAtrPct is null (unknown, e.g. a fetch failure)', () => {
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ marketAtrPct: null, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(false);
      expect(sz(result).suggestedQuantity).toBe(3); // full 1% sizing
    });

    it('is inactive at a threshold of 0 — "0 disables", matching the equity path', () => {
      // Without the > 0 guard any market ATR% exceeds 0, so setting the threshold
      // to 0 to turn the feature OFF instead half-sized every options position
      // while equity (which has the guard) used the full risk %.
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ marketAtrPct: 6, regimeAtrThresholdPct: 0, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(false);
      expect(sz(result).suggestedQuantity).toBe(3); // full 1% sizing, uncut
    });

    it('cuts size by regimeSizeCutPct once marketAtrPct exceeds the threshold', () => {
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(true);
      // 1% * (1 - 30%) = 0.7% of 100,000 = $700 budget / $300 per contract = 2 contracts
      expect(sz(result).suggestedQuantity).toBe(2);
    });

    it('stacks multiplicatively with step-down sizing when both are active', () => {
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ consecutiveLosses: 2, marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.stepDownActive).toBe(true);
      expect(result.regimeActive).toBe(true);
      // 1% * (1 - 50%) * (1 - 30%) = 0.35% of 100,000 = $350 budget / $300 per contract = 1 contract
      expect(sz(result).suggestedQuantity).toBe(1);
    });

    it('cuts a debit spread exactly like a single leg', () => {
      const result = evaluateOptionsRiskCheck(
        spreadSignal(),
        baseCtx({ marketAtrPct: 6, regimeAtrThresholdPct: 3, regimeSizeCutPct: 30 }),
      );
      expect(result.regimeActive).toBe(true);
      // 0.7% of 100,000 = $700 budget / $200 per spread = 3 spreads (floor(3.5))
      expect('suggestedContracts' in result.sizing && result.sizing.suggestedContracts).toBe(3);
    });
  });

  describe('daily drawdown halt', () => {
    it('blocks at or beyond the halt level (3% of 100k = -3000)', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ dailyPnl: -3000 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'daily_drawdown_halt').passed).toBe(false);
    });
  });

  describe('daily trade cap', () => {
    it('blocks at the profile max (MODERATE: 6/day)', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ tradesToday: 6 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_trades_per_day').passed).toBe(false);
    });
  });

  describe('concurrent position cap', () => {
    it('blocks at the profile max (MODERATE: 2) — combined with however many equity positions are already open', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ openPositionsCount: 2 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_concurrent_positions').passed).toBe(false);
    });
  });

  describe('CRITICAL: max aggregate open risk', () => {
    it('blocks an options signal whose own risk is individually fine, purely because combined with existing risk it would exceed the cap', () => {
      // MODERATE cap = 2% of 100k = $2000. $1500 already at risk (e.g. from
      // equity positions or an earlier-approved signal this batch); this
      // option's own risk is a normal $900 - 1500+900=2400 > 2000, must block.
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ openRisk: 1500 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_aggregate_open_risk').passed).toBe(false);
    });

    it('passes at exactly the cap boundary', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ openRisk: 1100 }));
      expect(findCheck(result, 'max_aggregate_open_risk').passed).toBe(true); // 1100+900=2000 <= 2000
    });
  });

  describe('correlated-ticker exposure cap', () => {
    it("does NOT count the proposed option's own notional", () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ correlatedNotional: 0 }));
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(true);
    });

    it('blocks when capital already correlated with this underlying exceeds the cap', () => {
      const result = evaluateOptionsRiskCheck(optionSignal(), baseCtx({ correlatedNotional: 7000 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_correlated_exposure').passed).toBe(false); // 7000 > 6000 cap
    });
  });

  describe('sector exposure cap', () => {
    it('is skipped entirely (no rule added) when the candidate has no sector classification', () => {
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ candidateSector: null, sectorNotional: 999_999 }),
      );
      expect(result.checks.find((c) => c.rule === 'max_sector_exposure')).toBeUndefined();
    });

    it("does NOT count the proposed option's own notional", () => {
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ candidateSector: 'Technology', sectorNotional: 0 }),
      );
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(true);
    });

    it("blocks when capital already in this underlying's sector exceeds the cap", () => {
      // 20% of $100k = $20,000 cap.
      const result = evaluateOptionsRiskCheck(
        optionSignal(),
        baseCtx({ candidateSector: 'Technology', sectorNotional: 21_000 }),
      );
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'max_sector_exposure').passed).toBe(false);
    });
  });

  describe('debit spread (signal.kind: debit_spread)', () => {
    it('sizes by max loss per spread, not premium alone: 1% of $100k = $1000 budget / $200 max loss per spread = 5 spreads', () => {
      const result = evaluateOptionsRiskCheck(spreadSignal(), baseCtx());
      expect(result.ok).toBe(true);
      expect('suggestedContracts' in result.sizing && result.sizing.suggestedContracts).toBe(5);
      expect(result.approvedRiskAmount).toBe(1000); // 5 spreads x $200 max loss/spread
    });

    it('approvedNotional equals approvedRiskAmount — capital tied up IS the max loss for a debit spread', () => {
      const result = evaluateOptionsRiskCheck(spreadSignal(), baseCtx());
      expect(result.approvedNotional).toBe(result.approvedRiskAmount);
      expect(result.approvedNotional).toBe(1000);
    });

    it('blocks when the risk budget cannot size even one spread', () => {
      // $10 equity x 1% = $0.10 budget; $200 max loss/spread -> 0 spreads.
      const result = evaluateOptionsRiskCheck(spreadSignal(), baseCtx({ equity: 10 }));
      expect(result.ok).toBe(false);
      expect(findCheck(result, 'quantity').passed).toBe(false);
    });

    it("counts a spread's max loss (not its notional/premium) toward the combined aggregate-risk budget", () => {
      // MODERATE cap = 2% of 100k = $2000. $1000 already at risk; this spread's
      // own risk is $1000 (5 x $200) - 1000+1000=2000, exactly at the cap.
      const atCap = evaluateOptionsRiskCheck(spreadSignal(), baseCtx({ openRisk: 1000 }));
      expect(findCheck(atCap, 'max_aggregate_open_risk').passed).toBe(true);

      const overCap = evaluateOptionsRiskCheck(spreadSignal(), baseCtx({ openRisk: 1001 }));
      expect(overCap.ok).toBe(false);
      expect(findCheck(overCap, 'max_aggregate_open_risk').passed).toBe(false);
    });

    it('cuts spread size via step-down sizing exactly like a single leg', () => {
      // 0.5% of 100,000 = $500 budget / $200 per spread = 2 spreads (floor(2.5)).
      const result = evaluateOptionsRiskCheck(spreadSignal(), baseCtx({ consecutiveLosses: 2 }));
      expect(result.stepDownActive).toBe(true);
      expect('suggestedContracts' in result.sizing && result.sizing.suggestedContracts).toBe(2);
    });
  });
});

describe('runOptionsRiskCheck — batch orchestration', () => {
  beforeAll(() => initDb());
  beforeEach(() => {
    db.exec('DELETE FROM position_exits; DELETE FROM positions;');
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  });

  it('blocks every signal when equity has never been set', async () => {
    db.exec('DELETE FROM autotrade_config');
    const results = await runOptionsRiskCheck([optionSignal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].checks[0].rule).toBe('equity_configured');
  });

  it('journals a passed result under the shared risk_check stage', async () => {
    const results = await runOptionsRiskCheck([optionSignal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(true);
    const events = listAutotradeEvents({ stage: 'risk_check', symbol: 'AAPL' });
    expect(events[0].action).toBe('passed');
    expect(events[0].riskProfile).toBe('MODERATE');
  });

  it('reads REAL open equity positions for the concurrent-position and aggregate-risk counts — one combined pool, not a separate options-only one', async () => {
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
    // MODERATE's concurrent-position cap is 2 — already at capacity from equity alone.
    const results = await runOptionsRiskCheck([optionSignal({ symbol: 'AAPL' })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].checks.find((c) => c.rule === 'max_concurrent_positions')?.passed).toBe(false);
  });

  it('accumulates risk sequentially across an options-only batch', async () => {
    // MODERATE aggregate cap = $2000. Each option below risks $900 on its own.
    // #1: 0+900<=2000 pass, running->900. #2: 900+900=1800<=2000 pass, running->1800.
    // #3: 1800+900=2700>2000 must block, even though its own risk matches the first two.
    const results = await runOptionsRiskCheck([
      optionSignal({ symbol: 'ONE' }),
      optionSignal({ symbol: 'TWO' }),
      optionSignal({ symbol: 'THREE' }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });

  it("combines with an equity batch's approved risk — options signals correctly draw down the SAME budget equity already spent this cycle", async () => {
    const equityResults = await runAutotradeRiskCheck([equitySignal({ symbol: 'EQ' })]); // sizes to exactly $1000 risk (1% of 100k, $5 stop)
    expect(equityResults[0].approvedRiskAmount).toBe(1000);

    // This option sizes to $900 (3 contracts x $300) purely on its OWN 1%
    // budget — passes if evaluated alone — but 1000 (equity, already
    // approved this batch) + 900 = 1900 <= 2000, so it should still PASS,
    // proving the combined budget isn't overly conservative either.
    const passResults = await runOptionsRiskCheck([optionSignal({ symbol: 'AAPL', premium: 3 })], equityResults);
    expect(passResults[0].ok).toBe(true);

    // Approving a SECOND option on top of that combined 1900 pushes to
    // 1900+900=2800 > 2000 — must block, purely from the combined equity +
    // options running total, with no real `positions` row involved at all.
    const blockResults = await runOptionsRiskCheck(
      [optionSignal({ symbol: 'AAPL', premium: 3 }), optionSignal({ symbol: 'MSFT', premium: 3 })],
      equityResults,
    );
    expect(blockResults[0].ok).toBe(true);
    expect(blockResults[1].ok).toBe(false);
    expect(blockResults[1].checks.find((c) => c.rule === 'max_aggregate_open_risk')?.passed).toBe(false);
  });

  it('ignores a BLOCKED equity result — only approved (ok: true) signals contribute to the combined budget', async () => {
    // An equity signal that itself failed risk-check (ok: false) carries
    // approvedRiskAmount: 0 by construction, but this proves the filter is
    // explicit (by `ok`), not just incidentally zero.
    const approvedEquity = await runAutotradeRiskCheck([equitySignal({ symbol: 'EQ' })]);
    const forcedBlocked = { ...approvedEquity[0], ok: false, approvedRiskAmount: 5000 }; // contrived: ok:false but a nonzero amount
    const results = await runOptionsRiskCheck([optionSignal({ symbol: 'AAPL', premium: 3 })], [forcedBlocked]);
    // If the $5000 had wrongly been added, 5000+900=5900 > 2000 would block.
    expect(results[0].ok).toBe(true);
  });

  it('accumulates a single leg and a debit spread against the SAME running budget, in one batch', async () => {
    // MODERATE aggregate cap = $2000. The single leg risks $900; the spread
    // risks $1000 (5 spreads x $200 max loss/spread). 900+1000=1900<=2000
    // both pass; a third signal of either shape would now push over the cap.
    const results = await runOptionsRiskCheck([optionSignal({ symbol: 'ONE' }), spreadSignal({ symbol: 'TWO' })]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[0].approvedRiskAmount).toBe(900);
    expect(results[1].approvedRiskAmount).toBe(1000);

    const overCap = await runOptionsRiskCheck([
      optionSignal({ symbol: 'ONE' }),
      spreadSignal({ symbol: 'TWO' }),
      optionSignal({ symbol: 'THREE' }),
    ]);
    expect(overCap.map((r) => r.ok)).toEqual([true, true, false]);
  });

  it("journals a debit spread's SUGGESTED CONTRACT COUNT as its spread count, not a single-leg quantity", async () => {
    await runOptionsRiskCheck([spreadSignal({ symbol: 'AAPL' })]);
    const events = listAutotradeEvents({ stage: 'risk_check', symbol: 'AAPL' });
    const detail = JSON.parse(events[0].detail!) as { contracts: number };
    expect(detail.contracts).toBe(5); // suggestedContracts, not suggestedQuantity (which doesn't exist here)
  });
});
