import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { DailyResult, saveDailyResult } from '../src/db/dailyResults';
import { listSwitchStates } from '../src/db/gatedSwitchState';
import { deriveDollarCaps } from '../src/services/autotrading/targetTune';
import {
  buildSizingReview,
  reviewSessions,
  runGatedSwitches,
  runGatedSwitchesAfterClose,
  sizingChangedOn,
} from '../src/services/autotrading/gatedSwitchesData';
import { SHADOW_MIN_EVALUATIONS } from '../src/services/autotrading/gatedSwitches';

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
      'DELETE FROM autotrade_daily_results; DELETE FROM edge_leak_scans;',
  );
});

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
    manualTrading: false,
    // The sizing this session ran under. Defaults to the TRIAL sizing these
    // tests configure (2.5), so a row counts toward the review window; a test
    // about the window itself overrides it.
    riskPerTradePct: 2.5,
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
      result('2026-09-11', { accountGainPct: -31.32, strategyGainPct: -1.96, manualTrading: true }),
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
      result('2026-09-11', { strategyGainPct: 1, manualTrading: true }),
    ];
    expect(buildSizingReview(rows, null).meanDayPct).toBe(1.5);
  });

  it('excludes a manual-trading day from the GOAL RATE, where the flag belongs', () => {
    // goalReached is stamped when the ACCOUNT equity crosses the target, so a
    // deposit or an afternoon of hand trading can bank a day the loop did not
    // earn — 2026-08-27 banked a fictional +9.69% on a spurious equity print.
    // A day whose two figures disagree cannot say whether the STRATEGY reached
    // the goal, so it is counted neither way.
    const rows = [
      result('2026-09-10', { goalReached: false }),
      result('2026-09-11', { goalReached: true, manualTrading: true }),
    ];
    const review = buildSizingReview(rows, null);
    expect(review.activeSessionsSinceChange).toBe(2); // still a session
    expect(review.goalRatePct).toBe(0); // …but its banked day is not counted
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
      result('2026-09-11', { strategyGainPct: 0.4, manualTrading: true }),
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
      result('2026-09-01', { accountGainPct: -31, strategyGainPct: -2, manualTrading: true, riskPerTradePct: 1.25 }),
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
