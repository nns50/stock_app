import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, setAutotradeKillSwitch } from '../src/db/autotradeConfig';
import { openPaperPosition } from '../src/db/autotradePaperPositions';
import { openOptionsPaperPosition } from '../src/db/autotradeOptionsPaperPositions';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { saveLastTick } from '../src/db/autotradeLastTick';
import { getAutotradeDashboard } from '../src/services/autotrading/dashboard';

// Unit coverage for the Phase 7 dashboard snapshot (docs/AUTOTRADING_SPEC.md —
// MONITORING & KILL SWITCH). Every "used vs limit" figure here is meant to be
// a direct read of the exact numbers evaluateRiskCheck() would use for a live
// decision (riskCheck.ts) — these tests pin that down against the RISK_PROFILES
// table's real MODERATE/AGGRESSIVE values, not invented expectations.

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_options_paper_positions; ' +
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; ' +
      'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders; ' +
      'DELETE FROM autotrade_live_options_orders; DELETE FROM order_events; DELETE FROM order_intents; ' +
      'DELETE FROM autotrade_last_tick;',
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

function openOptionsPos(overrides: Partial<Parameters<typeof openOptionsPaperPosition>[0]> = {}) {
  return openOptionsPaperPosition({
    symbol: 'AAPL',
    side: 'call',
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2026-08-21',
    quantity: 2,
    entryPrice: 3,
    riskAmount: 600,
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
    expect(dash.lastTick).toBeNull(); // the loop has never run
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

  it('surfaces the persisted last-tick snapshot directly — a read, not a second implementation', () => {
    saveLastTick({
      ranEntries: true,
      exitsChecked: 3,
      exitsClosed: 1,
      optionsExitsChecked: 0,
      optionsExitsClosed: 0,
      liveOrdersReconciled: 0,
      livePositionsClosed: 0,
      liveOptionsOrdersReconciled: 0,
      liveOptionsPositionsClosed: 0,
      liveOptionsExitsRequested: 0,
      liveTimeExitsRequested: 0,
      liveScaleInsRequested: 0,
      liveScaleOutsRequested: 0,
      liveStopsRatcheted: 0,
      candidatesScreened: 7,
      candidatesPassedVolatility: 4,
      signalsGenerated: 2,
      optionsSignalsGenerated: 0,
      optionsCandidatesConsidered: 0,
      entriesOpened: 1,
      optionsEntriesOpened: 0,
      liveEntriesOpened: 0,
      liveOptionsEntriesOpened: 0,
      moversAutoPromoted: 0,
    });
    const dash = getAutotradeDashboard();
    expect(dash.lastTick).not.toBeNull();
    expect(dash.lastTick?.summary).toMatchObject({ candidatesScreened: 7, signalsGenerated: 2, entriesOpened: 1 });
    expect(dash.lastTick?.ranAt).toBeGreaterThan(0);
  });

  it('computes $ caps from equity and the active MODERATE profile', () => {
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
    const dash = getAutotradeDashboard();
    expect(dash.equity).toBe(100_000);
    expect(dash.maxAggregateOpenRisk).toBeCloseTo(2_000, 5); // 2% of 100k
    expect(dash.dailyDrawdownHaltLevel).toBeCloseTo(-3_000, 5); // -(3% of 100k)
  });

  it("computes $ caps from equity and the configured caps (AGGRESSIVE's old preset values, set explicitly)", () => {
    // riskProfile no longer implies these — every field is independently
    // user-configured now (see riskProfiles.ts's header comment) — so the
    // AGGRESSIVE numbers this test wants have to be set explicitly.
    setAutotradeConfig({
      accountEquityUsd: 100_000,
      riskProfile: 'AGGRESSIVE',
      maxDailyDrawdownPct: 5,
      maxAggregateOpenRiskPct: 4.5,
      maxTradesPerDay: 10,
    });
    const dash = getAutotradeDashboard();
    // maxConcurrentPositions is NOT asserted here — it's config-driven now
    // (AutotradeConfig.maxConcurrentPositions), not part of the risk profile,
    // so switching to AGGRESSIVE leaves it unchanged (still 2, the default).
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

  describe('Phase 13: options paper fields — combined with equity, not a second pool', () => {
    it('combines equity + options paper positions into ONE count/risk pool, unlike live', () => {
      setAutotradeConfig({ accountEquityUsd: 100_000 });
      openPos({ symbol: 'AAPL', riskAmount: 500 });
      openOptionsPos({ symbol: 'MSFT', riskAmount: 300 });
      const dash = getAutotradeDashboard();
      expect(dash.openPositionsCount).toBe(2); // 1 equity + 1 options
      expect(dash.openRisk).toBe(800); // 500 + 300
      // openPositions itself stays equity-only — options get their own array below.
      expect(dash.openPositions.map((p) => p.symbol)).toEqual(['AAPL']);
      expect(dash.openOptionsPositions.map((p) => p.symbol)).toEqual(['MSFT']);
    });

    it('combines dailyPnl and tradesToday by SUM across equity + options', () => {
      setAutotradeConfig({ accountEquityUsd: 100_000 });
      const eq = openPos({ symbol: 'AAA', entryPrice: 100, riskAmount: 500 });
      db.prepare(
        "UPDATE autotrade_paper_positions SET status='closed', exit_price=90, exit_at=?, exit_reason='stop' WHERE id=?",
      ).run(Date.now(), eq.id); // (90-100)*10 = -100
      const opt = openOptionsPos({ symbol: 'BBB', entryPrice: 3, quantity: 2 });
      db.prepare(
        "UPDATE autotrade_options_paper_positions SET status='closed', exit_price=1, exit_at=?, exit_reason='time_exit' WHERE id=?",
      ).run(Date.now(), opt.id); // (1-3)*2*100 = -400

      const dash = getAutotradeDashboard();
      expect(dash.dailyPnl).toBe(-500); // -100 + -400
      expect(dash.tradesToday).toBe(2); // 1 equity + 1 options
    });

    it('combines consecutiveLosses by MAX (not sum) across equity + options', () => {
      setAutotradeConfig({ accountEquityUsd: 100_000 });
      // Equity: two losses in a row.
      const a = openPos({ symbol: 'AAA', entryPrice: 100, riskAmount: 500 });
      db.prepare(
        "UPDATE autotrade_paper_positions SET status='closed', exit_price=90, exit_at=?, exit_reason='stop' WHERE id=?",
      ).run(Date.now(), a.id);
      const b = openPos({ symbol: 'BBB', entryPrice: 100, riskAmount: 500 });
      db.prepare(
        "UPDATE autotrade_paper_positions SET status='closed', exit_price=90, exit_at=?, exit_reason='stop' WHERE id=?",
      ).run(Date.now(), b.id);
      // Options: a single win — its own streak is 0.
      const c = openOptionsPos({ symbol: 'CCC', entryPrice: 3 });
      db.prepare(
        "UPDATE autotrade_options_paper_positions SET status='closed', exit_price=5, exit_at=?, exit_reason='time_exit' WHERE id=?",
      ).run(Date.now(), c.id);

      const dash = getAutotradeDashboard();
      // max(2 equity losses, 0 options losses) = 2, not 2+0 and not double-counted.
      expect(dash.consecutiveLosses).toBe(2);
    });

    it('computes days-to-expiration for each open options position', () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-01T15:00:00Z'));
      try {
        setAutotradeConfig({ accountEquityUsd: 100_000 });
        openOptionsPos({ symbol: 'AAPL', expiration: '2026-08-15' }); // ~14 days out
        const dash = getAutotradeDashboard();
        expect(dash.openOptionsPositions).toHaveLength(1);
        expect(dash.openOptionsPositions[0].dte).toBeCloseTo(14.2, 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is empty when there are no options paper positions at all', () => {
      setAutotradeConfig({ accountEquityUsd: 100_000 });
      openPos({ symbol: 'AAPL', riskAmount: 500 });
      const dash = getAutotradeDashboard();
      expect(dash.openOptionsPositions).toEqual([]);
      expect(dash.openPositionsCount).toBe(1); // equity only, unaffected
      expect(dash.openRisk).toBe(500);
    });
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

  describe('lastCorrelatedExposureCheck — the one cap with no live "used" figure', () => {
    it('computes the $ cap from equity, same as maxAggregateOpenRisk, with no check logged yet', () => {
      setAutotradeConfig({ accountEquityUsd: 100_000, maxCorrelatedExposurePct: 6 });
      const dash = getAutotradeDashboard();
      expect(dash.maxCorrelatedExposure).toBeCloseTo(6_000, 5);
      expect(dash.lastCorrelatedExposureCheck).toBeNull();
    });

    it('reads the most recent risk-check event that reached the max_correlated_exposure rule', () => {
      logAutotradeEvent({
        symbol: 'MSFT',
        stage: 'risk_check',
        action: 'passed',
        detail: {
          checks: [
            { rule: 'daily_drawdown_halt', passed: true, detail: 'ok' },
            {
              rule: 'max_correlated_exposure',
              passed: true,
              detail: '$1,500.00 already correlated vs cap $6,000.00 (6% of equity, |r| ≥ 0.7)',
            },
          ],
        },
      });
      const dash = getAutotradeDashboard();
      expect(dash.lastCorrelatedExposureCheck).toMatchObject({
        symbol: 'MSFT',
        passed: true,
        correlatedNotional: 1500,
      });
    });

    it('reflects a BLOCKED reading (the number a user troubleshooting "nothing is trading" needs)', () => {
      logAutotradeEvent({
        symbol: 'NVDA',
        stage: 'risk_check',
        action: 'blocked',
        detail: {
          checks: [
            {
              rule: 'max_correlated_exposure',
              passed: false,
              detail: '$8,200.50 already correlated vs cap $6,000.00 (6% of equity, |r| ≥ 0.7)',
            },
          ],
        },
      });
      const dash = getAutotradeDashboard();
      expect(dash.lastCorrelatedExposureCheck).toMatchObject({
        symbol: 'NVDA',
        passed: false,
        correlatedNotional: 8200.5,
      });
    });

    it('skips past a newer event that never reached the rule (an early equity/quantity block)', () => {
      logAutotradeEvent({
        symbol: 'OLDER',
        stage: 'risk_check',
        action: 'blocked',
        detail: {
          checks: [
            {
              rule: 'max_correlated_exposure',
              passed: true,
              detail: '$500.00 already correlated vs cap $6,000.00 (6% of equity, |r| ≥ 0.7)',
            },
          ],
        },
      });
      // A later, newer event that short-circuited before max_correlated_exposure
      // ever ran (e.g. equity_configured or quantity failed) — no such rule logged.
      logAutotradeEvent({
        symbol: 'NEWER',
        stage: 'risk_check',
        action: 'blocked',
        detail: { checks: [{ rule: 'equity_configured', passed: false, detail: 'not set' }] },
      });
      const dash = getAutotradeDashboard();
      expect(dash.lastCorrelatedExposureCheck).toMatchObject({ symbol: 'OLDER', correlatedNotional: 500 });
    });

    it('ignores non-risk_check events and events with unparseable detail, without throwing', () => {
      logAutotradeEvent({ stage: 'config', action: 'kill_switch_engaged' });
      logAutotradeEvent({ stage: 'risk_check', action: 'blocked', detail: 'not json' });
      expect(() => getAutotradeDashboard()).not.toThrow();
      expect(getAutotradeDashboard().lastCorrelatedExposureCheck).toBeNull();
    });
  });
});
