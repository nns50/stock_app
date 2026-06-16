import { describe, it, expect } from 'vitest';
import { Position, PositionExit } from '../src/db/positions';
import {
  computePositionPnl,
  realizedPnlOf,
  computeJournalStats,
  kellySuggestion,
  computeStreaksAndDrawdown,
} from '../src/services/pnl';

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
    checklist: [],
    stopPrice: null,
    targetPrice: null,
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

  it('computes R-multiple from the logged stop (risk = |entry-stop|*qty*mult)', () => {
    const p = makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 90,
      exits: [exit({ quantity: 10, exitPrice: 120 })],
    });
    // risk = 10*10 = 100; realized = (120-100)*10 = 200 -> +2R
    expect(computePositionPnl(p, null).rMultiple).toBe(2);
  });

  it('R-multiple is null without a stop', () => {
    const p = makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      exits: [exit({ quantity: 10, exitPrice: 110 })],
    });
    expect(computePositionPnl(p, null).rMultiple).toBeNull();
  });
});

describe('kellySuggestion', () => {
  it('computes the Kelly fraction and a clamped quarter-Kelly risk %', () => {
    // W=0.6, avgWin=200, avgLoss=-100 -> b=2; f* = 0.6 - 0.4/2 = 0.4
    const k = kellySuggestion(60, 200, -100, 30)!;
    expect(k.payoffRatio).toBe(2);
    expect(k.fraction).toBeCloseTo(0.4);
    // quarter-Kelly = 0.4*0.25*100 = 10% -> clamped to 3
    expect(k.suggestedRiskPct).toBe(3);
    expect(k.reliable).toBe(true);
  });
  it('floors a negative edge at 0% and flags small samples', () => {
    // W=0.4, b=1 -> f* = 0.4 - 0.6 = -0.2 -> suggested 0
    const k = kellySuggestion(40, 100, -100, 8)!;
    expect(k.suggestedRiskPct).toBe(0);
    expect(k.reliable).toBe(false);
  });
  it('returns null without both winners and losers', () => {
    expect(kellySuggestion(100, 100, 0, 5)).toBeNull();
  });
});

describe('computeStreaksAndDrawdown', () => {
  it('tracks max drawdown and win/loss streaks in order', () => {
    // cum: 100, 60, 160, 110, 90 -> peak 160, trough-after-peak 90 -> DD 70
    const r = computeStreaksAndDrawdown([100, -40, 100, -50, -20]);
    expect(r.maxDrawdown).toBe(70);
    expect(r.currentStreak).toEqual({ type: 'loss', count: 2 }); // last two are losses
    expect(r.longestWinStreak).toBe(1);
    expect(r.longestLossStreak).toBe(2);
  });
  it('handles an all-up curve (no drawdown) and a winning streak', () => {
    const r = computeStreaksAndDrawdown([10, 20, 30]);
    expect(r.maxDrawdown).toBe(0);
    expect(r.currentStreak).toEqual({ type: 'win', count: 3 });
    expect(r.longestWinStreak).toBe(3);
  });
  it('is empty-safe', () => {
    expect(computeStreaksAndDrawdown([])).toEqual({
      maxDrawdown: 0,
      currentStreak: { type: 'none', count: 0 },
      longestWinStreak: 0,
      longestLossStreak: 0,
    });
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

  it('breaks P&L down by tag, grade and discipline', () => {
    const ts: Position[] = [
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        grade: 'A',
        tags: ['breakout'],
        checklist: [{ rule: 'r', checked: true }],
        exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-02-01' })],
      }), // +100
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        grade: 'C',
        tags: ['breakout', 'earnings'],
        checklist: [{ rule: 'r', checked: false }],
        exits: [exit({ quantity: 10, exitPrice: 90, exitDate: '2026-02-02' })],
      }), // -100
    ];
    const r = computeJournalStats(ts);
    const breakout = r.byTag.find((g) => g.key === 'breakout')!;
    expect(breakout.trades).toBe(2);
    expect(breakout.totalPnl).toBe(0);
    expect(r.byTag.find((g) => g.key === 'earnings')!.totalPnl).toBe(-100);
    expect(r.byGrade.find((g) => g.key === 'A')!.totalPnl).toBe(100);
    expect(r.byDiscipline.find((g) => g.key === 'Followed all rules')!.totalPnl).toBe(100);
    expect(r.byDiscipline.find((g) => g.key === 'Skipped a rule')!.totalPnl).toBe(-100);
  });

  it('aggregates edge in R over closed trades that logged a stop', () => {
    const ts: Position[] = [
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-03-01' })],
      }), // risk 50, realized +100 -> +2R
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        exits: [exit({ quantity: 10, exitPrice: 95, exitDate: '2026-03-02' })],
      }), // risk 50, realized -50 -> -1R
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        exits: [exit({ quantity: 10, exitPrice: 105, exitDate: '2026-03-03' })],
      }), // no stop -> excluded from R
    ];
    const r = computeJournalStats(ts);
    expect(r.rTrades).toBe(2);
    expect(r.avgR).toBeCloseTo(0.5); // (2 + -1) / 2
    expect(r.bestR).toBe(2);
    expect(r.worstR).toBe(-1);
    const b = Object.fromEntries(r.rBuckets.map((x) => [x.label, x.count]));
    expect(b['≥ 2R']).toBe(1);
    expect(b['-2 to -1R']).toBe(1);
  });

  it('computes Kelly over decisive trades — break-evens do not dilute its win probability', () => {
    const e = (exitPrice: number, exitDate: string) => exit({ quantity: 10, exitPrice, exitDate });
    const ts: Position[] = [
      makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 100, exits: [e(120, '2026-04-01')] }), // +200
      makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 100, exits: [e(120, '2026-04-02')] }), // +200
      makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 100, exits: [e(90, '2026-04-03')] }), // -100
      makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 100, exits: [e(90, '2026-04-04')] }), // -100
      makePosition({ assetType: 'stock', side: 'long', quantity: 10, entryPrice: 100, exits: [e(100, '2026-04-05')] }), // 0 (break-even)
    ];
    const r = computeJournalStats(ts);
    // Displayed win rate counts the break-even in the denominator: 2 / 5 = 40%.
    expect(r.breakeven).toBe(1);
    expect(r.winRate).toBeCloseTo(40, 1);
    // Kelly must use the DECISIVE win rate (2 wins / 4 decisive = 50%), not 40%.
    // b = 200/100 = 2; f* = 0.5 - 0.5/2 = 0.25 (would be 0.1 if break-evens diluted W).
    expect(r.kelly!.payoffRatio).toBe(2);
    expect(r.kelly!.fraction).toBeCloseTo(0.25, 4);
    expect(r.kelly!.sampleSize).toBe(4);
    expect(r.kelly!.suggestedRiskPct).toBe(3); // 0.25 * 0.25 * 100 = 6.25%, clamped to 3
  });
});
