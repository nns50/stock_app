import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { markDailyTargetReached, markGiveBackHalted, saveDailyBaseline } from '../src/db/dailyBaseline';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { listDailyResults } from '../src/db/dailyResults';
import {
  backfillDailyResults,
  buildDailyResult,
  buildDailyResultsReport,
  dayPctOf,
  isoWeekKey,
  MANUAL_TRADING_DIVERGENCE_PCT,
  recordDailyResult,
  recordTodayAfterClose,
  strategyDayFor,
} from '../src/services/autotrading/dailyResults';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';

// ---------------------------------------------------------------------------
// Before this table, the day's percentage lived in a singleton row that was
// overwritten every morning and in a dashboard figure recomputed per poll — so
// "how did last Tuesday go" had no answer. These tests are about the two things
// that make the record trustworthy: that the two percentages mean different
// things and are both kept, and that nothing is invented where the record
// genuinely cannot answer.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM positions; DELETE FROM position_exits; DELETE FROM autotrade_paper_positions; ' +
      'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_live_options_positions; ' +
      'DELETE FROM autotrade_daily_results; DELETE FROM autotrade_daily_baseline; DELETE FROM autotrade_config;',
  );
});

const DAY = '2026-09-10';

describe('the two percentages', () => {
  const base = {
    etDate: DAY,
    baselineEquityUsd: 10_000,
    closeEquityUsd: 10_200,
    goalReached: false,
    giveBackHalted: false,
    drawdownHalted: false,
    recordedAt: 1,
  };

  it('reports the account and the strategy separately, both over the same baseline', () => {
    const r = buildDailyResult(base, { pnlUsd: 180, trades: 3 }, 40);
    expect(r.accountGainPct).toBe(2); // (10,200 − 10,000) / 10,000
    expect(r.strategyGainPct).toBe(1.8); // 180 / 10,000
    expect(r.liveTrades).toBe(3);
    expect(r.paperPnlUsd).toBe(40);
    // A 0.2 point gap is ordinary mark-to-market on an open position.
    expect(r.manualTrading).toBe(false);
  });

  it('flags the day the account and the strategy disagree — a deposit, or hand trading', () => {
    // The 2026-09-11 shape: the account moved a long way, the loop did not.
    const r = buildDailyResult({ ...base, closeEquityUsd: 8_900 }, { pnlUsd: 0, trades: 0 }, 0);
    expect(r.accountGainPct).toBe(-11);
    expect(r.strategyGainPct).toBe(0);
    expect(r.manualTrading).toBe(true);
    expect(Math.abs(r.accountGainPct! - r.strategyGainPct!)).toBeGreaterThan(MANUAL_TRADING_DIVERGENCE_PCT);
  });

  it('never invents an account figure without an opening equity', () => {
    const r = buildDailyResult(
      { ...base, baselineEquityUsd: null, closeEquityUsd: null },
      { pnlUsd: 120, trades: 2 },
      0,
    );
    expect(r.accountGainPct).toBeNull();
    expect(r.strategyGainPct).toBeNull();
    // …but the strategy DOLLARS are exact, because they come from the ledger.
    expect(r.strategyPnlUsd).toBe(120);
    // With nothing to compare, the day is not "clean" — it is unknown, and a
    // false flag would read as a claim.
    expect(r.manualTrading).toBe(false);
  });
});

describe('strategyDayFor — the loop’s own day, by the date the money moved', () => {
  it('books a trade on its LAST exit date, not its entry date', () => {
    seedClosedAutotradeSessions({
      sessions: {
        '2026-09-09': [{ entryTime: '15:00', exitTime: '10:00', exitDate: DAY, r: 1 }],
        [DAY]: [{ entryTime: '09:35', exitTime: '10:00', r: -0.4 }],
      },
    });
    // Entry 100 / stop 95 / qty 10 → $50 risk, so +1R is +$50 and −0.4R is −$20.
    expect(strategyDayFor(DAY)).toEqual({ pnlUsd: 30, trades: 2 });
    expect(strategyDayFor('2026-09-09')).toEqual({ pnlUsd: 0, trades: 0 });
  });

  it('counts only the loop’s own positions — a hand trade is not the strategy', () => {
    seedClosedAutotradeSessions({
      sessions: {
        [DAY]: [
          { entryTime: '09:35', exitTime: '10:00', r: 1, symbol: 'AUTO' },
          { entryTime: '09:35', exitTime: '10:00', r: 4, symbol: 'HAND', tags: ['live'] },
        ],
      },
    });
    expect(strategyDayFor(DAY)).toEqual({ pnlUsd: 50, trades: 1 });
  });
});

describe('recordDailyResult / recordTodayAfterClose', () => {
  it('writes once per date and rewrites rather than duplicating', () => {
    saveDailyBaseline(DAY, 10_000);
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_150 });
    seedClosedAutotradeSessions({ sessions: { [DAY]: [{ entryTime: '09:35', exitTime: '10:00', r: 2 }] } });

    recordDailyResult(DAY, 1);
    recordDailyResult(DAY, 2);
    const rows = listDailyResults();
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedAt).toBe(2);
    expect(rows[0].strategyPnlUsd).toBe(100);
    expect(rows[0].accountGainPct).toBe(1.5);
  });

  it('carries the day’s stamps: goal reached and the give-back halt', () => {
    saveDailyBaseline(DAY, 10_000);
    markDailyTargetReached(Date.now());
    markGiveBackHalted(Date.now());
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_300 });
    const r = recordDailyResult(DAY, 1);
    expect(r.goalReached).toBe(true);
    expect(r.giveBackHalted).toBe(true);
  });

  it('does nothing at all while the session is still open', () => {
    saveDailyBaseline('2026-09-10', 10_000);
    // 2026-09-10 is a Thursday; 14:00 ET is 18:00 UTC.
    expect(recordTodayAfterClose(Date.parse('2026-09-10T18:00:00Z'))).toBeNull();
    expect(listDailyResults()).toHaveLength(0);
  });

  it('records once the bell has rung, and not on a weekend', () => {
    saveDailyBaseline('2026-09-10', 10_000);
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000 });
    expect(recordTodayAfterClose(Date.parse('2026-09-10T20:30:00Z'))).not.toBeNull();
    expect(listDailyResults()).toHaveLength(1);
    // Saturday: not a session, nothing written.
    expect(recordTodayAfterClose(Date.parse('2026-09-12T20:30:00Z'))).toBeNull();
    expect(listDailyResults()).toHaveLength(1);
  });

  it('re-recording a PAST date keeps the account half it already had', () => {
    // The baseline row is a singleton that rolls over every morning, so a
    // recording for yesterday cannot read yesterday's opening equity from it.
    saveDailyBaseline(DAY, 10_000);
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_500 });
    recordDailyResult(DAY, 1);
    // Morning rolls the baseline to the next session.
    saveDailyBaseline('2026-09-11', 10_500);
    seedClosedAutotradeSessions({ sessions: { [DAY]: [{ entryTime: '09:35', exitTime: '10:00', r: 1 }] } });
    const again = recordDailyResult(DAY, 2);
    expect(again.baselineEquityUsd).toBe(10_000);
    expect(again.accountGainPct).toBe(5);
    // …and the strategy half is re-derived from the ledger as it stands now.
    expect(again.strategyPnlUsd).toBe(50);
  });
});

describe('backfill — exact where the ledger knows, null where nothing does', () => {
  it('fills the strategy columns for past sessions and leaves the account columns null', () => {
    seedClosedAutotradeSessions({
      sessions: {
        '2026-09-08': [{ entryTime: '09:35', exitTime: '10:00', r: 1 }],
        '2026-09-09': [{ entryTime: '09:35', exitTime: '10:00', r: -0.5 }],
      },
    });
    const out = backfillDailyResults('2026-09-01', 1);
    expect(out.dates).toEqual(['2026-09-08', '2026-09-09']);
    const rows = listDailyResults();
    expect(rows.map((r) => r.strategyPnlUsd)).toEqual([50, -25]);
    for (const r of rows) {
      expect(r.baselineEquityUsd).toBeNull();
      expect(r.accountGainPct).toBeNull();
      expect(r.strategyGainPct).toBeNull();
    }
  });

  it('never overwrites a day that was already recorded properly', () => {
    saveDailyBaseline('2026-09-08', 10_000);
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_100 });
    seedClosedAutotradeSessions({ sessions: { '2026-09-08': [{ entryTime: '09:35', exitTime: '10:00', r: 1 }] } });
    recordDailyResult('2026-09-08', 1);

    expect(backfillDailyResults('2026-09-01', 2).written).toBe(0);
    expect(listDailyResults()[0].accountGainPct).toBe(1);
  });
});

describe('aggregates', () => {
  const row = (etDate: string, accountGainPct: number | null, over: Record<string, unknown> = {}) => ({
    etDate,
    baselineEquityUsd: accountGainPct === null ? null : 10_000,
    closeEquityUsd: accountGainPct === null ? null : 10_000 * (1 + accountGainPct / 100),
    accountGainPct,
    strategyPnlUsd: 10,
    strategyGainPct: 0.1,
    liveTrades: 1,
    paperPnlUsd: 0,
    goalReached: false,
    giveBackHalted: false,
    drawdownHalted: false,
    manualTrading: false,
    recordedAt: 1,
    ...over,
  });

  it('sums the strategy DOLLARS and averages the percentages — never sums a percentage', () => {
    const r = buildDailyResultsReport([
      row('2026-09-08', 1),
      row('2026-09-09', -2),
      row('2026-09-10', 3, { goalReached: true, drawdownHalted: true }),
    ]);
    const month = r.monthly[0];
    expect(month.key).toBe('2026-09');
    expect(month.sessions).toBe(3);
    expect(month.strategyPnlUsd).toBe(30);
    expect(month.meanAccountGainPct).toBeCloseTo(0.67, 2);
    expect(month.positiveDays).toBe(2);
    expect(month.goalDays).toBe(1);
    expect(month.haltDays).toBe(1);
    expect(month.bestDayPct).toBe(3);
    expect(month.worstDayPct).toBe(-2);
  });

  it('buckets by ISO week, so a week that crosses a month boundary stays one week', () => {
    expect(isoWeekKey('2026-09-07')).toBe(isoWeekKey('2026-09-11'));
    expect(isoWeekKey('2026-09-11')).not.toBe(isoWeekKey('2026-09-14'));
    const r = buildDailyResultsReport([row('2026-08-31', 1), row('2026-09-01', 1), row('2026-09-07', 1)]);
    expect(r.weekly).toHaveLength(2);
    expect(r.monthly).toHaveLength(2);
  });

  it('streaks on the account figure, and falls back to the strategy one before go-live', () => {
    expect(
      buildDailyResultsReport([row('2026-09-08', -1), row('2026-09-09', 1), row('2026-09-10', 2)]).currentStreak,
    ).toBe(2);
    expect(
      buildDailyResultsReport([row('2026-09-08', 1), row('2026-09-09', -1), row('2026-09-10', -2)]).currentStreak,
    ).toBe(-2);
    // A pre-go-live day has no account figure; the strategy one carries it.
    expect(dayPctOf(row('2026-09-08', null))).toBe(0.1);
    expect(buildDailyResultsReport([row('2026-09-08', null)]).currentStreak).toBe(1);
  });

  it('a flat day ends the streak rather than extending it', () => {
    expect(
      buildDailyResultsReport([row('2026-09-08', 1), row('2026-09-09', 0, { strategyGainPct: 0 })]).currentStreak,
    ).toBe(0);
  });
});

describe('the paper book’s own day travels with it', () => {
  it('records the control arm’s P&L beside the live one', () => {
    saveDailyBaseline(DAY, 10_000);
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000 });
    const p = openPaperPosition({
      symbol: 'AAA',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    closePaperPosition(p.id, { exitPrice: 104, exitReason: 'target' });
    db.prepare('UPDATE autotrade_paper_positions SET exit_at = ? WHERE id = ?').run(
      Date.parse('2026-09-10T18:00:00Z'),
      p.id,
    );
    expect(recordDailyResult(DAY, 1).paperPnlUsd).toBe(40);
  });
});
