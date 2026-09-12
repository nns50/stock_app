import { getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { listSwitchStates, saveSwitchState } from '../../db/gatedSwitchState';
import { getLastEdgeLeakScan } from '../../db/edgeLeakScans';
import { DailyResult, listDailyResults } from '../../db/dailyResults';
import { getMlRegimeReadiness } from '../mlRegimeReadiness';
import { etToday } from '../../util/marketDate';
import { isTradingSession } from '../trading/marketCalendar';
import { isAfterSessionClose } from '../trading/marketHours';
import { buildCapsCoherence } from './dashboard';
import { dayPctOf } from './dailyResults';
import { dispatchAutotradeNotification } from './notify';
import {
  assertWritable,
  evaluateGatedSwitches,
  GatedSwitchResult,
  GatedSwitchSnapshot,
  GATED_SWITCH_RULES,
  SizingReview,
} from './gatedSwitches';

// ---------------------------------------------------------------------------
// The DB half of the gated-switch engine: gather the snapshot, run the rules,
// persist each rule's shadow record, journal, and — for a rule that has
// graduated — write the patch.
//
// Runs once per session on the first loop tick after the close, beside the
// daily-results recorder, and is a no-op in session. Once per ET DATE is
// enforced by the engine itself (a rule already evaluated today is skipped),
// so a restart loop cannot graduate anything in an afternoon.
// ---------------------------------------------------------------------------

/** The window the review rule reads. Five is Decision 7's "twice in any 5". */
const HALT_WINDOW = 5;

/**
 * When the sizing was last changed, as an ET date, or null when the journal
 * does not say.
 *
 * Same shape of problem as the tuner's switch: the config row cannot date it
 * (its `updated_at` moves every tick, because the equity sync writes
 * `accountEquityUsd` every minute), so the moment is journaled by the config
 * route when `riskPerTradePct` changes.
 */
export function sizingChangedOn(now: number): string | null {
  const since = now - 180 * 24 * 60 * 60 * 1000;
  const rows = listAutotradeEvents({ stage: 'config', actions: ['sizing_changed'], since, limit: 10 });
  return rows.length ? etToday(rows[0].createdAt) : null;
}

/**
 * The sessions the pre-committed review is counted over.
 *
 * Preferred: everything on or after the journaled sizing change. Failing that
 * — a change that predates the journal row, which the 2026-09-12 trial itself
 * does — every session the loop RECORDED live, identified by having an account
 * baseline. A backfilled historical row has null account columns by
 * construction (`backfillDailyResults` refuses to invent an opening equity),
 * so this cannot over-count the window with sessions from before the change,
 * and over-counting is the only direction that would let the rule fire early.
 */
export function reviewSessions(rows: DailyResult[], changedOn: string | null): DailyResult[] {
  const inWindow = changedOn
    ? rows.filter((r) => r.etDate >= changedOn)
    : rows.filter((r) => r.baselineEquityUsd !== null);
  // Active sessions only — a day the book did not trade cannot speak to whether
  // the sizing works, and averaging it in would drag the mean toward zero.
  return inWindow.filter((r) => r.liveTrades > 0);
}

export function buildSizingReview(rows: DailyResult[], changedOn: string | null): SizingReview {
  const sessions = reviewSessions(rows, changedOn);
  // A manual-trading day's account % is not the strategy's, and the review is
  // about the strategy. Excluded from the MEAN, still counted as a session.
  const judged = sessions.filter((r) => !r.manualTrading);
  const pcts = judged.map(dayPctOf).filter((p): p is number => p !== null);
  let haltsMaxIn5 = 0;
  for (let i = 0; i < sessions.length; i++) {
    const window = sessions.slice(Math.max(0, i - HALT_WINDOW + 1), i + 1);
    haltsMaxIn5 = Math.max(haltsMaxIn5, window.filter((r) => r.drawdownHalted).length);
  }
  return {
    activeSessionsSinceChange: sessions.length,
    meanDayPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100 : null,
    goalRatePct: sessions.length
      ? Math.round((sessions.filter((r) => r.goalReached).length / sessions.length) * 1000) / 10
      : null,
    haltsMaxIn5,
  };
}

export function buildGatedSwitchSnapshot(now: number): GatedSwitchSnapshot {
  const config = getAutotradeConfig();
  const changedOn = sizingChangedOn(now);
  return {
    etDate: etToday(now),
    config,
    readiness: getMlRegimeReadiness(now),
    leakScan: getLastEdgeLeakScan()?.result ?? null,
    review: buildSizingReview(listDailyResults(), changedOn),
    capsCoherence: buildCapsCoherence(config).map((c) => ({
      key: c.key,
      stored: c.stored,
      derived: c.derived,
      anchorOwned: c.anchorOwned,
    })),
  };
}

/**
 * Evaluate every rule for `now`'s session and act on the result.
 *
 * Writes go through `setAutotradeConfig`, which sanitises every field, and the
 * patch has already passed `assertWritable` inside the engine — belt and
 * braces on purpose, because a patch assembled from a leak scan's lever is
 * data rather than literal code.
 */
export function runGatedSwitches(now: number = Date.now()): GatedSwitchResult {
  const snapshot = buildGatedSwitchSnapshot(now);
  const result = evaluateGatedSwitches({
    snapshot,
    states: listSwitchStates(),
    enabled: snapshot.config.gatedSwitchesEnabled,
    now,
    rules: GATED_SWITCH_RULES,
  });

  for (const { ruleId, patch, evidence } of result.applied) {
    assertWritable(patch);
    const before = getAutotradeConfig();
    setAutotradeConfig(patch);
    const changes = Object.fromEntries(
      Object.entries(patch).map(([k, to]) => [k, { from: before[k as keyof typeof before], to }]),
    );
    logAutotradeEvent({
      stage: 'config',
      action: 'config_auto_applied',
      detail: { rule: ruleId, changes, evidence },
      riskProfile: before.riskProfile,
    });
    // A config write on live money is consequential enough to surface now,
    // not merely to be discoverable on Recent Activity later.
    void dispatchAutotradeNotification('gated-switches', [
      {
        title: `Autotrade applied a gated switch: ${ruleId}`,
        message: `${Object.entries(patch)
          .map(([k, v]) => `${k} → ${String(v)}`)
          .join(', ')} — ${evidence}`,
      },
    ]);
  }

  for (const { ruleId, patch, evidence, direction } of result.proposed) {
    logAutotradeEvent({
      stage: 'config',
      action: 'config_change_proposed',
      detail: {
        rule: ruleId,
        direction,
        patch,
        evidence,
        // Why it was not applied — the reader should never have to infer it.
        blockers:
          result.decisions.find((d) => d.rule.id === ruleId)?.graduation.graduated === true
            ? ['the engine is switched off or the kill switch is engaged']
            : ((result.decisions.find((d) => d.rule.id === ruleId)?.graduation as { blockers?: string[] })?.blockers ??
              []),
      },
      riskProfile: snapshot.config.riskProfile,
    });
  }

  for (const decision of result.decisions) {
    if (decision.nextState !== undefined) saveSwitchState(decision.nextState);
    if (decision.outcome === 'applied' && decision.nextState.graduatedAt === now) {
      logAutotradeEvent({
        stage: 'config',
        action: 'gated_switch_graduated',
        detail: {
          rule: decision.rule.id,
          evaluations: decision.nextState.evaluations,
          proposals: decision.nextState.proposals,
          criterion: decision.rule.criterion,
        },
        riskProfile: snapshot.config.riskProfile,
      });
    }
  }

  return result;
}

/** The loop's hook: once the bell has rung, run the engine for today. Null
 *  when it is not after the close, or the day is not a session. */
export function runGatedSwitchesAfterClose(now: number = Date.now()): GatedSwitchResult | null {
  const today = etToday(now);
  if (!isTradingSession(today) || !isAfterSessionClose(now)) return null;
  return runGatedSwitches(now);
}
