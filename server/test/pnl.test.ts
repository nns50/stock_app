import { describe, it, expect } from 'vitest';
import { Position, PositionExit } from '../src/db/positions';
import { computePositionPnl, realizedPnlOf, computeJournalStats } from '../src/services/pnl';

let nextId = 1;

function makePosition(
  over: Partial<Position> & Pick<Position, 'assetType' | 'side' | 'quantity' | 'entryPrice'>,
): Position {
  const exits = (over.exits ?? []) as PositionExit[];
  const closed = exits.reduce((s, e) => s + e.quantity, 0);
  return {
    id: nextId++,
    symbol: 'T',
    entryDate: '2026-01-01',
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: over.assetType === 'option' ? 100 : 1,
    status: closed >= over.quantity ? 'closed' : 'open',
    tags: [],
    grade: null,
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    exits,
    remainingQuantity: over.quantity - closed,
    ...over,
  };
}

function exit(over: Partial<PositionExit> & Pick<PositionExit, 'quantity' | 'exitPrice'>): PositionExit {
  return {
    id: nextId++,
    positionId: 0,
    exitDate: '2026-02-01',
    fees: 0,
    notes: null,
    createdAt: 0,
    ...over,
  };
}

describe('computePositionPnl', () => {
  it('splits realized/unrealized with proportional entry-fee allocation', () => {
    const p = makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 100,
      entryPrice: 100,
      fees: 10,
      exits: [exit({ quantity: 40, exitPrice: 120, fees: 4 })],
    });
    const pnl = computePositionPnl(p, 130);
    // realized: (120-100)*40 - 4 exitFee - (10*40/100) entryFee = 800 - 4 - 4 = 792
    expect(pnl.realizedPnl).toBe(792);
    // unrealized: (130-100)*60 - (10*60/100) entryFee = 1800 - 6 = 1794
    expect(pnl.unrealizedPnl).toBe(1794);
    expect(pnl.totalPnl).toBe(2586);
    expect(pnl.costBasis).toBe(10000);
    expect(pnl.returnPct).toBeCloseTo(25.86, 2);
    expect(pnl.marketValue).toBe(7800);
  });

  it('handles short positions (profit as price falls)', () => {
    const p = makePosition({ assetType: 'stock', side: 'short', quantity: 10, entryPrice: 50 });
    const pnl = computePositionPnl(p, 45);
    expect(pnl.unrealizedPnl).toBe(50);
    expect(pnl.totalPnl).toBe(50);
  });

  it('applies the 100x multiplier for options', () => {
    const p = makePosition({
      assetType: 'option',
      side: 'long',
      quantity: 2,
      entryPrice: 5,
      optionType: 'call',
      strike: 100,
      expiration: '2026-07-01',
    });
    const pnl = computePositionPnl(p, 8);
    expect(pnl.unrealizedPnl).toBe(600); // (8-5)*2*100
    expect(pnl.costBasis).toBe(1000);
    expect(pnl.returnPct).toBeCloseTo(60);
  });

  it('returns null unrealized when no current price is available', () => {
    const p = makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 20 });
    const pnl = computePositionPnl(p, null);
    expect(pnl.unrealizedPnl).toBeNull();
    expect(pnl.marketValue).toBeNull();
  });
});

describe('realizedPnlOf', () => {
  it('nets a fully-closed trade against entry + all fees', () => {
    const p = makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      fees: 1,
      exits: [exit({ quantity: 10, exitPrice: 110, fees: 1 })],
    });
    expect(realizedPnlOf(p)).toBe(98); // (110-100)*10 - 1 - 1
  });
});

describe('computeJournalStats', () => {
  const trades: Position[] = [
    makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-01-10' })],
    }), // +100
    makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      exits: [exit({ quantity: 10, exitPrice: 96, exitDate: '2026-01-11' })],
    }), // -40
    makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      exits: [exit({ quantity: 10, exitPrice: 106, exitDate: '2026-01-12' })],
    }), // +60
  ];
  const s = computeJournalStats(trades);

  it('computes win rate, expectancy and profit factor', () => {
    expect(s.totalClosed).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(66.67, 1);
    expect(s.expectancy).toBeCloseTo(40); // (100-40+60)/3
    expect(s.profitFactor).toBeCloseTo(4); // 160 / 40
    expect(s.avgWin).toBe(80);
    expect(s.avgLoss).toBe(-40);
  });

  it('builds a cumulative equity curve in date order', () => {
    expect(s.equityCurve.map((p) => p.cumulative)).toEqual([100, 60, 120]);
    expect(s.bestTrade).toBe(100);
    expect(s.worstTrade).toBe(-40);
  });

  it('reports an infinite profit factor (null) when there are no losses', () => {
    const winsOnly = computeJournalStats([trades[0], trades[2]]);
    expect(winsOnly.profitFactor).toBeNull();
  });
});
