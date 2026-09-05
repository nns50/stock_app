import { describe, expect, it } from 'vitest';
import { computeFillDelta, isShortBooked } from '../src/services/trading/fillDelta';

// The shared safety core behind partial-fill handling on all three live paths
// (human reconcile, autotrade equity, autotrade options). Its whole job is to
// resolve every ambiguity toward booking LESS: under-booking is recoverable,
// over-booking invents cost basis that never existed.

const intent = (over: Partial<{ quantity: number; materializedQty: number; materializedNotional: number }> = {}) => ({
  quantity: 100,
  materializedQty: 0,
  materializedNotional: 0,
  ...over,
});

describe('computeFillDelta — a non-positive price is never booked', () => {
  // The vendor docs say filled_price "may be zero or null if the order has not
  // been executed yet", so a broker that advances filled_quantity before
  // filled_price lands reports a real quantity at price 0. Booking that is the
  // worst thing this module can do: an entry at 0 gives the position infinite R
  // and a meaningless cost basis; an exit at 0 books a total loss that never
  // happened. Everything downstream is derived from those.
  const intent = { quantity: 10, materializedQty: 0, materializedNotional: 0 };

  it('refuses a fill reported at price 0', () => {
    const out = computeFillDelta(intent, 10, 0);
    expect(out.qty).toBe(0);
    expect(out.warning).toMatch(/non-positive price/i);
  });

  it('refuses a negative price too', () => {
    expect(computeFillDelta(intent, 10, -5).qty).toBe(0);
  });

  it('still refuses when the price only goes bad on a LATER instalment', () => {
    // First instalment booked normally at 10.00, then the broker reports the
    // running total at an average of 0 — which cannot be explained by the cost
    // already recorded.
    const partly = { quantity: 10, materializedQty: 5, materializedNotional: 50 };
    const out = computeFillDelta(partly, 10, 0);
    expect(out.qty).toBe(0);
    expect(out.warning).toBeTruthy();
  });

  it('books normally at a good price — the guard must not be a blanket refusal', () => {
    const out = computeFillDelta(intent, 10, 12.5);
    expect(out).toMatchObject({ qty: 10, price: 12.5 });
    expect(out.warning).toBeUndefined();
  });
});

describe('computeFillDelta', () => {
  it('books the whole fill when nothing has been booked yet', () => {
    expect(computeFillDelta(intent(), 100, 5)).toMatchObject({ qty: 100, price: 5 });
  });

  it('books nothing when the observed fill is already fully recorded', () => {
    const r = computeFillDelta(intent({ materializedQty: 100, materializedNotional: 500 }), 100, 5);
    expect(r.qty).toBe(0);
    expect(r.warning).toBeUndefined(); // "already up to date", not a problem
  });

  it('prices a later instalment at its OWN price, backed out of the running average', () => {
    // 30 @ 5 booked; broker now reports 90 filled at a 5.6667 running average.
    // The new 60 actually filled at 6 — booking them at the blended average
    // would understate the cost of the second lot and overstate the first.
    const r = computeFillDelta(intent({ materializedQty: 30, materializedNotional: 150 }), 90, (30 * 5 + 60 * 6) / 90);
    expect(r.qty).toBeCloseTo(60);
    expect(r.price).toBeCloseTo(6);
    expect(r.warning).toBeUndefined();
  });

  it('refuses everything when the reported quantity DECREASES', () => {
    // A running total cannot go down. If it does, the field reports each
    // execution separately and differencing is meaningless.
    const r = computeFillDelta(intent({ materializedQty: 70, materializedNotional: 350 }), 20, 5);
    expect(r.qty).toBe(0);
    expect(r.warning).toMatch(/decreased/i);
  });

  it('clamps to the ordered quantity and prices the slice at the reported average', () => {
    // Regression: differencing the FULL observed notional across the CLAMPED
    // quantity inflated the price — 2 units of cost attributed to 1 doubled it.
    const r = computeFillDelta(intent({ quantity: 1 }), 2, 4.1);
    expect(r.qty).toBe(1);
    expect(r.price).toBeCloseTo(4.1); // NOT 8.2
    expect(r.warning).toMatch(/booking only/i);
  });

  it('clamps against what is left, not the whole order', () => {
    const r = computeFillDelta(intent({ quantity: 100, materializedQty: 80, materializedNotional: 400 }), 150, 5);
    expect(r.qty).toBeCloseTo(20);
    expect(r.warning).toMatch(/booking only the 20/);
  });

  it('books nothing when the order is already fully booked and the broker over-reports', () => {
    const r = computeFillDelta(intent({ materializedQty: 100, materializedNotional: 500 }), 150, 5);
    expect(r.qty).toBe(0);
    expect(r.warning).toMatch(/booking only/i);
  });

  it('falls back to the average when the implied incremental price is negative', () => {
    // A running average lower than the already-booked cost implies a negative
    // incremental notional — inconsistent data, not a free lot.
    const r = computeFillDelta(intent({ materializedQty: 30, materializedNotional: 240 }), 60, 2);
    expect(r.qty).toBeCloseTo(30);
    expect(r.price).toBeCloseTo(2);
    expect(r.warning).toMatch(/falling back/i);
  });

  it('treats a zero, negative, or non-finite observed quantity as nothing to do', () => {
    expect(computeFillDelta(intent(), 0, 5).qty).toBe(0);
    expect(computeFillDelta(intent(), -5, 5).qty).toBe(0);
    expect(computeFillDelta(intent(), Number.NaN, 5).qty).toBe(0);
  });

  it('does not warn on a fill that exactly fills the order', () => {
    const r = computeFillDelta(intent({ materializedQty: 40, materializedNotional: 200 }), 100, 5);
    expect(r.qty).toBeCloseTo(60);
    expect(r.warning).toBeUndefined();
  });
});

describe('isShortBooked', () => {
  it('is false when the whole order is reflected', () => {
    expect(isShortBooked({ quantity: 100, materializedQty: 100 })).toBe(false);
  });

  it('is true when the ledger holds less than the order filled', () => {
    expect(isShortBooked({ quantity: 100, materializedQty: 60 })).toBe(true);
  });

  it('tolerates floating-point dust rather than crying wolf', () => {
    expect(isShortBooked({ quantity: 100, materializedQty: 100 - 1e-12 })).toBe(false);
  });
});
