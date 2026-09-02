import { describe, it, expect } from 'vitest';
import {
  evaluateEntryCutoff,
  entryRunwayMinutes,
  ENTRY_RUNWAY_MINUTES,
} from '../src/services/autotrading/endOfDayFlatten';

// 2026-08-28 was a Friday. Times below are ET, converted to UTC (EDT = UTC-4).
const at = (hhmm: string) => Date.parse(`2026-08-28T${hhmm}:00-04:00`);
// stagnationExitMinutes defaults to 0 here, so every test below exercises the
// runway FLOOR (15m) — i.e. a book running with the stagnation exit off. The
// derived case has its own describe block at the bottom.
const cfg = (endOfDayFlattenMinutes: number, stagnationExitMinutes = 0) => ({
  endOfDayFlattenMinutes,
  stagnationExitMinutes,
});

describe('evaluateEntryCutoff', () => {
  it('blocks the exact entry that prompted this — ESTC at 15:56', () => {
    // Opened 15:56:04, flattened 15:57:12. Four minutes to the close, against
    // a 5m flatten + 15m runway = 20m cutoff.
    const d = evaluateEntryCutoff(cfg(5), at('15:56'));
    expect(d.blocked).toBe(true);
    expect(d.minutesLeft).toBe(4);
    expect(d.cutoffMinutes).toBe(20);
    expect(d.reason).toMatch(/past the 20m entry cutoff/);
  });

  it('still allows the legitimate entry from the same session — GAP at 15:19', () => {
    // 41 minutes of runway. This one had a real hold (36m) and a real outcome;
    // the gate must not swallow it, or it is just a blunt afternoon shutdown.
    const d = evaluateEntryCutoff(cfg(5), at('15:19'));
    expect(d.blocked).toBe(false);
    expect(d.reason).toBeNull();
  });

  it('is exact at the boundary, not near it', () => {
    // cutoff 20m: 20 minutes left is blocked, 21 is not.
    expect(evaluateEntryCutoff(cfg(5), at('15:40')).blocked).toBe(true); // 20m left
    expect(evaluateEntryCutoff(cfg(5), at('15:39')).blocked).toBe(false); // 21m left
  });

  it('moves with the flatten window — the two cannot drift apart', () => {
    // The same instant, judged against two flatten settings. A wider flatten
    // pushes the cutoff out by exactly the same amount, which is the reason
    // this is derived rather than configured separately: a hand-set cutoff
    // could be left BELOW the flatten and silently reopen the hole.
    expect(evaluateEntryCutoff(cfg(30), at('15:15')).cutoffMinutes).toBe(30 + ENTRY_RUNWAY_MINUTES); // 45
    expect(evaluateEntryCutoff(cfg(30), at('15:15')).blocked).toBe(true); // 45m left, at the cutoff
    expect(evaluateEntryCutoff(cfg(5), at('15:15')).blocked).toBe(false); // same time, 20m cutoff
  });

  it('is off entirely when the flatten is off', () => {
    // No flatten means no window to be swallowed by, and this gate has no
    // opinion about how late the loop trades.
    const d = evaluateEntryCutoff(cfg(0), at('15:59'));
    expect(d).toMatchObject({ blocked: false, cutoffMinutes: 0, reason: null });
  });

  it('does not block outside the regular session — that is another gate’s job', () => {
    expect(evaluateEntryCutoff(cfg(5), Date.parse('2026-08-29T14:00:00-04:00')).blocked).toBe(false); // Saturday
    expect(evaluateEntryCutoff(cfg(5), at('08:00')).blocked).toBe(false); // pre-market
    expect(evaluateEntryCutoff(cfg(5), at('17:00')).blocked).toBe(false); // after hours
  });

  it('leaves the whole morning and midday alone', () => {
    for (const t of ['09:31', '10:30', '12:00', '14:00', '15:00']) {
      expect(evaluateEntryCutoff(cfg(5), at(t)).blocked).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The runway is derived from the stagnation window (2026-09-02).
//
// The original flat 15 minutes asked whether a trade could reach its TARGET.
// But the target is not what closes these trades — the stagnation exit is (10
// of 11 exits on 2026-09-02, 7 of 8 the day before). It gives a position 90
// session-minutes to reach 0.5R, so a trade opened with less than that cannot
// reach its own verdict; the flatten decides it on the clock instead.
// ---------------------------------------------------------------------------
describe('entryRunwayMinutes — derived from the stagnation window', () => {
  it('uses the stagnation window when it is longer than the floor', () => {
    expect(entryRunwayMinutes({ endOfDayFlattenMinutes: 5, stagnationExitMinutes: 90 })).toBe(90);
  });

  it('never drops below the floor, however short stagnation is set', () => {
    expect(entryRunwayMinutes({ endOfDayFlattenMinutes: 5, stagnationExitMinutes: 5 })).toBe(ENTRY_RUNWAY_MINUTES);
    expect(entryRunwayMinutes({ endOfDayFlattenMinutes: 5, stagnationExitMinutes: 0 })).toBe(ENTRY_RUNWAY_MINUTES);
  });
});

describe('evaluateEntryCutoff — the 2026-09-02 session it was written for', () => {
  // 2026-09-02 was a Wednesday. Live config that day: 5m flatten, 90m stagnation
  // -> a 95m cutoff, so the last entry of the day is 14:25 ET.
  const sep2 = (hhmm: string) => Date.parse(`2026-09-02T${hhmm}:00-04:00`);
  const live = cfg(5, 90);

  it('blocks all three late entries that turned the day negative', () => {
    // MOS 15:26, BBY 15:27, SWKS 15:27 — 33-34 minutes left, comfortably
    // outside the OLD 20m cutoff, all force-closed by the 15:57 flatten about
    // 30 minutes later for a combined -$36.29 against a +$32.78 day.
    for (const t of ['15:26', '15:27']) {
      const d = evaluateEntryCutoff(live, sep2(t));
      expect(d.blocked, `entry at ${t}`).toBe(true);
      expect(d.cutoffMinutes).toBe(95);
      expect(d.reason).toMatch(/stagnation window could judge it/);
    }
  });

  it('still allows every entry that got a real hold that day', () => {
    // Including GTLB's 13:00 entry, which ran 93 minutes and was closed by the
    // stagnation rule on its merits. A gate that swallowed this would just be
    // an afternoon shutdown.
    for (const t of ['09:37', '11:14', '12:46', '13:00']) {
      expect(evaluateEntryCutoff(live, sep2(t)).blocked, `entry at ${t}`).toBe(false);
    }
  });

  it('is exact at the 14:25 boundary', () => {
    expect(evaluateEntryCutoff(live, sep2('14:25')).blocked).toBe(true); // 95m left
    expect(evaluateEntryCutoff(live, sep2('14:24')).blocked).toBe(false); // 96m left
  });

  it('would NOT have blocked them under the old flat runway — proving the change bites', () => {
    // Same instants, stagnation off: the 20m cutoff lets all three through,
    // which is exactly what happened.
    for (const t of ['15:26', '15:27']) {
      expect(evaluateEntryCutoff(cfg(5), sep2(t)).blocked, `entry at ${t}`).toBe(false);
    }
  });
});
