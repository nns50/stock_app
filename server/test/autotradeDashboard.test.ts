import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, setAutotradeKillSwitch } from '../src/db/autotradeConfig';
import { openPaperPosition } from '../src/db/autotradePaperPositions';
import { getAutotradeDashboard } from '../src/services/autotrading/dashboard';

// Unit coverage for the Phase 7 dashboard snapshot (docs/AUTOTRADING_SPEC.md —
// MONITORING & KILL SWITCH). Every "used vs limit" figure here is meant to be
// a direct read of the exact numbers evaluateRiskCheck() would use for a live
// decision (riskCheck.ts) — these tests pin that down against the RISK_PROFILES
// table's real MODERATE/AGGRESSIVE values, not invented expectations.

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
});

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

describe('getAutotradeDashboard', () => {
  it('returns safe defaults with no config set and nothing open', () => {
    const dash = getAutotradeDashboard();
    expect(dash.enabled).toBe(false);
    expect(dash.killSwitch).toBe(false);
    expect(dash.riskProfile).toBe('MODERATE');
    expect(dash.equity).toBeNull();
    expect(dash.openPositions).toEqual([]);
    expect(dash.openPositionsCount).toBe(0);
    expect(dash.maxConcurrentPositions).toBe(2); // MODERATE
    expect(dash.openRisk).toBe(0);
    expect(dash.maxAggregateOpenRisk).toBe(0); // equity unset -> 0, not NaN or a phantom cap
    expect(dash.dailyPnl).toBe(0);
    // -(3% * 0 equity) is IEEE -0 in JS, not +0 — toBeCloseTo (numeric) rather
    // than toBe (Object.is) so that's treated as the zero it actually is; the
    // UI's fmtUsd/fmtSignedUsd already render -0 as "$0.00", not "-$0.00" (they
    // branch on `< 0` / `>= 0`, both false/true respectively for -0).
    expect(dash.dailyDrawdownHaltLevel).toBeCloseTo(0, 9);
    expect(dash.tradesToday).toBe(0);
    expect(dash.maxTradesPerDay).toBe(6); // MODERATE
    expect(dash.consecutiveLosses).toBe(0);
    expect(dash.stepDownAfterLosses).toBe(2);
  });

  it('reflects enabled + killSwitch state directly from config', () => {
    setAutotradeConfig({ enabled: true });
    setAutotradeKillSwitch(true);
    const dash = getAutotradeDashboard();
    expect(dash.enabled).toBe(true);
    expect(dash.killSwitch).toBe(true);
  });

  it('computes $ caps from equity and the active MODERATE profile', () => {
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
    const dash = getAutotradeDashboard();
    expect(dash.equity).toBe(100_000);
    expect(dash.maxAggregateOpenRisk).toBeCloseTo(2_000, 5); // 2% of 100k
    expect(dash.dailyDrawdownHaltLevel).toBeCloseTo(-3_000, 5); // -(3% of 100k)
  });

  it('computes $ caps from equity and the active AGGRESSIVE profile', () => {
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'AGGRESSIVE' });
    const dash = getAutotradeDashboard();
    expect(dash.maxConcurrentPositions).toBe(3);
    expect(dash.maxTradesPerDay).toBe(10);
    expect(dash.maxAggregateOpenRisk).toBeCloseTo(4_500, 5); // 4.5% of 100k
    expect(dash.dailyDrawdownHaltLevel).toBeCloseTo(-5_000, 5); // -(5% of 100k)
  });

  it('sums openRisk across open paper positions and counts them', () => {
    setAutotradeConfig({ accountEquityUsd: 100_000 });
    openPos({ symbol: 'AAPL', riskAmount: 500 });
    openPos({ symbol: 'MSFT', riskAmount: 300 });
    const dash = getAutotradeDashboard();
    expect(dash.openPositionsCount).toBe(2);
    expect(dash.openRisk).toBe(800);
    expect(dash.openPositions.map((p) => p.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it("reflects today's realized P&L and the consecutive-loss streak from closed paper trades", () => {
    setAutotradeConfig({ accountEquityUsd: 100_000 });
    const first = openPos({ symbol: 'AAA', entryPrice: 100, riskAmount: 500 });
    db.prepare(
      "UPDATE autotrade_paper_positions SET status='closed', exit_price=90, exit_at=?, exit_reason='stop' WHERE id=?",
    ).run(Date.now(), first.id);
    const second = openPos({ symbol: 'BBB', entryPrice: 100, riskAmount: 500 });
    db.prepare(
      "UPDATE autotrade_paper_positions SET status='closed', exit_price=80, exit_at=?, exit_reason='stop' WHERE id=?",
    ).run(Date.now(), second.id);

    const dash = getAutotradeDashboard();
    expect(dash.dailyPnl).toBe((90 - 100) * 10 + (80 - 100) * 10); // -100 + -200 = -300
    expect(dash.consecutiveLosses).toBe(2);
    expect(dash.tradesToday).toBe(2);
  });
});
