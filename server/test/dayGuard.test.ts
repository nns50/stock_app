import { describe, it, expect } from 'vitest';
import { Position, PositionExit } from '../src/db/positions';
import { computeDayStats } from '../src/services/dayGuard';

let nextId = 1;
function makePosition(
  over: Partial<Position> & Pick<Position, 'side' | 'quantity' | 'entryPrice' | 'entryDate'>,
): Position {
  const exits = (over.exits ?? []) as PositionExit[];
  const closed = exits.reduce((s, e) => s + e.quantity, 0);
  return {
    id: nextId++,
    assetType: 'stock',
    symbol: 'T',
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
    entryTime: null,
    sourceIntentId: null,
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
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

describe('computeDayStats', () => {
  it('counts entries opened today and P&L booked from exits today', () => {
    const positions: Position[] = [
      // opened today, exited today for +90 (net of $10 exit fee): (110-100)*10 - 10
      makePosition({
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-06-17',
        exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-06-17', fees: 10 })],
      }),
      // opened today, still open (counts as an entry, no realized today)
      makePosition({ side: 'long', quantity: 5, entryPrice: 50, entryDate: '2026-06-17' }),
      // opened earlier, partial exit today for -50 on a short: (60-50)*5*-1 = -50
      makePosition({
        side: 'short',
        quantity: 10,
        entryPrice: 50,
        entryDate: '2026-06-10',
        exits: [exit({ quantity: 5, exitPrice: 60, exitDate: '2026-06-17' })],
      }),
      // exit on a different day — excluded entirely
      makePosition({
        side: 'long',
        quantity: 10,
        entryPrice: 20,
        entryDate: '2026-06-10',
        exits: [exit({ quantity: 10, exitPrice: 25, exitDate: '2026-06-16' })],
      }),
    ];
    const d = computeDayStats(positions, '2026-06-17');
    expect(d.entries).toBe(2); // two positions opened on 2026-06-17
    expect(d.exits).toBe(2); // two exit events on 2026-06-17
    expect(d.realizedPnl).toBe(40); // +90 and -50
  });

  it('is zero on a day with no activity', () => {
    const positions: Position[] = [
      makePosition({ side: 'long', quantity: 1, entryPrice: 10, entryDate: '2026-01-01' }),
    ];
    expect(computeDayStats(positions, '2026-06-17')).toEqual({
      date: '2026-06-17',
      realizedPnl: 0,
      exits: 0,
      entries: 0,
    });
  });
});
