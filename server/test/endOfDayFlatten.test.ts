import { describe, it, expect } from 'vitest';
import { evaluateEndOfDayFlatten, minutesUntilClose } from '../src/services/autotrading/endOfDayFlatten';

// 2026-08-25 is a Monday. ET is UTC-4 in August, so 16:00 ET = 20:00Z.
const at = (iso: string) => Date.parse(iso);
const cfg = { endOfDayFlattenMinutes: 3 };

describe('minutesUntilClose', () => {
  it('counts down to the 16:00 ET bell', () => {
    expect(minutesUntilClose(at('2026-08-25T19:57:00Z'))).toBe(3); // 15:57 ET
    expect(minutesUntilClose(at('2026-08-25T19:59:00Z'))).toBe(1);
    expect(minutesUntilClose(at('2026-08-25T13:30:00Z'))).toBe(390); // the open
  });

  it('is null outside the regular session — including the bell itself', () => {
    expect(minutesUntilClose(at('2026-08-25T20:00:00Z'))).toBeNull(); // 16:00 ET, closed
    expect(minutesUntilClose(at('2026-08-25T20:30:00Z'))).toBeNull(); // after hours
    expect(minutesUntilClose(at('2026-08-25T12:00:00Z'))).toBeNull(); // pre-market
  });

  it('is null at the weekend', () => {
    expect(minutesUntilClose(at('2026-08-22T17:00:00Z'))).toBeNull(); // Saturday
    expect(minutesUntilClose(at('2026-08-23T17:00:00Z'))).toBeNull(); // Sunday
  });

  it('tracks the ET offset through standard time', () => {
    // January: ET is UTC-5, so the close is 21:00Z.
    expect(minutesUntilClose(at('2026-01-15T20:57:00Z'))).toBe(3);
    expect(minutesUntilClose(at('2026-01-15T20:00:00Z'))).toBe(60);
  });
});

describe('evaluateEndOfDayFlatten', () => {
  it('is off at 0 minutes, even at the bell', () => {
    const d = evaluateEndOfDayFlatten({ endOfDayFlattenMinutes: 0 }, at('2026-08-25T19:59:00Z'));
    expect(d.active).toBe(false);
    expect(d.detail).toMatch(/off/);
  });

  it('activates only inside the window, inclusive of its opening minute', () => {
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-25T19:56:00Z')).active).toBe(false); // 4m left
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-25T19:57:00Z')).active).toBe(true); // exactly 3m
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-25T19:59:00Z')).active).toBe(true); // 1m
  });

  it('never fires after the bell — no close into after-hours liquidity', () => {
    // A flatten attempted post-close would pay the after-hours spread to avoid
    // an overnight gap it is already exposed to.
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-25T20:00:00Z')).active).toBe(false);
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-25T20:05:00Z')).active).toBe(false);
  });

  it('never fires mid-session, however the trade is doing', () => {
    // The decision is about the CLOCK, not the trade — but only at the end of it.
    const d = evaluateEndOfDayFlatten(cfg, at('2026-08-25T15:00:00Z')); // 11:00 ET
    expect(d.active).toBe(false);
    expect(d.minutesLeft).toBe(300);
    expect(d.detail).toMatch(/flatten starts at 3m/);
  });

  it('is dormant at the weekend even with a window configured', () => {
    expect(evaluateEndOfDayFlatten(cfg, at('2026-08-22T19:59:00Z')).active).toBe(false);
  });

  it('reports minutes left so a trigger can journal how close it ran', () => {
    const d = evaluateEndOfDayFlatten(cfg, at('2026-08-25T19:58:00Z'));
    expect(d).toMatchObject({ active: true, minutesLeft: 2 });
    expect(d.detail).toMatch(/rather than carrying overnight/);
  });
});
