import { describe, it, expect } from 'vitest';
import { computeBacktestStats, BacktestReport, SimulatedTrade } from '../src/services/autotrading/backtest';

function trade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    symbol: 'TEST',
    side: 'buy',
    signalDate: '2024-01-01',
    entryDate: '2024-01-02',
    entryPrice: 100,
    exitDate: '2024-01-03',
    exitPrice: 100,
    exitReason: 'end_of_period',
    quantity: 10,
    pnl: 0,
    rMultiple: 0,
    ...overrides,
  };
}

function reportOf(trades: SimulatedTrade[], startingEquity = 10_000): BacktestReport {
  const finalEquity = startingEquity + trades.reduce((s, t) => s + t.pnl, 0);
  return { trades, equityCurve: [], startingEquity, finalEquity, excludedSymbols: [] };
}

describe('computeBacktestStats', () => {
  it('computes win rate, profit factor, expectancy, R stats, and drawdown from a mixed trade set', () => {
    // Hand-verified: wins [200,150] losses [-100,-100] -> grossProfit 350, grossLoss 200,
    // totalPnl 150, winRate 50%, avgWin 175, avgLoss -100, expectancy 37.5, profitFactor 1.75.
    // R sequence [2,-1,1.5,-1] -> avgR 0.375, rounded half-up to 0.38; bestR 2, worstR -1.
    // Cumulative pnl [200,100,250,150] -> peak 250, maxDrawdown 100 (250-150); streak pattern
    // win,loss,win,loss -> longestWinStreak 1, longestLossStreak 1.
    const report = reportOf(
      [
        trade({ pnl: 200, rMultiple: 2 }),
        trade({ pnl: -100, rMultiple: -1 }),
        trade({ pnl: 150, rMultiple: 1.5 }),
        trade({ pnl: -100, rMultiple: -1 }),
      ],
      10_000,
    );
    const stats = computeBacktestStats(report);
    expect(stats.totalTrades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBe(50);
    expect(stats.avgWin).toBe(175);
    expect(stats.avgLoss).toBe(-100);
    expect(stats.expectancy).toBe(37.5);
    expect(stats.profitFactor).toBe(1.75);
    expect(stats.totalPnl).toBe(150);
    expect(stats.returnPct).toBe(1.5);
    expect(stats.avgR).toBe(0.38);
    expect(stats.bestR).toBe(2);
    expect(stats.worstR).toBe(-1);
    expect(stats.maxDrawdown).toBe(100);
    expect(stats.longestWinStreak).toBe(1);
    expect(stats.longestLossStreak).toBe(1);
  });

  it('reports profitFactor as null (not Infinity) when there are wins and no losses yet', () => {
    const stats = computeBacktestStats(reportOf([trade({ pnl: 100, rMultiple: 1 })]));
    expect(stats.profitFactor).toBeNull();
    expect(stats.avgLoss).toBe(0);
  });

  it('reports profitFactor 0 when there are neither wins nor losses', () => {
    const stats = computeBacktestStats(reportOf([trade({ pnl: 0, rMultiple: 0 })]));
    expect(stats.profitFactor).toBe(0);
  });

  it('returns zeroed/null stats for an empty trade list, without dividing by zero', () => {
    const stats = computeBacktestStats(reportOf([]));
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.avgWin).toBe(0);
    expect(stats.avgLoss).toBe(0);
    expect(stats.expectancy).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.avgR).toBeNull();
    expect(stats.bestR).toBeNull();
    expect(stats.worstR).toBeNull();
    expect(stats.maxDrawdown).toBe(0);
    expect(stats.returnPct).toBe(0);
  });

  it('computes returnPct from starting vs final equity, independent of trade count', () => {
    const stats = computeBacktestStats(reportOf([trade({ pnl: 500, rMultiple: 1 })], 20_000));
    expect(stats.returnPct).toBe(2.5); // 500 / 20,000 * 100
  });
});
