import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getDailyBaseline, markGiveBackArmed, saveDailyBaseline, setDailyGoalScale } from '../src/db/dailyBaseline';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { computeTargetTune, resetToModerate } from '../src/services/autotrading/targetTune';
import { emptyRealizedEdge } from '../src/services/autotrading/dailyTargetSweep';
import {
  applyExternalCashFlow,
  evaluateDailyTarget,
  updateDailyGoalScale,
  updateDailyTarget,
} from '../src/services/autotrading/dailyTarget';
import { etToday } from '../src/util/marketDate';
import { importPositions } from '../src/db/positions';

// A fixed instant: 2026-08-21 14:00 UTC = 10:00 ET (during the session).
const NOW = Date.parse('2026-08-21T14:00:00Z');
const TODAY = etToday(NOW);

/**
 * The old two-argument call, preserved.
 *
 * Every pure case below was written when the day was
 * `(accountEquity - baseline)` — i.e. for a world with NO manual trading, where
 * the account's move and the loop's P&L are the same number. That is still a
 * real and common case, so those cases keep their numbers and this supplies the
 * equivalent strategy P&L. What CHANGED on 2026-09-14 — an account that moves
 * for reasons the loop had nothing to do with — gets its own cases.
 */
const evalDay = (
  c: Parameters<typeof evaluateDailyTarget>[0],
  b: Parameters<typeof evaluateDailyTarget>[1],
): ReturnType<typeof evaluateDailyTarget> => evaluateDailyTarget(c, b, (c.accountEquityUsd ?? 0) - (b?.equityUsd ?? 0));

/**
 * Make the LOOP actually realize `usd` today.
 *
 * The DB cases below used to raise `accountEquityUsd` to stand for a day's
 * gain, which no longer banks anything — the whole point of the change. A day
 * is now something the book has to have traded for.
 */
function seedLoopPnl(usd: number, symbol = 'SEEDP'): void {
  // Replaces, never accumulates: a case that walks the day up and back down is
  // setting the day's P&L, not adding trades to it.
  db.exec(`DELETE FROM position_exits WHERE position_id IN (SELECT id FROM positions WHERE symbol = '${symbol}')`);
  db.exec(`DELETE FROM positions WHERE symbol = '${symbol}'`);
  const qty = 10;
  const exitPrice = round2(100 + usd / qty);
  importPositions(
    [
      {
        assetType: 'stock',
        symbol,
        side: 'long',
        quantity: qty,
        entryPrice: 100,
        entryDate: TODAY,
        entryTime: '09:35',
        stopPrice: 95,
        targetPrice: 110,
        status: 'closed',
        tags: ['live', 'autotrade'],
        createdAt: NOW,
        updatedAt: NOW,
        exits: [{ quantity: qty, exitPrice, exitDate: TODAY, createdAt: NOW }],
      },
    ],
    'merge',
  );
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Make the LOOP realize `usd` today in its LIVE OPTIONS sleeve.
 *
 * Inserted as SQL rather than through closeLiveOptionsPosition because that
 * helper stamps `exit_at` with the wall clock, and every case here runs on a
 * fixed NOW in the past — the row has to land on the day being measured.
 */
function seedLoopOptionsPnl(usd: number): void {
  db.exec("DELETE FROM autotrade_live_options_positions WHERE symbol = 'SEEDO'");
  const exitPrice = round2(1 + usd / 100); // 1 contract x 100 shares
  db.prepare(
    `INSERT INTO autotrade_live_options_positions
       (symbol, side, kind, contract_symbol, strike, expiration, quantity, entry_price, entry_at,
        risk_amount, risk_profile, rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
     VALUES ('SEEDO','call','single_leg','SEEDO260821C00100000',100,?,1,1,?,100,'moderate','seed','closed',?,?,'take_profit',?,?)`,
  ).run(TODAY, NOW, exitPrice, NOW, NOW, NOW);
}

describe('evaluateDailyTarget (pure)', () => {
  const cfg = (
    target: number | null,
    equity: number | null,
    arm: number | null = null,
    floor: number | null = null,
    /** The day-protective stop's own floor — independent of the guard above
     *  since 2026-09-15, so it is its own pair of arguments. */
    protectiveFloor: number | null = null,
    protectiveEnabled = protectiveFloor !== null,
  ) => ({
    targetDailyGainPct: target,
    accountEquityUsd: equity,
    giveBackArmPct: arm,
    giveBackFloorPct: floor,
    dayProtectiveStopEnabled: protectiveEnabled,
    dayProtectiveStopFloorPct: protectiveFloor,
  });
  const baseline = (
    equity: number,
    reachedAt: number | null = null,
    giveBackArmedAt: number | null = null,
    giveBackHaltedAt: number | null = null,
    goalScale: number | null = null,
  ) => ({
    etDate: TODAY,
    equityUsd: equity,
    reachedAt,
    giveBackArmedAt,
    giveBackHaltedAt,
    reachCandidateAt: null,
    goalScale,
    goalScaleReason: goalScale === null ? null : 'ML regime High Volatility/Bearish (35% cut)',
    // Null = stamped before the basis was tracked; a case about the basis
    // itself sets it explicitly.
    goalBasis: null,
  });

  it('is inactive with no target set — the calibration-only tune never halts anything', () => {
    const s = evalDay(cfg(null, 10_000), baseline(10_000));
    expect(s).toMatchObject({ active: false, reached: false });
    expect(s.inactiveReason).toMatch(/no daily-gain target/);
  });

  it('is inactive without usable equity or a baseline — an unmeasurable goal never halts entries', () => {
    expect(evalDay(cfg(3, null), baseline(10_000))).toMatchObject({ active: false, reached: false });
    expect(evalDay(cfg(3, 10_000), null)).toMatchObject({ active: false, reached: false });
    expect(evalDay(cfg(3, 10_000), baseline(0))).toMatchObject({ active: false, reached: false });
  });

  it('measures the day: 3% of the day-start value, reached exactly at the line', () => {
    // Day started at 10,000 → the 3% goal banks at 10,300.
    expect(evalDay(cfg(3, 10_299.99), baseline(10_000))).toMatchObject({ active: true, reached: false });
    const s = evalDay(cfg(3, 10_300), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: true, targetEquityUsd: 10_300, gainPct: 3 });
  });

  // The goal held constant in R (2026-09-08): the baseline row's scale moves
  // the goal, the arm and the floor together, and every consumer reads the
  // effective numbers.
  describe('the regime goal scale', () => {
    it('scales the goal, the arm and the floor by the one factor: 3/2/1 at 0.65 reads 1.95/1.3/0.65', () => {
      const s = evalDay(cfg(3, 10_100, 2, 1), baseline(10_000, null, null, null, 0.65));
      expect(s).toMatchObject({
        active: true,
        targetPct: 1.95,
        configuredTargetPct: 3,
        goalScale: 0.65,
        goalScaleReason: 'ML regime High Volatility/Bearish (35% cut)',
        targetEquityUsd: 10_195,
        giveBackArmPct: 1.3,
        giveBackFloorPct: 0.65,
      });
    });

    it('banks at the SCALED line — +1.95% reaches, +1.9% does not', () => {
      expect(evalDay(cfg(3, 10_190, 2, 1), baseline(10_000, null, null, null, 0.65)).reached).toBe(false);
      expect(evalDay(cfg(3, 10_195, 2, 1), baseline(10_000, null, null, null, 0.65))).toMatchObject({
        reached: true,
        entriesHalted: true,
      });
    });

    it('arms the guard at the SCALED arm (+1.3%) and fires at the scaled floor', () => {
      const row = baseline(10_000, null, null, null, 0.65);
      expect(evalDay(cfg(3, 10_125, 2, 1), row).giveBackArmed).toBe(false);
      expect(evalDay(cfg(3, 10_130, 2, 1), row).giveBackArmed).toBe(true);
      const armedRow = baseline(10_000, null, NOW, null, 0.65);
      expect(evalDay(cfg(3, 10_070, 2, 1), armedRow).giveBackHalted).toBe(false);
      expect(evalDay(cfg(3, 10_065, 2, 1), armedRow)).toMatchObject({
        giveBackHalted: true,
        entriesHalted: true,
      });
    });

    it('a null scale, a scale of 1, 0 or above 1 all read as unscaled — the same numbers as before', () => {
      const plain = evalDay(cfg(3, 10_100, 2, 1), baseline(10_000));
      expect(plain).toMatchObject({ targetPct: 3, configuredTargetPct: 3, goalScale: 1, targetEquityUsd: 10_300 });
      expect(plain.goalScaleReason).toBeUndefined();
      for (const s of [1, 0, 1.5, -0.5]) {
        expect(evalDay(cfg(3, 10_100, 2, 1), baseline(10_000, null, null, null, s))).toMatchObject({
          targetPct: 3,
          goalScale: 1,
          giveBackArmPct: 2,
          giveBackFloorPct: 1,
        });
      }
    });
  });

  it('reports negative progress honestly — behind is behind, never a halt', () => {
    const s = evalDay(cfg(3, 9_500), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: false, gainPct: -5 });
  });

  it('a recorded reach is STICKY: equity slipping back under the line stays banked', () => {
    // Reached earlier today at some point; equity has since faded to +1%.
    const s = evalDay(cfg(3, 10_100), baseline(10_000, NOW - 60_000));
    expect(s).toMatchObject({ active: true, reached: true, reachedAt: NOW - 60_000, entriesHalted: true });
  });

  // The day-protective stop's own floor (2026-09-15). It used to borrow the
  // give-back guard's, so switching that guard off — a decision about a
  // different rule entirely — took this one with it.
  describe('the day-protective floor stands on its own', () => {
    it('is present with the guard switched OFF, and absent when the rule is', () => {
      // arm/floor null (the guard off), the rule's own floor set: the shape
      // production was actually in on 2026-09-15.
      const withRule = evalDay(cfg(3, 10_150, null, null, 1), baseline(10_000));
      expect(withRule.giveBackFloorPct).toBeUndefined();
      expect(withRule.headroomToFloorUsd).toBeUndefined();
      expect(withRule.dayProtectiveFloorPct).toBe(1);
      // +$150 of loop P&L, floor at 1% of a 10,000 baseline = $100.
      expect(withRule.dayProtectiveHeadroomUsd).toBe(50);

      // The guard configured and the rule off: the mirror image.
      const guardOnly = evalDay(cfg(3, 10_150, 2, 1), baseline(10_000));
      expect(guardOnly.giveBackFloorPct).toBe(1);
      expect(guardOnly.headroomToFloorUsd).toBe(50);
      expect(guardOnly.dayProtectiveFloorPct).toBeUndefined();
      expect(guardOnly.dayProtectiveHeadroomUsd).toBeUndefined();
    });

    it('needs its flag as well as its floor — either one absent disables it', () => {
      expect(evalDay(cfg(3, 10_150, null, null, null, true), baseline(10_000)).dayProtectiveFloorPct).toBeUndefined();
      expect(evalDay(cfg(3, 10_150, null, null, 1, false), baseline(10_000)).dayProtectiveFloorPct).toBeUndefined();
    });

    it('scales with the day, like the goal and the guard do', () => {
      // A 35% regime cut: the goal reads 1.95 and this floor 0.65, so the day
      // keeps its shape in R. A floor left at its configured 1% would sit at a
      // different height than everything around it.
      const s = evalDay(cfg(3, 10_150, null, null, 1), baseline(10_000, null, null, null, 0.65));
      expect(s.targetPct).toBeCloseTo(1.95, 4);
      expect(s.dayProtectiveFloorPct).toBeCloseTo(0.65, 4);
      expect(s.dayProtectiveHeadroomUsd).toBe(85); // 150 - 10,000 x 0.65%
    });

    it('goes negative once the day is under its floor, rather than vanishing', () => {
      // The consumer tests `> 0`; a missing field and a breached floor are
      // different facts and the status says which.
      const s = evalDay(cfg(3, 10_050, null, null, 1), baseline(10_000));
      expect(s.dayProtectiveHeadroomUsd).toBe(-50);
    });
  });

  describe('give-back guard', () => {
    // Levels for a 3% goal, as the tune stamps them: arm at +2%, floor at +1%.
    const guarded = (equity: number | null) => cfg(3, equity, 2, 1);

    it('is dormant while unconfigured — entriesHalted mirrors reached alone', () => {
      const s = evalDay(cfg(3, 10_150), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: false, giveBackHalted: false, entriesHalted: false });
      expect(s.giveBackArmPct).toBeUndefined();
    });

    it('arms once the day gain touches the arm level, and only then', () => {
      expect(evalDay(guarded(10_199), baseline(10_000))).toMatchObject({ giveBackArmed: false });
      const s = evalDay(guarded(10_200), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: false, entriesHalted: false });
    });

    it('never fires on an UNARMED day — morning chop below the arm level is not give-back', () => {
      // +0.5%: below the floor line but the day never armed, so nothing halts.
      const s = evalDay(guarded(10_050), baseline(10_000));
      expect(s).toMatchObject({ giveBackArmed: false, giveBackHalted: false, entriesHalted: false });
    });

    it('fires when an ARMED day fades back to the floor — that is the whole point', () => {
      // Armed earlier (persisted), now faded to exactly +1%.
      const s = evalDay(guarded(10_100), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: true, entriesHalted: true, reached: false });
    });

    it('holds fire while an armed day stays above the floor', () => {
      const s = evalDay(guarded(10_101), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackArmed: true, giveBackHalted: false, entriesHalted: false });
    });

    it('a recorded fire is STICKY: recovering above the floor stays halted', () => {
      const s = evalDay(guarded(10_180), baseline(10_000, null, NOW - 120_000, NOW - 60_000));
      expect(s).toMatchObject({ giveBackHalted: true, entriesHalted: true, giveBackHaltedAt: NOW - 60_000 });
    });

    it('a BANKED day never also fires the guard — one halt per day is enough', () => {
      // Reached (sticky) earlier, then equity faded under the floor.
      const s = evalDay(guarded(10_050), baseline(10_000, NOW - 60_000, NOW - 120_000));
      expect(s).toMatchObject({ reached: true, giveBackHalted: false, entriesHalted: true });
    });

    it('incoherent levels (floor at or above arm) leave the guard off', () => {
      const s = evalDay(cfg(3, 10_050, 1, 2), baseline(10_000, null, NOW - 60_000));
      expect(s).toMatchObject({ giveBackHalted: false, entriesHalted: false });
      expect(s.giveBackArmPct).toBeUndefined();
      // A floor EQUAL to the arm level is rejected too — it would fire the
      // instant it armed.
      expect(evalDay(cfg(3, 10_100, 1, 1), baseline(10_000, null, NOW))).toMatchObject({
        giveBackHalted: false,
      });
    });

    it('a floor of 0 is legitimate: halt only when the armed day is all the way back to flat', () => {
      const zeroFloor = cfg(3, 10_000, 2, 0); // day faded to exactly flat
      const s = evalDay(zeroFloor, baseline(10_000, null, NOW - 60_000));
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
    db.exec(
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline; ' +
        // The day is the LOOP's realized P&L now, so a position left behind by
        // one case is a gain the next case never traded for.
        'DELETE FROM position_exits; DELETE FROM positions;',
    ),
  );

  const BASE = 2_228.83;

  it('re-bases the day so the deposit is not gain, and the day stops reading banked', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 5_352.23, targetDailyGainPct: 3 });
    saveDailyBaseline(TODAY, BASE);

    // The deposit cannot reach the goal even BEFORE the re-base (2026-09-14).
    // It used to read +130% and bank the day outright; the gain is the loop's
    // own realized P&L now, and a deposit is not a trade. This assertion is the
    // stronger guarantee the re-base below used to be the only defence for.
    expect(updateDailyTarget(NOW).gainPct).toBe(0);

    const out = applyExternalCashFlow(5_352.23, -2_067.64, NOW);

    // The re-base still earns its place: it keeps the DENOMINATOR honest, so
    // every later percentage is of the equity the day is really being traded
    // on rather than the pre-deposit figure.
    expect(out!.flowUsd).toBeCloseTo(5_191.04, 2);
    expect(getDailyBaseline()!.equityUsd).toBeCloseTo(7_419.87, 2);
    // And a real trading loss on top of the deposit still reads as a loss.
    seedLoopPnl(-100);
    const after = updateDailyTarget(NOW + 60_000);
    expect(after.reached).toBe(false);
    expect(after.gainPct).toBeCloseTo((-100 / 7_419.87) * 100, 2);
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
    db.exec(
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline; ' +
        // The day is the LOOP's realized P&L now, so a position left behind by
        // one case is a gain the next case never traded for. Every one of these
        // cases passed alone and six failed together without this.
        'DELETE FROM position_exits; DELETE FROM positions;',
    ),
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
    seedLoopPnl(200); // the LOOP closed +$200 — a day it actually traded for
    const s = updateDailyTarget(NOW + 60_000);
    expect(s).toMatchObject({ baselineEquityUsd: 10_000, gainPct: 2, reached: false });
  });

  it('journals daily_target_reached exactly ONCE per day, then halts stick', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
    updateDailyTarget(NOW); // baseline 10,000
    seedLoopPnl(400); // the loop closed +$400 — +4%, past the goal

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
    //
    // That exact failure is now impossible twice over: the day is the loop's
    // realized P&L, so an equity reading cannot move it at all (2026-09-14).
    // The confirmation still earns its place against a spurious P&L — a
    // mis-booked exit price, a reconcile that double-counts — so these cases
    // spike the thing that decides now, rather than the thing that used to.
    const arm = () => {
      setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 2_228.83, targetDailyGainPct: 3 });
      updateDailyTarget(NOW);
    };
    /** A day's P&L as a % of the 2,228.83 baseline. */
    const loopPct = (pct: number) => seedLoopPnl(round2((2_228.83 * pct) / 100));

    it('does NOT bank on a one-tick spike, and does not halt entries for it', () => {
      arm();
      loopPct(9.69); // the spurious reading, as a P&L
      const spike = updateDailyTarget(NOW + 60_000);
      expect(spike).toMatchObject({ reached: false, entriesHalted: false });

      // Feed returns to reality: the candidate is dropped and nothing banked.
      loopPct(0.3); // back to reality
      const back = updateDailyTarget(NOW + 120_000);
      expect(back).toMatchObject({ reached: false, entriesHalted: false });
      expect(getDailyBaseline()).toMatchObject({ reachedAt: null, reachCandidateAt: null });
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
    });

    it('journals the pending reach, so a near-miss is visible rather than silent', () => {
      arm();
      loopPct(9.69);
      updateDailyTarget(NOW + 60_000);
      const pending = listAutotradeEvents({}).filter((e) => e.action === 'daily_target_pending_confirmation');
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].detail!)).toMatchObject({ targetPct: 3, baselineEquityUsd: 2_228.83 });
    });

    it('still banks a REAL day — one tick later than before, which a real +3% survives', () => {
      arm();
      loopPct(3.2); // a genuine +3.2% the book actually traded for
      expect(updateDailyTarget(NOW + 60_000).reached).toBe(false);
      const banked = updateDailyTarget(NOW + 120_000);
      expect(banked).toMatchObject({ reached: true, entriesHalted: true });
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(1);
    });

    it('will not let two NON-consecutive spikes add up to a confirmation', () => {
      arm();
      loopPct(9.69);
      updateDailyTarget(NOW + 60_000); // candidate set
      loopPct(0.3);
      updateDailyTarget(NOW + 120_000); // candidate cleared
      loopPct(9.69);
      const second = updateDailyTarget(NOW + 180_000); // starts over, must not bank
      expect(second.reached).toBe(false);
      expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
    });

    it('leaves an ALREADY-banked day alone — the confirmation guards banking, not the state', () => {
      arm();
      loopPct(3.2);
      updateDailyTarget(NOW + 60_000);
      updateDailyTarget(NOW + 120_000); // banked
      // A later fade must still read reached, with no re-confirmation dance.
      loopPct(-5.8);
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
      seedLoopPnl(250); // the loop is up +2.5% — arms the guard
      updateDailyTarget(NOW + 60_000);
      seedLoopPnl(50); // gives it back to +0.5%, under the floor
      const halted = updateDailyTarget(NOW + 120_000);
      expect(halted).toMatchObject({ giveBackHalted: true, entriesHalted: true });
    });
  });

  // updateDailyGoalScale: tracks until the day has a gain to protect, then freezes.
  describe('updateDailyGoalScale (DB + journal, 2026-09-08)', () => {
    const cut = {
      factor: 0.65,
      skip: false,
      detail: 'ML regime High Volatility/Bearish (35% cut; ATR trigger inactive at 0.9%)',
    };
    const calm = {
      factor: 1,
      skip: false,
      detail: 'market ATR 0.9% (triggers above 3%); ML regime Sideways — cuts only in High Volatility/Bearish',
    };
    const scaledEvents = () => listAutotradeEvents({}).filter((e) => e.action === 'daily_goal_scaled');

    it('writes the factor while unarmed, journals once per change, and re-measures the scaled goal', () => {
      setAutotradeConfig({
        ...defaultAutotradeConfig(),
        accountEquityUsd: 10_000,
        targetDailyGainPct: 3,
        giveBackArmPct: 2,
        giveBackFloorPct: 1,
      });
      updateDailyTarget(NOW); // baseline 10,000, scale NULL
      expect(updateDailyGoalScale(cut, NOW)).toEqual({ scale: 0.65, changed: true, frozen: false });
      expect(getDailyBaseline()).toMatchObject({ goalScale: 0.65, goalScaleReason: cut.detail });
      expect(updateDailyTarget(NOW + 1_000)).toMatchObject({
        targetPct: 1.95,
        giveBackArmPct: 1.3,
        giveBackFloorPct: 0.65,
        goalScale: 0.65,
      });
      // The same factor again is not a change: no write, no second event.
      expect(updateDailyGoalScale(cut, NOW + 2_000)).toEqual({ scale: 0.65, changed: false, frozen: false });
      expect(scaledEvents()).toHaveLength(1);
      const detail = JSON.parse(scaledEvents()[0].detail!) as {
        factor: number;
        configured: unknown;
        effective: unknown;
      };
      expect(detail.factor).toBe(0.65);
      expect(detail.configured).toEqual({ targetPct: 3, giveBackArmPct: 2, giveBackFloorPct: 1 });
      expect(detail.effective).toEqual({ targetPct: 1.95, giveBackArmPct: 1.3, giveBackFloorPct: 0.65 });
      // The cut lifting before anything sticky happened: back to 1, one more event.
      expect(updateDailyGoalScale(calm, NOW + 3_000)).toEqual({ scale: 1, changed: true, frozen: false });
      expect(getDailyBaseline()).toMatchObject({ goalScale: 1, goalScaleReason: null });
      expect(updateDailyTarget(NOW + 4_000)).toMatchObject({ targetPct: 3, goalScale: 1 });
      expect(scaledEvents()).toHaveLength(2);
    });

    it('is FROZEN once the guard has armed or the day has banked — a later switch changes tomorrow, not today', () => {
      setAutotradeConfig({
        ...defaultAutotradeConfig(),
        accountEquityUsd: 10_000,
        targetDailyGainPct: 3,
        giveBackArmPct: 2,
        giveBackFloorPct: 1,
      });
      updateDailyTarget(NOW);
      expect(updateDailyGoalScale(cut, NOW).changed).toBe(true);
      markGiveBackArmed(NOW + 1_000);
      expect(updateDailyGoalScale(calm, NOW + 2_000)).toEqual({ scale: 0.65, changed: false, frozen: true });
      expect(getDailyBaseline()?.goalScale).toBe(0.65);
      expect(scaledEvents()).toHaveLength(1);
      // The DB guard itself refuses a write on an armed row.
      expect(setDailyGoalScale(1, null)).toBe(false);
    });

    it('a skip, a factor of 1, or 0 read as unscaled; no baseline for today means nothing to scale', () => {
      setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
      updateDailyTarget(NOW);
      expect(updateDailyGoalScale({ factor: 0, skip: true, detail: 'skip' }, NOW)).toEqual({
        scale: 1,
        changed: false,
        frozen: false,
      });
      expect(updateDailyGoalScale({ factor: 0, skip: false, detail: 'zero' }, NOW).scale).toBe(1);
      expect(getDailyBaseline()?.goalScale).toBeNull();
      expect(scaledEvents()).toHaveLength(0);
      saveDailyBaseline('2026-08-20', 10_000); // yesterday's row
      expect(updateDailyGoalScale(cut, NOW)).toEqual({ scale: 1, changed: false, frozen: false });
    });

    it('clears on the day roll, and journals nothing while no goal is configured', () => {
      setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
      updateDailyTarget(NOW);
      updateDailyGoalScale(cut, NOW);
      expect(getDailyBaseline()?.goalScale).toBe(0.65);
      updateDailyTarget(NOW + 86_400_000);
      expect(getDailyBaseline()).toMatchObject({ goalScale: null, goalScaleReason: null });
      setAutotradeConfig({ targetDailyGainPct: null });
      db.exec('DELETE FROM autotrade_events');
      expect(updateDailyGoalScale(cut, NOW + 86_400_000).changed).toBe(true);
      expect(scaledEvents()).toHaveLength(0);
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
    seedLoopPnl(250);
    expect(updateDailyTarget(NOW + 60_000)).toMatchObject({ giveBackArmed: true, giveBackHalted: false });
    expect(getDailyBaseline()).toMatchObject({ giveBackArmedAt: NOW + 60_000, giveBackHaltedAt: null });
    expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_give_back_halted')).toHaveLength(0);

    // Fade to +1%: the guard FIRES — halted, journaled once.
    seedLoopPnl(100);
    const fired = updateDailyTarget(NOW + 120_000);
    expect(fired).toMatchObject({ giveBackHalted: true, entriesHalted: true, reached: false });
    // Recovery to +1.5% changes nothing — sticky, and still only one event.
    seedLoopPnl(150);
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

// ---------------------------------------------------------------------------
// 2026-09-14: the operator's own trading banked the loop's day.
// ---------------------------------------------------------------------------
describe('the day is the LOOP’s, not the account’s', () => {
  beforeAll(() => initDb());
  beforeEach(() =>
    db.exec(
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline; ' +
        'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_options_positions;',
    ),
  );

  /** The real session, to the dollar. Baseline 3,522.81; the loop closed
   *  CRWD +82.35, COIN +35.46, NOW +0.63 and BWIN -0.65 = +117.79; the operator
   *  closed -34.60 and then a manual TSLA options position moved about +88,
   *  which is what carried the ACCOUNT from +2.36% to +4.87%. */
  const BASELINE = 3_522.81;
  const LOOP_PNL = 117.79;
  const ACCOUNT_AT_1441 = 3_694.39;

  it('does not bank the day on money the loop did not make', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: BASELINE, targetDailyGainPct: 3 });
    updateDailyTarget(NOW);

    // The manual options position moves; the loop has traded nothing yet.
    setAutotradeConfig({ accountEquityUsd: ACCOUNT_AT_1441 });
    const first = updateDailyTarget(NOW + 60_000);
    const second = updateDailyTarget(NOW + 120_000); // two ticks: the old bug banked here

    expect(first).toMatchObject({ reached: false, entriesHalted: false, gainPct: 0 });
    expect(second).toMatchObject({ reached: false, entriesHalted: false, gainPct: 0 });
    // The account's move is still reported — it is what the operator feels —
    // it just decides nothing.
    expect(second.accountGainPct).toBeCloseTo(4.87, 2);
    expect(listAutotradeEvents({ actions: ['daily_target_reached'] })).toHaveLength(0);
  });

  it('banks the day when the LOOP earns it, whatever the account is doing', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: BASELINE, targetDailyGainPct: 3 });
    updateDailyTarget(NOW);
    // The loop's real day: +117.79 = +3.34% of the baseline, over the 3% line.
    seedLoopPnl(LOOP_PNL);
    // ...while the account is DOWN on the operator's own trading.
    setAutotradeConfig({ accountEquityUsd: BASELINE - 500 });

    updateDailyTarget(NOW + 60_000);
    const banked = updateDailyTarget(NOW + 120_000);
    expect(banked).toMatchObject({ reached: true, entriesHalted: true });
    expect(banked.gainPct).toBeCloseTo(3.34, 2);
    // To the cent the seeder can represent: it prices one 10-share exit, so a
    // P&L that is not a multiple of 10 cents lands a penny out.
    expect(banked.strategyPnlUsd).toBeCloseTo(LOOP_PNL, 1);
    expect(banked.accountGainPct).toBeLessThan(0);
  });

  it('a manual LOSS cannot trip the give-back guard either', () => {
    // The mirror of the first case, and the one that costs money rather than
    // opportunity: the operator having a bad afternoon must not halt a book
    // that is quietly up.
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      accountEquityUsd: BASELINE,
      targetDailyGainPct: 3,
      giveBackArmPct: 2,
      giveBackFloorPct: 1,
    });
    updateDailyTarget(NOW);
    seedLoopPnl(BASELINE * 0.025); // the loop is up +2.5% — the guard arms
    expect(updateDailyTarget(NOW + 60_000)).toMatchObject({ giveBackArmed: true, giveBackHalted: false });

    // The operator now loses far more than the guard's floor, in their own
    // trades. The loop has given back nothing.
    setAutotradeConfig({ accountEquityUsd: BASELINE * 0.9 });
    expect(updateDailyTarget(NOW + 120_000)).toMatchObject({ giveBackHalted: false, entriesHalted: false });
  });

  it('counts the options sleeve, because the loop trades it too', () => {
    // strategyDayFor is live stock PLUS live options, so a day carried by the
    // options sleeve is still the loop's day. Both halves are seeded here: an
    // earlier version of this case seeded two STOCK positions while its name
    // and comment claimed the options sleeve, which proved nothing about the
    // half it was named for.
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: BASELINE, targetDailyGainPct: 3 });
    updateDailyTarget(NOW);
    seedLoopPnl(60, 'SEEDA'); // stock: +60
    seedLoopOptionsPnl(60); // options: 1 contract 1.00 -> 1.60 = +60
    updateDailyTarget(NOW + 60_000);
    const banked = updateDailyTarget(NOW + 120_000);
    expect(banked.strategyPnlUsd).toBeCloseTo(120, 2);
    expect(banked.reached).toBe(true);

    // And the options half alone carries a day: drop the stock trade and the
    // remaining $60 is still measured, journaled and banked as the loop's.
    db.exec("DELETE FROM position_exits; DELETE FROM positions WHERE symbol = 'SEEDA'");
    expect(updateDailyTarget(NOW + 180_000).strategyPnlUsd).toBeCloseTo(60, 2);
  });

  it('reports the goal in DOLLARS the trim can act on, and the gap to it', () => {
    // gapToTargetUsd is the only thing the finish-line trim reads, and
    // headroomToFloorUsd the only thing the day-protective stop reads, so both
    // are asserted against the loop's own dollars rather than the account's.
    setAutotradeConfig({
      ...defaultAutotradeConfig(),
      accountEquityUsd: BASELINE,
      targetDailyGainPct: 3,
      giveBackArmPct: 2,
      giveBackFloorPct: 1,
    });
    updateDailyTarget(NOW);
    seedLoopPnl(40);
    // The account, meanwhile, is off doing something else entirely.
    setAutotradeConfig({ accountEquityUsd: ACCOUNT_AT_1441 });
    const s = updateDailyTarget(NOW + 60_000);
    // 3% of 3,522.81 = 105.68; the loop has 40 of it.
    expect(s.targetPnlUsd).toBeCloseTo(105.68, 2);
    expect(s.gapToTargetUsd).toBeCloseTo(65.68, 2);
    // The 1% floor is 35.23, so 40 leaves 4.77 of headroom.
    expect(s.headroomToFloorUsd).toBeCloseTo(4.77, 2);
    // …and the account's +171.58 moved none of them.
    expect(s.accountGainPct).toBeCloseTo(4.87, 2);
  });
});

describe('tune integration', () => {
  it('a tune apply carries the target into config — applying IS arming', () => {
    const t = computeTargetTune({
      equityUsd: 10_000,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
      realized: emptyRealizedEdge(40),
    });
    expect(t.patch.targetDailyGainPct).toBe(3);
    // …and stamps the give-back guard at 2/3 and 1/3 of the goal.
    expect(t.patch.giveBackArmPct).toBe(2);
    expect(t.patch.giveBackFloorPct).toBe(1);
  });

  it('reset-to-moderate declares NO goal and disarms the tracker AND the guard', () => {
    const patch = resetToModerate(10_000, defaultAutotradeConfig());
    expect(patch.targetDailyGainPct).toBeNull();
    expect(patch.giveBackArmPct).toBeNull();
    expect(patch.giveBackFloorPct).toBeNull();
  });
});
