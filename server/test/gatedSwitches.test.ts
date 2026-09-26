import { describe, it, expect } from 'vitest';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import {
  assertProposable,
  assertWritable,
  evaluateGatedSwitches,
  freshSwitchState,
  GATED_SWITCH_RULES,
  SWITCH_WRITABLE_KEYS,
  GatedSwitchSnapshot,
  graduationVerdict,
  nextSwitchState,
  patchInForce,
  coherenceGuard,
  exposureGuard,
  leverInForce,
  PRE_TRIAL_SIZING,
  SAFE_DIRECTION,
  SHADOW_MIN_EVALUATIONS,
  ShortShadowEvidence,
  SwitchRule,
  SwitchState,
  leakLeverPatch,
  leakLeverRefusal,
} from '../src/services/autotrading/gatedSwitches';
import { redTapeGateOf, SHORT_ENABLE_GATE, type ShadowTrade } from '../src/services/autotrading/shortShadowRecord';

// ---------------------------------------------------------------------------
// This engine's output is a config write on live money, so the tests are
// written around the two things that keep it safe rather than around the
// arithmetic: an exposure rule can NEVER act, and a safe rule cannot act until
// it has shadowed its way to a written bar. Every rule in the table is driven
// to its own firing on seeded data and asserted on the exact patch.
// ---------------------------------------------------------------------------

const ET = '2026-09-14';

function snapshot(over: Partial<GatedSwitchSnapshot> = {}): GatedSwitchSnapshot {
  return {
    etDate: ET,
    config: defaultAutotradeConfig(),
    readiness: null,
    leakScan: null,
    review: {
      activeSessionsSinceChange: 0,
      meanDayPct: null,
      goalRatePct: null,
      goalRateJudgedSessions: 0,
      meanRedDayPct: null,
      worstDayPct: null,
      haltsMaxIn5: 0,
    },
    capsCoherence: [],
    shortShadow: null,
    ...over,
  };
}

/** The short shadow record as the snapshot carries it. Defaults to the
 *  deployed reading of 2026-09-18: 19 trades, +0.08R, 52.6% — under the bar
 *  on the count and the average, over it on the win rate. */
function shortShadow(over: Partial<ShortShadowEvidence> = {}): ShortShadowEvidence {
  const n = over.n ?? 19;
  const avgR = over.avgR === undefined ? 0.08 : over.avgR;
  const winRatePct = over.winRatePct === undefined ? 52.6 : over.winRatePct;
  const g = SHORT_ENABLE_GATE;
  const passesN = n >= g.minTrades;
  const passesAvgR = avgR !== null && avgR >= g.minAvgR;
  const passesWinRate = winRatePct !== null && winRatePct >= g.minWinRatePct;
  return {
    etDate: ET,
    journaledRows: 240,
    n,
    avgR,
    winRatePct,
    gate: { ...g, passesN, passesAvgR, passesWinRate, passes: passesN && passesAvgR && passesWinRate },
    redTapeGate: null,
    ...over,
  };
}

/** A rule that fires whenever `on` says so — the vehicle for the graduation
 *  tests, so they are not hostage to any real rule's criterion. */
function stubRule(on: () => boolean, direction: 'safe' | 'exposure' = 'safe'): SwitchRule {
  return {
    id: 'stub',
    label: 'stub',
    direction,
    criterion: 'the stub says so',
    evaluate: () => (on() ? { patch: { mlRegimeEnabled: false }, evidence: 'because' } : null),
  };
}

const graduated = (over: Partial<SwitchState> = {}): SwitchState => ({
  ...freshSwitchState('stub'),
  evaluations: SHADOW_MIN_EVALUATIONS,
  proposals: 1,
  ...over,
});

describe('the blast radius is explicit', () => {
  it('refuses to write a key no rule is allowed to touch', () => {
    expect(() => assertWritable({ riskPerTradePct: 1 })).not.toThrow();
    // A lever read out of a scan result is data, not literal code — the type
    // system cannot promise this one.
    expect(() => assertWritable({ liveTradingEnabled: false } as never)).toThrow(/may not write liveTradingEnabled/);
    expect(() => assertWritable({ killSwitch: true } as never)).toThrow(/killSwitch/);
  });

  it('lets an exposure rule NAME the shorts switch and still refuses to write it', () => {
    // A proposal-only key: reportable, never writable. Both checks in one
    // place so the next key added here is judged on both questions.
    expect(() => assertProposable({ liveAllowNakedShort: true })).not.toThrow();
    expect(() => assertWritable({ liveAllowNakedShort: true })).toThrow(/may not write liveAllowNakedShort/);
    expect(() => assertProposable({ killSwitch: true } as never)).toThrow(/may not propose killSwitch/);
  });
});

describe('graduation — a safe rule shadows its way to acting', () => {
  const rule = stubRule(() => true);

  it('an EXPOSURE rule never graduates, however long it has run', () => {
    const exposure = stubRule(() => true, 'exposure');
    const v = graduationVerdict(exposure, graduated({ evaluations: 500, proposals: 100 }));
    expect(v.graduated).toBe(false);
    if (!v.graduated) expect(v.blockers[0]).toMatch(/only the operator applies this/);
    // …not even with a graduation stamped on its row. The direction is the
    // operator's standing decision; no row overrides it (2026-09-19).
    expect(graduationVerdict(exposure, graduated({ graduatedAt: 1 })).graduated).toBe(false);
  });

  it('needs five evaluations, at least one firing, and no contradiction', () => {
    expect(graduationVerdict(rule, graduated()).graduated).toBe(true);

    const thin = graduationVerdict(rule, graduated({ evaluations: 4 }));
    expect(thin.graduated).toBe(false);
    if (!thin.graduated) expect(thin.blockers[0]).toMatch(/evaluated on 4 of 5/);

    // A rule that has sat quiet for a month has demonstrated nothing.
    const never = graduationVerdict(rule, graduated({ evaluations: 30, proposals: 0 }));
    expect(never.graduated).toBe(false);
    if (!never.graduated) expect(never.blockers[0]).toMatch(/has never fired/);

    const flapped = graduationVerdict(rule, graduated({ contradictions: 1 }));
    expect(flapped.graduated).toBe(false);
    if (!flapped.graduated) expect(flapped.blockers[0]).toMatch(/contradicted itself 1×/);
  });

  it('stays graduated once it has graduated', () => {
    expect(graduationVerdict(rule, { ...freshSwitchState('stub'), graduatedAt: 1 }).graduated).toBe(true);
  });
});

describe('the shadow record', () => {
  it('counts a proposal that evaporates as a contradiction', () => {
    const proposed = nextSwitchState(freshSwitchState('stub'), true, '2026-09-14', false);
    expect(proposed).toMatchObject({ evaluations: 1, proposals: 1, contradictions: 0, lastMet: true });
    const gone = nextSwitchState(proposed, false, '2026-09-15', false);
    expect(gone.contradictions).toBe(1);
  });

  it('does NOT count it when the patch was applied — the criterion lapsing is the fix working', () => {
    const applied = nextSwitchState(freshSwitchState('stub'), true, '2026-09-14', true);
    const gone = nextSwitchState(applied, false, '2026-09-15', true);
    expect(gone.contradictions).toBe(0);
  });

  // The same principle, for the hand that actually applies these during the
  // five-session shadow: the OPERATOR's. Until 2026-09-13 only the app's own
  // write counted, so a rule that proposed, was listened to, and correctly
  // went quiet was recorded as flapping and barred for good.
  it('does NOT count it when the patch is in force by someone else’s hand', () => {
    const proposed = nextSwitchState(freshSwitchState('stub'), true, '2026-09-14', false);
    const gone = nextSwitchState(proposed, false, '2026-09-15', false, true);
    expect(gone.contradictions).toBe(0);
  });

  it('still counts a proposal that evaporated with its patch nowhere in force', () => {
    // The behaviour the gate exists for — a rule reading noise — must survive
    // the fix above, or the fix has simply removed the gate.
    const proposed = nextSwitchState(freshSwitchState('stub'), true, '2026-09-14', false);
    expect(nextSwitchState(proposed, false, '2026-09-15', false, false).contradictions).toBe(1);
  });

  it('remembers the proposed patch, and a quiet session does not erase it', () => {
    const proposed = nextSwitchState(freshSwitchState('stub'), true, '2026-09-14', false, false, {
      mlRegimeEnabled: false,
    });
    expect(proposed.lastProposedPatch).toEqual({ mlRegimeEnabled: false });
    // A quiet session passes null; the next contradiction test still needs it.
    expect(nextSwitchState(proposed, false, '2026-09-15', false, true).lastProposedPatch).toEqual({
      mlRegimeEnabled: false,
    });
  });
});

describe('leverInForce (2026-09-25)', () => {
  const config = { ...defaultAutotradeConfig(), liveMinSignalScore: 81, symbolReentryCooldownMinutes: 390 };
  const lever = (field: string, value: number | boolean, direction: 'safe' | 'exposure' = 'safe') => ({
    field,
    value,
    direction,
  });

  it('is in force at the lever’s value, and past it in the direction the lever pushes', () => {
    expect(leverInForce(lever('symbolReentryCooldownMinutes', 390), config)).toBe(true);
    // The score-band lever is a floor to raise TO: 81 is already past 70.
    expect(leverInForce(lever('liveMinSignalScore', 70), config)).toBe(true);
    expect(leverInForce(lever('liveMinSignalScore', 85), config)).toBe(false);
    // An exposure lever pushes the other way: a cooldown of 390 is not yet 120.
    expect(leverInForce(lever('symbolReentryCooldownMinutes', 120, 'exposure'), config)).toBe(false);
    expect(leverInForce(lever('symbolReentryCooldownMinutes', 400, 'exposure'), config)).toBe(true);
  });

  it('reads a flag, and a number with no written direction, by equality only', () => {
    expect(leverInForce(lever('marketDirectionGateEnabled', true), config)).toBe(false);
    expect(
      leverInForce(lever('marketDirectionGateEnabled', true), { ...config, marketDirectionGateEnabled: true }),
    ).toBe(true);
  });

  it('is never past anything for a research lever, an unclassified or two-way number, or a null', () => {
    // Research names a measurement, not a setting to be at.
    expect(leverInForce({ field: 'symbolReentryCooldownMinutes', value: 120, direction: 'research' }, config)).toBe(
      false,
    );
    // No written direction: at the exact value only, never "past" it.
    const cfg = { ...config, maxConcurrentPositions: 3 };
    expect(leverInForce(lever('maxConcurrentPositions', 5), cfg)).toBe(false);
    expect(leverInForce(lever('maxConcurrentPositions', 3), cfg)).toBe(true);
    // The scratch is two-way (it also sets the end-of-day entry runway).
    expect(leverInForce(lever('stagnationExitMinutes', 45), { ...config, stagnationExitMinutes: 30 })).toBe(false);
    // A null value names no setting to be at, even against a null field.
    expect(
      leverInForce(
        { field: 'liveCapsAnchorEquityUsd', value: null, direction: 'safe' },
        {
          ...config,
          liveCapsAnchorEquityUsd: null,
        },
      ),
    ).toBe(false);
  });
});

describe('the exposure check on a data-sourced patch (2026-09-25)', () => {
  const cfg = { ...defaultAutotradeConfig(), liveMinSignalScore: 81, riskPerTradePct: 2.5, stagnationExitMinutes: 60 };

  it('refuses the scratch outright: shorter also lets entries open later, and 0 is off', () => {
    expect(exposureGuard({ stagnationExitMinutes: 45 }, cfg)[0]).toMatch(/not an exposure knob on its own/);
    expect(exposureGuard({ stagnationExitMinutes: 0 }, cfg)[0]).toMatch(/not an exposure knob on its own/);
  });

  it('refuses a key with no written direction, a number that is not finite, and a value the config would not keep', () => {
    expect(exposureGuard({ maxConcurrentPositions: 2 } as never, cfg)[0]).toMatch(/no written safe direction/);
    expect(exposureGuard({ liveMinSignalScore: Number.NaN }, cfg)[0]).toMatch(/not a finite number/);
    // The floor is clamped to 100 at the write: 150 is not what would be stored.
    expect(exposureGuard({ liveMinSignalScore: 150 }, cfg)[0]).toMatch(/would be stored as 100/);
    expect(exposureGuard({ riskPerTradePct: 2 }, cfg)).toEqual([]);
  });
});

describe('patchInForce', () => {
  const cfg = { ...defaultAutotradeConfig(), mlRegimeEnabled: false, riskPerTradePct: 1.25 };

  it('is true only when every key already matches', () => {
    expect(patchInForce({ mlRegimeEnabled: false }, cfg)).toBe(true);
    expect(patchInForce({ mlRegimeEnabled: false, riskPerTradePct: 1.25 }, cfg)).toBe(true);
    expect(patchInForce({ mlRegimeEnabled: false, riskPerTradePct: 2.5 }, cfg)).toBe(false);
  });

  it('matches a false and a 0 rather than reading them as absent', () => {
    // The reason it compares with Object.is: `patch[k] || config[k]` would
    // make every boolean-false patch look unapplied forever.
    expect(patchInForce({ mlRegimeEnabled: false }, { ...cfg, mlRegimeEnabled: false })).toBe(true);
    expect(patchInForce({ stagnationExitMinutes: 0 }, { ...cfg, stagnationExitMinutes: 0 })).toBe(true);
    expect(patchInForce({ liveScaleOutEnabled: false }, { ...cfg, liveScaleOutEnabled: false })).toBe(true);
  });

  it('is false for an empty patch — nothing is not in force', () => {
    expect(patchInForce({}, cfg)).toBe(false);
  });
});

describe('evaluateGatedSwitches', () => {
  it('reads a stricter value set by hand as the lever acted on, never as a contradiction (2026-09-25)', () => {
    // The rule proposes a cooldown of 390; the operator sets 400. The next
    // session leak_lever reads the lever as carried and goes quiet, and a quiet
    // session after a proposal is a contradiction unless the patch was acted
    // on. Asked for an exact match, 400 was not "390" and the rule was barred
    // from graduating for good.
    const rule = GATED_SWITCH_RULES.find((r) => r.id === 'leak_lever')!;
    const leakScan = {
      leaks: [
        {
          dimension: 'round',
          dimensionLabel: 'Round',
          bucket: '2',
          n: 23,
          meanR: -0.24,
          severityR: 3,
          verdict: 'leak',
          lever: { kind: 'config', field: 'symbolReentryCooldownMinutes', value: 390, direction: 'safe', detail: '' },
        },
      ],
    } as unknown as NonNullable<GatedSwitchSnapshot['leakScan']>;
    const first = evaluateGatedSwitches({
      snapshot: snapshot({
        etDate: '2026-09-24',
        leakScan,
        config: { ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 120 },
      }),
      states: new Map(),
      enabled: true,
      now: 1,
      rules: [rule],
    });
    expect(first.decisions[0].met).toBe(true);
    const second = evaluateGatedSwitches({
      snapshot: snapshot({
        etDate: '2026-09-25',
        leakScan,
        config: { ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 400 },
      }),
      states: new Map([['leak_lever', first.decisions[0].nextState]]),
      enabled: true,
      now: 2,
      rules: [rule],
    });
    expect(second.decisions[0].met).toBe(false);
    expect(second.decisions[0].nextState.contradictions).toBe(0);
  });

  const run = (over: Partial<Parameters<typeof evaluateGatedSwitches>[0]> = {}) =>
    evaluateGatedSwitches({
      snapshot: snapshot(),
      states: new Map(),
      enabled: true,
      now: 1_000,
      rules: [stubRule(() => true)],
      ...over,
    });

  // -------------------------------------------------------------------------
  // THE OPERATOR'S HAND COUNTS AS THE FIX WORKING (2026-09-13).
  //
  // Workstream 5 says the operator applies safe-direction rules by hand while
  // a rule is still shadowed. Doing exactly that used to read as the rule
  // flapping: it proposed, was listened to, correctly went quiet, and the
  // engine recorded a contradiction — which `graduationVerdict` blocks on,
  // which never decays, and which is persisted. The rule was barred forever
  // for being right.
  //
  // Driven through the real engine over two sessions rather than through
  // nextSwitchState alone, because the operator only ever enters here: the
  // patch's in-force check reads the SNAPSHOT's config, and that is the part
  // a unit test on the fold cannot reach.
  // -------------------------------------------------------------------------
  it('does not punish a rule whose proposal the operator applied between sessions', () => {
    // Session 1: shadowed, so the engine only proposes. mlRegimeEnabled starts
    // true, so the patch {mlRegimeEnabled: false} is NOT yet in force.
    const before = { ...defaultAutotradeConfig(), mlRegimeEnabled: true };
    let on = true;
    const rule = stubRule(() => on);
    const first = evaluateGatedSwitches({
      snapshot: snapshot({ config: before }),
      states: new Map(),
      enabled: true,
      now: 1_000,
      rules: [rule],
    });
    expect(first.decisions[0].outcome).toBe('proposed');
    expect(first.applied).toEqual([]);
    const afterOne = first.decisions[0].nextState;
    expect(afterOne.lastProposedPatch).toEqual({ mlRegimeEnabled: false });

    // The operator applies it, and the criterion stops holding BECAUSE of that.
    on = false;
    const second = evaluateGatedSwitches({
      snapshot: snapshot({ etDate: '2026-09-15', config: { ...before, mlRegimeEnabled: false } }),
      states: new Map([['stub', afterOne]]),
      enabled: true,
      now: 2_000,
      rules: [rule],
    });
    expect(second.decisions[0].nextState.contradictions).toBe(0);
  });

  it('still records a contradiction when the patch is nowhere in force', () => {
    // The gate exists to catch a rule reading noise, and must survive the fix
    // above: same sequence, except nobody applied anything.
    const before = { ...defaultAutotradeConfig(), mlRegimeEnabled: true };
    let on = true;
    const rule = stubRule(() => on);
    const first = evaluateGatedSwitches({
      snapshot: snapshot({ config: before }),
      states: new Map(),
      enabled: true,
      now: 1_000,
      rules: [rule],
    });
    on = false;
    const second = evaluateGatedSwitches({
      snapshot: snapshot({ etDate: '2026-09-15', config: before }),
      states: new Map([['stub', first.decisions[0].nextState]]),
      enabled: true,
      now: 2_000,
      rules: [rule],
    });
    expect(second.decisions[0].nextState.contradictions).toBe(1);
    // And that is terminal, which is the whole reason the case above matters.
    const verdict = graduationVerdict(rule, second.decisions[0].nextState);
    expect(verdict.graduated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A DATA-SOURCED PATCH IS CHECKED BY ARITHMETIC, NOT BY ITS LABEL.
  //
  // The engine's whole safety model is "a rule that adds exposure is never
  // applied by the app", and for `leak_lever` that rested on a
  // `direction: 'safe'` field attached by a different module, to data. The scan
  // writes `value: bucket === '<60' ? 60 : 70` with the detail "RAISE the score
  // floor" — an ABSOLUTE floor where it means a raise. Production's floor is
  // 72, so a losing 60-69 band proposes 70: a DROP that admits trades the live
  // book refuses, labelled safe, applied to real money once the rule graduated.
  // The scan cannot catch it (its lever is given no config), so the write is
  // the only place it can be caught.
  // -------------------------------------------------------------------------
  it('refuses to APPLY a data-sourced patch that lowers the live score floor', () => {
    const config = { ...defaultAutotradeConfig(), liveMinSignalScore: 72 };
    const graduated: SwitchState = {
      ...freshSwitchState('stub'),
      evaluations: SHADOW_MIN_EVALUATIONS,
      proposals: 1,
      graduatedAt: 1,
    };
    const rule: SwitchRule = {
      ...stubRule(() => true),
      patchFromData: true,
      evaluate: () => ({ patch: { liveMinSignalScore: 70 }, evidence: 'scoreBand=60-69' }),
    };
    const r = evaluateGatedSwitches({
      snapshot: snapshot({ config }),
      states: new Map([['stub', graduated]]),
      enabled: true,
      now: 1_000,
      rules: [rule],
    });
    expect(r.applied).toEqual([]);
    expect(r.decisions[0].outcome).toBe('proposed');
    expect(r.decisions[0].exposureRefusals[0]).toMatch(/liveMinSignalScore 72 → 70 LOWERS it/);
    // The proposal still reaches the operator — refusing to act is not
    // refusing to report.
    expect(r.proposed).toHaveLength(1);
  });

  it('still applies a data-sourced patch that moves the RIGHT way', () => {
    const config = { ...defaultAutotradeConfig(), liveMinSignalScore: 60 };
    const graduated: SwitchState = {
      ...freshSwitchState('stub'),
      evaluations: SHADOW_MIN_EVALUATIONS,
      proposals: 1,
      graduatedAt: 1,
    };
    const rule: SwitchRule = {
      ...stubRule(() => true),
      patchFromData: true,
      evaluate: () => ({ patch: { liveMinSignalScore: 70 }, evidence: 'scoreBand=60-69' }),
    };
    const r = evaluateGatedSwitches({
      snapshot: snapshot({ config }),
      states: new Map([['stub', graduated]]),
      enabled: true,
      now: 1_000,
      rules: [rule],
    });
    expect(r.applied).toHaveLength(1);
    expect(r.decisions[0].exposureRefusals).toEqual([]);
  });

  it('leaves a LITERAL patch alone — the pre-committed revert moves three keys "up"', () => {
    // sizing_revert restores the 2026-09-11 settings as a SET: risk down, but
    // expectancyMaxMultiplier 1.25 → 1.5, stagnationExitMinutes 60 → 90 and
    // symbolReentryCooldownMinutes 390 → 120 all move toward more exposure on
    // their own. It is safe because it is a known-good prior configuration, not
    // because each field points the same way — which is exactly why the guard
    // is scoped to patches assembled from DATA.
    const refusals = exposureGuard(PRE_TRIAL_SIZING, {
      ...defaultAutotradeConfig(),
      riskPerTradePct: 2.5,
      expectancyMaxMultiplier: 1.25,
      stagnationExitMinutes: 60,
      symbolReentryCooldownMinutes: 390,
    });
    expect(refusals.length).toBeGreaterThan(0); // it WOULD be refused as data…
    const graduated: SwitchState = {
      ...freshSwitchState('stub'),
      evaluations: SHADOW_MIN_EVALUATIONS,
      proposals: 1,
      graduatedAt: 1,
    };
    const rule: SwitchRule = {
      ...stubRule(() => true),
      evaluate: () => ({ patch: { ...PRE_TRIAL_SIZING }, evidence: 'revert' }),
    };
    const r = evaluateGatedSwitches({
      snapshot: snapshot({ config: { ...defaultAutotradeConfig(), riskPerTradePct: 2.5 } }),
      states: new Map([['stub', graduated]]),
      enabled: true,
      now: 1_000,
      rules: [rule],
    });
    expect(r.applied).toHaveLength(1); // …and is not, because it is literal code
  });

  it('refuses a patch the PUT route itself would answer 400 for, literal or not', () => {
    // Workstream 7 said an auto-applied patch goes "through the same validated
    // path the PUT route uses". It goes through setAutotradeConfig directly,
    // which sanitizes one field at a time and cannot see a PAIR. Exactly one of
    // the route's ordered pairs has a writable side here.
    const config = { ...defaultAutotradeConfig(), expectancyMinMultiplier: 1 };
    expect(coherenceGuard({ expectancyMaxMultiplier: 0.8 }, config)[0]).toMatch(/below expectancyMinMultiplier/);
    expect(coherenceGuard({ expectancyMaxMultiplier: 1.5 }, config)).toEqual([]);
    // Unlike the exposure guard, this one applies to a LITERAL patch too: a
    // rule is trusted with its own direction, never with a config the route
    // would reject.
    const graduated: SwitchState = {
      ...freshSwitchState('stub'),
      evaluations: SHADOW_MIN_EVALUATIONS,
      proposals: 1,
      graduatedAt: 1,
    };
    const r = evaluateGatedSwitches({
      snapshot: snapshot({ config }),
      states: new Map([['stub', graduated]]),
      enabled: true,
      now: 1_000,
      rules: [
        { ...stubRule(() => true), evaluate: () => ({ patch: { expectancyMaxMultiplier: 0.8 }, evidence: 'x' }) },
      ],
    });
    expect(r.applied).toEqual([]);
  });

  it('classifies every writable key, so a new one cannot slip in unjudged', () => {
    // The compile-time twin of targetTune's exhaustiveness guard: a key added
    // to SWITCH_WRITABLE_KEYS without a direction would let a data-sourced rule
    // write it with nothing checking which way it moved.
    for (const key of SWITCH_WRITABLE_KEYS) expect(SAFE_DIRECTION[key]).toBeDefined();
    // 'either' keys are refused outright rather than waved through.
    expect(exposureGuard({ targetRMultiple: 1 }, defaultAutotradeConfig())[0]).toMatch(/not an exposure knob/);
  });

  it('proposes but does not apply while the rule is still shadowed', () => {
    const r = run();
    expect(r.applied).toEqual([]);
    expect(r.proposed).toHaveLength(1);
    expect(r.decisions[0].outcome).toBe('proposed');
    // …and the shadow record still accrues, which is what eventually ends it.
    expect(r.decisions[0].nextState).toMatchObject({ evaluations: 1, proposals: 1 });
  });

  it('applies on the very session the criteria are met — no extra wait', () => {
    const r = run({ states: new Map([['stub', graduated()]]) });
    expect(r.applied).toEqual([{ ruleId: 'stub', patch: { mlRegimeEnabled: false }, evidence: 'because' }]);
    expect(r.decisions[0].outcome).toBe('applied');
    // The graduation is stamped on the session it acts, so the journal and the
    // state agree about when the shadow ended.
    expect(r.decisions[0].nextState.graduatedAt).toBe(1_000);
  });

  it('HOLDS a graduated rule while the engine is off or the kill switch is engaged', () => {
    const off = run({ states: new Map([['stub', graduated()]]), enabled: false });
    expect(off.applied).toEqual([]);
    expect(off.decisions[0].outcome).toBe('held');
    // Evaluation continues while it is off: a shadow record that froze would
    // hand the rule a graduation it never earned when the engine came back.
    expect(off.decisions[0].nextState.evaluations).toBe(SHADOW_MIN_EVALUATIONS + 1);

    const killed = run({
      states: new Map([['stub', graduated()]]),
      snapshot: snapshot({ config: { ...defaultAutotradeConfig(), killSwitch: true } }),
    });
    expect(killed.applied).toEqual([]);
    expect(killed.decisions[0].outcome).toBe('held');
  });

  it('never evaluates the same ET date twice — a restart loop cannot graduate anything', () => {
    const states = new Map([['stub', { ...freshSwitchState('stub'), evaluations: 3, lastEvaluatedEtDate: ET }]]);
    const r = run({ states });
    expect(r.decisions[0].nextState.evaluations).toBe(3);
    expect(r.applied).toEqual([]);
    expect(r.proposed).toEqual([]);
  });

  it('refuses a rule that tries to write outside the allowlist', () => {
    const rogue: SwitchRule = {
      id: 'rogue',
      label: 'rogue',
      direction: 'safe',
      criterion: 'never mind',
      evaluate: () => ({ patch: { liveTradingEnabled: true } as never, evidence: '' }),
    };
    // Refused at the FIRING, before any outcome is decided: a key that is
    // neither writable nor proposal-only may not even be named.
    expect(() => run({ rules: [rogue] })).toThrow(/may not propose liveTradingEnabled/);
  });

  it('refuses to APPLY a proposal-only key even from a safe rule that has graduated', () => {
    // The shorts switch names liveAllowNakedShort, an exposure rule's message
    // to the operator. A safe rule reaching `applied` with the same key is held
    // to the writable list on top of the proposal check.
    const rogue: SwitchRule = {
      id: 'stub',
      label: 'stub',
      direction: 'safe',
      criterion: 'never mind',
      evaluate: () => ({ patch: { liveAllowNakedShort: true }, evidence: '' }),
    };
    expect(() => run({ rules: [rogue], states: new Map([['stub', graduated()]]) })).toThrow(
      /may not write liveAllowNakedShort/,
    );
  });
});

// ---------------------------------------------------------------------------
// Every rule in the shipped table, driven to its own firing. CLAUDE.md's rule
// is that a value exercised where it is computed proves nothing about its
// consumer, so each of these asserts the exact PATCH the engine would write.
// ---------------------------------------------------------------------------
describe('the shipped rules', () => {
  const fire = (id: string, s: GatedSwitchSnapshot) => {
    const rule = GATED_SWITCH_RULES.find((r) => r.id === id)!;
    return rule.evaluate(s);
  };

  const readiness = (over: Record<string, unknown> = {}) =>
    ({
      parity: { checked: 3, agreed: 3, disagreed: 0, unchecked: [], tolerance: 0.01 },
      drift: false,
      driftSessions: 0,
      inertStreak: 0,
      inertRevertAt: 5,
      switches: { total: 0, maxIn5Sessions: 0, limitPerWeek: 2, dates: [] },
      ...over,
    }) as unknown as NonNullable<GatedSwitchSnapshot['readiness']>;

  describe('overlay_revert', () => {
    const on = { ...defaultAutotradeConfig(), mlRegimeEnabled: true };

    it('fires on each of the four tripwires, and writes only the overlay flag', () => {
      for (const [over, expected] of [
        [{ parity: { checked: 3, agreed: 2, disagreed: 1, unchecked: [], tolerance: 0.01 } }, /parity disagreement/],
        [{ drift: true, driftSessions: 2 }, /drift on 2 session/],
        [{ inertStreak: 5 }, /inert streak 5/],
        [{ switches: { total: 4, maxIn5Sessions: 3, limitPerWeek: 2, dates: [] } }, /3 switches in 5 sessions/],
      ] as const) {
        const f = fire('overlay_revert', snapshot({ config: on, readiness: readiness(over) }));
        expect(f?.patch).toEqual({ mlRegimeEnabled: false });
        expect(f?.evidence).toMatch(expected);
      }
    });

    it('is silent on a healthy overlay, and on an overlay already off', () => {
      expect(fire('overlay_revert', snapshot({ config: on, readiness: readiness() }))).toBeNull();
      expect(
        fire('overlay_revert', snapshot({ config: defaultAutotradeConfig(), readiness: readiness({ drift: true }) })),
      ).toBeNull();
      // No readiness object is not a met criterion.
      expect(fire('overlay_revert', snapshot({ config: on, readiness: null }))).toBeNull();
    });
  });

  describe('sizing_revert', () => {
    const trial = { ...defaultAutotradeConfig(), riskPerTradePct: 2.5 };

    it('waits for 10 active sessions, then fires on a negative mean day', () => {
      const early = snapshot({
        config: trial,
        review: {
          activeSessionsSinceChange: 9,
          meanDayPct: -1,
          goalRatePct: 0,
          goalRateJudgedSessions: 9,
          meanRedDayPct: null,
          worstDayPct: null,
          haltsMaxIn5: 0,
        },
      });
      expect(fire('sizing_revert', early)).toBeNull();

      const due = snapshot({
        config: trial,
        review: {
          activeSessionsSinceChange: 10,
          meanDayPct: -0.4,
          goalRatePct: 10,
          goalRateJudgedSessions: 10,
          meanRedDayPct: null,
          worstDayPct: null,
          haltsMaxIn5: 0,
        },
      });
      const f = fire('sizing_revert', due);
      expect(f?.patch).toEqual(PRE_TRIAL_SIZING);
      expect(f?.evidence).toMatch(/mean day -0\.4% over 10 active sessions/);
    });

    it('also fires on two halts in five sessions, even with a positive mean day', () => {
      const f = fire(
        'sizing_revert',
        snapshot({
          config: trial,
          review: {
            activeSessionsSinceChange: 12,
            meanDayPct: 0.5,
            goalRatePct: 20,
            goalRateJudgedSessions: 12,
            meanRedDayPct: null,
            worstDayPct: null,
            haltsMaxIn5: 2,
          },
        }),
      );
      expect(f?.evidence).toMatch(/2 drawdown halts in 5 sessions/);
    });

    it('does not fire when the numbers are good, nor once already reverted', () => {
      const good = {
        activeSessionsSinceChange: 12,
        meanDayPct: 0.8,
        goalRatePct: 25,
        goalRateJudgedSessions: 12,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 1,
      };
      expect(fire('sizing_revert', snapshot({ config: trial, review: good }))).toBeNull();
      // Already at the pre-trial risk: a revert that changes nothing must not
      // propose every session forever.
      expect(
        fire(
          'sizing_revert',
          snapshot({
            config: { ...defaultAutotradeConfig(), riskPerTradePct: 1.25 },
            review: {
              activeSessionsSinceChange: 12,
              meanDayPct: -1,
              goalRatePct: 0,
              goalRateJudgedSessions: 12,
              meanRedDayPct: null,
              worstDayPct: null,
              haltsMaxIn5: 0,
            },
          }),
        ),
      ).toBeNull();
    });
  });

  describe('leak_lever', () => {
    const scanWith = (over: Record<string, unknown>) =>
      ({
        leaks: [
          {
            dimension: 'round',
            dimensionLabel: 'Round within symbol-day',
            bucket: '2',
            n: 23,
            meanR: -0.24,
            severityR: 3,
            verdict: 'leak',
            lever: {
              kind: 'config',
              field: 'symbolReentryCooldownMinutes',
              value: 390,
              direction: 'safe',
              detail: '',
            },
            ...over,
          },
        ],
      }) as unknown as NonNullable<GatedSwitchSnapshot['leakScan']>;

    it('applies a confirmed leak’s safe config lever, with the leak as evidence', () => {
      const f = fire('leak_lever', snapshot({ leakScan: scanWith({}) }));
      expect(f?.patch).toEqual({ symbolReentryCooldownMinutes: 390 });
      expect(f?.evidence).toMatch(/round=2: 23 trades at -0\.24R, 3R left on the table/);
    });

    it('ignores an unconfirmed leak, a code lever, an exposure lever, and a field off the allowlist', () => {
      expect(fire('leak_lever', snapshot({ leakScan: scanWith({ verdict: 'unconfirmed' }) }))).toBeNull();
      expect(
        fire(
          'leak_lever',
          snapshot({
            leakScan: scanWith({ lever: { kind: 'code', field: null, value: null, direction: 'safe', detail: '' } }),
          }),
        ),
      ).toBeNull();
      expect(
        fire(
          'leak_lever',
          snapshot({
            leakScan: scanWith({
              lever: { kind: 'config', field: 'liveTradingEnabled', value: true, direction: 'safe', detail: '' },
            }),
          }),
        ),
      ).toBeNull();
      expect(
        fire(
          'leak_lever',
          snapshot({
            leakScan: scanWith({
              lever: { kind: 'config', field: 'riskPerTradePct', value: 5, direction: 'exposure', detail: '' },
            }),
          }),
        ),
      ).toBeNull();
    });

    it('says why it would not apply a lever, in the words the tune advisor shows (2026-09-25, on review)', () => {
      const cfg = defaultAutotradeConfig();
      const leakOf = (over: Record<string, unknown>) =>
        scanWith(over).leaks[0] as unknown as Parameters<typeof leakLeverRefusal>[0];
      expect(leakLeverRefusal(leakOf({}), { ...cfg, symbolReentryCooldownMinutes: 120 })).toBeNull();
      expect(leakLeverRefusal(leakOf({ verdict: 'unconfirmed' }), cfg)).toMatch(/not confirmed/);
      expect(
        leakLeverRefusal(
          leakOf({ lever: { kind: 'code', field: null, value: null, direction: 'safe', detail: '' } }),
          cfg,
        ),
      ).toMatch(/code change/);
      expect(
        leakLeverRefusal(
          leakOf({ lever: { kind: 'config', field: 'riskPerTradePct', value: 5, direction: 'exposure', detail: '' } }),
          cfg,
        ),
      ).toMatch(/adds exposure/);
      expect(
        leakLeverRefusal(
          leakOf({
            lever: { kind: 'config', field: 'liveTradingEnabled', value: true, direction: 'safe', detail: '' },
          }),
          cfg,
        ),
      ).toMatch(/may not write liveTradingEnabled/);
      expect(leakLeverRefusal(leakOf({}), { ...cfg, symbolReentryCooldownMinutes: 390 })).toMatch(
        /already at or past 390/,
      );
      // The rule proposes exactly the levers this clears, so the two cannot disagree.
      expect(leakLeverPatch(leakOf({}), { ...cfg, symbolReentryCooldownMinutes: 120 })).toEqual({
        symbolReentryCooldownMinutes: 390,
      });
      expect(leakLeverPatch(leakOf({}), { ...cfg, symbolReentryCooldownMinutes: 390 })).toBeNull();
    });

    it('reads past a spent lever to the next open one (2026-09-25)', () => {
      // Each of the first six used to return null, or stand as a patch the
      // write refuses, and hide every leak below: a cooldown already at its
      // lever, a floor already above the band's, a flag and a number the app
      // may not write, a flag whose direction the arithmetic cannot judge, and
      // the two-way scratch.
      const leak = (dimension: string, field: string, value: number | boolean) => ({
        dimension,
        dimensionLabel: dimension,
        bucket: 'b',
        n: 20,
        meanR: -0.3,
        severityR: 4,
        verdict: 'leak',
        lever: { kind: 'config', field, value, direction: 'safe', detail: '' },
      });
      const s = snapshot({
        config: {
          ...defaultAutotradeConfig(),
          symbolReentryCooldownMinutes: 390,
          liveMinSignalScore: 81,
          stagnationExitMinutes: 60,
          riskPerTradePct: 2.5,
        },
        leakScan: {
          leaks: [
            leak('round', 'symbolReentryCooldownMinutes', 390),
            leak('scoreBand', 'liveMinSignalScore', 70),
            leak('marketTape', 'marketDirectionGateEnabled', true),
            // A number the app may not write: past the writable check it would
            // reach assertProposable, which throws and stops every rule.
            leak('slots', 'maxConcurrentPositions', 2),
            // Writable, but a flag the write refuses from data ('either').
            leak('exitShape', 'liveScaleOutEnabled', true),
            leak('holdTime', 'stagnationExitMinutes', 45),
            leak('sizing', 'riskPerTradePct', 2),
          ],
        } as unknown as NonNullable<GatedSwitchSnapshot['leakScan']>,
      });
      const f = fire('leak_lever', s);
      expect(f?.patch).toEqual({ riskPerTradePct: 2 });
      expect(f?.evidence).toMatch(/^sizing=b:/);
    });

    it('is silent once the config already carries the lever’s value', () => {
      const s = snapshot({
        config: { ...defaultAutotradeConfig(), symbolReentryCooldownMinutes: 390 },
        leakScan: scanWith({}),
      });
      expect(fire('leak_lever', s)).toBeNull();
    });
  });

  describe('frozen_cap', () => {
    it('hands a frozen cap back to its derived value', () => {
      const f = fire(
        'frozen_cap',
        snapshot({
          capsCoherence: [
            { key: 'liveMaxOrderUsd', stored: 5284, derived: 5284, anchorOwned: true },
            { key: 'liveOptionsMaxOrderUsd', stored: 300, derived: 236, anchorOwned: false },
          ],
        }),
      );
      expect(f?.patch).toEqual({ liveOptionsMaxOrderUsd: 236 });
      expect(f?.evidence).toMatch(/liveOptionsMaxOrderUsd stored \$300 vs \$236 derived/);
    });

    it('says nothing when every cap is anchor-owned, or when there is no anchor to derive against', () => {
      expect(
        fire(
          'frozen_cap',
          snapshot({ capsCoherence: [{ key: 'liveMaxOrderUsd', stored: 1, derived: 1, anchorOwned: true }] }),
        ),
      ).toBeNull();
      expect(
        fire(
          'frozen_cap',
          snapshot({ capsCoherence: [{ key: 'liveMaxOrderUsd', stored: 1, derived: null, anchorOwned: false }] }),
        ),
      ).toBeNull();
    });
  });

  it('every rule in the table declares a direction and a written criterion', () => {
    for (const r of GATED_SWITCH_RULES) {
      expect(r.criterion.length).toBeGreaterThan(20);
      expect(['safe', 'exposure']).toContain(r.direction);
    }
    // The one exposure rule is reported, never applied.
    expect(GATED_SWITCH_RULES.filter((r) => r.direction === 'exposure').map((r) => r.id)).toEqual(['shorts']);
  });

  // -------------------------------------------------------------------------
  // THE SHORTS SWITCH READS THE RECORD IT WAS WRITTEN FOR (2026-09-19).
  //
  // It shipped as `evaluate: () => null` with a comment saying it would stay
  // unevaluated until the shadow record exposed its three numbers "in one
  // place". The record's route exposed them from the day it shipped; nothing
  // in the app read it. Driven through the real engine, because the point is
  // the consumer: a firing here must reach `proposed` and never `applied`.
  // -------------------------------------------------------------------------
  describe('shorts — reads the red-tape bar and the paper control (2026-09-24)', () => {
    const shorts = GATED_SWITCH_RULES.find((r) => r.id === 'shorts')!;
    const run = (s: GatedSwitchSnapshot, state?: SwitchState) =>
      evaluateGatedSwitches({
        snapshot: s,
        states: new Map(state ? [['shorts', state]] : []),
        enabled: true,
        now: 1_000,
        rules: [shorts],
      });
    const trades = (...rs: number[]) => ({ trades: rs.map((exitR) => ({ exitR }) as ShadowTrade) });
    // 20 red-tape shorts at +0.16R and 60% winners; the other tapes flat.
    const redMet = redTapeGateOf({
      red: trades(...Array(12).fill(0.5), ...Array(8).fill(-0.35)),
      mixed: trades(0, 0),
      green: trades(0),
      unlabeled: trades(),
    });
    const redShort = redTapeGateOf({
      red: trades(0.4, -1, 0.5),
      mixed: trades(0.1),
      green: trades(),
      unlabeled: trades(),
    });
    /** The last scan, carrying only what the rule reads: which books it read,
     *  and the paper book's stock shorts taken on a red tape. A null control
     *  is a scan that read paper and filed none. */
    const scanWithPaper = (
      control: { n: number; meanR: number | null } | null,
      books: ('live' | 'paper')[] = ['live', 'paper'],
    ) =>
      ({
        books,
        dimensions: [
          {
            id: 'marketTapeBySide',
            buckets: control === null ? [] : [{ bucket: 'equity_short_red', n: 0, meanR: null, control }],
          },
        ],
      }) as unknown as NonNullable<GatedSwitchSnapshot['leakScan']>;
    const paperMet = scanWithPaper({ n: 12, meanR: 0.21 });
    /** A scan that cannot answer, each for its own reason. */
    const liveOnlyScan = scanWithPaper({ n: 12, meanR: 0.21 }, ['live']);
    const scanBeforeTheCut = { books: ['live', 'paper'], dimensions: [] } as unknown as NonNullable<
      GatedSwitchSnapshot['leakScan']
    >;

    it('reads nothing while no record exists — an absent input is not a met criterion', () => {
      const r = run(snapshot({ leakScan: paperMet }));
      expect(r.decisions[0].outcome).toBe('quiet');
      expect(r.decisions[0].nextState.lastReading).toBeNull();
    });

    it('stays quiet under the bar, and says how far each leg sits from it', () => {
      const r = run(snapshot({ shortShadow: shortShadow({ redTapeGate: redShort }), leakScan: scanWithPaper(null) }));
      expect(r.decisions[0].outcome).toBe('quiet');
      expect(r.proposed).toEqual([]);
      expect(r.decisions[0].nextState.lastReading).toBe(
        "red tape: 3 of 20 shorts, avg -0.03R (bar +0.15R), win 66.7% (bar 50%), -0.13R over the other tapes' 1 " +
          '(bar +0.1R) — short on trades, avg R, edge over other tapes; paper red-tape stock shorts: 0 of 10, mean ' +
          'n/a (bar above 0); all tapes: 19 shadow shorts, avg +0.08R, win 52.6%, as of 2026-09-14',
      );
    });

    it('says why the paper control is unread, rather than reading it as zero trades', () => {
      const cases: [NonNullable<GatedSwitchSnapshot['leakScan']> | null, string][] = [
        [null, 'no edge-leak scan saved yet'],
        // A live-only scan persists too, and carries no paper figures at all.
        [liveOnlyScan, 'the last scan did not read the paper book'],
        [scanBeforeTheCut, 'the last scan has no side-and-tape cut'],
      ];
      for (const [leakScan, why] of cases) {
        const r = run(snapshot({ shortShadow: shortShadow({ redTapeGate: redMet }), leakScan }));
        expect(r.decisions[0].outcome, why).toBe('quiet');
        expect(r.decisions[0].nextState.lastReading).toContain(`paper red-tape stock shorts: unread (${why});`);
      }
    });

    it('proposes liveAllowNakedShort once both are met — and NEVER applies it', () => {
      const s = snapshot({ shortShadow: shortShadow({ redTapeGate: redMet }), leakScan: paperMet });
      // Even against a state that claims a graduation: the direction wins.
      const r = run(s, { ...freshSwitchState('shorts'), evaluations: 20, proposals: 6, graduatedAt: 1 });
      expect(r.decisions[0].outcome).toBe('proposed');
      expect(r.applied).toEqual([]);
      expect(r.proposed).toEqual([
        {
          ruleId: 'shorts',
          direction: 'exposure',
          patch: { liveAllowNakedShort: true },
          evidence:
            "red tape: 20 of 20 shorts, avg +0.16R (bar +0.15R), win 60.0% (bar 50%), +0.16R over the other tapes' 3 " +
            '(bar +0.1R) — bar met; paper red-tape stock shorts: 12 of 10, mean +0.21R (bar above 0) — met; all ' +
            'tapes: 19 shadow shorts, avg +0.08R, win 52.6%, as of 2026-09-14',
        },
      ]);
    });

    it('does not propose on the red-tape bar alone: the paper control has to agree', () => {
      for (const control of [null, { n: 9, meanR: 0.4 }, { n: 12, meanR: 0 }, { n: 12, meanR: null }]) {
        const r = run(
          snapshot({ shortShadow: shortShadow({ redTapeGate: redMet }), leakScan: scanWithPaper(control) }),
        );
        expect(r.decisions[0].outcome, JSON.stringify(control)).toBe('quiet');
      }
    });

    it('no longer proposes on the old bar: a record over it on every tape, and short on red, stays quiet', () => {
      const oldBarMet = shortShadow({ n: 31, avgR: 0.14, winRatePct: 54.8, redTapeGate: redShort });
      expect(oldBarMet.gate.passes).toBe(true);
      expect(run(snapshot({ shortShadow: oldBarMet, leakScan: paperMet })).decisions[0].outcome).toBe('quiet');
      // Nor on a record persisted before the split, which carries no red-tape bar.
      const unsplit = run(
        snapshot({ shortShadow: shortShadow({ n: 31, avgR: 0.14, winRatePct: 54.8 }), leakScan: paperMet }),
      );
      expect(unsplit.decisions[0].outcome).toBe('quiet');
      expect(unsplit.decisions[0].nextState.lastReading).toMatch(/^red tape: not split in this record/);
    });

    it('stays quiet with the red-tape rule switched off: the evidence covers red tapes only', () => {
      const r = run(
        snapshot({
          shortShadow: shortShadow({ redTapeGate: redMet }),
          leakScan: paperMet,
          config: { ...defaultAutotradeConfig(), liveShortsRedTapeOnly: false },
        }),
      );
      expect(r.decisions[0].outcome).toBe('quiet');
    });

    it('goes quiet once shorts are on — a proposal for the state already in force is noise', () => {
      const r = run(
        snapshot({
          shortShadow: shortShadow({ redTapeGate: redMet }),
          leakScan: paperMet,
          config: { ...defaultAutotradeConfig(), liveAllowNakedShort: true },
        }),
      );
      expect(r.decisions[0].outcome).toBe('quiet');
      // The reading still travels: "on, and here is what the record says".
      expect(r.decisions[0].nextState.lastReading).toMatch(/bar met/);
    });
  });
});
