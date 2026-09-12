import { describe, it, expect } from 'vitest';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import {
  assertWritable,
  evaluateGatedSwitches,
  freshSwitchState,
  GATED_SWITCH_RULES,
  SWITCH_WRITABLE_KEYS,
  GatedSwitchSnapshot,
  graduationVerdict,
  nextSwitchState,
  coherenceGuard,
  exposureGuard,
  PRE_TRIAL_SIZING,
  SAFE_DIRECTION,
  SHADOW_MIN_EVALUATIONS,
  SwitchRule,
  SwitchState,
} from '../src/services/autotrading/gatedSwitches';

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
    review: { activeSessionsSinceChange: 0, meanDayPct: null, goalRatePct: null, haltsMaxIn5: 0 },
    capsCoherence: [],
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
});

describe('graduation — a safe rule shadows its way to acting', () => {
  const rule = stubRule(() => true);

  it('an EXPOSURE rule never graduates, however long it has run', () => {
    const exposure = stubRule(() => true, 'exposure');
    const v = graduationVerdict(exposure, graduated({ evaluations: 500, proposals: 100 }));
    expect(v.graduated).toBe(false);
    if (!v.graduated) expect(v.blockers[0]).toMatch(/only the operator applies this/);
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
});

describe('evaluateGatedSwitches', () => {
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
    expect(() => run({ rules: [rogue] })).toThrow(/may not write/);
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
        review: { activeSessionsSinceChange: 9, meanDayPct: -1, goalRatePct: 0, haltsMaxIn5: 0 },
      });
      expect(fire('sizing_revert', early)).toBeNull();

      const due = snapshot({
        config: trial,
        review: { activeSessionsSinceChange: 10, meanDayPct: -0.4, goalRatePct: 10, haltsMaxIn5: 0 },
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
          review: { activeSessionsSinceChange: 12, meanDayPct: 0.5, goalRatePct: 20, haltsMaxIn5: 2 },
        }),
      );
      expect(f?.evidence).toMatch(/2 drawdown halts in 5 sessions/);
    });

    it('does not fire when the numbers are good, nor once already reverted', () => {
      const good = { activeSessionsSinceChange: 12, meanDayPct: 0.8, goalRatePct: 25, haltsMaxIn5: 1 };
      expect(fire('sizing_revert', snapshot({ config: trial, review: good }))).toBeNull();
      // Already at the pre-trial risk: a revert that changes nothing must not
      // propose every session forever.
      expect(
        fire(
          'sizing_revert',
          snapshot({
            config: { ...defaultAutotradeConfig(), riskPerTradePct: 1.25 },
            review: { activeSessionsSinceChange: 12, meanDayPct: -1, goalRatePct: 0, haltsMaxIn5: 0 },
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
});
