import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The push an exposure proposal sends is the one side effect here that leaves
// the process; captured so the "once, on the session the bar is first met"
// rule is asserted rather than assumed.
vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));

import { dispatchNotifications } from '../src/services/notifier';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { DailyResult, saveDailyResult } from '../src/db/dailyResults';
import { listSwitchStates } from '../src/db/gatedSwitchState';
import { saveShortShadowRecord } from '../src/db/shortShadowRecords';
import { saveEdgeLeakScan } from '../src/db/edgeLeakScans';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { runEdgeLeakScanFromDb } from '../src/services/autotrading/edgeLeakScanData';
import { etDateTimeToMs } from '../src/util/marketDate';
import type { EdgeLeakScanResult } from '../src/services/autotrading/edgeLeakScan';
import { Candle } from '../src/providers/types';
import { deriveDollarCaps } from '../src/services/autotrading/targetTune';
import {
  buildGatedSwitchSnapshot,
  buildSizingReview,
  reviewSessions,
  runGatedSwitches,
  runGatedSwitchesAfterClose,
  sizingChangedOn,
} from '../src/services/autotrading/gatedSwitchesData';
import { GATED_SWITCH_RULES, SHADOW_MIN_EVALUATIONS } from '../src/services/autotrading/gatedSwitches';
import { saveDailyBaseline } from '../src/db/dailyBaseline';
import { recordDailyResult } from '../src/services/autotrading/dailyResults';
import { writeDailyHaltMarker } from '../src/services/autotrading/dailyHaltMarker';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';
import { buildGatedSwitchStatus } from '../src/services/autotrading/dashboard';
import { buildShortShadowRecord } from '../src/services/autotrading/shortShadowRecord';
import { SHORT_SHADOW_SINCE_MS, ShortShadowReport } from '../src/services/autotrading/shortShadowRecordData';

// ---------------------------------------------------------------------------
// The DB half. What matters here is the chain a config write actually travels:
// the snapshot is assembled from real rows, the shadow record survives, and
// nothing is written until a rule has earned it — asserted on the CONFIG, not
// on the engine's return value (CLAUDE.md: a value exercised where it is
// computed proves nothing about its consumer).
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM gated_switch_state; ' +
      'DELETE FROM autotrade_daily_results; DELETE FROM edge_leak_scans; DELETE FROM short_shadow_records;',
  );
  vi.mocked(dispatchNotifications).mockClear();
});

/**
 * A short shadow record built by the PRODUCER — buildShortShadowRecord over
 * `n` declined shorts that each fall straight to their 2R target — rather than
 * a hand-written shape the producer could not emit. Wrapped the way the
 * after-close hook persists it.
 */
/**
 * A persisted short shadow record of `n` declined shorts. `losersOnOtherTapes`
 * adds that many shorts declined on a MIXED tape that stop out, and stamps the
 * `n` winners RED, so the record carries a red-tape split (2026-09-24).
 */
async function shortReport(n: number, losersOnOtherTapes = 0): Promise<ShortShadowReport> {
  const T0 = Date.parse('2026-09-10T13:35:00Z');
  const bar = (offsetMin: number, high: number, low: number): Candle => ({
    time: T0 + offsetMin * 60_000,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1000,
  });
  // Opens at the signal's 100; the replay enters at that open less the whole
  // 0.5% buffer (no live fills measured here), 99.5, so 1R is $2.5 and the 2R
  // target is 94.5, which the 94 low trades through.
  const winning = [{ ...bar(0, 100, 99), open: 100 }, bar(5, 99, 97), bar(10, 97, 94)];
  // Runs to the 102 stop on the second bar.
  const losing = [{ ...bar(0, 100.5, 99.5), open: 100 }, bar(5, 102.6, 100)];
  const source = {
    getCandles: async (symbol: string) => (symbol.startsWith('L') ? losing : winning),
  };
  const split = losersOnOtherTapes > 0;
  const rows = [
    ...Array.from({ length: n }, (_, i) => ({
      symbol: `S${i}`,
      at: T0,
      score: 80,
      entry: 100,
      stop: 102,
      ...(split ? { directionAtSkip: 'red' as const } : {}),
    })),
    ...Array.from({ length: losersOnOtherTapes }, (_, i) => ({
      symbol: `L${i}`,
      at: T0,
      score: 80,
      entry: 100,
      stop: 102,
      directionAtSkip: 'mixed' as const,
    })),
  ];
  const record = await buildShortShadowRecord(source, rows, {
    ...defaultAutotradeConfig(),
    liveMinSignalScore: 72,
    targetRMultiple: 2,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    liveScaleOutEnabled: false,
  });
  return { since: SHORT_SHADOW_SINCE_MS, journaledRows: n, journalTruncated: false, ...record, liveReplay: null };
}

/** Thursday 2026-09-10, 17:30 ET — after the close, on a session. */
const AFTER_CLOSE = Date.parse('2026-09-10T21:30:00Z');
const IN_SESSION = Date.parse('2026-09-10T18:00:00Z');

function result(etDate: string, over: Partial<DailyResult> = {}): DailyResult {
  return {
    etDate,
    baselineEquityUsd: 10_000,
    closeEquityUsd: 10_050,
    accountGainPct: 0.5,
    strategyPnlUsd: 50,
    strategyGainPct: 0.5,
    liveTrades: 2,
    paperPnlUsd: 0,
    goalReached: false,
    giveBackHalted: false,
    drawdownHalted: false,
    accountStrategyDiverged: false,
    divergenceUsd: 0,
    preOpenMoveUsd: null,
    // The sizing this session ran under. Defaults to the TRIAL sizing these
    // tests configure (2.5), so a row counts toward the review window; a test
    // about the window itself overrides it.
    riskPerTradePct: 2.5,
    // Null = "recorded before the basis was tracked", i.e. goalReached came
    // from ACCOUNT equity. That is what most of these rows are: sessions the
    // review is reading back. The strategy-basis case opts in explicitly, so
    // each test says which world it is in rather than inheriting one.
    goalBasis: null,
    recordedAt: 1,
    ...over,
  };
}

/** A config with a frozen options cap — the one rule that can fire on a book
 *  with no trading history at all, which makes it the cheapest vehicle for the
 *  end-to-end tests. */
function frozenCapConfig() {
  const cfg = { ...defaultAutotradeConfig(), riskPerTradePct: 1.25, maxStopDistancePct: 2.5 };
  const derived = deriveDollarCaps(cfg, 10_000);
  setAutotradeConfig({ ...cfg, ...derived, liveOptionsMaxOrderUsd: 999, liveCapsAnchorEquityUsd: 10_000 });
  return derived.liveOptionsMaxOrderUsd;
}

describe('the review window', () => {
  it('prefers the journaled sizing change', () => {
    const rows = [result('2026-09-07'), result('2026-09-08'), result('2026-09-09')];
    expect(reviewSessions(rows, '2026-09-08').map((r) => r.etDate)).toEqual(['2026-09-08', '2026-09-09']);
  });

  it('falls back to sessions the loop RECORDED, never to backfilled history', () => {
    // A backfilled row has null account columns by construction, so it cannot
    // creep into the window and let the review fire on pre-change sessions.
    const rows = [
      result('2026-09-01', { baselineEquityUsd: null, closeEquityUsd: null, accountGainPct: null }),
      result('2026-09-08'),
      result('2026-09-09'),
    ];
    expect(reviewSessions(rows, null).map((r) => r.etDate)).toEqual(['2026-09-08', '2026-09-09']);
  });

  it('counts ACTIVE sessions only — a day the book did not trade says nothing', () => {
    const rows = [result('2026-09-08', { liveTrades: 0 }), result('2026-09-09')];
    expect(reviewSessions(rows, null)).toHaveLength(1);
  });

  it('means the STRATEGY percentage, not the account one — they are not close', () => {
    // 2026-09-11 on the real book: account −31.32%, strategy −1.96%. A
    // sixteen-fold difference, with Decision 7's "REVERT if the mean day is
    // negative" on the other side of it. The account figure carries deposits,
    // withdrawals, hand trading and the unrealized mark on anything open at the
    // close; the strategy figure is realized P&L on positions the loop itself
    // opened and closed. This review is a strategy decision.
    const rows = [
      result('2026-09-10', { accountGainPct: 4, strategyGainPct: 1 }),
      result('2026-09-11', { accountGainPct: -31.32, strategyGainPct: -1.96, accountStrategyDiverged: true }),
    ];
    const review = buildSizingReview(rows, null);
    expect(review.activeSessionsSinceChange).toBe(2);
    // (1 + −1.96) / 2 — and NOT (4 + −31.32)/2, nor 4 with the manual day cut.
    expect(review.meanDayPct).toBe(-0.48);
  });

  it('keeps a manual-trading day IN the mean — its strategy figure is still the loop’s', () => {
    // The old rule dropped it. That threw away a real session out of a review
    // only ten sessions long, to remove a contamination the strategy figure
    // never had. Options are deliberately not flattened at the close, so an
    // open contract's mark alone can cross the 0.5% divergence threshold and
    // flag a perfectly clean day.
    const rows = [
      result('2026-09-10', { strategyGainPct: 2 }),
      result('2026-09-11', { strategyGainPct: 1, accountStrategyDiverged: true }),
    ];
    expect(buildSizingReview(rows, null).meanDayPct).toBe(1.5);
  });

  it('excludes a manual-trading day from the GOAL RATE while the row was stamped on the ACCOUNT', () => {
    // On a row from before 2026-09-14, goalReached was stamped when the ACCOUNT
    // equity crossed the target, so a deposit or an afternoon of hand trading
    // could bank a day the loop did not earn — 2026-08-27 banked a fictional
    // +9.69% on a spurious equity print. Such a day cannot say whether the
    // STRATEGY reached the goal, so it is counted neither way.
    const rows = [
      result('2026-09-10', { goalReached: false }),
      result('2026-09-11', { goalReached: true, accountStrategyDiverged: true }),
    ];
    const review = buildSizingReview(rows, null);
    expect(review.activeSessionsSinceChange).toBe(2); // still a session
    expect(review.goalRatePct).toBe(0); // …but its banked day is not counted
  });

  it('counts a manual-trading day on the STRATEGY basis — that stamp cannot be contaminated', () => {
    // The exclusion above is a workaround for a basis that no longer exists.
    // Once the row records that the loop's OWN realized P&L banked the day, the
    // operator's trading is irrelevant to the stamp, and dropping the session
    // would throw away real evidence out of a ten-session review. Asserted at
    // the CONSUMER: what changes is the rate the review reports, not a field.
    const rows = [
      result('2026-09-10', { goalReached: false, goalBasis: 'strategy' }),
      result('2026-09-11', { goalReached: true, accountStrategyDiverged: true, goalBasis: 'strategy' }),
    ];
    expect(buildSizingReview(rows, null).goalRatePct).toBe(50);
    // Mixed window: the pre-change row is still dropped, so the rate is over
    // the one row whose stamp can be trusted. No date literal decides this.
    const mixed = [
      result('2026-09-10', { goalReached: true, accountStrategyDiverged: true, goalBasis: 'strategy' }),
      result('2026-09-11', { goalReached: true, accountStrategyDiverged: true, goalBasis: null }),
    ];
    expect(buildSizingReview(mixed, null).goalRatePct).toBe(100);
  });

  it('reports the DENOMINATOR the rate was computed over, not only the rate', () => {
    // A rate with an unstated denominator hid the 2026-09-16 bug for two days:
    // `goalBasis` existed only on REACHED days, so the exclusion below could
    // only ever drop misses, and "100%" over a silently-halved window read
    // exactly like 100% over the whole one. The two numbers are reported side
    // by side now, so a shrinking window is visible on its face.
    const rows = [
      result('2026-09-10', { goalReached: true, goalBasis: 'strategy' }),
      result('2026-09-11', { goalReached: false, accountStrategyDiverged: true, goalBasis: null }),
    ];
    const review = buildSizingReview(rows, null);
    expect(review.activeSessionsSinceChange).toBe(2);
    expect(review.goalRateJudgedSessions).toBe(1); // the null-basis miss is dropped
    expect(review.goalRatePct).toBe(100); // …which is why this reads 100 on a 1-of-2 book

    // Every row carrying a basis is the world after the fix: nothing is dropped
    // and the rate is over the whole window.
    const stamped = rows.map((r) => ({ ...r, goalBasis: 'strategy' as const }));
    const after = buildSizingReview(stamped, null);
    expect(after.goalRateJudgedSessions).toBe(2);
    expect(after.goalRatePct).toBe(50);
  });

  // DECISION 9'S NUMBERS, IN DECISION 9'S UNIT (2026-09-12).
  //
  // "Mean red day <= -1.5%" is the pre-committed bar, and until now the only
  // red-day figures the app produced were the leak scan's meanRedSessionR /
  // worstSessionR — in R. Read side by side, -1.274R looked like it cleared
  // -1.5% when at 1.25% risk it is -1.59% and at 2.5% it would be -3.19%. Same
  // series as meanDayPct, so the two cannot disagree about which sessions or
  // which percentage they mean.
  it('reports the mean red day and the worst day in PERCENT, off the strategy series', () => {
    const rows = [
      result('2026-09-08', { strategyGainPct: 2.4 }),
      result('2026-09-09', { strategyGainPct: -1.2 }),
      result('2026-09-10', { strategyGainPct: -2.6 }),
      result('2026-09-11', { strategyGainPct: 0.4, accountStrategyDiverged: true }),
    ];
    const review = buildSizingReview(rows, null);
    expect(review.meanRedDayPct).toBe(-1.9); // (-1.2 + -2.6) / 2 — greens excluded
    expect(review.worstDayPct).toBe(-2.6);
    expect(review.meanDayPct).toBe(-0.25); // every session, manual included
  });

  it('says null rather than 0 when no session was red', () => {
    const rows = [result('2026-09-08', { strategyGainPct: 1 }), result('2026-09-09', { strategyGainPct: 0.2 })];
    const review = buildSizingReview(rows, null);
    expect(review.meanRedDayPct).toBeNull();
    expect(review.worstDayPct).toBe(0.2);
  });

  it('finds the worst run of halts in any five consecutive sessions', () => {
    const rows = [
      result('2026-09-01', { drawdownHalted: true }),
      result('2026-09-02'),
      result('2026-09-03'),
      result('2026-09-04'),
      result('2026-09-05'),
      result('2026-09-08', { drawdownHalted: true }),
      result('2026-09-09', { drawdownHalted: true }),
    ];
    expect(buildSizingReview(rows, null).haltsMaxIn5).toBe(2);
  });

  // THE CASE ABOVE PASSED THROUGHOUT, AND THE RULE IT GUARDS WAS DEAD
  // (2026-09-23). It hands the review rows built with `drawdownHalted: true`,
  // and no producer could emit one: the recorder wrote
  // `existing?.drawdownHalted ?? false` and nothing ever set `existing` true.
  // This is the goalBasis lesson again (see the comment on `judged` in
  // gatedSwitchesData.ts). So this case builds the rows with the RECORDER, from
  // halts journaled by the same writer the alert uses, and asserts on the rule's
  // verdict rather than on the count alone.
  describe('from the halt the alert journals to the revert rule, end to end', () => {
    const SESSIONS = [
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-21',
    ];

    beforeEach(() => {
      db.exec('DELETE FROM positions; DELETE FROM position_exits; DELETE FROM autotrade_daily_baseline;');
    });

    /** Records every session the way the loop does after its close: that
     *  day's baseline, one closing trade, then the recorder. A small winner
     *  each day, so the mean day stays positive and the halts are the only
     *  reason the rule can give. */
    function recordTrial(halted: { date: string; pool: 'live' | 'paper' }[]): void {
      setAutotradeConfig({ ...defaultAutotradeConfig(), riskPerTradePct: 2.5, accountEquityUsd: 10_000 });
      for (const d of SESSIONS) {
        seedClosedAutotradeSessions({ sessions: { [d]: [{ entryTime: '09:35', exitTime: '10:00', r: 0.2 }] } });
        for (const h of halted.filter((x) => x.date === d)) {
          writeDailyHaltMarker({ pool: h.pool, date: d, dailyPnl: -800, haltLevel: -750 });
        }
        saveDailyBaseline(d, 10_000);
        recordDailyResult(d, 1);
      }
    }

    const sizingRevert = GATED_SWITCH_RULES.find((r) => r.id === 'sizing_revert')!;
    const AFTER_TRIAL = Date.parse('2026-09-21T21:30:00Z');

    it('two live halts in five sessions fire the revert, with the halts as its evidence', () => {
      recordTrial([
        { date: '2026-09-15', pool: 'live' },
        { date: '2026-09-17', pool: 'live' },
      ]);
      const snap = buildGatedSwitchSnapshot(AFTER_TRIAL);
      expect(snap.review.activeSessionsSinceChange).toBe(10);
      expect(snap.review.meanDayPct).toBeGreaterThan(0);
      expect(snap.review.haltsMaxIn5).toBe(2);
      expect(sizingRevert.evaluate(snap)?.evidence).toBe('2 drawdown halts in 5 sessions');
    });

    it('paper halts are the control arm\u2019s, and never revert the live sizing', () => {
      recordTrial([
        { date: '2026-09-15', pool: 'paper' },
        { date: '2026-09-17', pool: 'paper' },
      ]);
      const snap = buildGatedSwitchSnapshot(AFTER_TRIAL);
      expect(snap.review.haltsMaxIn5).toBe(0);
      expect(sizingRevert.evaluate(snap)).toBeNull();
    });
  });

  it('reads the sizing change off the journal the config route writes', () => {
    expect(sizingChangedOn(AFTER_CLOSE)).toBeNull();
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (NULL,'config','sizing_changed','{}',NULL,?)",
    ).run(Date.parse('2026-09-09T14:00:00Z'));
    expect(sizingChangedOn(AFTER_CLOSE)).toBe('2026-09-09');
  });
});

describe('runGatedSwitches — the shadow, end to end', () => {
  it('writes NOTHING on a rule’s first firing, and journals what it would have done', () => {
    const derived = frozenCapConfig();
    runGatedSwitches(AFTER_CLOSE);

    // The config is untouched: that is the whole point of the shadow.
    expect(getAutotradeConfig().liveOptionsMaxOrderUsd).toBe(999);
    const proposals = listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] });
    const mine = proposals.find((e) => JSON.parse(e.detail!).rule === 'frozen_cap');
    expect(mine).toBeTruthy();
    const detail = JSON.parse(mine!.detail!) as { patch: Record<string, number>; blockers: string[] };
    expect(detail.patch).toEqual({ liveOptionsMaxOrderUsd: derived });
    expect(detail.blockers.join(' ')).toMatch(/evaluated on 0 of 5 sessions/);
    expect(listAutotradeEvents({ stage: 'config', actions: ['config_auto_applied'] })).toHaveLength(0);
  });

  it('graduates and applies once the written criteria are met, and says so in the journal', () => {
    const derived = frozenCapConfig();
    // Five prior sessions on which the rule was evaluated and fired.
    db.prepare(
      'INSERT INTO gated_switch_state (rule_id, evaluations, proposals, contradictions, last_met, last_evaluated_et_date, graduated_at)' +
        " VALUES ('frozen_cap', ?, 3, 0, 1, '2026-09-09', NULL)",
    ).run(SHADOW_MIN_EVALUATIONS);

    runGatedSwitches(AFTER_CLOSE);

    // THE CONSUMER: the stored config, not the engine's return value.
    expect(getAutotradeConfig().liveOptionsMaxOrderUsd).toBe(derived);
    const applied = listAutotradeEvents({ stage: 'config', actions: ['config_auto_applied'] });
    expect(applied).toHaveLength(1);
    const detail = JSON.parse(applied[0].detail!) as { rule: string; changes: Record<string, unknown> };
    expect(detail.rule).toBe('frozen_cap');
    expect(detail.changes).toEqual({ liveOptionsMaxOrderUsd: { from: 999, to: derived } });

    const grad = listAutotradeEvents({ stage: 'config', actions: ['gated_switch_graduated'] });
    expect(grad).toHaveLength(1);
    expect(JSON.parse(grad[0].detail!).rule).toBe('frozen_cap');
    expect(listSwitchStates().get('frozen_cap')?.graduatedAt).toBe(AFTER_CLOSE);
  });

  it('the master switch stops the WRITE, never the shadow record', () => {
    frozenCapConfig();
    setAutotradeConfig({ gatedSwitchesEnabled: false });
    db.prepare(
      'INSERT INTO gated_switch_state (rule_id, evaluations, proposals, contradictions, last_met, last_evaluated_et_date, graduated_at)' +
        " VALUES ('frozen_cap', ?, 3, 0, 1, '2026-09-09', NULL)",
    ).run(SHADOW_MIN_EVALUATIONS);

    runGatedSwitches(AFTER_CLOSE);
    expect(getAutotradeConfig().liveOptionsMaxOrderUsd).toBe(999);
    // Still evaluated — a record that froze while the engine was off would
    // hand the rule a graduation it never lived through.
    expect(listSwitchStates().get('frozen_cap')?.evaluations).toBe(SHADOW_MIN_EVALUATIONS + 1);
    expect(listSwitchStates().get('frozen_cap')?.graduatedAt).toBeNull();
  });

  it('persists every rule’s record, so a restart cannot hand one a clean slate', () => {
    frozenCapConfig();
    runGatedSwitches(AFTER_CLOSE);
    const states = listSwitchStates();
    // Every rule in the table has a row, including the exposure one.
    expect(states.size).toBeGreaterThanOrEqual(5);
    expect(states.get('shorts')).toMatchObject({ evaluations: 1, proposals: 0, graduatedAt: null });
    expect(states.get('frozen_cap')).toMatchObject({ evaluations: 1, proposals: 1, lastEvaluatedEtDate: '2026-09-10' });
  });

  it('a second run on the same ET date does no work at all', () => {
    frozenCapConfig();
    expect(runGatedSwitches(AFTER_CLOSE)).not.toBeNull();
    // Null rather than an empty result: the loop calls this on every tick from
    // the close to midnight (~480 a night), so the second call must bail out
    // BEFORE assembling a snapshot rather than build one for the engine to
    // discard. Five rows of state to find that out.
    expect(runGatedSwitches(AFTER_CLOSE + 60_000)).toBeNull();
    expect(listSwitchStates().get('frozen_cap')?.evaluations).toBe(1);
    expect(listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] })).toHaveLength(1);
  });

  it('still evaluates a rule with no row yet, even after the others have run today', () => {
    // A rule added between deploys has no state, so its own date guard cannot
    // have been satisfied — the cheap skip must not swallow it.
    frozenCapConfig();
    runGatedSwitches(AFTER_CLOSE);
    db.prepare("DELETE FROM gated_switch_state WHERE rule_id = 'overlay_revert'").run();

    const again = runGatedSwitches(AFTER_CLOSE + 60_000);
    expect(again).not.toBeNull();
    expect(listSwitchStates().get('overlay_revert')?.evaluations).toBe(1);
    // …and the rules that already ran today are still untouched.
    expect(listSwitchStates().get('frozen_cap')?.evaluations).toBe(1);
  });

  it('does not run at all while the session is open, or on a weekend', () => {
    frozenCapConfig();
    expect(runGatedSwitchesAfterClose(IN_SESSION)).toBeNull();
    expect(runGatedSwitchesAfterClose(Date.parse('2026-09-12T21:30:00Z'))).toBeNull(); // Saturday
    expect(listSwitchStates().size).toBe(0);
    expect(runGatedSwitchesAfterClose(AFTER_CLOSE)).not.toBeNull();
  });
});

describe('the shorts switch, over the persisted record (2026-09-19)', () => {
  const shortsPushes = () =>
    vi.mocked(dispatchNotifications).mock.calls.filter(([events]) => events[0]?.title.includes('shorts'));

  /** The last edge-leak scan as persisted, carrying the paper book's stock
   *  shorts on a red tape (the `marketTapeBySide` cut the rule reads). */
  function saveScanWithPaperShortRed(control: { n: number; meanR: number }): void {
    saveEdgeLeakScan({
      asOf: AFTER_CLOSE - 60_000,
      books: ['live', 'paper'],
      leaks: [],
      watches: [],
      findings: [],
      dimensions: [
        {
          id: 'marketTapeBySide',
          label: 'Side and market direction at entry',
          covered: 0,
          uncovered: 0,
          descriptive: null,
          buckets: [{ bucket: 'equity_short_red', n: 0, meanR: null, control }],
        },
      ],
    } as unknown as EdgeLeakScanResult);
  }

  it('proposes liveAllowNakedShort once the red-tape bar and the paper control pass, pushes once, and writes nothing', async () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), liveAllowNakedShort: false });
    // 20 red-tape winners at +2R against 2 mixed-tape stop-outs.
    const report = await shortReport(20, 2);
    expect(report.redTapeGate.passes).toBe(true);
    saveShortShadowRecord('2026-09-10', report);
    saveScanWithPaperShortRed({ n: 12, meanR: 0.3 });
    // The snapshot carries the record's OWN verdict, not a restatement of it.
    expect(buildGatedSwitchSnapshot(AFTER_CLOSE).shortShadow).toMatchObject({
      etDate: '2026-09-10',
      n: 22,
      redTapeGate: { n: 20, passes: true },
    });

    runGatedSwitches(AFTER_CLOSE);

    // THE CONSUMER: the stored config, untouched — an exposure rule never writes.
    expect(getAutotradeConfig().liveAllowNakedShort).toBe(false);
    expect(listAutotradeEvents({ stage: 'config', actions: ['config_auto_applied'] })).toHaveLength(0);
    const proposed = listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] })
      .map(
        (e) =>
          JSON.parse(e.detail!) as {
            rule: string;
            direction: string;
            patch: Record<string, unknown>;
            evidence: string;
            blockers: string[];
          },
      )
      .find((d) => d.rule === 'shorts');
    expect(proposed).toMatchObject({ direction: 'exposure', patch: { liveAllowNakedShort: true } });
    expect(proposed?.evidence).toMatch(
      /^red tape: 20 of 20 shorts, avg \+2\.00R \(bar \+0\.15R\), win 100\.0% \(bar 50%\), .* — bar met; paper red-tape stock shorts: 12 of 10, mean \+0\.30R \(bar above 0\) — met; all tapes: 22 shadow shorts/,
    );
    expect(proposed?.blockers.join(' ')).toMatch(/only the operator applies this/);
    expect(listSwitchStates().get('shorts')).toMatchObject({ proposals: 1, lastMet: true, graduatedAt: null });
    expect(listSwitchStates().get('shorts')?.lastReading).toMatch(/bar met/);
    // Pushed on the session the bar was first met…
    expect(shortsPushes()).toHaveLength(1);
    expect(shortsPushes()[0][0][0].message).toMatch(/liveAllowNakedShort → true .* waits for you/);

    // …and not again the next session it stays met: the question is the same
    // one, and the operator has not answered it yet.
    runGatedSwitches(Date.parse('2026-09-11T21:30:00Z'));
    expect(listSwitchStates().get('shorts')?.proposals).toBe(2);
    expect(shortsPushes()).toHaveLength(1);
    expect(getAutotradeConfig().liveAllowNakedShort).toBe(false);
  });

  // THE CONSUMER, end to end: paper shorts taken on a red tape, filed by a
  // REAL scan, persisted the way the route persists it, and read by the rule.
  // The synthetic scan above stands in for the producer; this is the chain.
  it('reads the paper control from a real scan of paper shorts on a red tape, and not from a live-only one', async () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), liveAllowNakedShort: false });
    saveShortShadowRecord('2026-09-10', await shortReport(20, 2));
    const at = (time: string) => etDateTimeToMs('2026-09-10', time) as number;
    db.prepare(
      'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) ' +
        "VALUES (NULL,'screen','market_direction_read',?,NULL,?)",
    ).run(JSON.stringify({ direction: 'red', indexChangePct: -0.4, redPct: 72 }), at('09:40'));
    // Twelve paper shorts after the red reading: entry 100, stop 105, covered
    // at 97, so +0.6R each.
    for (let i = 0; i < 12; i++) {
      const p = openPaperPosition({
        symbol: `S${i}`,
        side: 'sell',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 105,
        targetPrice: 90,
        riskAmount: 50,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
      });
      db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(at('10:00') + i * 60_000, p.id);
      closePaperPosition(p.id, { exitPrice: 97, exitReason: 'target' });
    }

    // A scan of the live book alone persists as well, and carries no paper
    // figures: the rule must say so, not read it as zero paper shorts.
    saveEdgeLeakScan(runEdgeLeakScanFromDb({ now: AFTER_CLOSE, books: ['live'] }));
    runGatedSwitches(AFTER_CLOSE);
    expect(listSwitchStates().get('shorts')).toMatchObject({ proposals: 0, lastMet: false });
    expect(listSwitchStates().get('shorts')?.lastReading).toContain(
      'paper red-tape stock shorts: unread (the last scan did not read the paper book)',
    );

    // The next session's scan reads both books: the control is met.
    saveEdgeLeakScan(runEdgeLeakScanFromDb({ now: AFTER_CLOSE, books: ['live', 'paper'] }));
    runGatedSwitches(Date.parse('2026-09-11T21:30:00Z'));
    expect(listSwitchStates().get('shorts')).toMatchObject({ proposals: 1, lastMet: true });
    expect(listSwitchStates().get('shorts')?.lastReading).toContain(
      'paper red-tape stock shorts: 12 of 10, mean +0.60R (bar above 0) — met',
    );
    expect(getAutotradeConfig().liveAllowNakedShort).toBe(false);
  });

  it('carries a record under the bar as a READING on the dashboard row, not a proposal', async () => {
    const report = await shortReport(19);
    expect(report.gate).toMatchObject({ passesN: false, passesAvgR: true, passesWinRate: true, passes: false });
    saveShortShadowRecord('2026-09-10', report);

    runGatedSwitches(AFTER_CLOSE);

    expect(listSwitchStates().get('shorts')).toMatchObject({ proposals: 0, lastMet: false });
    expect(shortsPushes()).toHaveLength(0);
    // The dashboard's row reads the same persisted state the engine wrote.
    const row = buildGatedSwitchStatus().find((r) => r.id === 'shorts');
    // Since 2026-09-24 it reads the red-tape bar first. These 19 shorts carry
    // no tape (the loop had not read the market yet), so none count toward it.
    expect(row?.lastReading).toBe(
      "red tape: 0 of 20 shorts, avg n/a (bar +0.15R), win n/a (bar 50%), n/a over the other tapes' 0 " +
        '(bar +0.1R) — short on trades, avg R, win rate, edge over other tapes; paper red-tape stock shorts: unread ' +
        '(no edge-leak scan saved yet); all tapes: 19 shadow shorts, avg +2.00R, win 100.0%, as of 2026-09-10',
    );
  });

  it('reads no record as no evidence — the rule stays quiet with nothing to read', () => {
    frozenCapConfig();
    runGatedSwitches(AFTER_CLOSE);
    expect(buildGatedSwitchSnapshot(AFTER_CLOSE).shortShadow).toBeNull();
    expect(listSwitchStates().get('shorts')).toMatchObject({ evaluations: 1, proposals: 0, lastReading: null });
  });
});

describe('the sizing revert, over real rows', () => {
  it('proposes the pre-trial settings once ten active sessions read negative', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), riskPerTradePct: 2.5 });
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0');
      saveDailyResult(result(`2026-09-${day}`, { accountGainPct: -0.8, strategyGainPct: -0.8 }));
    }
    runGatedSwitches(AFTER_CLOSE);

    const proposed = listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] })
      .map((e) => JSON.parse(e.detail!) as { rule: string; patch: Record<string, unknown>; evidence: string })
      .find((d) => d.rule === 'sizing_revert');
    expect(proposed).toBeTruthy();
    expect(proposed!.patch.riskPerTradePct).toBe(1.25);
    expect(proposed!.evidence).toMatch(/mean day -0\.8% over 10 active sessions/);
    // Shadowed, so the live risk % is untouched.
    expect(getAutotradeConfig().riskPerTradePct).toBe(2.5);
  });

  it('does not count a session that ran a DIFFERENT sizing as part of the trial', () => {
    // The bug this column exists for (2026-09-12). The daily-results recorder
    // deployed one session before the sizing changed, and no `sizing_changed`
    // journal row existed, so the old fallback counted that session — old
    // sizing, and a -31% manual-trading day — as trial session 1. Ten rows
    // here, but one of them ran 1.25%, so the window is nine and the rule must
    // stay silent.
    setAutotradeConfig({ ...defaultAutotradeConfig(), riskPerTradePct: 2.5 });
    saveDailyResult(
      result('2026-09-01', {
        accountGainPct: -31,
        strategyGainPct: -2,
        accountStrategyDiverged: true,
        riskPerTradePct: 1.25,
      }),
    );
    for (let i = 2; i <= 10; i++) {
      const day = String(i).padStart(2, '0');
      saveDailyResult(result(`2026-09-${day}`, { accountGainPct: -0.8, strategyGainPct: -0.8 }));
    }
    runGatedSwitches(AFTER_CLOSE);
    const proposed = listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] })
      .map((e) => JSON.parse(e.detail!) as { rule: string })
      .find((d) => d.rule === 'sizing_revert');
    expect(proposed).toBeFalsy();

    // A row with an UNKNOWN sizing (recorded before the column, or backfilled)
    // is not a match either — unknown is not the current sizing.
    saveDailyResult(result('2026-08-31', { accountGainPct: -0.8, strategyGainPct: -0.8, riskPerTradePct: null }));
    runGatedSwitches(AFTER_CLOSE + 86_400_000);
    expect(
      listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] })
        .map((e) => JSON.parse(e.detail!) as { rule: string })
        .find((d) => d.rule === 'sizing_revert'),
    ).toBeFalsy();
  });

  it('stays silent at nine sessions, however bad they look', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), riskPerTradePct: 2.5 });
    for (let i = 1; i <= 9; i++) {
      saveDailyResult(result(`2026-09-0${i}`, { accountGainPct: -3, strategyGainPct: -3 }));
    }
    runGatedSwitches(AFTER_CLOSE);
    const rules = listAutotradeEvents({ stage: 'config', actions: ['config_change_proposed'] }).map(
      (e) => (JSON.parse(e.detail!) as { rule: string }).rule,
    );
    expect(rules).not.toContain('sizing_revert');
  });
});
