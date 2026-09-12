import { AutotradeConfig } from '../../db/autotradeConfig';
import type { MlRegimeReadiness } from '../mlRegimeReadiness';
import type { EdgeLeakScanResult, LeakReport } from './edgeLeakScan';
import type { DollarCapKey } from './targetTune';

// ---------------------------------------------------------------------------
// The criteria-gated switches (Workstream 7 of the 3%-goal plan, 2026-09-12).
//
// Every gated item in that plan has a written criterion, and until now the
// criteria were checked by a human reading a daily routine's output. That is a
// single point of failure sitting underneath a risk increase: the routine has
// to fire, and someone has to read it correctly, on each of the ten sessions
// the pre-committed review runs over. This module evaluates the criteria
// itself, once per session after the close.
//
// THE OPERATOR'S DIVISION (2026-09-12): a rule that REDUCES exposure — a
// revert, a size cut, a cooldown, a score floor — may be applied by the app; a
// rule that ADDS exposure is reported and waits for their word, always, with
// no graduation path. That asymmetry is the whole safety model, so `direction`
// is a required field on every rule and `exposure` is checked in three places
// rather than one.
//
// EVERY RULE SHADOWS BEFORE IT ACTS. This codebase's own convention is to ship
// a mechanism as a measurement first — the entry-extension gate, the short
// shadow record, the regime-tighten ledger all did — and a mechanism whose
// output is a config write on live money has a stronger claim to that than any
// of them. So a `safe` rule starts in SHADOW: it evaluates, it journals what it
// WOULD have applied, and it changes nothing. It graduates to applying by its
// own written criterion (see `graduationVerdict`), which the engine checks
// itself — the operator does not have to come back and flip a flag.
//
// Shadow costs nothing that is not already being paid. During it the routine
// reports each proposal to the operator exactly as it does today, so a genuine
// revert is still one line away from being applied by hand; the shadow only
// withholds the app's own hand until the rule has been seen to behave.
//
// PURE. Snapshot in, decisions out. The DB half (gatedSwitchesData.ts) gathers
// the snapshot, persists per-rule state, journals, and applies.
// ---------------------------------------------------------------------------

export type SwitchDirection = 'safe' | 'exposure';

/** What a rule may write. Deliberately an explicit union rather than
 *  `keyof AutotradeConfig`: the engine's blast radius should be readable in
 *  one place, and a rule that wanted a new field should have to come here and
 *  justify it. `assertWritable` enforces it at runtime too, because a patch
 *  assembled from a leak scan's lever is data, not literal code. */
export type SwitchWritableKey =
  | 'mlRegimeEnabled'
  | 'riskPerTradePct'
  | 'liveMaxExposurePct'
  | 'maxAggregateOpenRiskPct'
  | 'maxDailyDrawdownPct'
  | 'expectancyMaxMultiplier'
  | 'liveScaleOutEnabled'
  | 'targetRMultiple'
  | 'stagnationExitMinutes'
  | 'symbolReentryCooldownMinutes'
  | 'liveMinSignalScore'
  | DollarCapKey;

export const SWITCH_WRITABLE_KEYS: readonly SwitchWritableKey[] = [
  'mlRegimeEnabled',
  'riskPerTradePct',
  'liveMaxExposurePct',
  'maxAggregateOpenRiskPct',
  'maxDailyDrawdownPct',
  'expectancyMaxMultiplier',
  'liveScaleOutEnabled',
  'targetRMultiple',
  'stagnationExitMinutes',
  'symbolReentryCooldownMinutes',
  'liveMinSignalScore',
  'liveMaxOrderUsd',
  'liveMaxDailyLossUsd',
  'liveOptionsMaxOrderUsd',
  'liveOptionsMaxDailyLossUsd',
] as const;

export type SwitchPatch = Partial<Pick<AutotradeConfig, SwitchWritableKey>>;

/** Throws rather than writing a key no rule is allowed to touch. The leak
 *  scan's levers are data read out of a scan result, so "the rule only writes
 *  what its literal says" is not something the type system can promise here. */
export function assertWritable(patch: SwitchPatch): void {
  for (const key of Object.keys(patch)) {
    if (!(SWITCH_WRITABLE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`gated switches may not write ${key}`);
    }
  }
}

/** One rule's reading on one session. */
export interface SwitchFiring {
  patch: SwitchPatch;
  /** The numbers that met the criterion, for the journal and the report. */
  evidence: string;
}

export interface SwitchRule {
  id: string;
  label: string;
  direction: SwitchDirection;
  /** The written criterion, in the words the plan uses, carried with the rule
   *  so a report never has to paraphrase it. */
  criterion: string;
  /** Null when the criterion is not met, or when the snapshot cannot answer
   *  it — an absent input is NOT a met criterion. */
  evaluate: (s: GatedSwitchSnapshot) => SwitchFiring | null;
}

/** Everything the rules read. Assembled by the DB half so the rules stay
 *  testable on fixtures, and so "what does this engine look at" is one type
 *  rather than a scattering of imports. */
export interface GatedSwitchSnapshot {
  etDate: string;
  config: AutotradeConfig;
  /** Null when the readiness tracker has nothing to say (not deployed, or no
   *  sessions counted yet). */
  readiness: MlRegimeReadiness | null;
  /** The last persisted edge-leak scan, or null if none has run. */
  leakScan: EdgeLeakScanResult | null;
  review: SizingReview;
  capsCoherence: { key: DollarCapKey; stored: number; derived: number | null; anchorOwned: boolean }[];
}

/** The pre-committed review's inputs (Decision 7), counted since the sizing
 *  change rather than over a fixed window. */
export interface SizingReview {
  /** Active sessions since `riskPerTradePct` was raised. 0 until it was. */
  activeSessionsSinceChange: number;
  /** Mean day over those sessions, in % — manual-trading days excluded. */
  meanDayPct: number | null;
  /** Goal-hit rate over those sessions, in %. */
  goalRatePct: number | null;
  /** The most drawdown halts in any 5 consecutive sessions of the window. */
  haltsMaxIn5: number;
}

// --- the graduation gate ---------------------------------------------------

/** Sessions a rule must have been EVALUATED on before it may act. Five is one
 *  trading week: long enough that a rule reading a transient has shown its
 *  hand, short enough that the shadow is not itself the risk. */
export const SHADOW_MIN_EVALUATIONS = 5;

/** One rule's accumulated shadow record. Persisted, because a restart must not
 *  hand a rule a fresh clean slate it has not earned. */
export interface SwitchState {
  ruleId: string;
  evaluations: number;
  proposals: number;
  /** Times the rule proposed and then read NOT met on the very next
   *  evaluation, without its patch having been applied in between — a rule
   *  that flaps is a rule reading noise, and it never graduates. */
  contradictions: number;
  lastMet: boolean;
  lastEvaluatedEtDate: string | null;
  /** Epoch ms the rule graduated from shadow to applying; null while shadowed. */
  graduatedAt: number | null;
}

export const freshSwitchState = (ruleId: string): SwitchState => ({
  ruleId,
  evaluations: 0,
  proposals: 0,
  contradictions: 0,
  lastMet: false,
  lastEvaluatedEtDate: null,
  graduatedAt: null,
});

export type GraduationVerdict = { graduated: true } | { graduated: false; blockers: string[] };

/**
 * May this rule act yet?
 *
 * The criterion, written once here so the engine, the report and the docs all
 * quote the same thing:
 *
 *   • the rule reduces exposure (an `exposure` rule NEVER graduates), and
 *   • it has been evaluated on at least SHADOW_MIN_EVALUATIONS sessions, and
 *   • it has actually fired at least once in shadow — a rule that has never
 *     produced a proposal has demonstrated nothing, however long it has sat
 *     there, and
 *   • it has never contradicted itself (proposed, then read not-met the next
 *     session without its patch being applied).
 *
 * `state` is the record BEFORE this session's evaluation is folded in, so a
 * rule that meets the bar and is met today graduates and applies today rather
 * than a session later. That is the operator's "flip it on automatically once
 * the criteria are met".
 */
export function graduationVerdict(rule: SwitchRule, state: SwitchState): GraduationVerdict {
  if (state.graduatedAt !== null) return { graduated: true };
  const blockers: string[] = [];
  if (rule.direction === 'exposure') {
    // Not a blocker that time can clear — say so in those words, so a reader
    // never waits for an exposure rule to graduate.
    return { graduated: false, blockers: ['adds exposure — only the operator applies this, by standing decision'] };
  }
  if (state.evaluations < SHADOW_MIN_EVALUATIONS) {
    blockers.push(`evaluated on ${state.evaluations} of ${SHADOW_MIN_EVALUATIONS} sessions`);
  }
  if (state.proposals < 1) blockers.push('has never fired — a rule that has not proposed has proved nothing');
  if (state.contradictions > 0) {
    blockers.push(`contradicted itself ${state.contradictions}× (proposed, then not met the next session)`);
  }
  return blockers.length === 0 ? { graduated: true } : { graduated: false, blockers };
}

/** What one rule did this session. */
export interface SwitchDecision {
  rule: SwitchRule;
  met: boolean;
  firing: SwitchFiring | null;
  /** 'applied' — written; 'proposed' — met but still shadowed, or an exposure
   *  rule; 'quiet' — not met; 'held' — met and graduated, but the engine is
   *  switched off or the kill switch is engaged. */
  outcome: 'applied' | 'proposed' | 'quiet' | 'held';
  graduation: GraduationVerdict;
  /** The state AFTER this session is folded in — what the caller persists. */
  nextState: SwitchState;
}

export interface GatedSwitchResult {
  etDate: string;
  decisions: SwitchDecision[];
  /** Patches to write, in rule order. Empty in shadow, which is the point. */
  applied: { ruleId: string; patch: SwitchPatch; evidence: string }[];
  proposed: { ruleId: string; patch: SwitchPatch; evidence: string; direction: SwitchDirection }[];
}

/** Fold this session's reading into a rule's shadow record. */
export function nextSwitchState(state: SwitchState, met: boolean, etDate: string, applied: boolean): SwitchState {
  // A rule that proposed and now reads not-met, with nothing having been
  // applied in between, contradicted itself. If its patch WAS applied, the
  // criterion ceasing to hold is the patch working — the opposite of a
  // contradiction — which is why `applied` is a parameter rather than inferred.
  const contradicted = state.lastMet && !met && !applied;
  return {
    ruleId: state.ruleId,
    evaluations: state.evaluations + 1,
    proposals: state.proposals + (met ? 1 : 0),
    contradictions: state.contradictions + (contradicted ? 1 : 0),
    lastMet: met,
    lastEvaluatedEtDate: etDate,
    graduatedAt: state.graduatedAt,
  };
}

export interface EvaluateInput {
  snapshot: GatedSwitchSnapshot;
  states: Map<string, SwitchState>;
  /** The master switch. False = evaluate and record, apply nothing. */
  enabled: boolean;
  now: number;
  rules?: SwitchRule[];
}

/**
 * Evaluate every rule for one session.
 *
 * The kill switch and the master flag suppress APPLICATION, never evaluation:
 * a shadow record that stops accumulating while the engine is off would hand a
 * rule a graduation it never earned the moment it came back on.
 */
export function evaluateGatedSwitches(input: EvaluateInput): GatedSwitchResult {
  const { snapshot, states, enabled, now } = input;
  const rules = input.rules ?? GATED_SWITCH_RULES;
  const decisions: SwitchDecision[] = [];
  const applied: GatedSwitchResult['applied'] = [];
  const proposed: GatedSwitchResult['proposed'] = [];

  for (const rule of rules) {
    const state = states.get(rule.id) ?? freshSwitchState(rule.id);
    // A rule evaluated twice on one ET date must not count twice, or a restart
    // loop would graduate everything in an afternoon.
    if (state.lastEvaluatedEtDate === snapshot.etDate) {
      decisions.push({
        rule,
        met: state.lastMet,
        firing: null,
        outcome: 'quiet',
        graduation: graduationVerdict(rule, state),
        nextState: state,
      });
      continue;
    }

    const firing = rule.evaluate(snapshot);
    if (firing) assertWritable(firing.patch);
    const met = firing !== null;
    const graduation = graduationVerdict(rule, state);
    const canApply = met && graduation.graduated && enabled && !snapshot.config.killSwitch;

    let outcome: SwitchDecision['outcome'] = 'quiet';
    if (met && canApply) outcome = 'applied';
    else if (met && graduation.graduated) outcome = 'held';
    else if (met) outcome = 'proposed';

    if (outcome === 'applied' && firing)
      applied.push({ ruleId: rule.id, patch: firing.patch, evidence: firing.evidence });
    if ((outcome === 'proposed' || outcome === 'held') && firing) {
      proposed.push({ ruleId: rule.id, patch: firing.patch, evidence: firing.evidence, direction: rule.direction });
    }

    const folded = nextSwitchState(state, met, snapshot.etDate, outcome === 'applied');
    decisions.push({
      rule,
      met,
      firing,
      outcome,
      graduation,
      // Stamp the graduation on the session it actually acts, so the journal
      // and the state agree about when the shadow ended.
      nextState: outcome === 'applied' && folded.graduatedAt === null ? { ...folded, graduatedAt: now } : folded,
    });
  }

  return { etDate: snapshot.etDate, decisions, applied, proposed };
}

// --- the rules -------------------------------------------------------------

const pct = (n: number | null): string => (n === null ? 'n/a' : `${n}%`);

/** The 2026-09-11 sizing, verbatim — what Decision 7's revert restores. Kept
 *  as a literal rather than read from anywhere, because the whole point of a
 *  pre-committed revert is that its destination cannot drift. */
export const PRE_TRIAL_SIZING: SwitchPatch = {
  riskPerTradePct: 1.25,
  liveMaxExposurePct: 155,
  maxAggregateOpenRiskPct: 6,
  maxDailyDrawdownPct: 6.42,
  expectancyMaxMultiplier: 1.5,
  liveScaleOutEnabled: true,
  targetRMultiple: 2,
  stagnationExitMinutes: 90,
  symbolReentryCooldownMinutes: 120,
};

export const GATED_SWITCH_RULES: SwitchRule[] = [
  {
    id: 'overlay_revert',
    label: 'Revert the ML regime overlay to OFF',
    direction: 'safe',
    criterion:
      'the overlay is on AND any of: a parity disagreement, a drift day, an inert streak of 5, or more than 2 regime switches in any 5 sessions',
    evaluate: (s) => {
      const r = s.readiness;
      if (!s.config.mlRegimeEnabled || !r) return null;
      const reasons: string[] = [];
      if (r.parity.disagreed > 0) reasons.push(`${r.parity.disagreed} parity disagreement(s)`);
      if (r.drift) reasons.push(`drift on ${r.driftSessions} session(s)`);
      if (r.inertStreak >= r.inertRevertAt)
        reasons.push(`inert streak ${r.inertStreak} (revert at ${r.inertRevertAt})`);
      if (r.switches.maxIn5Sessions > r.switches.limitPerWeek) {
        reasons.push(`${r.switches.maxIn5Sessions} switches in 5 sessions (limit ${r.switches.limitPerWeek})`);
      }
      if (reasons.length === 0) return null;
      return { patch: { mlRegimeEnabled: false }, evidence: reasons.join('; ') };
    },
  },
  {
    id: 'sizing_revert',
    label: 'Revert to the 2026-09-11 sizing',
    direction: 'safe',
    criterion:
      'at 10+ active sessions since the sizing change: the mean day is negative, OR the drawdown halt tripped twice in any 5 sessions',
    evaluate: (s) => {
      const { activeSessionsSinceChange: n, meanDayPct, haltsMaxIn5 } = s.review;
      if (n < 10) return null;
      const reasons: string[] = [];
      if (meanDayPct !== null && meanDayPct < 0) reasons.push(`mean day ${pct(meanDayPct)} over ${n} active sessions`);
      if (haltsMaxIn5 >= 2) reasons.push(`${haltsMaxIn5} drawdown halts in 5 sessions`);
      if (reasons.length === 0) return null;
      // Already there — a revert that changes nothing is not a firing, or the
      // rule would propose every session forever once the numbers went bad.
      if (s.config.riskPerTradePct === PRE_TRIAL_SIZING.riskPerTradePct) return null;
      return { patch: { ...PRE_TRIAL_SIZING }, evidence: reasons.join('; ') };
    },
  },
  {
    id: 'leak_lever',
    label: 'Apply the leak scan’s top cutting lever',
    direction: 'safe',
    criterion:
      'the last edge-leak scan reports a LEAK (not a watch, not unconfirmed) whose lever is a config field in the safe direction',
    evaluate: (s) => {
      const scan = s.leakScan;
      if (!scan) return null;
      const leak = scan.leaks.find(
        (l: LeakReport) =>
          l.verdict === 'leak' && l.lever?.kind === 'config' && l.lever.direction === 'safe' && l.lever.field !== null,
      );
      if (!leak || !leak.lever || leak.lever.field === null) return null;
      const field = leak.lever.field as SwitchWritableKey;
      if (!(SWITCH_WRITABLE_KEYS as readonly string[]).includes(field)) return null;
      const value = leak.lever.value;
      if (typeof value !== 'number' && typeof value !== 'boolean') return null;
      // Already at the lever's value: the leak is historical, not open.
      if (s.config[field] === value) return null;
      return {
        patch: { [field]: value } as SwitchPatch,
        evidence: `${leak.dimension}=${leak.bucket}: ${leak.n} trades at ${leak.meanR}R, ${leak.severityR}R left on the table`,
      };
    },
  },
  {
    id: 'frozen_cap',
    label: 'Hand a frozen dollar cap back to the anchor',
    direction: 'safe',
    criterion: 'a stored dollar cap no longer equals its anchor-derived value, so every automatic re-anchor skips it',
    evaluate: (s) => {
      const frozen = s.capsCoherence.find((c) => !c.anchorOwned && c.derived !== null);
      if (!frozen || frozen.derived === null) return null;
      return {
        patch: { [frozen.key]: frozen.derived } as SwitchPatch,
        evidence: `${frozen.key} stored $${frozen.stored} vs $${frozen.derived} derived`,
      };
    },
  },
  {
    id: 'shorts',
    label: 'Enable live shorts',
    direction: 'exposure',
    criterion: '30 shadow short trades with average R ≥ +0.1 and a win rate ≥ 50%',
    // Reported, never applied — and deliberately left unevaluated until the
    // shadow record exposes those three numbers in one place. A rule that
    // guesses at its own criterion is worse than one that says it cannot read
    // it yet; `graduationVerdict` already refuses every exposure rule, so this
    // costs nothing but the row in the report.
    evaluate: () => null,
  },
];
