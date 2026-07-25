import { describe, expect, it } from 'vitest';
import {
  PIN_RISK_BAND,
  classifyExpiredOptions,
  findExpiredOpenOptions,
  intrinsicAt,
  optionLabel,
} from '../src/services/expiredOptions';
import type { Position } from '../src/db/positions';

// An option held THROUGH expiry never produces a closing order, so nothing ever
// records an exit and the position sits `open` forever — inflating exposure,
// open-risk caps, position counts, and unrealized P&L with a contract that has
// not existed since expiry. These pin what the sweep may and may not conclude.

const option = (over: Partial<Position> = {}): Position =>
  ({
    id: 1,
    symbol: 'AAPL',
    assetType: 'option',
    status: 'open',
    side: 'long',
    quantity: 2,
    remainingQuantity: 2,
    entryPrice: 3,
    entryDate: '2026-06-01',
    optionType: 'call',
    strike: 200,
    expiration: '2026-07-17',
    multiplier: 100,
    tags: [],
    exits: [],
    ...over,
  }) as Position;

describe('findExpiredOpenOptions', () => {
  it('finds an open option whose expiry has passed', () => {
    expect(findExpiredOpenOptions([option()], '2026-07-20')).toHaveLength(1);
  });

  it('leaves a position alone ON its expiration day — it is still tradeable', () => {
    // Sweeping here would close something that can still be sold, exercised, or
    // covered by a real closing order later the same session.
    expect(findExpiredOpenOptions([option()], '2026-07-17')).toHaveLength(0);
  });

  it('ignores stock, closed, and fully-exited positions', () => {
    const rows = [
      option({ id: 2, assetType: 'stock' }),
      option({ id: 3, status: 'closed' }),
      option({ id: 4, remainingQuantity: 0 }),
      option({ id: 5, expiration: null }),
    ];
    expect(findExpiredOpenOptions(rows, '2026-07-20')).toHaveLength(0);
  });
});

describe('intrinsicAt', () => {
  it('values calls and puts at settlement', () => {
    expect(intrinsicAt('call', 200, 210)).toBe(10);
    expect(intrinsicAt('call', 200, 190)).toBe(0);
    expect(intrinsicAt('put', 200, 190)).toBe(10);
    expect(intrinsicAt('put', 200, 210)).toBe(0);
  });
});

describe('classifyExpiredOptions', () => {
  const at = (price: number | null) => () => price;

  it('calls a clearly out-of-the-money call worthless', () => {
    const [f] = classifyExpiredOptions([option()], at(150));
    expect(f.disposition).toBe('worthless');
    expect(f.intrinsic).toBe(0);
    expect(f.underlyingAtExpiry).toBe(150);
  });

  it('calls a clearly out-of-the-money put worthless', () => {
    const [f] = classifyExpiredOptions([option({ optionType: 'put', strike: 100 })], at(150));
    expect(f.disposition).toBe('worthless');
  });

  it('flags an in-the-money option instead of closing it', () => {
    // It was exercised or assigned, which creates or removes a STOCK position
    // this app doesn't model. A cash exit would misstate both.
    const [f] = classifyExpiredOptions([option()], at(250));
    expect(f.disposition).toBe('in_the_money');
    expect(f.intrinsic).toBe(50);
    expect(f.reason).toMatch(/exercised/);
  });

  it('says "assigned" rather than "exercised" for a short position', () => {
    const [f] = classifyExpiredOptions([option({ side: 'short' })], at(250));
    expect(f.reason).toMatch(/assigned/);
  });

  it('refuses to call a near-the-strike option worthless (pin risk)', () => {
    // Just barely OTM: intrinsically zero, but an option this close can still
    // be exercised, and the settlement print can differ from this close.
    const nearMiss = 200 - 200 * (PIN_RISK_BAND / 2);
    const [f] = classifyExpiredOptions([option()], at(nearMiss));
    expect(f.disposition).toBe('unknown');
    expect(f.reason).toMatch(/too close to call/i);
  });

  it('does call it worthless once clear of the pin-risk band', () => {
    const clear = 200 - 200 * PIN_RISK_BAND * 2;
    expect(classifyExpiredOptions([option()], at(clear))[0].disposition).toBe('worthless');
  });

  it('flags rather than assumes when no price can be resolved', () => {
    // The dangerous default would be treating a missing price as worthless —
    // that silently writes a realized loss that may never have happened.
    const [f] = classifyExpiredOptions([option()], at(null));
    expect(f.disposition).toBe('unknown');
    expect(f.underlyingAtExpiry).toBeNull();
    expect(f.reason).toMatch(/no usable/i);
  });

  it('flags a zero or non-finite price rather than treating it as a real close', () => {
    expect(classifyExpiredOptions([option()], at(0))[0].disposition).toBe('unknown');
    expect(classifyExpiredOptions([option()], at(Number.NaN))[0].disposition).toBe('unknown');
  });

  it('flags a position missing its strike or option type', () => {
    expect(classifyExpiredOptions([option({ strike: null })], at(150))[0].disposition).toBe('unknown');
    expect(classifyExpiredOptions([option({ optionType: null })], at(150))[0].disposition).toBe('unknown');
  });

  it('carries the quantity to close and a readable label', () => {
    const [f] = classifyExpiredOptions([option({ remainingQuantity: 3 })], at(150));
    expect(f.remainingQuantity).toBe(3);
    expect(f.label).toBe('AAPL 200C 2026-07-17');
  });
});

describe('optionLabel', () => {
  it('renders calls and puts', () => {
    expect(optionLabel(option())).toBe('AAPL 200C 2026-07-17');
    expect(optionLabel(option({ optionType: 'put', strike: 90 }))).toBe('AAPL 90P 2026-07-17');
  });
});
