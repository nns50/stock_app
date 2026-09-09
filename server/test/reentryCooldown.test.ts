import { describe, it, expect } from 'vitest';
import { reentryCooldownFor, sameDaySymbolExits } from '../src/services/autotrading/reentryCooldown';
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

// ---------------------------------------------------------------------------
// sameDaySymbolExits — the count behind the same-day re-entry size cut (#49).
//
// Measured 2026-09-08 over 89 closed live-autotrade trades: first entries
// n=56 +$398.98, repeats n=33 -$121.03. The direction survives trimming, the
// magnitude does not (86% of the deficit is one DELL trade), which is why the
// feature is a size cut and not a block.
// ---------------------------------------------------------------------------

/** Deliberately partial — only the fields this pure function reads. */
const closedOn = (symbol: string, exitDates: string[]): Position =>
  ({ symbol, exits: exitDates.map((exitDate) => ({ exitDate })) }) as unknown as Position;

describe('sameDaySymbolExits', () => {
  const TODAY = '2026-09-08';

  it('counts a name that already concluded a trade today', () => {
    expect(sameDaySymbolExits('DELL', [closedOn('DELL', [TODAY])], TODAY)).toBe(1);
  });

  it('counts POSITIONS, not exit rows — a scaled-out trade is ONE repeat', () => {
    // The discriminating case. A scale-out books a partial exit and a final
    // exit on the same day; counting rows would score that single trade as two
    // repeats and cut the next entry twice as hard for no reason. Live since
    // 2026-09-05, so this is the ordinary shape of a live trade, not an edge.
    expect(sameDaySymbolExits('NOK', [closedOn('NOK', [TODAY, TODAY])], TODAY)).toBe(1);
  });

  it('counts two SEPARATE trades in the name as two', () => {
    expect(sameDaySymbolExits('SEI', [closedOn('SEI', [TODAY]), closedOn('SEI', [TODAY])], TODAY)).toBe(2);
  });

  it("does not let yesterday's exit suppress this morning's FIRST entry", () => {
    // ET date, not a rolling 24h window, deliberately: the finding is about
    // re-entering inside the same SESSION. An overnight gap resets the thesis,
    // and a wall-clock window would have yesterday's 15:50 exit still cutting
    // an entry at today's open.
    expect(sameDaySymbolExits('LITE', [closedOn('LITE', ['2026-09-07'])], TODAY)).toBe(0);
  });

  it('counts a position OPENED yesterday and closed today', () => {
    // Exits are what make a name a repeat, not entries: an overnight hold sold
    // this morning makes this morning's second attempt the second attempt.
    expect(sameDaySymbolExits('ANF', [closedOn('ANF', [TODAY])], TODAY)).toBe(1);
  });

  it('ignores other symbols, and matches case/whitespace-insensitively', () => {
    expect(sameDaySymbolExits('DE', [closedOn('CRWD', [TODAY])], TODAY)).toBe(0);
    expect(sameDaySymbolExits(' de ', [closedOn('DE', [TODAY])], TODAY)).toBe(1);
  });

  it('is zero for a name with no exits at all', () => {
    expect(sameDaySymbolExits('ESTC', [closedOn('ESTC', [])], TODAY)).toBe(0);
  });
});
