import { describe, it, expect } from 'vitest';
import { evaluateStagnation, progressR } from '../src/services/autotrading/stagnationExit';

// Long: entry 100, stop 95 => risk $5/share. Short mirrors it.
const longPos = { side: 'long' as const, entryPrice: 100, stopPrice: 95, createdAt: 0 };
const shortPos = { side: 'short' as const, entryPrice: 100, stopPrice: 105, createdAt: 0 };

const cfg = { stagnationExitMinutes: 90, stagnationExitMinR: 0.5 };
const MIN = 60_000;

describe('progressR', () => {
  it("measures progress against the trade's own risk geometry, both sides", () => {
    expect(progressR(longPos, 102.5)).toBe(0.5); // +2.5 on $5 risk
    expect(progressR(longPos, 97.5)).toBe(-0.5); // drifting toward the stop
    expect(progressR(shortPos, 97.5)).toBe(0.5); // a short profits downward
    expect(progressR(shortPos, 102.5)).toBe(-0.5);
  });

  it('is null with no stop, zero risk distance, or a junk price — no guessed R', () => {
    expect(progressR({ ...longPos, stopPrice: null }, 102)).toBeNull();
    expect(progressR({ ...longPos, stopPrice: 100 }, 102)).toBeNull();
    expect(progressR(longPos, NaN)).toBeNull();
    expect(progressR(longPos, 0)).toBeNull();
  });
});

describe('evaluateStagnation', () => {
  it('never triggers while off (0 minutes)', () => {
    const d = evaluateStagnation(longPos, 100, { ...cfg, stagnationExitMinutes: 0 }, 500 * MIN);
    expect(d.triggered).toBe(false);
  });

  it('never triggers before the deadline', () => {
    expect(evaluateStagnation(longPos, 100, cfg, 89 * MIN).triggered).toBe(false);
  });

  it('scratches a going-nowhere position at the deadline — including a slow bleeder', () => {
    // Flat at 90 minutes: 0R < 0.5R bar.
    const flat = evaluateStagnation(longPos, 100, cfg, 90 * MIN);
    expect(flat).toMatchObject({ triggered: true, heldMinutes: 90, progress: 0 });
    // Drifting down but not yet stopped: recycled before it finds the stop.
    expect(evaluateStagnation(longPos, 98, cfg, 90 * MIN).triggered).toBe(true);
  });

  it('leaves a WORKING position alone — at or above the bar is not stagnant', () => {
    expect(evaluateStagnation(longPos, 102.5, cfg, 300 * MIN).triggered).toBe(false); // exactly the bar
    expect(evaluateStagnation(longPos, 104, cfg, 300 * MIN).triggered).toBe(false);
  });

  it('never scratches a position whose R cannot be measured (no stop)', () => {
    const d = evaluateStagnation({ ...longPos, stopPrice: null }, 100, cfg, 300 * MIN);
    expect(d.triggered).toBe(false);
    expect(d.detail).toMatch(/no measurable R/);
  });

  it('a zero R bar means "scratch only when not even at breakeven progress"', () => {
    const zeroBar = { stagnationExitMinutes: 90, stagnationExitMinR: 0 };
    expect(evaluateStagnation(longPos, 100, zeroBar, 90 * MIN).triggered).toBe(false); // 0R >= 0R: kept
    expect(evaluateStagnation(longPos, 99.9, zeroBar, 90 * MIN).triggered).toBe(true); // below water: recycled
  });
});
