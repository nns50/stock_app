import { describe, it, expect } from 'vitest';
import { inferBracketExitReason } from '../src/services/trading/bracketExitReason';

// SWKS, 2026-09-10: 11 shares closed by the broker-truth sync at a quoted
// 83.845 against a ratcheted stop of 83.85 — half a cent above — and booked
// 'manual', so a stop fill entered the journal as a human sale.
const swks = { side: 'long' as const, stopPrice: 83.85, targetPrice: 86.92 };

describe('inferBracketExitReason', () => {
  it('reads the SWKS case as the stop it was', () => {
    const out = inferBracketExitReason(swks, 83.845);
    expect(out.reason).toBe('stop');
    expect(out.detail).toMatch(/at or through the stop/);
  });

  it('attributes a long exit at or through either level', () => {
    expect(inferBracketExitReason(swks, 83.85).reason).toBe('stop'); // exactly on it
    expect(inferBracketExitReason(swks, 83.2).reason).toBe('stop'); // through it
    expect(inferBracketExitReason(swks, 86.92).reason).toBe('target');
    expect(inferBracketExitReason(swks, 87.4).reason).toBe('target');
  });

  it('refuses to attribute a price sitting between the levels', () => {
    // The whole middle of the bracket is where a human sale lands, and calling
    // it a stop would invent the very number the analytics read.
    const out = inferBracketExitReason(swks, 85.0);
    expect(out.reason).toBeNull();
    expect(out.detail).toMatch(/between the stop/);
  });

  it('mirrors the directions for a short', () => {
    const short = { side: 'short' as const, stopPrice: 90, targetPrice: 80 };
    expect(inferBracketExitReason(short, 90.05).reason).toBe('stop'); // stop is ABOVE
    expect(inferBracketExitReason(short, 79.9).reason).toBe('target'); // target is BELOW
    expect(inferBracketExitReason(short, 85).reason).toBeNull();
  });

  it('allows quote drift, but never enough to reach the other level', () => {
    // 0.1% of 83.85 is ~8 cents, so a close miss still reads as the stop...
    expect(inferBracketExitReason(swks, 83.79).reason).toBe('stop');
    // ...while a bracket only a cent wide gets a tolerance capped at 10% of
    // that span, so neither level can swallow the other.
    const tight = { side: 'long' as const, stopPrice: 100.0, targetPrice: 100.01 };
    expect(inferBracketExitReason(tight, 100.005).reason).toBeNull();
  });

  it('returns null rather than guessing when the inputs cannot support an answer', () => {
    expect(inferBracketExitReason({ side: 'long', stopPrice: null, targetPrice: null }, 50).reason).toBeNull();
    expect(inferBracketExitReason(swks, 0).reason).toBeNull();
    expect(inferBracketExitReason(swks, Number.NaN).reason).toBeNull();
  });

  it('works with only one level known', () => {
    const stopOnly = { side: 'long' as const, stopPrice: 83.85, targetPrice: null };
    expect(inferBracketExitReason(stopOnly, 83.845).reason).toBe('stop');
    expect(inferBracketExitReason(stopOnly, 90).reason).toBeNull();
  });

  it('will not pick a side when a degenerate bracket puts both within tolerance', () => {
    const crossed = { side: 'long' as const, stopPrice: 100, targetPrice: 100 };
    const out = inferBracketExitReason(crossed, 100);
    expect(out.reason).toBeNull();
    expect(out.detail).toMatch(/BOTH/);
  });
});
