import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { markDailyTargetReached, markGiveBackHalted, saveDailyBaseline } from '../src/db/dailyBaseline';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { listDailyResults } from '../src/db/dailyResults';
import { DayMark } from '../src/db/dayMarks';
import {
  backfillDailyResults,
  buildDailyResult,
  buildDailyResultsReport,
  dayPctOf,
  isoWeekKey,
  ACCOUNT_STRATEGY_DIVERGENCE_PCT,
  preOpenMoveUsdFor,
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
    riskPerTradePct: 2.5,
    goalBasis: 'strategy' as const,
    // No day-marks samples in a pure case: null is "the samples cannot say",
    // which is exactly the state a hand-built input is in.
    preOpenMoveUsd: null,
    recordedAt: 1,
  };

  it('reports the account and the strategy separately, both over the same baseline', () => {
    const r = buildDailyResult(base, { pnlUsd: 180, trades: 3 }, 40);
    expect(r.accountGainPct).toBe(2); // (10,200 − 10,000) / 10,000
    expect(r.strategyGainPct).toBe(1.8); // 180 / 10,000
    expect(r.liveTrades).toBe(3);
    expect(r.paperPnlUsd).toBe(40);
    // A 0.2 point gap is ordinary mark-to-market on an open position.
    expect(r.accountStrategyDiverged).toBe(false);
  });

  it('flags the day the account and the strategy disagree — a deposit, or hand trading', () => {
    // The 2026-09-11 shape: the account moved a long way, the loop did not.
    const r = buildDailyResult({ ...base, closeEquityUsd: 8_900 }, { pnlUsd: 0, trades: 0 }, 0);
    expect(r.accountGainPct).toBe(-11);
    expect(r.strategyGainPct).toBe(0);
    expect(r.accountStrategyDiverged).toBe(true);
    expect(Math.abs(r.accountGainPct! - r.strategyGainPct!)).toBeGreaterThan(ACCOUNT_STRATEGY_DIVERGENCE_PCT);
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
    expect(r.accountStrategyDiverged).toBe(false);
    expect(r.divergenceUsd).toBeNull();
  });

  // THE FLAG SAYS THAT THEY DIFFER, NEVER WHY (2026-09-16).
  //
  // It was called `manualTrading`, and on 2026-09-16 it fired on a session
  // neither book traded: the broker settled the previous day's option expiry
  // for -$193.50 at 04:03 ET, against a baseline captured at ET midnight. The
  // operator confirmed no hand trade. A name that asserts a cause the row
  // cannot establish is a claim, not a measurement.
  it('carries the gap in DOLLARS, which is the unit its causes are spoken of in', () => {
    const r = buildDailyResult({ ...base, closeEquityUsd: 10_200 }, { pnlUsd: 180, trades: 3 }, 0);
    // account moved +$200, the loop realized +$180 → $20 unexplained.
    expect(r.divergenceUsd).toBe(20);
    expect(r.accountStrategyDiverged).toBe(false); // 0.2% of equity, under the bar
  });

  it('reproduces 2026-09-16: flagged on a day with no trade in either book', () => {
    const r = buildDailyResult(
      { ...base, baselineEquityUsd: 30_204.81, closeEquityUsd: 30_011.3, preOpenMoveUsd: -193.51 },
      { pnlUsd: 0, trades: 0 },
      0,
    );
    expect(r.accountGainPct).toBe(-0.64);
    expect(r.strategyGainPct).toBe(0);
    expect(r.liveTrades).toBe(0);
    expect(r.accountStrategyDiverged).toBe(true);
    expect(r.divergenceUsd).toBe(-193.51);
    // …and the whole of it predates the opening bell, which is what makes the
    // "hand trading" reading impossible rather than merely unproven. The two
    // figures come from different tables and agree EXACTLY here, which they can
    // only do when the loop realized nothing and nothing moved after the bell —
    // so the equality IS the evidence that the session was flat. Verified
    // against the deployed row on 2026-09-16.
    expect(r.preOpenMoveUsd).toBe(r.divergenceUsd);
    expect(r.preOpenMoveUsd).toBe(-193.51);
  });
});

describe('preOpenMoveUsdFor — what happened before the bell', () => {
  // 2026-09-16 ET, as epoch ms. The loop ticks from ET midnight, so a whole
  // overnight sits inside the session's own date.
  const at = (hhmm: string) => Date.parse(`2026-09-16T${hhmm}:00-04:00`);
  const mark = (hhmm: string, equity: number | null): DayMark => ({
    etDate: '2026-09-16',
    at: at(hhmm),
    baselineEquityUsd: 30_204.81,
    realizedUsd: 0,
    unrealizedEquityUsd: 0,
    accountEquityUsd: equity,
    openEquity: 0,
    openOptions: 0,
  });

  it('measures the settlement step and stops at the bell', () => {
    const move = preOpenMoveUsdFor([
      mark('00:00', 30_204.81),
      mark('04:03', 30_011.31),
      mark('09:00', 30_011.3),
      // Anything from the session itself must not be counted.
      mark('10:30', 29_800),
      mark('15:59', 29_500),
    ]);
    expect(move).toBe(-193.51);
  });

  it('is null when the samples cannot answer — never 0, which would assert a quiet night', () => {
    expect(preOpenMoveUsdFor([])).toBeNull();
    // A loop that started mid-session never saw the window.
    expect(preOpenMoveUsdFor([mark('10:30', 30_000), mark('11:30', 30_100)])).toBeNull();
    // One pre-open sample is a reading, not a move.
    expect(preOpenMoveUsdFor([mark('04:03', 30_011.31), mark('10:30', 29_800)])).toBeNull();
    // Failed equity reads carry no number to difference.
    expect(preOpenMoveUsdFor([mark('00:00', null), mark('04:03', null)])).toBeNull();
  });

  it('reports a quiet night as 0 once there are samples to prove it', () => {
    expect(preOpenMoveUsdFor([mark('00:00', 30_204.81), mark('09:00', 30_204.81)])).toBe(0);
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

  it('carries the day’s stamps: goal reached, its BASIS, and the give-back halt', () => {
    saveDailyBaseline(DAY, 10_000);
    markDailyTargetReached(Date.now(), 'strategy');
    markGiveBackHalted(Date.now());
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_300 });
    const r = recordDailyResult(DAY, 1);
    expect(r.goalReached).toBe(true);
    expect(r.giveBackHalted).toBe(true);
    expect(r.goalBasis).toBe('strategy');
  });

  it('reports the basis the STAMP carried, not the one the recorder is running (2026-09-14)', () => {
    // The recorder runs after the close, possibly a deploy later than the
    // stamp. It said `current ? 'strategy' : …` for a few hours and got its
    // first real row wrong: 2026-09-14's reach was stamped at 14:41 by the
    // account-based evaluator, and the row claimed a strategy-basis goal day
    // at +2.01% against a 3% goal — a day the ACCOUNT banked at +4.87%, which
    // is precisely the contamination the basis exists to exclude.
    //
    // A day stamped before the basis column existed carries NULL, and null is
    // read as "the old basis" everywhere downstream. Simulated by stamping the
    // reach and then clearing the basis, which is exactly the state such a row
    // is in.
    saveDailyBaseline(DAY, 10_000);
    markDailyTargetReached(Date.now(), 'strategy');
    db.exec('UPDATE autotrade_daily_baseline SET goal_basis = NULL WHERE id = 1');
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_300 });
    const r = recordDailyResult(DAY, 1);
    expect(r.goalReached).toBe(true);
    expect(r.goalBasis).toBeNull();
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
    accountStrategyDiverged: false,
    divergenceUsd: 0,
    preOpenMoveUsd: null,
    riskPerTradePct: 2.5,
    goalBasis: 'strategy' as const,
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

  it('reports the mean RED day, which the worst day cannot stand in for', () => {
    // Decision 9's yardstick is "mean red day <= -1.5%". These two months have
    // the SAME worst day and the same count of red days; only the mean tells
    // them apart, which is the whole reason it is a field.
    const oneBadDay = buildDailyResultsReport([row('2026-09-08', -3), row('2026-09-09', -0.1), row('2026-09-10', 2)]);
    const aRunOfThem = buildDailyResultsReport([row('2026-08-10', -3), row('2026-08-11', -2.9), row('2026-08-12', 2)]);
    expect(oneBadDay.monthly[0].worstDayPct).toBe(aRunOfThem.monthly[0].worstDayPct);
    expect(oneBadDay.monthly[0].redDays).toBe(aRunOfThem.monthly[0].redDays);
    expect(oneBadDay.monthly[0].meanRedDayPct).toBeCloseTo(-1.55, 2);
    expect(aRunOfThem.monthly[0].meanRedDayPct).toBeCloseTo(-2.95, 2);
    // The green day is not averaged in, and a month with no red day has none.
    expect(buildDailyResultsReport([row('2026-09-08', 1)]).monthly[0].meanRedDayPct).toBeNull();
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
