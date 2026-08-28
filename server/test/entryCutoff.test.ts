import { describe, it, expect } from 'vitest';
import { evaluateEntryCutoff, ENTRY_RUNWAY_MINUTES } from '../src/services/autotrading/endOfDayFlatten';

// 2026-08-28 was a Friday. Times below are ET, converted to UTC (EDT = UTC-4).
const at = (hhmm: string) => Date.parse(`2026-08-28T${hhmm}:00-04:00`);
const cfg = (endOfDayFlattenMinutes: number) => ({ endOfDayFlattenMinutes });

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
