import { describe, it, expect, beforeEach } from 'vitest';
import { claimOncePerDay, resetOncePerDayEvents } from '../src/services/autotrading/oncePerDayEvents';

/** 14:00 UTC = 10:00 ET — mid-session on the given ET day, well clear of the
 *  midnight boundary in both directions. */
const etMidday = (day: string) => Date.parse(`${day}T14:00:00Z`);

describe('claimOncePerDay', () => {
  beforeEach(() => resetOncePerDayEvents());

  it('grants the first claim of a day and refuses every later one', () => {
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(true);
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(false);
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(false);
  });

  it('keeps symbols and actions apart', () => {
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(true);
    expect(claimOncePerDay('excluded_re', 'AMT', etMidday('2026-09-09'))).toBe(true);
    expect(claimOncePerDay('excluded_volatility', 'PLD', etMidday('2026-09-09'))).toBe(true);
  });

  it('is case- and whitespace-insensitive, so one symbol is one slot', () => {
    expect(claimOncePerDay('excluded_re', 'pld', etMidday('2026-09-09'))).toBe(true);
    expect(claimOncePerDay('excluded_re', ' PLD ', etMidday('2026-09-09'))).toBe(false);
  });

  it('grants a fresh claim on the next ET day', () => {
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(true);
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-10'))).toBe(true);
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-10'))).toBe(false);
  });

  it('rolls the day in ET, not UTC', () => {
    // 03:00 UTC on the 10th is 23:00 ET on the NINTH — still the same trading
    // day, and a UTC-keyed cache would hand out a second row for it.
    expect(claimOncePerDay('excluded_re', 'PLD', Date.parse('2026-09-09T20:00:00Z'))).toBe(true);
    expect(claimOncePerDay('excluded_re', 'PLD', Date.parse('2026-09-10T03:00:00Z'))).toBe(false);
  });

  it('drops the previous day’s claims rather than accumulating them', () => {
    claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'));
    claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-10'));
    // Back to the 9th: the set was cleared on the roll, so this is a first
    // claim again. Bounded memory is the point — a set that kept every day
    // would grow with uptime, which is the problem this file exists to fix.
    expect(claimOncePerDay('excluded_re', 'PLD', etMidday('2026-09-09'))).toBe(true);
  });
});
