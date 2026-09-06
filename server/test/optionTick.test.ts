import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPTION_PENNY_THRESHOLD_USD,
  isOnOptionTick,
  optionTickUsd,
  roundOptionPrice,
  tickDirectionForSide,
} from '../src/services/trading/optionTick';
import { buildWebullOptionOrder } from '../src/providers/webull/orders';
import type { OrderIntent } from '../src/services/trading/guardrails';

// ---------------------------------------------------------------------------
// Webull refuses an option order whose price is off the tick grid:
//   "The limit price increment is not correct. Orders placed with a premium of
//    less than $3 must be in increments of 0.05."
// Quoted from our own journal. It is what made the only live options position
// this app has ever taken impossible to close — SRAD, opened 2026-08-03 at a
// 1.05 limit (a nickel by luck), three exits rejected on 08-04, then seventeen
// unmanaged days until the broker sync found it gone and booked -$87 off an
// ESTIMATE. Every price site rounded to the cent, including priceStr(), the
// backstop whose entire job is stopping a tick rejection from reaching the
// broker — it was written for equities, where the cent IS the grid.
// ---------------------------------------------------------------------------

describe('optionTickUsd', () => {
  it('is a nickel below $3 of premium and a penny at or above it', () => {
    expect(optionTickUsd(0.05)).toBe(0.05);
    expect(optionTickUsd(2.99)).toBe(0.05);
    expect(optionTickUsd(OPTION_PENNY_THRESHOLD_USD)).toBe(0.01);
    expect(optionTickUsd(7.5)).toBe(0.01);
  });
});

describe('roundOptionPrice', () => {
  it('snaps the exact prices the paper book has produced onto the grid', () => {
    // Seven of the thirteen options exits the paper book has taken priced off
    // the grid. Each is an order the broker would have refused, on a contract
    // with at most two days left to live.
    const offGrid = [0.73, 1.06, 0.71, 0.89, 0.64, 0.43, 0.23];
    for (const p of offGrid) {
      expect(isOnOptionTick(p), `${p} should be off-grid`).toBe(false);
      expect(isOnOptionTick(roundOptionPrice(p, 'down'))).toBe(true);
      expect(isOnOptionTick(roundOptionPrice(p, 'up'))).toBe(true);
    }
    expect(roundOptionPrice(0.73, 'down')).toBe(0.7);
    expect(roundOptionPrice(0.73, 'up')).toBe(0.75);
    expect(roundOptionPrice(0.23, 'down')).toBe(0.2);
    expect(roundOptionPrice(1.06, 'up')).toBe(1.1);
  });

  it('leaves a price already on the grid exactly alone, both directions', () => {
    // The float trap: 0.70 arrives as 0.7000000000000001 as readily as
    // 0.6999999999999, and a naive ceil moves it a whole tick every time.
    for (const p of [0.05, 0.1, 0.35, 0.7, 1.05, 2.95]) {
      expect(roundOptionPrice(p, 'up'), `up ${p}`).toBe(p);
      expect(roundOptionPrice(p, 'down'), `down ${p}`).toBe(p);
    }
    // 1.05 is the SRAD entry — accepted by the broker, and it must stay 1.05.
    expect(roundOptionPrice(1.05, 'up')).toBe(1.05);
  });

  it('always moves toward filling, never away from it', () => {
    // The direction is the whole safety argument: snapping to the grid may
    // only make an order MORE marketable, so a close can never be made less
    // likely to fill by the rounding that makes it placeable at all.
    for (const p of [0.23, 0.64, 0.71, 0.89, 1.06, 2.97]) {
      expect(roundOptionPrice(p, 'up')).toBeGreaterThanOrEqual(p);
      expect(roundOptionPrice(p, 'down')).toBeLessThanOrEqual(p);
      expect(roundOptionPrice(p, 'up') - roundOptionPrice(p, 'down')).toBeCloseTo(0.05, 10);
    }
  });

  it('uses the penny grid at or above $3 and crosses the boundary cleanly', () => {
    expect(roundOptionPrice(3.47, 'down')).toBe(3.47);
    // 2.99 rounded up lands on 3.00, which is valid on either grid.
    expect(roundOptionPrice(2.99, 'up')).toBe(3);
    expect(roundOptionPrice(2.99, 'down')).toBe(2.95);
  });

  it('is plain nearest-cent rounding above $3 — direction must not move it', () => {
    // Stage one is float hygiene, not a price decision. Above $3 the cent IS
    // the grid, so this function has to be byte-identical to the cent rounding
    // it replaces; the existing webullOrders backstop tests (98.14816 ->
    // '98.15') are asserting exactly that and must keep passing.
    for (const p of [3.474, 98.14816, 103.70368, 4.005]) {
      const nearest = Math.round(p * 100) / 100;
      expect(roundOptionPrice(p, 'up'), `up ${p}`).toBe(nearest);
      expect(roundOptionPrice(p, 'down'), `down ${p}`).toBe(nearest);
    }
  });

  it('strips sub-cent noise before the nickel snap, so noise cannot cost a tick', () => {
    // 0.7000001 is 0.70, not "just above 0.70" — rounding that up to 0.75
    // would pay a whole tick for a float artifact.
    expect(roundOptionPrice(0.7000001, 'up')).toBe(0.7);
    expect(roundOptionPrice(0.6999999, 'down')).toBe(0.7);
  });

  it('rounds a near-worthless mark down to zero rather than off the grid', () => {
    // The nickel is the floor: a contract marking at 0.03 cannot be sold at
    // all. The caller's validPremium() guard is what turns this into a
    // journaled skip instead of an order the broker refuses every cycle.
    expect(roundOptionPrice(0.03, 'down')).toBe(0);
    expect(roundOptionPrice(0.024, 'down')).toBe(0);
  });

  it('keeps a mark just under a nickel placeable instead of zeroing it', () => {
    // Stage one lands 0.049 on 0.05, which is already on the grid, so the
    // directional step has nothing to do. The tenth of a cent this costs a
    // seller is the difference between an order and no order at all.
    expect(roundOptionPrice(0.049, 'down')).toBe(0.05);
  });

  it('passes a non-finite price through for the premium guard to reject', () => {
    expect(roundOptionPrice(NaN, 'up')).toBeNaN();
    expect(roundOptionPrice(Infinity, 'down')).toBe(Infinity);
  });
});

describe('tickDirectionForSide', () => {
  it('rounds a buy up and a sell down', () => {
    expect(tickDirectionForSide('buy')).toBe('up');
    expect(tickDirectionForSide('sell')).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// Assert at the CONSUMER (CLAUDE.md): the pure function above proves nothing
// about the body that actually reaches Webull. These drive the real builder.
// ---------------------------------------------------------------------------
const singleLeg = (side: 'buy' | 'sell', limitPrice: number): OrderIntent => ({
  symbol: 'SRAD',
  assetKind: 'option',
  side,
  openClose: side === 'buy' ? 'open' : 'close',
  quantity: 1,
  orderType: 'limit',
  limitPrice,
  optionType: 'call',
  strike: 20,
  expiration: '2026-09-08',
});

const vertical = (side: 'buy' | 'sell', limitPrice: number): OrderIntent => ({
  ...singleLeg(side, limitPrice),
  optionStrategy: 'VERTICAL',
  optionLegs: [
    { side: 'buy', optionType: 'call', strike: 20, expiration: '2026-09-08' },
    { side: 'sell', optionType: 'call', strike: 22, expiration: '2026-09-08' },
  ],
});

describe('the option order body Webull actually receives', () => {
  it('sends a single-leg SELL close on the nickel grid, rounded down', () => {
    // The SRAD exit, as it was: three rejections at a cent-grid price.
    const body = buildWebullOptionOrder(singleLeg('sell', 0.13), 'cid');
    expect(body.limit_price).toBe('0.1');
    expect(isOnOptionTick(Number(body.limit_price))).toBe(true);
  });

  it('sends a single-leg BUY open on the nickel grid, rounded up', () => {
    const body = buildWebullOptionOrder(singleLeg('buy', 0.93), 'cid');
    expect(body.limit_price).toBe('0.95');
  });

  it('rounds a spread NET price too, in the order-level direction', () => {
    expect(buildWebullOptionOrder(vertical('buy', 0.73), 'cid').limit_price).toBe('0.75');
    expect(buildWebullOptionOrder(vertical('sell', 0.73), 'cid').limit_price).toBe('0.7');
  });

  it('leaves an on-grid price untouched, so a good order is not re-priced', () => {
    expect(buildWebullOptionOrder(singleLeg('buy', 1.05), 'cid').limit_price).toBe('1.05');
    expect(buildWebullOptionOrder(singleLeg('sell', 0.5), 'cid').limit_price).toBe('0.5');
  });

  it('still uses the penny grid above $3, where the nickel would be a real concession', () => {
    expect(buildWebullOptionOrder(singleLeg('buy', 4.37), 'cid').limit_price).toBe('4.37');
  });
});

// ---------------------------------------------------------------------------
// A source scan, in the spirit of effectiveRisk.test.ts. The builder backstop
// above cannot stop a live path computing its own cent-rounded option price and
// carrying it into a guardrail check — the notional cap would then be checked
// against a price the broker never sees. This is the guard against that.
// ---------------------------------------------------------------------------
describe('no live options price site rounds to the cent by hand', () => {
  it('liveOptionsExecute derives every limit through roundOptionPrice', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'liveOptionsExecute.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    // The exact shape all four sites carried: a cent-grid round assigned to a limit.
    expect(code).not.toMatch(/limitPrice\s*=\s*Math\.round\([^)]*\*\s*100\)\s*\/\s*100/);
    expect(code.match(/roundOptionPrice\(/g) ?? []).toHaveLength(4);
  });
});
