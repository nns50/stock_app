import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { saveDailyBaseline } from '../src/db/dailyBaseline';
import { etToday } from '../src/util/marketDate';
import { dayLossBudgetUsd, dayStartEquityUsd } from '../src/services/autotrading/dayLossBudget';
import { evaluateRiskCheck, RiskCheckContext } from '../src/services/autotrading/riskCheck';
import { evaluateOptionsRiskCheck } from '../src/services/autotrading/optionsRiskCheck';
import { evaluateDailyTarget } from '../src/services/autotrading/dailyTarget';
import { TradeSignal } from '../src/services/autotrading/decide';
import { SingleLegOptionsSignal } from '../src/services/autotrading/optionsDecide';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { withLoopRealizedToday } from '../src/services/autotrading/liveExecute';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';
import type { AccountState } from '../src/services/trading/guardrails';

beforeAll(() => initDb());
beforeEach(() => {
  db.prepare('DELETE FROM autotrade_daily_baseline').run();
});

const signal = (o: Partial<TradeSignal> = {}): TradeSignal => ({
  symbol: 'TEST',
  side: 'buy',
  entry: 100,
  stop: 95,
  target: 110,
  rMultiple: 2,
  rationale: 'fixture',
  score: 70,
  ...o,
});

const optionsSignal = (o: Partial<SingleLegOptionsSignal> = {}): SingleLegOptionsSignal => ({
  kind: 'single_leg',
  symbol: 'TEST',
  side: 'call',
  underlyingPrice: 100,
  contractSymbol: 'TEST-fixture',
  strike: 100,
  expiration: '2030-01-18',
  dte: 21,
  premium: 3,
  delta: 0.45,
  ivRank: 50,
  maxLossPerContract: 300,
  rationale: 'fixture',
  score: 70,
  ...o,
});

/** Everything passes; each test moves only what it is about. */
const ctx = (o: Partial<RiskCheckContext> = {}): RiskCheckContext =>
  ({
    equity: 100_000,
    dayStartEquityUsd: 100_000,
    dailyPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    openRisk: 0,
    openPositionsCount: 0,
    maxConcurrentPositions: 3,
    correlatedNotional: 0,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 6,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 6,
    maxCorrelatedExposurePct: 80,
    maxTradesPerDay: 10,
    correlationThreshold: 0.8,
    sectorNotional: 0,
    maxSectorExposurePct: 80,
    candidateSector: null,
    marketAtrPct: null,
    regimeAtrThresholdPct: 0,
    regimeSizeCutPct: 0,
    mlRegime: null,
    mlRegimeEnabled: false,
    mlRegimeSizeCutPct: 0,
    todayRangePct: null,
    regimeShockRangeRatio: 0,
    priorSameDayExits: 0,
    repeatEntrySizeCutPct: 0,
    equityCurveDeriskActive: false,
    gradeExpectancyMultipliers: {},
    methodMultipliers: {},
    ...o,
  }) as RiskCheckContext;

const rule = (checks: { rule: string; passed: boolean; detail: string }[], name: string) =>
  checks.find((c) => c.rule === name)!;

describe('dayLossBudgetUsd', () => {
  it('is the percentage of the day-start equity, as a positive magnitude', () => {
    expect(dayLossBudgetUsd(7.5, 33_694.39)).toBeCloseTo(2527.08, 2);
    expect(dayLossBudgetUsd(7.5, 3_694.39)).toBeCloseTo(277.08, 2);
  });

  it('is 0 when either side is missing, never negative or NaN', () => {
    expect(dayLossBudgetUsd(0, 10_000)).toBe(0);
    expect(dayLossBudgetUsd(7.5, 0)).toBe(0);
    expect(dayLossBudgetUsd(-1, 10_000)).toBe(0);
    expect(dayLossBudgetUsd(7.5, Number.NaN)).toBe(0);
  });
});

describe('dayStartEquityUsd', () => {
  it("prefers today's baseline", () => {
    const baseline = saveDailyBaseline(etToday(), 3_694.39);
    expect(dayStartEquityUsd(baseline, etToday(), 591.81)).toEqual({ usd: 3694.39, fromBaseline: true });
  });

  it('falls back to the live reading when there is no baseline, or it is yesterday’s', () => {
    expect(dayStartEquityUsd(null, etToday(), 591.81)).toEqual({ usd: 591.81, fromBaseline: false });
    const stale = saveDailyBaseline('2020-01-02', 10_000);
    expect(dayStartEquityUsd(stale, etToday(), 591.81)).toEqual({ usd: 591.81, fromBaseline: false });
  });

  it('falls back on a zero or negative baseline rather than dividing by it', () => {
    const zeroed = { ...saveDailyBaseline(etToday(), 3_694.39), equityUsd: 0 };
    expect(dayStartEquityUsd(zeroed, etToday(), 591.81).usd).toBe(591.81);
  });
});

// The producer above is not the point. These are the CONSUMERS: each one used
// to divide by its own equity reading, and a unit test on the formula alone
// would have passed throughout.
describe('the halt reads the day-start equity, not the current reading', () => {
  it('equity risk check: a collapsed reading does not shrink the day’s budget', () => {
    // 2026-09-15's shape: the day opened at 3,694.39 and net liquidation read
    // 591.81 intraday (an operator-held 0DTE put decaying, not the loop).
    const r = evaluateRiskCheck(
      signal(),
      ctx({ equity: 591.81, dayStartEquityUsd: 3_694.39, maxDailyDrawdownPct: 7.5, dailyPnl: -100 }),
    );
    const halt = rule(r.checks, 'daily_drawdown_halt');
    expect(halt.passed).toBe(true); // -100 is inside -277.08
    expect(halt.detail).toContain('halt at $-277.08');
    expect(halt.detail).toContain("day's opening $3,694.39");
  });

  it('equity risk check: still halts once the LOOP’s own day passes the budget', () => {
    const r = evaluateRiskCheck(
      signal(),
      ctx({ equity: 591.81, dayStartEquityUsd: 3_694.39, maxDailyDrawdownPct: 7.5, dailyPnl: -300 }),
    );
    expect(rule(r.checks, 'daily_drawdown_halt').passed).toBe(false);
  });

  // The options twin, driven the other way round: a LARGE current reading and
  // a small day-start. Reading `equity` would put the halt at -$7,500 and pass;
  // reading the day-start puts it at -$277.08 and halts.
  it('options risk check: the same budget, from the same function', () => {
    const r = evaluateOptionsRiskCheck(
      optionsSignal(),
      ctx({ equity: 100_000, dayStartEquityUsd: 3_694.39, maxDailyDrawdownPct: 7.5, dailyPnl: -300 }),
    );
    const halt = rule(r.checks, 'daily_drawdown_halt');
    expect(halt.passed).toBe(false);
    expect(halt.detail).toContain('halt at $-277.08');
    expect(halt.detail).toContain("day's opening $3,694.39");
  });

  it('equity risk check, the same way round', () => {
    const r = evaluateRiskCheck(
      signal(),
      ctx({ equity: 100_000, dayStartEquityUsd: 3_694.39, maxDailyDrawdownPct: 7.5, dailyPnl: -300 }),
    );
    expect(rule(r.checks, 'daily_drawdown_halt').passed).toBe(false);
  });
});

// The property that was missing, stated as a test rather than as a comment:
// the day's goal and the day's halt are percentages of the SAME dollars. On
// 2026-09-15 they were not — the goal was $110.83 and the halt $44.39 — so the
// book had to win more than it was allowed to lose before being stopped.
describe('the goal and the halt share a denominator', () => {
  it('a 3% goal and a 7.5% halt stand 2.5:1 apart, whatever the current reading says', () => {
    const baselineUsd = 3_694.39;
    const baseline = saveDailyBaseline(etToday(), baselineUsd);
    const cfg = { ...defaultAutotradeConfig(), targetDailyGainPct: 3, accountEquityUsd: 591.81 };
    const target = evaluateDailyTarget(cfg, baseline, 0);

    const budget = dayLossBudgetUsd(7.5, dayStartEquityUsd(baseline, etToday(), 591.81).usd);
    expect(target.targetPnlUsd).toBeCloseTo(110.83, 2);
    expect(budget).toBeCloseTo(277.08, 2);
    expect(budget / (target.targetPnlUsd as number)).toBeCloseTo(2.5, 3);
  });
});

// The numerator's consumer. `AccountState.realizedPnlTodayUsd` is account-wide
// by design — the worse of the broker's day figure and EVERY exit the journal
// dates today, hand trades included. That is right for the Trade page and
// wrong for the loop, and before 2026-09-15 the loop used it: an operator
// trade could halt the book's entries. PR #610 made exactly this correction to
// dailyTarget and never reached the dollar twin, which is the tighter one.
describe('withLoopRealizedToday — an operator’s loss is not the loop’s day', () => {
  beforeEach(() => {
    db.exec('DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_options_positions;');
  });

  const accountState = (over: Partial<AccountState> = {}): AccountState => ({
    buyingPowerUsd: 100_000,
    exposureUsd: 0,
    realizedPnlTodayUsd: -3_000,
    ordersToday: 0,
    currentPositionQty: 0,
    ...over,
  });

  it('replaces the account-wide figure with the loop’s own realized day', () => {
    seedClosedAutotradeSessions({
      sessions: {
        [etToday()]: [
          // Entry 100 / stop 95 / qty 10 → $50 a full R.
          { entryTime: '09:35', exitTime: '10:00', r: 1, symbol: 'AUTO' },
          // Tagged `live` only: an imported broker holding, not the loop's.
          { entryTime: '09:35', exitTime: '10:00', r: -60, symbol: 'HAND', tags: ['live'] },
        ],
      },
    });
    expect(withLoopRealizedToday(accountState()).realizedPnlTodayUsd).toBe(50);
  });

  it('still reports the loop’s OWN loss — this narrows the figure, it does not disarm the halt', () => {
    seedClosedAutotradeSessions({
      sessions: { [etToday()]: [{ entryTime: '09:35', exitTime: '10:00', r: -6, symbol: 'AUTO' }] },
    });
    expect(withLoopRealizedToday(accountState({ realizedPnlTodayUsd: 0 })).realizedPnlTodayUsd).toBe(-300);
  });

  it('leaves every other field of the account state alone', () => {
    const before = accountState({ buyingPowerUsd: 4_022.61, exposureUsd: 451.5, ordersToday: 3 });
    const after = withLoopRealizedToday(before);
    expect(after.buyingPowerUsd).toBe(4_022.61);
    expect(after.exposureUsd).toBe(451.5);
    expect(after.ordersToday).toBe(3);
  });
});
