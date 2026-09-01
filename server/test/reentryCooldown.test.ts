import { describe, it, expect } from 'vitest';
import { reentryCooldownFor } from '../src/services/autotrading/reentryCooldown';
import type { Position } from '../src/db/positions';

const NOW = Date.parse('2026-09-01T11:55:00-04:00'); // DE's real re-entry moment
const mins = (n: number) => n * 60_000;

/** Deliberately partial — only the fields this pure function reads. */
const closed = (symbol: string, exitAt: number): Position =>
  ({ symbol, exits: [{ createdAt: exitAt }] }) as unknown as Position;

describe('reentryCooldownFor', () => {
  it('blocks the real DE re-entry that prompted this', () => {
    // DE opened 09:37, the stagnation exit closed it ~11:16, and the loop
    // re-entered at 11:55 — 39 minutes later, against a 90m window.
    const c = reentryCooldownFor('DE', [closed('DE', NOW - mins(39))], 90, NOW);
    expect(c).not.toBeNull();
    expect(c!.minutesSince).toBe(39);
    expect(c!.cooldownMinutes).toBe(90);
  });

  it('gets out of the way once the window has passed', () => {
    // The counter-case symbolCooldown.ts records: LVWR lost at 12:30 and the
    // same-day re-entry won +1.93R. A real second setup hours later must
    // still be takeable — this blocks the reflex, not the whole session.
    expect(reentryCooldownFor('LVWR', [closed('LVWR', NOW - mins(91))], 90, NOW)).toBeNull();
  });

  it('is exact at the boundary', () => {
    expect(reentryCooldownFor('X', [closed('X', NOW - mins(89))], 90, NOW)).not.toBeNull();
    expect(reentryCooldownFor('X', [closed('X', NOW - mins(90))], 90, NOW)).toBeNull();
  });

  it('measures from the MOST RECENT exit when a name traded twice', () => {
    const c = reentryCooldownFor('ANF', [closed('ANF', NOW - mins(300)), closed('ANF', NOW - mins(10))], 90, NOW);
    expect(c!.minutesSince).toBe(10); // not 300 — the old one must not clear it
  });

  it('ignores other symbols entirely', () => {
    expect(reentryCooldownFor('DE', [closed('CRWD', NOW - mins(5))], 90, NOW)).toBeNull();
  });

  it('is off at 0, exactly as before this existed', () => {
    expect(reentryCooldownFor('DE', [closed('DE', NOW - mins(1))], 0, NOW)).toBeNull();
  });

  it('never cools a symbol that has never closed', () => {
    expect(reentryCooldownFor('DE', [], 90, NOW)).toBeNull();
  });

  it('ignores a position with no exits rather than throwing', () => {
    const open = { symbol: 'DE', exits: [] } as unknown as Position;
    expect(reentryCooldownFor('DE', [open], 90, NOW)).toBeNull();
  });

  it('does not read a future-dated exit as cooled forever', () => {
    // Clock skew between the broker feed and the app must fail OPEN, not
    // silently blacklist a symbol.
    expect(reentryCooldownFor('DE', [closed('DE', NOW + mins(30))], 90, NOW)).toBeNull();
  });
});
