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
  db.exec(
    'DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders; DELETE FROM order_events; DELETE FROM order_intents;',
  );
});

/** entry 100, stop 95, qty 10 -> initialRiskOf() derives $50 risk. */
function insertLivePosition(overrides: { symbol?: string; tags?: string[] } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, stop_price, target_price, created_at, updated_at)
     VALUES ('stock', ?, 'long', 10, 100, ?, 0, 1, 'open', ?, 95, 110, ?, ?)`,
  ).run(
    overrides.symbol ?? 'AAPL',
    new Date(now).toISOString().slice(0, 10),
    JSON.stringify(overrides.tags ?? ['live', 'autotrade']),
    now,
    now,
  );
}

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

  describe('Phase 8: live-trading fields', () => {
    it('surfaces liveTradingEnabled/liveAccountId directly from config', () => {
      setAutotradeConfig({ liveTradingEnabled: false, liveAccountId: null });
      expect(getAutotradeDashboard()).toMatchObject({ liveTradingEnabled: false, liveAccountId: null });

      setAutotradeConfig({ liveAccountId: 'ACC1', liveTradingEnabled: true, liveEnabledAt: Date.now() });
      expect(getAutotradeDashboard()).toMatchObject({ liveTradingEnabled: true, liveAccountId: 'ACC1' });
    });

    it('counts only positions tagged autotrade for the live pool, ignoring human-only "live" positions', () => {
      insertLivePosition({ symbol: 'AAPL', tags: ['live', 'autotrade'] });
      insertLivePosition({ symbol: 'MSFT', tags: ['live'] }); // human-placed — must not count
      const dash = getAutotradeDashboard();
      expect(dash.liveOpenPositionsCount).toBe(1);
      expect(dash.liveOpenPositions.map((p) => p.symbol)).toEqual(['AAPL']);
    });

    it('computes liveOpenRisk from the stop distance of open autotrade-tagged positions', () => {
      insertLivePosition({ symbol: 'AAPL' }); // entry 100, stop 95, qty 10 -> $50 risk
      insertLivePosition({ symbol: 'MSFT' });
      expect(getAutotradeDashboard().liveOpenRisk).toBe(100);
    });

    it("keeps the live pool independent of paper's — a paper position never affects live figures or vice versa", () => {
      openPos({ symbol: 'AAPL', riskAmount: 500 }); // paper
      insertLivePosition({ symbol: 'MSFT' }); // live
      const dash = getAutotradeDashboard();
      expect(dash.openPositionsCount).toBe(1);
      expect(dash.openRisk).toBe(500);
      expect(dash.liveOpenPositionsCount).toBe(1);
      expect(dash.liveOpenRisk).toBe(50);
    });

    it('surfaces the live-specific caps directly from config, distinct from the human Trade page caps', () => {
      setAutotradeConfig({ liveMaxOrderUsd: 12_345, liveMaxDailyLossUsd: 678, liveMaxOrdersPerDay: 9 });
      const dash = getAutotradeDashboard();
      expect(dash.liveMaxOrderUsd).toBe(12_345);
      expect(dash.liveMaxDailyLossUsd).toBe(678);
      expect(dash.liveMaxOrdersPerDay).toBe(9);
    });

    it('surfaces probation status derived from liveEnabledAt', () => {
      const dash = getAutotradeDashboard();
      expect(dash.probation.active).toBe(false); // never enabled

      setAutotradeConfig({ liveEnabledAt: Date.now(), liveProbationTrades: 20 });
      const enabled = getAutotradeDashboard();
      expect(enabled.probation.active).toBe(true);
      expect(enabled.probation.tradesRemaining).toBe(20);
    });
  });
});
