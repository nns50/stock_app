import { describe, it, expect } from 'vitest';
import { Position, PositionExit } from '../src/db/positions';
import { detectWashSale, WASH_SALE_WINDOW_DAYS } from '../src/services/washSale';

let nextId = 1;
function makePosition(
  over: Partial<Position> & Pick<Position, 'side' | 'quantity' | 'entryPrice' | 'entryDate'>,
): Position {
  const exits = (over.exits ?? []) as PositionExit[];
  const closed = exits.reduce((s, e) => s + e.quantity, 0);
  return {
    id: nextId++,
    assetType: 'stock',
    symbol: 'AAPL',
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: closed >= over.quantity ? 'closed' : 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    entryTime: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
    createdAt: 0,
    updatedAt: 0,
    exits,
    remainingQuantity: over.quantity - closed,
    ...over,
  };
}
function exit(over: Partial<PositionExit> & Pick<PositionExit, 'quantity' | 'exitPrice' | 'exitDate'>): PositionExit {
  return {
    id: nextId++,
    positionId: 0,
    fees: 0,
    notes: null,
    sourceIntentId: null,
    exitReason: null,
    createdAt: 0,
    ...over,
  };
}

describe('detectWashSale', () => {
  it('returns null for a still-open position', () => {
    const p = makePosition({ side: 'long', quantity: 10, entryPrice: 100, entryDate: '2026-06-01' });
    expect(detectWashSale(p, [])).toBeNull();
  });

  it('returns null for a closed position with a PROFIT (only losses can be wash-sale disallowed)', () => {
    const p = makePosition({
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-06-05' })], // +100 gain
    });
    const reopened = makePosition({ side: 'long', quantity: 10, entryPrice: 90, entryDate: '2026-06-06' });
    expect(detectWashSale(p, [reopened])).toBeNull();
  });

  it('returns null for a closed LOSS with no nearby same-symbol activity', () => {
    const p = makePosition({
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-05' })], // -100 loss
    });
    const farAway = makePosition({ side: 'long', quantity: 5, entryPrice: 50, entryDate: '2026-08-01' });
    expect(detectWashSale(p, [farAway])).toBeNull();
  });

  it('flags a reopen within 30 days AFTER the loss closed (the classic case)', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-05' })], // closes at a loss on 06-05
    });
    const reopened = makePosition({ id: 2, side: 'long', quantity: 5, entryPrice: 85, entryDate: '2026-06-20' }); // 15 days later
    const warning = detectWashSale(p, [reopened]);
    expect(warning).toMatchObject({ triggerPositionId: 2, triggerEntryDate: '2026-06-20', daysApart: 15 });
  });

  it('flags a replacement bought within 30 days BEFORE the loss closed', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-20' })], // closes at a loss on 06-20
    });
    // A second lot bought 10 days before the loss closed -- still open when it closes.
    const other = makePosition({ id: 2, side: 'long', quantity: 5, entryPrice: 95, entryDate: '2026-06-10' });
    const warning = detectWashSale(p, [other]);
    expect(warning).toMatchObject({ triggerPositionId: 2, triggerEntryDate: '2026-06-10', daysApart: -10 });
  });

  it('is inclusive at exactly the 30-day boundary', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-01' })],
    });
    const atBoundary = makePosition({ id: 2, side: 'long', quantity: 5, entryPrice: 85, entryDate: '2026-07-01' }); // exactly 30 days
    expect(detectWashSale(p, [atBoundary])).not.toBeNull();
    expect(WASH_SALE_WINDOW_DAYS).toBe(30);
  });

  it('excludes a reopen just OUTSIDE the 30-day window (31 days)', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-01' })],
    });
    const justOutside = makePosition({ id: 2, side: 'long', quantity: 5, entryPrice: 85, entryDate: '2026-07-02' }); // 31 days
    expect(detectWashSale(p, [justOutside])).toBeNull();
  });

  it('never matches the position against itself', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-01' })],
    });
    expect(detectWashSale(p, [p])).toBeNull();
  });

  it('matches across instrument types on the same underlying (a stock loss + an option reopen)', () => {
    const stockLoss = makePosition({
      id: 1,
      assetType: 'stock',
      side: 'long',
      quantity: 100,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 100, exitPrice: 90, exitDate: '2026-06-05' })],
    });
    const optionReopen = makePosition({
      id: 2,
      assetType: 'option',
      optionType: 'call',
      strike: 100,
      expiration: '2026-09-18',
      multiplier: 100,
      side: 'long',
      quantity: 1,
      entryPrice: 5,
      entryDate: '2026-06-10',
    });
    const warning = detectWashSale(stockLoss, [optionReopen]);
    expect(warning).toMatchObject({ triggerPositionId: 2, daysApart: 5 });
  });

  it('returns the FIRST matching trigger when multiple same-symbol positions are in the window', () => {
    const p = makePosition({
      id: 1,
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-06-01',
      exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-06-05' })],
    });
    const first = makePosition({ id: 2, side: 'long', quantity: 5, entryPrice: 85, entryDate: '2026-06-10' });
    const second = makePosition({ id: 3, side: 'long', quantity: 5, entryPrice: 80, entryDate: '2026-06-15' });
    expect(detectWashSale(p, [first, second])?.triggerPositionId).toBe(2);
  });
});
