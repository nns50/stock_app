import { describe, it, expect } from 'vitest';
import { computeScaleIn, ScaleInState, ScaleInConfig } from '../src/services/autotrading/scaleIn';

const ON: ScaleInConfig = { addOnTriggerRMultiple: 1, addOnSizePct: 50, maxAddOns: 2 };

function longState(over: Partial<ScaleInState> = {}): ScaleInState {
  return { side: 'buy', entryPrice: 100, initialStopPrice: 90, stopPrice: 90, quantity: 100, addOnsTaken: 0, ...over };
}

describe('computeScaleIn — gating', () => {
  it('is off when the trigger, size, or cap is zero', () => {
    expect(computeScaleIn(longState(), 110, { ...ON, addOnTriggerRMultiple: 0 })).toBeNull();
    expect(computeScaleIn(longState(), 110, { ...ON, addOnSizePct: 0 })).toBeNull();
    expect(computeScaleIn(longState(), 110, { ...ON, maxAddOns: 0 })).toBeNull();
  });

  it('does not fire below the trigger R-multiple', () => {
    // 105 is only +0.5R against a 10-wide initial stop
    expect(computeScaleIn(longState(), 105, ON)).toBeNull();
  });

  it('stops once maxAddOns is reached', () => {
    expect(computeScaleIn(longState({ addOnsTaken: 2 }), 130, ON)).toBeNull();
  });

  it('skips a degenerate (zero-width) initial stop', () => {
    expect(computeScaleIn(longState({ initialStopPrice: 100 }), 110, ON)).toBeNull();
  });

  it('skips when the add rounds to zero shares', () => {
    // 1 share × 50% floors to 0
    expect(computeScaleIn(longState({ quantity: 1 }), 110, ON)).toBeNull();
  });
});

describe('computeScaleIn — long', () => {
  it('blends the entry, preserves the R denominator, and raises the stop', () => {
    // entry 100, stop 90 (10 wide). At 110 (=+1R), add 50% of 100 = 50 shares.
    const r = computeScaleIn(longState(), 110, ON)!;
    expect(r.addQty).toBe(50);
    expect(r.newQuantity).toBe(150);
    // blended = (100*100 + 110*50)/150 = 15500/150 = 103.333…
    expect(r.blendedEntry).toBeCloseTo(103.3333, 3);
    // initial stop shifts up by the same delta, keeping |entry − initialStop| = 10
    expect(r.blendedEntry - r.newInitialStopPrice).toBeCloseTo(10, 6);
    // protective stop raised to 1R below blended entry (≈93.33), above the old 90
    expect(r.newStopPrice).toBeCloseTo(93.3333, 3);
    expect(r.newStopPrice).toBeGreaterThan(90);
  });

  it('never loosens an already-trailed stop', () => {
    // stop already trailed up to 108; the 1R-below-blended candidate (~93) is worse, so keep 108
    const r = computeScaleIn(longState({ stopPrice: 108 }), 110, ON)!;
    expect(r.newStopPrice).toBe(108);
  });

  it('after an add the instantaneous R-multiple drops back below the trigger', () => {
    const r = computeScaleIn(longState(), 110, ON)!;
    // from the blended entry, price 110 is only (110-103.33)/10 ≈ 0.667R — not another trigger
    const rmFromBlended = (110 - r.blendedEntry) / (r.blendedEntry - r.newInitialStopPrice);
    expect(rmFromBlended).toBeLessThan(ON.addOnTriggerRMultiple);
  });
});

describe('computeScaleIn — short', () => {
  it('blends down, preserves risk, and tightens the stop downward', () => {
    // short entry 100, initial stop 110 (10 wide). At 90 (=+1R), add 50% of 100 = 50.
    const state: ScaleInState = {
      side: 'sell',
      entryPrice: 100,
      initialStopPrice: 110,
      stopPrice: 110,
      quantity: 100,
      addOnsTaken: 0,
    };
    const r = computeScaleIn(state, 90, ON)!;
    expect(r.addQty).toBe(50);
    // blended = (100*100 + 90*50)/150 = 14500/150 = 96.666…
    expect(r.blendedEntry).toBeCloseTo(96.6667, 3);
    // risk preserved: initialStop − entry stays 10
    expect(r.newInitialStopPrice - r.blendedEntry).toBeCloseTo(10, 6);
    // protective stop lowered to 1R above blended (~106.67), below the old 110
    expect(r.newStopPrice).toBeCloseTo(106.6667, 3);
    expect(r.newStopPrice).toBeLessThan(110);
  });
});
