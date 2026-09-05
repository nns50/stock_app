import { describe, it, expect } from 'vitest';
import {
  CALENDAR_THROUGH,
  EARLY_CLOSES,
  EARLY_CLOSE_MINUTES,
  FULL_HOLIDAYS,
  etCalendarDate,
  isCalendarStale,
  isMarketHoliday,
  sessionCloseMinute,
} from '../src/services/trading/marketCalendar';
import { isUsEquityMarketOpen } from '../src/services/trading/marketHours';
import { minutesUntilClose, evaluateEndOfDayFlatten } from '../src/services/autotrading/endOfDayFlatten';
import { checkSessionWindow } from '../src/services/autotrading/executionGuards';

// ---------------------------------------------------------------------------
// The market calendar (2026-09-05). Nothing in this app knew about holidays or
// early closes: isUsEquityMarketOpen excluded only Saturday and Sunday, and
// three separate copies of "the close is 16:00" counted down to a bell that
// does not always ring then.
//
// The two consequences, both real and both dated:
//   - Labor Day 2026-09-07 (two days after this was written) would have run the
//     full loop off the previous session's stale closes, and the PAPER book —
//     which needs no broker to fill — would have opened and, since the paper
//     flatten landed the same day, closed a batch of phantom positions at those
//     stale prices, straight into the evidence track.
//   - An early close is worse. It is a real trading morning, so positions are
//     genuinely open, and the flatten measured against 16:00 would fire at
//     15:55 — nearly three hours after the bell — cancelling a live bracket and
//     placing a replacement that cannot fill until the next open.
// ---------------------------------------------------------------------------

/** An ET instant. Months are 1-based here for readability. */
const et = (y: number, m: number, d: number, hh: number, mm: number): number =>
  // -04:00 is EDT, which covers every date this file asserts on except the
  // December ones; those are given in -05:00 explicitly below.
  Date.parse(
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00`,
  );

describe('the calendar itself', () => {
  it('knows Labor Day 2026 — the date that prompted this', () => {
    expect(FULL_HOLIDAYS.has('2026-09-07')).toBe(true);
    expect(isMarketHoliday(et(2026, 9, 7, 11, 0))).toBe(true);
  });

  it('lists no date twice across the two tables', () => {
    // A date cannot be both shut all day and closing early. 2026-07-03 is the
    // live example: it is a FULL holiday this year (the 4th falls on a
    // Saturday), not the usual half-day, and having it in both would make
    // sessionCloseMinute contradict isMarketHoliday.
    for (const d of EARLY_CLOSES) expect(FULL_HOLIDAYS.has(d)).toBe(false);
  });

  it('holds well-formed ET dates only', () => {
    for (const d of [...FULL_HOLIDAYS, ...EARLY_CLOSES]) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(etCalendarDate(Date.parse(`${d}T12:00:00-04:00`))).toBe(d);
    }
  });

  it('matches the NYSE rules that generate each date', () => {
    // The table is hand-transcribed, and a wrong entry is expensive in both
    // directions: a spurious date costs a whole trading session, a missing one
    // reopens the bug. So derive every 2026 date from its rule and compare.
    // (This checks the arithmetic, not the exchange's intent — an unscheduled
    // closure still has to be added by hand.)
    const nth = (m: number, weekday: number, n: number): string => {
      const d = new Date(Date.UTC(2026, m - 1, 1));
      let count = 0;
      for (;;) {
        if (d.getUTCDay() === weekday && ++count === n) break;
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return d.toISOString().slice(0, 10);
    };
    const lastMonday = (m: number): string => {
      const d = new Date(Date.UTC(2026, m, 0)); // last day of month m
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    };
    /** NYSE: a Saturday holiday is observed the Friday before, a Sunday one the Monday after. */
    const observed = (month: number, day: number): string => {
      const d = new Date(Date.UTC(2026, month - 1, day));
      if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
      if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };

    const derived = new Set([
      observed(1, 1), // New Year's Day
      nth(1, 1, 3), // MLK — 3rd Monday of January
      nth(2, 1, 3), // Washington's Birthday — 3rd Monday of February
      '2026-04-03', // Good Friday — computus, spelled out rather than re-derived
      lastMonday(5), // Memorial Day
      observed(6, 19), // Juneteenth
      observed(7, 4), // Independence Day — the 4th is a Saturday in 2026, so the 3rd
      nth(9, 1, 1), // Labor Day — 1st Monday of September
      nth(11, 4, 4), // Thanksgiving — 4th Thursday of November
      observed(12, 25), // Christmas
    ]);
    expect([...FULL_HOLIDAYS].sort()).toEqual([...derived].sort());

    // Early closes: the day after Thanksgiving and Christmas Eve. There is no
    // July 3 half-day in 2026 — that date is a full holiday this year.
    const dayAfterThanksgiving = new Date(Date.UTC(2026, 10, Number(nth(11, 4, 4).slice(-2)) + 1))
      .toISOString()
      .slice(0, 10);
    expect([...EARLY_CLOSES].sort()).toEqual([dayAfterThanksgiving, '2026-12-24'].sort());
  });

  it('has not gone stale — replace the table when this fails', () => {
    // The whole point of CALENDAR_THROUGH. A hand-maintained calendar that
    // quietly runs past its coverage starts treating holidays as trading days
    // again, which is the exact bug this file was written to end. When this
    // fails, add the next year's NYSE dates and move CALENDAR_THROUGH.
    expect(
      isCalendarStale(),
      `market calendar only covers through ${CALENDAR_THROUGH} — add the next year's NYSE holidays and early closes`,
    ).toBe(false);
  });
});

describe('isUsEquityMarketOpen', () => {
  it('is closed all day on a full holiday that is otherwise a normal Monday', () => {
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 7, 11, 0)))).toBe(false);
    // The Tuesday after is a trading day again.
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 8, 11, 0)))).toBe(true);
  });

  it('closes at 13:00 on an early-close day', () => {
    const dayAfterThanksgiving = (hh: number, mm: number) =>
      Date.parse(`2026-11-27T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`);
    expect(isUsEquityMarketOpen(new Date(dayAfterThanksgiving(12, 30)))).toBe(true);
    expect(isUsEquityMarketOpen(new Date(dayAfterThanksgiving(13, 0)))).toBe(false);
    expect(isUsEquityMarketOpen(new Date(dayAfterThanksgiving(15, 55)))).toBe(false);
  });

  it('still opens normally on an ordinary weekday', () => {
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 8, 9, 29)))).toBe(false);
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 8, 9, 30)))).toBe(true);
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 8, 15, 59)))).toBe(true);
    expect(isUsEquityMarketOpen(new Date(et(2026, 9, 8, 16, 0)))).toBe(false);
  });
});

describe('minutesUntilClose', () => {
  it('is null all day on a full holiday, so nothing flattens', () => {
    expect(minutesUntilClose(et(2026, 9, 7, 15, 55))).toBeNull();
    expect(evaluateEndOfDayFlatten({ endOfDayFlattenMinutes: 5 }, et(2026, 9, 7, 15, 55)).active).toBe(false);
  });

  it('counts down to 13:00 on an early close, not 16:00', () => {
    const at = (hh: number, mm: number) =>
      Date.parse(`2026-11-27T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`);
    expect(minutesUntilClose(at(12, 55))).toBe(5);
    // 15:55 is nearly three hours past the bell — it must not read as "5m left".
    expect(minutesUntilClose(at(15, 55))).toBeNull();
  });

  it('flattens at 12:55 on a half-day and NOT at 15:55', () => {
    // The defect in one assertion. Firing at 15:55 there would cancel a live
    // bracket and leave the position naked overnight.
    const at = (hh: number, mm: number) =>
      Date.parse(`2026-11-27T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`);
    const cfg = { endOfDayFlattenMinutes: 5 };
    expect(evaluateEndOfDayFlatten(cfg, at(12, 55)).active).toBe(true);
    expect(evaluateEndOfDayFlatten(cfg, at(15, 55)).active).toBe(false);
  });

  it('is unchanged on an ordinary session', () => {
    expect(minutesUntilClose(et(2026, 9, 8, 15, 55))).toBe(5);
    expect(minutesUntilClose(et(2026, 9, 8, 16, 0))).toBeNull();
  });
});

describe('checkSessionWindow', () => {
  it('refuses the whole day on a full holiday', () => {
    expect(checkSessionWindow(15, new Date(et(2026, 9, 7, 11, 0)))).toMatchObject({ ok: false });
  });

  it("measures its close buffer against the DAY'S close, not a fixed 16:00", () => {
    // At 12:50 on a 13:00 half-day there are ten minutes left, so a 15-minute
    // buffer must refuse. Against a hard-coded 16:00 this read as three hours
    // of runway and let the entry through.
    const at = (hh: number, mm: number) =>
      new Date(Date.parse(`2026-11-27T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`));
    expect(checkSessionWindow(15, at(12, 50)).ok).toBe(false);
    expect(checkSessionWindow(15, at(11, 0)).ok).toBe(true);
  });

  it('is unchanged on an ordinary session', () => {
    expect(checkSessionWindow(15, new Date(et(2026, 9, 8, 11, 0))).ok).toBe(true);
    expect(checkSessionWindow(15, new Date(et(2026, 9, 8, 15, 50))).ok).toBe(false);
  });
});

describe('sessionCloseMinute', () => {
  it('is 16:00 by default and 13:00 on the listed early closes', () => {
    expect(sessionCloseMinute(et(2026, 9, 8, 11, 0))).toBe(16 * 60);
    expect(sessionCloseMinute(Date.parse('2026-11-27T11:00:00-05:00'))).toBe(EARLY_CLOSE_MINUTES);
    expect(sessionCloseMinute(Date.parse('2026-12-24T11:00:00-05:00'))).toBe(EARLY_CLOSE_MINUTES);
  });
});
