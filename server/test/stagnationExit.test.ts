import { describe, it, expect } from 'vitest';
import { evaluateStagnation, progressR, sessionMinutesBetween } from '../src/services/autotrading/stagnationExit';

// Long: entry 100, stop 95 => risk $5/share. Short mirrors it.
// Entry at 10:00 ET on Monday 2026-08-24 — mid-session, so elapsed minutes and
// session minutes agree for the first six hours and the intent of each case
// stays readable.
const ENTRY = Date.parse('2026-08-24T14:00:00Z');
const longPos = { side: 'long' as const, entryPrice: 100, stopPrice: 95, initialStopPrice: 95, createdAt: ENTRY };
const shortPos = {
  side: 'short' as const,
  entryPrice: 100,
  stopPrice: 105,
  initialStopPrice: 105,
  createdAt: ENTRY,
};

const cfg = { stagnationExitMinutes: 90, stagnationExitMinR: 0.5 };
const MIN = 60_000;
/** `n` minutes of real session time after the entry. */
const after = (n: number) => ENTRY + n * MIN;

describe('progressR', () => {
  it("measures progress against the trade's own risk geometry, both sides", () => {
    expect(progressR(longPos, 102.5)).toBe(0.5); // +2.5 on $5 risk
    expect(progressR(longPos, 97.5)).toBe(-0.5); // drifting toward the stop
    expect(progressR(shortPos, 97.5)).toBe(0.5); // a short profits downward
    expect(progressR(shortPos, 102.5)).toBe(-0.5);
  });

  it('is null with no stop, zero risk distance, or a junk price — no guessed R', () => {
    // "No stop" means NEITHER stop is usable. A null current stop alone is not
    // enough while the frozen initial one survives.
    expect(progressR({ ...longPos, stopPrice: null, initialStopPrice: null }, 102)).toBeNull();
    expect(progressR({ ...longPos, stopPrice: 100, initialStopPrice: 100 }, 102)).toBeNull();
    expect(progressR(longPos, NaN)).toBeNull();
    expect(progressR(longPos, 0)).toBeNull();
  });

  // The ratchet moves stopPrice; the risk unit must not move with it. At
  // breakeven the current stop equals the entry, so a current-stop denominator
  // is exactly zero and progress reads null — which made evaluateStagnation
  // answer "unmeasurable" and stop scratching that position for the rest of
  // the day. These pin the denominator to the initial stop.
  it('keeps measuring after the stop has ratcheted to breakeven', () => {
    const ratcheted = { ...longPos, stopPrice: 100 }; // breakeven, initial still 95
    expect(progressR(ratcheted, 102.5)).toBe(0.5);
    expect(progressR(ratcheted, 100)).toBe(0);
  });

  it('does not inflate progress when a trailing stop has tightened', () => {
    // Trailed 95 -> 98. Against the current stop +2.5 would read 1.25R; the
    // true progress on the frozen $5 risk is 0.5R.
    expect(progressR({ ...longPos, stopPrice: 98 }, 102.5)).toBe(0.5);
  });

  it('falls back to the current stop for rows with no initial stop recorded', () => {
    expect(progressR({ ...longPos, initialStopPrice: null }, 102.5)).toBe(0.5);
  });
});

describe('evaluateStagnation after a ratchet', () => {
  it('still scratches a breakeven-ratcheted position that is going nowhere', () => {
    // The regression that mattered: breakeven fires at 0.25R on ~half of
    // trades, and this position would otherwise hold its slot until the
    // end-of-day flatten.
    const ratcheted = { ...longPos, stopPrice: 100 };
    const d = evaluateStagnation(ratcheted, 100.5, cfg, after(90));
    expect(d.progress).toBe(0.1);
    expect(d.triggered).toBe(true);
    expect(d.detail).not.toMatch(/no measurable R progress/);
  });

  it('still spares a ratcheted position that IS working', () => {
    const ratcheted = { ...longPos, stopPrice: 100 };
    expect(evaluateStagnation(ratcheted, 103, cfg, after(90)).triggered).toBe(false);
  });
});

describe('evaluateStagnation', () => {
  it('never triggers while off (0 minutes)', () => {
    const d = evaluateStagnation(longPos, 100, { ...cfg, stagnationExitMinutes: 0 }, after(500));
    expect(d.triggered).toBe(false);
  });

  it('never triggers before the deadline', () => {
    expect(evaluateStagnation(longPos, 100, cfg, after(89)).triggered).toBe(false);
  });

  it('scratches a going-nowhere position at the deadline — including a slow bleeder', () => {
    // Flat at 90 minutes: 0R < 0.5R bar.
    const flat = evaluateStagnation(longPos, 100, cfg, after(90));
    expect(flat).toMatchObject({ triggered: true, heldMinutes: 90, progress: 0 });
    // Drifting down but not yet stopped: recycled before it finds the stop.
    expect(evaluateStagnation(longPos, 98, cfg, after(90)).triggered).toBe(true);
  });

  it('leaves a WORKING position alone — at or above the bar is not stagnant', () => {
    expect(evaluateStagnation(longPos, 102.5, cfg, after(300)).triggered).toBe(false); // exactly the bar
    expect(evaluateStagnation(longPos, 104, cfg, after(300)).triggered).toBe(false);
  });

  it('never scratches a position whose R cannot be measured (no stop at all)', () => {
    // Both stops gone. A null CURRENT stop with a live initial one is still
    // measurable — see the ratchet cases above.
    const d = evaluateStagnation({ ...longPos, stopPrice: null, initialStopPrice: null }, 100, cfg, after(300));
    expect(d.triggered).toBe(false);
    expect(d.detail).toMatch(/no measurable R/);
  });

  it('a zero R bar means "scratch only when not even at breakeven progress"', () => {
    const zeroBar = { stagnationExitMinutes: 90, stagnationExitMinR: 0 };
    expect(evaluateStagnation(longPos, 100, zeroBar, after(90)).triggered).toBe(false); // 0R >= 0R: kept
    expect(evaluateStagnation(longPos, 99.9, zeroBar, after(90)).triggered).toBe(true); // below water: recycled
  });
});

// ---------------------------------------------------------------------------
// Session-minute counting (2026-08-24). Raw elapsed time meant a late entry got
// almost no real market before judgement, and ANY overnight hold arrived at the
// next open already ~1,230 minutes "old" — scratched on the opening print. The
// header comment claimed session gating prevented this; it only ever stopped
// EVALUATION while the market was shut, never the clock.
// ---------------------------------------------------------------------------
describe('sessionMinutesBetween', () => {
  const at = (iso: string) => Date.parse(iso);

  it('counts only minutes inside the regular session', () => {
    // 10:00 -> 11:30 ET, entirely inside the session.
    expect(sessionMinutesBetween(at('2026-08-24T14:00:00Z'), at('2026-08-24T15:30:00Z'))).toBe(90);
  });

  it('ignores after-hours entirely', () => {
    // 15:50 ET -> 20:00 ET: only the 10 minutes before the 16:00 close count.
    expect(sessionMinutesBetween(at('2026-08-24T19:50:00Z'), at('2026-08-25T00:00:00Z'))).toBe(10);
  });

  it('does not let an overnight gap age a position', () => {
    // Monday 15:50 ET -> Tuesday 09:35 ET: 10 minutes Monday + 5 Tuesday = 15,
    // NOT the ~1,065 minutes of wall clock that used to be counted.
    const held = sessionMinutesBetween(at('2026-08-24T19:50:00Z'), at('2026-08-25T13:35:00Z'));
    expect(held).toBe(15);
  });

  it('skips the weekend', () => {
    // Friday 15:00 ET -> Monday 10:00 ET: 60 min Friday + 30 min Monday.
    const held = sessionMinutesBetween(at('2026-08-21T19:00:00Z'), at('2026-08-24T14:00:00Z'));
    expect(held).toBe(90);
  });

  it('accumulates whole sessions across days', () => {
    // Monday 10:00 ET -> Wednesday 10:00 ET: Mon 360 + Tue 390 + Wed 30 = 780.
    expect(sessionMinutesBetween(at('2026-08-24T14:00:00Z'), at('2026-08-26T14:00:00Z'))).toBe(780);
  });

  it('is zero for a span entirely outside the session, and for a reversed one', () => {
    expect(sessionMinutesBetween(at('2026-08-24T01:00:00Z'), at('2026-08-24T05:00:00Z'))).toBe(0);
    expect(sessionMinutesBetween(at('2026-08-24T15:00:00Z'), at('2026-08-24T14:00:00Z'))).toBe(0);
  });
});

describe('evaluateStagnation with session minutes', () => {
  it('does NOT scratch an overnight position on the opening print', () => {
    // Entered 15:50 Monday (10 session minutes), checked 09:35 Tuesday.
    // Wall-clock would read ~1,065 minutes and scratch instantly; session time
    // is 15 minutes, far short of the 90-minute bar.
    const pos = {
      side: 'long' as const,
      entryPrice: 100,
      stopPrice: 95,
      initialStopPrice: 95,
      createdAt: Date.parse('2026-08-24T19:50:00Z'),
    };
    const d = evaluateStagnation(pos, 100, cfg, Date.parse('2026-08-25T13:35:00Z'));
    expect(d.triggered).toBe(false);
    expect(d.heldMinutes).toBe(15);
  });

  it('still scratches once the position has had 90 real minutes of market', () => {
    // Same entry, now checked at 11:10 Tuesday: 10 + 100 = 110 session minutes.
    const pos = {
      side: 'long' as const,
      entryPrice: 100,
      stopPrice: 95,
      initialStopPrice: 95,
      createdAt: Date.parse('2026-08-24T19:50:00Z'),
    };
    const d = evaluateStagnation(pos, 100, cfg, Date.parse('2026-08-25T15:10:00Z'));
    expect(d.triggered).toBe(true);
    expect(d.heldMinutes).toBeGreaterThanOrEqual(90);
  });
});
