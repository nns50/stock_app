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
 * THE OLD FALLBACK WAS WRONG, and its comment said so confidently (2026-09-12).
 * It preferred the journaled sizing change and, failing that, counted "every
 * session the loop RECORDED live, identified by having an account baseline",
 * asserting that this "cannot over-count the window with sessions from before
 * the change". It could, and did: the daily-results recorder deployed on
 * 2026-09-11 and the sizing changed on 2026-09-12, so exactly one session
 * — the old sizing, and a -31% manual-trading day — was recorded live and
 * counted as trial session 1. The `sizing_changed` journal row that would have
 * ruled it out did not exist, because the route that writes it deployed after
 * the config was already changed.
 *
 * The fix is not a better guess. Each row now records the risk % that was in
 * force on it, so the window is "sessions that ran the sizing we are
 * reviewing" — true by construction, needing no journal row, and self-healing
 * for any future change. A row with a null risk (recorded before the column,
 * or backfilled) is NOT counted: unknown is not a match.
 *
 * The journaled date still wins when present. It is the more precise fact, and
 * it distinguishes two separate trials that happened to use the same risk %.
 */
export function reviewSessions(
  rows: DailyResult[],
  changedOn: string | null,
  currentRiskPerTradePct?: number,
): DailyResult[] {
  const inWindow = changedOn
    ? rows.filter((r) => r.etDate >= changedOn)
    : currentRiskPerTradePct !== undefined
      ? rows.filter((r) => r.riskPerTradePct !== null && r.riskPerTradePct === currentRiskPerTradePct)
      : rows.filter((r) => r.baselineEquityUsd !== null);
  // Active sessions only — a day the book did not trade cannot speak to whether
  // the sizing works, and averaging it in would drag the mean toward zero.
  return inWindow.filter((r) => r.liveTrades > 0);
}

export function buildSizingReview(
  rows: DailyResult[],
  changedOn: string | null,
  currentRiskPerTradePct?: number,
): SizingReview {
  const sessions = reviewSessions(rows, changedOn, currentRiskPerTradePct);
  // THE MEAN IS THE STRATEGY'S FIGURE, NOT THE ACCOUNT'S (2026-09-12).
  //
  // This used to read `dayPctOf` — `accountGainPct ?? strategyGainPct`, the
  // ACCOUNT number first — and then try to subtract the contamination with the
  // `manualTrading` flag. Both halves of that were wrong, and the one session
  // on the book with both numbers shows the size of it: 2026-09-11 recorded
  // **account −31.32%** against **strategy −1.96%**. A sixteen-fold difference,
  // with Decision 7's "REVERT if the mean day is negative" on the other side of
  // it and a single boolean in between.
  //
  // The account figure carries deposits, withdrawals, hand trading, and the
  // unrealized mark on anything still open at the close. The strategy figure is
  // realized P&L on positions the LOOP opened and closed, over the same
  // baseline — immune to all four BY CONSTRUCTION. dailyResults.ts's own header
  // already says which is which: "A strategy decision is made on the second
  // (OPTIONS_TUNING_PLAN's data-quality rule — a position-derived series
  // carries no flows)." Decision 7 is a strategy decision. It was reading the
  // other series.
  //
  // A THRESHOLD IS NOT A SUBSTITUTE FOR THE RIGHT INPUT. `manualTrading` fires
  // at 0.5% of equity — on a $3,523 account, $17.60. Hand trading below that is
  // never flagged and flowed straight into the mean; and the flag fires on
  // clean days too, because options are deliberately NOT flattened at the close
  // (endOfDayFlatten.ts) so an open contract's mark can cross 0.5% on its own.
  // The same number both admitted real contamination and threw away real
  // sessions — out of a review that is only ten sessions long.
  //
  // So the mean reads the strategy figure and NO session is dropped from it: a
  // manual day's strategy percentage is still exactly what the loop did.
  // `dayPctOf` is left alone for the calendar, where account-first is right —
  // that page answers "how am I doing", which is the question the account
  // figure is for.
  const pcts = sessions.map((r) => r.strategyGainPct).filter((p): p is number => p !== null);
  // Kept for the GOAL RATE below, whose flag is account-derived — see there.
  const judged = sessions.filter((r) => !r.manualTrading);
  let haltsMaxIn5 = 0;
  for (let i = 0; i < sessions.length; i++) {
    const window = sessions.slice(Math.max(0, i - HALT_WINDOW + 1), i + 1);
    haltsMaxIn5 = Math.max(haltsMaxIn5, window.filter((r) => r.drawdownHalted).length);
  }
  return {
    activeSessionsSinceChange: sessions.length,
    meanDayPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100 : null,
    // The goal rate is where the manual exclusion BELONGS, and it was the half
    // that did not have it. `goalReached` is stamped when the ACCOUNT equity
    // crosses the target (dailyTarget.ts reads the synced net liquidation), so
    // a deposit or an afternoon of hand trading can bank a day the loop did not
    // earn — which is not hypothetical: 2026-08-27 banked a fictional +9.69% on
    // a spurious equity print. A day whose two figures disagree cannot say
    // whether the STRATEGY reached the goal, so it is not counted either way.
    goalRatePct: judged.length
      ? Math.round((judged.filter((r) => r.goalReached).length / judged.length) * 1000) / 10
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
    review: buildSizingReview(listDailyResults(), changedOn, config.riskPerTradePct),
    capsCoherence: buildCapsCoherence(config).map((c) => ({
      key: c.key,
      stored: c.stored,
      derived: c.derived,
      anchorOwned: c.anchorOwned,
    })),
  };
}

/**
 * Evaluate every rule for `now`'s session and act on the result. Null when
 * every rule has already been evaluated on this ET date.
 *
 * Writes go through `setAutotradeConfig`, which sanitises every field, and the
 * patch has already passed `assertWritable` inside the engine — belt and
 * braces on purpose, because a patch assembled from a leak scan's lever is
 * data rather than literal code.
 *
 * THE DATE CHECK HAPPENS TWICE, and deliberately. The engine holds the
 * authoritative per-RULE guard (a rule added mid-day has no row yet, so it is
 * still evaluated today while its neighbours are skipped). The cheap check
 * below is only about work: the loop calls this on every tick from the close
 * to midnight — roughly 480 times a night — and without it the snapshot would
 * be rebuilt each time only for the engine to discard the lot. Five rows of
 * state to find that out, against a readiness read, the whole daily-results
 * table and a caps derivation.
 */
export function runGatedSwitches(now: number = Date.now()): GatedSwitchResult | null {
  const etDate = etToday(now);
  const states = listSwitchStates();
  const pending = GATED_SWITCH_RULES.some((r) => states.get(r.id)?.lastEvaluatedEtDate !== etDate);
  if (!pending) return null;

  const snapshot = buildGatedSwitchSnapshot(now);
  const result = evaluateGatedSwitches({
    snapshot,
    states,
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
        // An exposure refusal comes FIRST and on its own: "this patch adds
        // exposure" is a different answer from "this rule is still shadowing",
        // and it is the one that needs reading.
        blockers: (() => {
          const d = result.decisions.find((x) => x.rule.id === ruleId);
          if (d && d.exposureRefusals.length > 0) return d.exposureRefusals;
          if (d?.graduation.graduated === true) return ['the engine is switched off or the kill switch is engaged'];
          return (d?.graduation as { blockers?: string[] } | undefined)?.blockers ?? [];
        })(),
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
