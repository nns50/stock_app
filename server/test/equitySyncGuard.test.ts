import { describe, it, expect } from 'vitest';
import {
  evaluateEquitySync,
  freshEquityGuardState,
  EQUITY_GUARD_CONFIRMATIONS,
} from '../src/services/autotrading/equitySyncGuard';

// The numbers below are the real 2026-08-27 session: a ~$2,230 account holding
// one position (SMCI, 32 shares, ~$1,220) that moved cents, while the broker
// reported net liquidation anywhere from $1,907.21 to $2,316.71.
const PREV = 2_234.58; // last good reading, 14:12
const SPIKE = 2_444.7; // the 14:16 reading that banked the day at +9.69%
const GUARD = 5;

/** Feed a sequence of readings through the guard, threading its state. */
function run(readings: number[], previous = PREV, maxJumpPct = GUARD) {
  let state = freshEquityGuardState();
  let accepted = previous;
  return readings.map((r) => {
    const d = evaluateEquitySync(r, accepted, maxJumpPct, state);
    state = d.state;
    if (d.accept) accepted = r;
    return { reading: r, accept: d.accept, accepted, reason: d.reason };
  });
}

describe('evaluateEquitySync', () => {
  it('rejects the reading that actually banked a fictional day', () => {
    const d = evaluateEquitySync(SPIKE, PREV, GUARD, freshEquityGuardState());
    expect(d.accept).toBe(false);
    expect(d.jumpPct).toBeCloseTo(9.4, 1);
    expect(d.reason).toMatch(/exceeds the 5% guard/);
  });

  it('passes ordinary mark-to-market drift untouched, and journals nothing', () => {
    // The common case by far — it must not log, or the feed fills with noise.
    for (const r of [2_235.54, 2_229.14, 2_242.58, 2_290.0]) {
      const d = evaluateEquitySync(r, PREV, GUARD, freshEquityGuardState());
      expect(d.accept).toBe(true);
      expect(d.reason).toBeNull();
    }
  });

  it('holds the accepted equity in a sane band through the real 14:32-14:39 burst', () => {
    // The actual sequence that session. NOT all of it is out of band — the
    // $2,230-ish prints sit within 0.2% of the last good value and are
    // rightly taken. What matters is that the wild ones never move the number
    // the rest of the system sizes and banks off: unguarded, this walked
    // equity down to $1,907 and up to $2,444.
    const out = run([1_938.07, 2_230.79, 1_917.71, 2_231.11, 2_040.51, 2_444.7]);

    expect(out.map((o) => o.accept)).toEqual([false, true, false, true, false, false]);
    for (const o of out) {
      expect(Math.abs((o.accepted - PREV) / PREV) * 100).toBeLessThanOrEqual(GUARD);
    }
    // Specifically: the reading that banked the day never lands.
    expect(out.at(-1)!.accepted).not.toBe(SPIKE);
  });

  it('accepts a sustained move — a deposit is not a glitch', () => {
    // A guard with no way to accept a real balance change would freeze equity
    // at a stale value forever. Three consecutive readings near the new level.
    const out = run([3_500, 3_505, 3_499]);
    expect(out.map((o) => o.accept)).toEqual([false, false, true]);
    expect(out.at(-1)!.accepted).toBe(3_499);
    expect(out.at(-1)!.reason).toMatch(/sustained/);
  });

  it('needs the readings to agree with EACH OTHER, not merely to be out of band', () => {
    // Three wild readings in a row must NOT add up to a confirmation.
    const out = run([1_900, 2_600, 1_950, 2_700]);
    expect(out.every((o) => !o.accept)).toBe(true);
  });

  it('abandons a half-corroborated outlier the moment the feed comes back in band', () => {
    // Two readings near $3,500, then a normal one: the pending level is
    // dropped, so a later single $3,500 print starts from scratch.
    const out = run([3_500, 3_505, 2_240, 3_500]);
    expect(out.map((o) => o.accept)).toEqual([false, false, true, false]);
  });

  it('takes the first sync of all on trust — there is nothing to compare to', () => {
    const d = evaluateEquitySync(2_234.58, null, GUARD, freshEquityGuardState());
    expect(d).toMatchObject({ accept: true, reason: null, jumpPct: null });
  });

  it('is disabled by 0, restoring write-whatever-arrives', () => {
    const d = evaluateEquitySync(SPIKE, PREV, 0, freshEquityGuardState());
    expect(d).toMatchObject({ accept: true, reason: null });
  });

  it('is symmetric — a crash is as suspect as a spike', () => {
    expect(evaluateEquitySync(1_200, PREV, GUARD, freshEquityGuardState()).accept).toBe(false);
  });

  it('confirms in exactly EQUITY_GUARD_CONFIRMATIONS readings', () => {
    const out = run(Array.from({ length: EQUITY_GUARD_CONFIRMATIONS }, () => 3_500));
    expect(out.filter((o) => !o.accept)).toHaveLength(EQUITY_GUARD_CONFIRMATIONS - 1);
    expect(out.at(-1)!.accept).toBe(true);
  });
});
