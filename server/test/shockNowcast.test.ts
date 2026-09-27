import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/executionGuards')>();
  return { ...actual, getMarketRangePct: vi.fn(), getMarketAtrPct: vi.fn() };
});

import { initDb, db } from '../src/db';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { saveMlRegimeReading } from '../src/db/mlRegimeReadings';
import { getMarketAtrPct, getMarketRangePct } from '../src/services/autotrading/executionGuards';
import { recordShockShadow } from '../src/services/autotrading/shockShadow';
import { getMlRegimeReadiness } from '../src/services/mlRegimeReadiness';
import type { MlRegime } from '../src/services/regimeModel';
import {
  SHOCK_SHADOW_ACTION,
  ShockReading,
  ShockShadowRow,
  computeShockNowcastEvidence,
  readShockNowcastEvidence,
} from '../src/services/shockNowcast';

// ---------------------------------------------------------------------------
// The shock trigger's gate, readable at last (2026-09-26): each day the
// measured range reached a level, paired with the first model reading that had
// SEEN that day. A level is met on 3+ such days with the model reading High
// Volatility/Bearish on more than half; the lowest met candidate is proposed.
// ---------------------------------------------------------------------------

// Mon 09-28 .. Fri 10-02, and the Saturday reading after it.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const WED = '2026-09-30';
const THU = '2026-10-01';
const FRI = '2026-10-02';
const SAT = '2026-10-03';

/** The days the range reached each level: Mon to 2.5×, Tue and Wed to 2×,
 *  Thu to 1× only, Fri to 1.5×. */
const REACHED: Record<string, number> = { [MON]: 2.5, [TUE]: 2, [WED]: 2, [THU]: 1, [FRI]: 1.5 };
const LEVELS = [0, 1, 1.5, 2, 2.5, 3];
const rowsFor = (reached: Record<string, number>): ShockShadowRow[] =>
  Object.entries(reached).flatMap(([date, peak]) =>
    LEVELS.filter((l) => l <= peak).map((level) => ({ date, level, at: '10:30' })),
  );

/** What the model read each day. Thursday's reading had not yet seen
 *  Wednesday (FRED's lag), so Wednesday's label is Friday's. */
const READINGS: ShockReading[] = [
  { etDate: MON, regime: 'low_vol_bullish', asOf: '2026-09-25' },
  { etDate: TUE, regime: 'high_vol_bearish', asOf: MON },
  { etDate: WED, regime: 'high_vol_bearish', asOf: TUE },
  { etDate: THU, regime: 'sideways', asOf: TUE },
  { etDate: FRI, regime: 'sideways', asOf: THU },
  { etDate: SAT, regime: 'low_vol_bullish', asOf: FRI },
];

describe('computeShockNowcastEvidence — the pairing rule', () => {
  const evidence = computeShockNowcastEvidence(rowsFor(REACHED), READINGS, 0);
  const at = (level: number) => evidence.levels.find((l) => l.level === level)!;

  it('pairs each shock day with the first reading that has seen it', () => {
    expect(at(2).shockDays).toEqual([
      {
        date: MON,
        at: '10:30',
        dayRegime: 'low_vol_bullish',
        next: { etDate: TUE, asOf: MON, regime: 'high_vol_bearish' },
      },
      {
        date: TUE,
        at: '10:30',
        dayRegime: 'high_vol_bearish',
        next: { etDate: WED, asOf: TUE, regime: 'high_vol_bearish' },
      },
      // Thursday's reading is skipped: its data ended Tuesday.
      { date: WED, at: '10:30', dayRegime: 'high_vol_bearish', next: { etDate: FRI, asOf: THU, regime: 'sideways' } },
    ]);
  });

  it('meets a level on three decided days with the model agreeing on most, and proposes the lowest', () => {
    expect(evidence.measuredSessions).toBe(5);
    expect([evidence.firstMeasured, evidence.lastMeasured]).toEqual([MON, FRI]);
    // 1.5×: four days, the model High Vol next on two — half is not most.
    // Tuesday and Wednesday already read High Vol on the day itself.
    expect(at(1.5)).toMatchObject({ days: 4, decided: 4, highVolNext: 2, highVolSameDay: 2, meets: false });
    // 2×: three days, High Vol next on two of them.
    expect(at(2)).toMatchObject({ days: 3, decided: 3, highVolNext: 2, highVolSameDay: 2, meets: true });
    expect(at(2.5)).toMatchObject({ days: 1, meets: false });
    expect(at(3)).toMatchObject({ days: 0, meets: false });
    // 1× is the base rate, never a candidate, whatever it reads.
    expect(at(1)).toMatchObject({ candidate: false, days: 5 });
    expect(evidence.proposal).toEqual({ regimeShockRangeRatio: 2 });
  });

  it("never takes the day's own reading as its next-session label, even one refreshed after the close", () => {
    const readings: ShockReading[] = [
      // An evening refresh that already carries Monday's close is still Monday's reading.
      { etDate: MON, regime: 'high_vol_bearish', asOf: MON },
      { etDate: TUE, regime: 'sideways', asOf: MON },
    ];
    const e = computeShockNowcastEvidence(rowsFor({ [MON]: 2 }), readings, 0);
    expect(e.levels.find((l) => l.level === 2)!.shockDays[0]).toMatchObject({
      dayRegime: 'high_vol_bearish',
      next: { etDate: TUE, regime: 'sideways' },
    });
  });

  it('needs three decided days: two that agree are not enough', () => {
    const readings: ShockReading[] = [
      { etDate: TUE, regime: 'high_vol_bearish', asOf: MON },
      { etDate: WED, regime: 'high_vol_bearish', asOf: TUE },
    ];
    const e = computeShockNowcastEvidence(rowsFor({ [MON]: 3, [TUE]: 3 }), readings, 0);
    expect(e.levels.find((l) => l.level === 3)).toMatchObject({ decided: 2, highVolNext: 2, meets: false });
    expect(e.proposal).toBeNull();
  });

  it('proposes nothing while the trigger is already on', () => {
    const on = computeShockNowcastEvidence(rowsFor(REACHED), READINGS, 2);
    expect(on.levels.find((l) => l.level === 2)!.meets).toBe(true);
    expect(on.proposal).toBeNull();
    expect(on.triggerRatio).toBe(2);
  });

  it('leaves a day undecided until a known reading within a week has seen it', () => {
    const lateOnly: ShockReading[] = [
      // Saw the day, but read no label: not a verdict either way.
      { etDate: '2026-10-06', regime: 'unknown', asOf: '2026-10-05' },
      // Eight days later is not the next session's label.
      { etDate: '2026-10-13', regime: 'high_vol_bearish', asOf: '2026-10-12' },
    ];
    const e = computeShockNowcastEvidence(rowsFor({ '2026-10-05': 3 }), lateOnly, 0);
    const three = e.levels.find((l) => l.level === 3)!;
    expect(three).toMatchObject({ days: 1, decided: 0, highVolNext: 0, meets: false });
    expect(three.shockDays[0].next).toBeNull();
  });

  it("keeps each day's level once, at the earliest time a restart re-journaled it", () => {
    const rows: ShockShadowRow[] = [
      { date: MON, level: 0, at: '11:02' },
      { date: MON, level: 2, at: '14:10' },
      { date: MON, level: 0, at: '09:31' },
      { date: MON, level: 2, at: '10:45' },
    ];
    const e = computeShockNowcastEvidence(rows, READINGS, 0);
    expect(e.measuredSessions).toBe(1);
    expect(e.levels.find((l) => l.level === 2)!.shockDays).toMatchObject([{ date: MON, at: '10:45' }]);
  });
});

describe('readShockNowcastEvidence — from the journal and the persisted readings', () => {
  const range = vi.mocked(getMarketRangePct);
  const atr = vi.mocked(getMarketAtrPct);
  const et = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00-04:00`);

  beforeAll(() => initDb());
  beforeEach(() => {
    db.exec('DELETE FROM autotrade_events; DELETE FROM ml_regime_readings;');
    // 0.5 is exact in binary, so each range ÷ ATR below is exactly its level.
    atr.mockReset().mockResolvedValue(0.5);
  });

  it('reads what the recorder wrote, pairs it with the stored readings, and rides on the readiness object', async () => {
    setAutotradeConfig({ regimeShockRangeRatio: 0 });
    for (const [date, peak] of Object.entries(REACHED)) {
      // Two ticks a day: the morning's smaller range, then the day's peak.
      range.mockResolvedValue(0.1);
      await recordShockShadow(null, et(date, '09:35'));
      range.mockResolvedValue(peak * 0.5);
      await recordShockShadow(null, et(date, '13:20'));
    }
    for (const r of READINGS) {
      saveMlRegimeReading({
        etDate: r.etDate,
        regime: r.regime as MlRegime,
        asOf: r.asOf,
        reading: {},
        modelVersion: 'test',
      });
    }
    // A row something else wrote under another action is not read.
    logAutotradeEvent({ stage: 'screen', action: 'market_direction_read', detail: { date: MON, level: 3 } });

    const now = et(SAT, '12:00');
    const e = readShockNowcastEvidence(now);
    expect(e.measuredSessions).toBe(5);
    expect(e.levels.find((l) => l.level === 2)).toMatchObject({ days: 3, decided: 3, highVolNext: 2, meets: true });
    expect(e.levels.find((l) => l.level === 2)!.shockDays[0]).toMatchObject({ date: MON, at: '13:20' });
    expect(e.proposal).toEqual({ regimeShockRangeRatio: 2 });
    // The market_direction_read row claiming level 3 was not read.
    expect(e.levels.find((l) => l.level === 3)!.days).toBe(0);
    expect(e.journalTruncated).toBe(false);
    expect(getMlRegimeReadiness(now).shockNowcast).toEqual(e);

    // Nothing measured yet reads as nothing, not as a calm market.
    db.exec(`DELETE FROM autotrade_events WHERE action = '${SHOCK_SHADOW_ACTION}'`);
    const empty = readShockNowcastEvidence(now);
    expect(empty).toMatchObject({ measuredSessions: 0, firstMeasured: null, proposal: null });
    expect(empty.levels.every((l) => l.days === 0)).toBe(true);
  });
});
