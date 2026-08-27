import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getDailyBaseline, saveDailyBaseline } from '../src/db/dailyBaseline';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { computeTargetTune, resetToModerate } from '../src/services/autotrading/targetTune';
import { applyExternalCashFlow, evaluateDailyTarget, updateDailyTarget } from '../src/services/autotrading/dailyTarget';
import { etToday } from '../src/util/marketDate';

// A fixed instant: 2026-08-21 14:00 UTC = 10:00 ET (during the session).
const NOW = Date.parse('2026-08-21T14:00:00Z');
const TODAY = etToday(NOW);

describe('evaluateDailyTarget (pure)', () => {
  const cfg = (
    target: number | null,
    equity: number | null,
    arm: number | null = null,
    floor: number | null = null,
  ) => ({
    targetDailyGainPct: target,
    accountEquityUsd: equity,
    giveBackArmPct: arm,
    giveBackFloorPct: floor,
  });
  const baseline = (
    equity: number,
    reachedAt: number | null = null,
    giveBackArmedAt: number | null = null,
    giveBackHaltedAt: number | null = null,
  ) => ({
    etDate: TODAY,
    equityUsd: equity,
    reachedAt,
    giveBackArmedAt,
    giveBackHaltedAt,
    reachCandidateAt: null,
  });

  it('is inactive with no target set — the calibration-only tune never halts anything', () => {
    const s = evaluateDailyTarget(cfg(null, 10_000), baseline(10_000));
    expect(s).toMatchObject({ active: false, reached: false });
    expect(s.inactiveReason).toMatch(/no daily-gain target/);
  });

  it('is inactive without usable equity or a baseline — an unmeasurable goal never halts entries', () => {
    expect(evaluateDailyTarget(cfg(3, null), baseline(10_000))).toMatchObject({ active: false, reached: false });
    expect(evaluateDailyTarget(cfg(3, 10_000), null)).toMatchObject({ active: false, reached: false });
    expect(evaluateDailyTarget(cfg(3, 10_000), baseline(0))).toMatchObject({ active: false, reached: false });
  });

  it('measures the day: 3% of the day-start value, reached exactly at the line', () => {
    // Day started at 10,000 → the 3% goal banks at 10,300.
    expect(evaluateDailyTarget(cfg(3, 10_299.99), baseline(10_000))).toMatchObject({ active: true, reached: false });
    const s = evaluateDailyTarget(cfg(3, 10_300), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: true, targetEquityUsd: 10_300, gainPct: 3 });
  });

  it('reports negative progress honestly — behind is behind, never a halt', () => {
    const s = evaluateDailyTarget(cfg(3, 9_500), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: false, gainPct: -5 });
  });

  it('a recorded reach is STICKY: equity slipping back under the line stays banked', () => {
    // Reached earlier today at some point; equity has since faded to +1%.
    const s = evaluateDailyTarget(cfg(3, 10_100), baseline(10_000, NOW - 60_000));
    expect(s).toMatchObject({ active: true, reached: true, reachedAt: NOW - 60_000, entriesHalted: true });
  });

  describe('give-back guard', () => {
    // Levels for a 3% goal, as the tune stamps them: arm at +2%, floor at +1%.
    const guarded = (equity: number | null) => cfg(3, equity, 2, 1);

    it('is dormant while unconfigured — entriesHalted mirrors reached alone', () => {
      const s = evaluateDailyTarget(cfg(3, 10_150), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: false, giveBackHalted: false, entriesHalted: false });
      expect(s.giveBackArmPct).toBeUndefined();
    });

    it('arms once the day gain touches the arm level, and only then', () => {
      expect(evaluateDailyTarget(guarded(10_199), baseline(10_000))).toMatchObject({ giveBackArmed: false });
      const s = evaluateDailyTarget(guarded(10_200), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: false, entriesHalted: false });
    });

    it('never fires on an UNARMED day — morning chop below the arm level is not give-back', () => {
      // +0.5%: below the floor line but the day never armed, so nothing halts.
      const s = evaluateDailyTarget(guarded(10_050), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: false, giveBackHalted: false, entriesHalted: false });
    });

    it('fires when an ARMED day fades back to the floor — that is the whole point', () => {
      // Armed earlier (persisted), now faded to exactly +1%.
      const s = evaluateDailyTarget(guarded(10_100), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: true, entriesHalted: true, reached: false });
    });

    it('holds fire while an armed day stays above the floor', () => {
      const s = evaluateDailyTarget(guarded(10_101), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: false, entriesHalted: false });
    });

    it('a recorded fire is STICKY: recovering above the floor stays halted', () => {
      const s = evaluateDailyTarget(guarded(10_180), baseline(10_000, null, NOW - 120_000, NOW - 60_000));
      expect(s).toMatchObject({ giveBackHalted: true, entriesHalted: true, giveBackHaltedAt: NOW - 60_000 });
    });

    it('a BANKED day never also fires the guard — one halt per day is enough', () => {
      // Reached (sticky) earlier, then equity faded under the floor.
      const s = evaluateDailyTarget(guarded(10_050), baseline(10_000, NOW - 60_000, NOW - 120_000));
      expect(s).toMatchObject({ reached: true, giveBackHalted: false, entriesHalted: true });
    });

    it('incoherent levels (floor at or above arm) leave the guard off', () => {
      const s = evaluateDailyTarget(cfg(3, 10_050, 1, 2), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackHalted: false, entriesHalted: false });
      expect(s.giveBackArmPct).toBeUndefined();
      // A floor EQUAL to the arm level is rejected too — it would fire the
      // instant it armed.
      expect(evaluateDailyTarget(cfg(3, 10_100, 1, 1), baseline(10_000, null, NOW))).toMatchObject({
        giveBackHalted: false,
      });
    });

    it('a floor of 0 is legitimate: halt only when the armed day is all the way back to flat', () => {
      const zeroFloor = cfg(3, 10_000, 2, 0); // day faded to exactly flat
      const s = evaluateDailyTarget(zeroFloor, baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: true, entriesHalted: true });
    });
  });
});

// ---------------------------------------------------------------------------
// A deposit is not a return. On 2026-08-27 a $5,000 deposit against a
// $2,228.83 baseline read as +131.56%, banked the day, and halted live entries
// on a session whose actual autotrade P&L was -$8.32.
// ---------------------------------------------------------------------------
describe('applyExternalCashFlow (DB + journal)', () => {
  beforeAll(() => initDb());
  beforeEach(() =>
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline;'),
  );

  const BASE = 2_228.83;

  it('re-bases the day so the deposit is not gain, and the day stops reading banked', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    saveDailyBaseline(TODAY, BASE);

    // Before: the deposit alone clears a 3% goal many times over.
    expect(updateDailyTarget(NOW).gainPct).toBeGreaterThan(130);

    const out = applyExternalCashFlow(5_352.23, -2_067.64, NOW);

    expect(out!.flowUsd).toBeCloseTo(5_191.04, 2);
    expect(getDailyBaseline()!.equityUsd).toBeCloseTo(7_419.87, 2);
    // After: the day reads its trading result — a loss — not the deposit.
    expect(
      evaluateDailyTarget(
        { targetDailyGainPct: 3, accountEquityUsd: 5_352.23, giveBackArmPct: null, giveBackFloorPct: null },
        getDailyBaseline(),
      ),
    ).toMatchObject({ reached: false });
  });

  it('journals the re-base — a silent baseline move would be untraceable', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    saveDailyBaseline(TODAY, BASE);
    applyExternalCashFlow(5_352.23, -2_067.64, NOW);
    const ev = listAutotradeEvents({ actions: ['daily_baseline_rebased'] });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail!)).toMatchObject({ fromBaselineUsd: BASE });
  });

  it('keeps a reach that was already EARNED before the deposit landed', () => {
    // Stickiness is the point: a real +3% morning stays banked. The deposit
    // changes what the percentage is OF, not whether it was earned.
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    saveDailyBaseline(TODAY, BASE);
    db.prepare('UPDATE autotrade_daily_baseline SET reached_at = ?').run(NOW - 1000);

    applyExternalCashFlow(5_352.23, -2_067.64, NOW);

    expect(getDailyBaseline()!.reachedAt).toBe(NOW - 1000);
  });

  it('does nothing on an ordinary day, and writes no event', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: BASE + 40, targetDailyGainPct: 3 });
    saveDailyBaseline(TODAY, BASE);
    expect(applyExternalCashFlow(BASE + 40, 40, NOW)).toBeNull();
    expect(getDailyBaseline()!.equityUsd).toBe(BASE);
    expect(listAutotradeEvents({ actions: ['daily_baseline_rebased'] })).toHaveLength(0);
  });

  it('will not touch a baseline belonging to another ET day', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    saveDailyBaseline('2026-08-20', BASE);
    expect(applyExternalCashFlow(5_352.23, -2_067.64, NOW)).toBeNull();
    expect(getDailyBaseline()!.equityUsd).toBe(BASE);
  });

  it('does nothing when there is no baseline at all', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    expect(applyExternalCashFlow(5_352.23, -2_067.64, NOW)).toBeNull();
  });
});

describe('updateDailyTarget (DB + journal)', () => {
  beforeAll(() => initDb());
  beforeEach(() =>
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline;'),
  );

  it('captures the day-start baseline on the first tick of an ET day', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 12_345, targetDailyGainPct: 3 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: true, reached: false, baselineEquityUsd: 12_345 });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, equityUsd: 12_345, reachedAt: null });
  });

  it('rolls the baseline to the NEW day and clears the reach — the goal compounds daily', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_300, targetDailyGainPct: 3 });
    // Yesterday: started at 10,000 and banked.
    saveDailyBaseline('2026-08-20', 10_000);
    db.prepare('UPDATE autotrade_daily_baseline SET reached_at = ?').run(NOW - 86_400_000);

    const s = updateDailyTarget(NOW);
    // Today's goal is measured off TODAY's start (10,300), not yesterday's:
    // equity == baseline → 0% progress, not still-banked.
    expect(s).toMatchObject({ active: true, reached: false, baselineEquityUsd: 10_300, gainPct: 0 });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, reachedAt: null });
  });

  it('keeps the same-day baseline across ticks — a mid-day gain never re-baselines', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
    updateDailyTarget(NOW);
    setAutotradeConfig({ accountEquityUsd: 10_200 }); // equity moved intraday
    const s = updateDailyTarget(NOW + 60_000);
    expect(s).toMatchObject({ baselineEquityUsd: 10_000, gainPct: 2, reached: false });
  });

  it('journals daily_target_reached exactly ONCE per day, then halts stick', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
    updateDailyTarget(NOW); // baseline 10,000
    setAutotradeConfig({ accountEquityUsd: 10_400 }); // +4% — past the goal

    // Banking now takes TWO consecutive ticks (2026-08-27) — the first only
    // records a candidate.
    const first = updateDailyTarget(NOW + 60_000);
    expect(first.reached).toBe(false);
    const second = updateDailyTarget(NOW + 120_000);
    expect(second.reached).toBe(true);
    // Later ticks, including a fade back UNDER the line: still reached, no new event.
    setAutotradeConfig({ accountEquityUsd: 10_100 });
    const later = updateDailyTarget(NOW + 180_000);
    expect(later.reached).toBe(true);

    const events = listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached');
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!) as { targetPct: number; baselineEquityUsd: number; gainPct: number };
    expect(detail).toMatchObject({ targetPct: 3, baselineEquityUsd: 10_000, gainPct: 4 });
  });

  describe('two-tick confirmation before banking the day (2026-08-27)', () => {
    // On 2026-08-27 a single spurious net-liquidation reading of $2,444.70
    // against a $2,228.83 baseline banked the day at a fictional +9.69% and
    // halted live entries for the rest of the session. reachedAt is sticky by
    // design, so nothing could undo it.
    const arm = () => {
      setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 2_228.83, targetDailyGainPct: 3 });
      updateDailyTarget(NOW);
    };

    it('does NOT bank on a one-tick spike, and does not halt entries for it', () => {
      arm();
      setAutotradeConfig({ accountEquityUsd: 2_444.7 }); // the spurious reading
      const spike = updateDailyTarget(NOW + 60_000);
      expect(spike).toMatchObject({ reached: false, entriesHalted: false });

      // Feed returns to reality: the candidate is dropped and nothing banked.
      setAutotradeConfig({ accountEquityUsd: 2_235.54 });
      const back = updateDailyTarget(NOW + 120_000);
      expect(back).toMatchObject({ reached: false, entriesHalted: false });
      expect(getDailyBaseline()).toMatchObject({ reachedAt: null, reachCandidateAt: null });
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
    });

    it('journals the pending reach, so a near-miss is visible rather than silent', () => {
      arm();
      setAutotradeConfig({ accountEquityUsd: 2_444.7 });
      updateDailyTarget(NOW + 60_000);
      const pending = listAutotradeEvents({}).filter((e) => e.action === 'daily_target_pending_confirmation');
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].detail!)).toMatchObject({ targetPct: 3, baselineEquityUsd: 2_228.83 });
    });

    it('still banks a REAL day — one tick later than before, which a real +3% survives', () => {
      arm();
      setAutotradeConfig({ accountEquityUsd: 2_300 }); // a genuine +3.2%
      expect(updateDailyTarget(NOW + 60_000).reached).toBe(false);
      const banked = updateDailyTarget(NOW + 120_000);
      expect(banked).toMatchObject({ reached: true, entriesHalted: true });
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(1);
    });

    it('will not let two NON-consecutive spikes add up to a confirmation', () => {
      arm();
      setAutotradeConfig({ accountEquityUsd: 2_444.7 });
      updateDailyTarget(NOW + 60_000); // candidate set
      setAutotradeConfig({ accountEquityUsd: 2_235.54 });
      updateDailyTarget(NOW + 120_000); // candidate cleared
      setAutotradeConfig({ accountEquityUsd: 2_444.7 });
      const second = updateDailyTarget(NOW + 180_000); // starts over, must not bank
      expect(second.reached).toBe(false);
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
    });

    it('leaves an ALREADY-banked day alone — the confirmation guards banking, not the state', () => {
      arm();
      setAutotradeConfig({ accountEquityUsd: 2_300 });
      updateDailyTarget(NOW + 60_000);
      updateDailyTarget(NOW + 120_000); // banked
      // A later fade must still read reached, with no re-confirmation dance.
      setAutotradeConfig({ accountEquityUsd: 2_100 });
      expect(updateDailyTarget(NOW + 180_000)).toMatchObject({ reached: true, entriesHalted: true });
    });

    it('does not suppress an already-fired give-back halt while a reach is pending', () => {
      // entriesHalted must not be cleared by the pending-reach branch when the
      // give-back guard has independently halted the day.
      setAutotradeConfig({
        ...defaultAutotradeConfig(),
        accountEquityUsd: 10_000,
        targetDailyGainPct: 3,
        giveBackArmPct: 2,
        giveBackFloorPct: 1,
      });
      updateDailyTarget(NOW);
      setAutotradeConfig({ accountEquityUsd: 10_250 }); // arms the guard at +2.5%
      updateDailyTarget(NOW + 60_000);
      setAutotradeConfig({ accountEquityUsd: 10_050 }); // fades to the +0.5% floor
      const halted = updateDailyTarget(NOW + 120_000);
      expect(halted).toMatchObject({ giveBackHalted: true, entriesHalted: true });
    });
  });

  it('with no target set it still maintains the baseline but never journals or halts', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: false, reached: false });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, equityUsd: 10_000 });
    expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
  });

  it('with no usable equity on a new day it declines to baseline, and never halts', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: null, targetDailyGainPct: 3 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: false, reached: false });
    expect(getDailyBaseline()).toBeNull();
  });

  it('give-back guard: arms silently, journals ONE daily_give_back_halted, sticks, and clears on the day roll', () => {
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      accountEquityUsd: 10_000,
      targetDailyGainPct: 3,
      giveBackArmPct: 2,
      giveBackFloorPct: 1,
    });
    updateDailyTarget(NOW); // baseline 10,000

    // Day runs to +2.5%: the guard ARMS — persisted, but no journal noise.
    setAutotradeConfig({ accountEquityUsd: 10_250 });
    expect(updateDailyTarget(NOW + 60_000)).toMatchObject({ giveBackArmed: true, giveBackHalted: false });
    expect(getDailyBaseline()).toMatchObject({ giveBackArmedAt: NOW + 60_000, giveBackHaltedAt: null });
    expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_give_back_halted')).toHaveLength(0);

    // Fade to +1%: the guard FIRES — halted, journaled once.
    setAutotradeConfig({ accountEquityUsd: 10_100 });
    const fired = updateDailyTarget(NOW + 120_000);
    expect(fired).toMatchObject({ giveBackHalted: true, entriesHalted: true, reached: false });
    // Recovery to +1.5% changes nothing — sticky, and still only one event.
    setAutotradeConfig({ accountEquityUsd: 10_150 });
    expect(updateDailyTarget(NOW + 180_000)).toMatchObject({ giveBackHalted: true, entriesHalted: true });
    const events = listAutotradeEvents({}).filter((e) => e.action === 'daily_give_back_halted');
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!) as { giveBackArmPct: number; giveBackFloorPct: number };
    expect(detail).toMatchObject({ giveBackArmPct: 2, giveBackFloorPct: 1 });

    // The NEXT ET day starts clean: baseline rolls, both guard flags clear.
    const nextDay = updateDailyTarget(NOW + 86_400_000);
    expect(nextDay).toMatchObject({ giveBackArmed: false, giveBackHalted: false, entriesHalted: false });
    expect(getDailyBaseline()).toMatchObject({ giveBackArmedAt: null, giveBackHaltedAt: null });
  });
});

describe('tune integration', () => {
  it('a tune apply carries the target into config — applying IS arming', () => {
    const t = computeTargetTune({
      equityUsd: 10_000,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
    });
    expect(t.patch.targetDailyGainPct).toBe(3);
    // …and stamps the give-back guard at 2/3 and 1/3 of the goal.
    expect(t.patch.giveBackArmPct).toBe(2);
    expect(t.patch.giveBackFloorPct).toBe(1);
  });

  it('reset-to-moderate declares NO goal and disarms the tracker AND the guard', () => {
    const patch = resetToModerate(10_000, defaultAutotradeConfig().maxStopDistancePct);
    expect(patch.targetDailyGainPct).toBeNull();
    expect(patch.giveBackArmPct).toBeNull();
    expect(patch.giveBackFloorPct).toBeNull();
  });
});
