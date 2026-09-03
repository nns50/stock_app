import { describe, it, expect } from 'vitest';
import { evaluateScaleOut } from '../src/services/autotrading/scaleOut';
import type { PositionExit } from '../src/db/positions';

const cfg = { liveScaleOutEnabled: true, partialExitRMultiple: 1.5, partialExitPct: 50 };

/** Long: entry 100, stop 96 => $4 of risk per share. */
const long = (over: Partial<Parameters<typeof evaluateScaleOut>[0]> = {}) => ({
  side: 'long' as const,
  entryPrice: 100,
  stopPrice: 96,
  initialStopPrice: 96,
  quantity: 10,
  remainingQuantity: 10,
  exits: [] as PositionExit[],
  ...over,
});

const anExit = () => [{ quantity: 5 } as PositionExit];

describe('evaluateScaleOut', () => {
  it('banks half at the R trigger', () => {
    // +6 on $4 of risk = 1.5R exactly.
    const d = evaluateScaleOut(long(), 106, cfg);
    expect(d).toMatchObject({ triggered: true, quantity: 5, rMultiple: 1.5 });
  });

  // The loop ratchets stops BEFORE it scales out. Once breakeven fires, the
  // CURRENT stop sits at the entry price — so measuring R against it divides by
  // zero and kills the scale-out for the life of the position. These three
  // pin the denominator to the INITIAL stop, which is what stopAdjust.ts uses.
  it('still banks after the stop has ratcheted to breakeven', () => {
    const ratcheted = long({ stopPrice: 100 }); // breakeven: stop === entry
    expect(evaluateScaleOut(ratcheted, 106, cfg)).toMatchObject({
      triggered: true,
      quantity: 5,
      rMultiple: 1.5,
    });
  });

  it('does not inflate R when a trailing stop has tightened', () => {
    // Stop trailed 96 -> 98. Against the current stop the move would read 4R
    // and fire early; against the initial stop it is the true 1.5R.
    const trailed = long({ stopPrice: 98 });
    expect(evaluateScaleOut(trailed, 106, cfg).rMultiple).toBe(1.5);
    expect(evaluateScaleOut(trailed, 105.9, cfg).triggered).toBe(false);
  });

  it('falls back to the current stop when no initial stop was recorded', () => {
    // Legacy/imported rows predate initialStopPrice; they must still work.
    const legacy = long({ initialStopPrice: null });
    expect(evaluateScaleOut(legacy, 106, cfg)).toMatchObject({ triggered: true, rMultiple: 1.5 });
    expect(evaluateScaleOut(long({ stopPrice: null, initialStopPrice: null }), 106, cfg)).toMatchObject({
      triggered: false,
    });
  });

  it('does nothing below the trigger', () => {
    expect(evaluateScaleOut(long(), 105.9, cfg).triggered).toBe(false);
    expect(evaluateScaleOut(long(), 100, cfg).triggered).toBe(false);
    expect(evaluateScaleOut(long(), 94, cfg).triggered).toBe(false); // losing
  });

  it('mirrors for a short', () => {
    const short = long({ side: 'short', stopPrice: 104, initialStopPrice: 104 });
    expect(evaluateScaleOut(short, 94, cfg)).toMatchObject({ triggered: true, quantity: 5, rMultiple: 1.5 });
    expect(evaluateScaleOut(short, 106, cfg).triggered).toBe(false); // wrong way
  });

  it('is off unless liveScaleOutEnabled — partialExitRMultiple alone must not arm it', () => {
    // That value has been 1.5 in production since the paper-only version, so
    // reusing it as the switch would have armed live scale-outs on deploy.
    const d = evaluateScaleOut(long(), 106, { ...cfg, liveScaleOutEnabled: false });
    expect(d.triggered).toBe(false);
    expect(d.detail).toMatch(/off/);
  });

  it('fires ONCE per position — an open position with an exit already scaled out', () => {
    const d = evaluateScaleOut(long({ exits: anExit(), remainingQuantity: 5 }), 106, cfg);
    expect(d.triggered).toBe(false);
    expect(d.detail).toMatch(/already scaled out/);
  });

  it('never scales out a position with no measurable R', () => {
    // Unmeasurable means NEITHER stop is usable, or the price is degenerate.
    // A current stop of null or entry-price is NOT unmeasurable while an
    // initial stop survives — that is the ratcheted case, covered above, and
    // this assertion used to encode the bug by demanding false for it.
    expect(evaluateScaleOut(long({ stopPrice: null, initialStopPrice: null }), 106, cfg).triggered).toBe(false);
    expect(evaluateScaleOut(long({ stopPrice: 100, initialStopPrice: 100 }), 106, cfg).triggered).toBe(false);
    expect(evaluateScaleOut(long(), 0, cfg).triggered).toBe(false);
    expect(evaluateScaleOut(long(), NaN, cfg).triggered).toBe(false);
  });

  it('refuses to round a scale-out into a full exit', () => {
    // 50% of 1 share floors to 0 — retried later, never rounded up to 1, which
    // would close the whole position through a path that resizes the bracket
    // instead of cancelling it.
    const one = evaluateScaleOut(long({ quantity: 1, remainingQuantity: 1 }), 106, cfg);
    expect(one.triggered).toBe(false);
    expect(one.quantity).toBe(0);

    const all = evaluateScaleOut(long(), 106, { ...cfg, partialExitPct: 100 });
    expect(all.triggered).toBe(false);
    expect(all.detail).toMatch(/between 0 and 100/);
  });

  it('always leaves a remainder running', () => {
    // Whatever the percentage, the kept side must be non-zero — the resting
    // bracket is RESIZED to it, so a zero remainder would leave an order for
    // nothing against a closed position.
    for (const pctVal of [10, 25, 50, 75, 90, 99]) {
      for (const qty of [2, 3, 7, 10, 33]) {
        const d = evaluateScaleOut(long({ quantity: qty, remainingQuantity: qty }), 106, {
          ...cfg,
          partialExitPct: pctVal,
        });
        if (d.triggered) {
          expect(d.quantity).toBeGreaterThan(0);
          expect(qty - d.quantity).toBeGreaterThan(0);
        }
      }
    }
  });

  it('reports the R it measured even when it does not fire, for the journal', () => {
    const d = evaluateScaleOut(long(), 104, cfg); // +1R, under the 1.5R bar
    expect(d.rMultiple).toBe(1);
    expect(d.detail).toMatch(/under the 1.5R/);
  });
});
