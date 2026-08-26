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
    entryTime: null,
    sourceIntentId: null,
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
    initialStopPrice: null,
    bestPriceSinceEntry: null,
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
    sourceIntentId: null,
    exitReason: null,
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
    expect(r.currentDrawdown).toBe(70); // still 70 below the 160 peak at the end
    expect(r.currentStreak).toEqual({ type: 'loss', count: 2 }); // last two are losses
    expect(r.longestWinStreak).toBe(1);
    expect(r.longestLossStreak).toBe(2);
  });
  it('reports zero current drawdown when the last trade sets a new equity high', () => {
    // cum: 100, 60, 160 -> peak 160, ends at the peak
    const r = computeStreaksAndDrawdown([100, -40, 100]);
    expect(r.maxDrawdown).toBe(40);
    expect(r.currentDrawdown).toBe(0);
  });
  it('handles an all-up curve (no drawdown) and a winning streak', () => {
    const r = computeStreaksAndDrawdown([10, 20, 30]);
    expect(r.maxDrawdown).toBe(0);
    expect(r.currentDrawdown).toBe(0);
    expect(r.currentStreak).toEqual({ type: 'win', count: 3 });
    expect(r.longestWinStreak).toBe(3);
  });
  it('is empty-safe', () => {
    expect(computeStreaksAndDrawdown([])).toEqual({
      maxDrawdown: 0,
      currentDrawdown: 0,
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

  it('buckets realized P&L by entry session, only for trades with a logged time', () => {
    const t = computeJournalStats([
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryTime: '09:45', // Open
        exits: [exit({ quantity: 10, exitPrice: 110 })],
      }), // +100
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryTime: '15:30', // Power hr
        exits: [exit({ quantity: 10, exitPrice: 95 })],
      }), // -50
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        // no entryTime → excluded from the session breakdown
        exits: [exit({ quantity: 10, exitPrice: 105 })],
      }),
    ]);
    const by = Object.fromEntries(t.byTimeOfDay.map((g) => [g.key, g.totalPnl]));
    expect(by['Open']).toBe(100);
    expect(by['Power hr']).toBe(-50);
    expect(t.byTimeOfDay.reduce((n, g) => n + g.trades, 0)).toBe(2); // the timeless trade is excluded
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

  it('computes profit factor and avg R within each tag group', () => {
    const ts: Position[] = [
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        tags: ['breakout'],
        exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-03-01' })],
      }), // risk 50, +100 -> +2R
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        tags: ['breakout'],
        exits: [exit({ quantity: 10, exitPrice: 95, exitDate: '2026-03-02' })],
      }), // risk 50, -50 -> -1R
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        tags: ['breakout', 'earnings'],
        exits: [exit({ quantity: 10, exitPrice: 105, exitDate: '2026-03-03' })],
      }), // no stop -> +50, excluded from R
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95,
        tags: ['earnings'],
        exits: [exit({ quantity: 10, exitPrice: 120, exitDate: '2026-03-04' })],
      }), // risk 50, +200 -> +4R
    ];
    const r = computeJournalStats(ts);

    const breakout = r.byTag.find((g) => g.key === 'breakout')!;
    expect(breakout.trades).toBe(3);
    expect(breakout.profitFactor).toBeCloseTo(3); // 150 gross profit / 50 gross loss
    expect(breakout.avgR).toBeCloseTo(0.5); // only the 2 stopped trades count: (2 + -1) / 2

    // all-winners group -> infinite profit factor (null), same convention as the headline stat
    const earnings = r.byTag.find((g) => g.key === 'earnings')!;
    expect(earnings.trades).toBe(2);
    expect(earnings.profitFactor).toBeNull();
    expect(earnings.avgR).toBeCloseTo(4); // only 1 of its 2 trades logged a stop
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

  it('computes R std-dev and the System Quality Number', () => {
    const mk = (exitPrice: number, exitDate: string) =>
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        stopPrice: 95, // risk = 50
        exits: [exit({ quantity: 10, exitPrice, exitDate })],
      });
    // R = [+2, +2, -1]; mean 1, sample stdev = √3 ≈ 1.73, SQN = (1/√3)·√3 = 1.
    const r = computeJournalStats([mk(110, '2026-05-01'), mk(110, '2026-05-02'), mk(95, '2026-05-03')]);
    expect(r.rTrades).toBe(3);
    expect(r.avgR).toBeCloseTo(1, 4);
    expect(r.stdevR).toBeCloseTo(1.73, 2);
    expect(r.sqn).toBeCloseTo(1, 2);
  });

  it('computes a trailing rolling expectancy (and stays empty below the floor)', () => {
    const mk = (exitPrice: number, exitDate: string) =>
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        exits: [exit({ quantity: 10, exitPrice, exitDate })],
      });
    // 8 alternating ±100 trades — under the 20-trade window, so each point is the
    // expanding mean: [100, 0, 33.33, 0, 20, 0, 14.29, 0].
    const prices = [110, 90, 110, 90, 110, 90, 110, 90];
    const ts = prices.map((px, i) => mk(px, `2026-07-0${i + 1}`));
    const r = computeJournalStats(ts);
    expect(r.rollingExpectancy).toHaveLength(8);
    expect(r.rollingExpectancy[0].value).toBe(100);
    expect(r.rollingExpectancy[1].value).toBe(0);
    expect(r.rollingExpectancy[2].value).toBeCloseTo(33.33, 1);
    expect(r.rollingExpectancy[7].value).toBe(0);
    // Below the 8-trade floor it's empty.
    expect(computeJournalStats(ts.slice(0, 3)).rollingExpectancy).toEqual([]);
  });

  it('breaks P&L down by exit weekday and hold-time bucket', () => {
    const ts: Position[] = [
      // Mon 2026-06-15, same-day (intraday), +100
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-06-15',
        exits: [exit({ quantity: 10, exitPrice: 110, exitDate: '2026-06-15' })],
      }),
      // closed Fri 2026-06-19, held 7 days, -50
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-06-12',
        exits: [exit({ quantity: 10, exitPrice: 95, exitDate: '2026-06-19' })],
      }),
      // closed Tue 2026-06-16, held 1 day, +30
      makePosition({
        assetType: 'stock',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-06-15',
        exits: [exit({ quantity: 10, exitPrice: 103, exitDate: '2026-06-16' })],
      }),
    ];
    const r = computeJournalStats(ts);
    const wd = Object.fromEntries(r.byWeekday.map((g) => [g.key, g.totalPnl]));
    expect(wd).toEqual({ Mon: 100, Tue: 30, Fri: -50 });
    // weekdays come out in calendar order (Sun..Sat)
    expect(r.byWeekday.map((g) => g.key)).toEqual(['Mon', 'Tue', 'Fri']);
    const hold = Object.fromEntries(r.byHold.map((g) => [g.key, g.totalPnl]));
    expect(hold).toEqual({ Intraday: 100, '1–3 days': 30, '4–10 days': -50 });
  });

  it('leaves SQN / R std-dev null with fewer than two R trades', () => {
    const one = makePosition({
      assetType: 'stock',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      exits: [exit({ quantity: 10, exitPrice: 110 })],
    });
    const r = computeJournalStats([one]);
    expect(r.rTrades).toBe(1);
    expect(r.stdevR).toBeNull();
    expect(r.sqn).toBeNull();
  });
});

describe('computeJournalStats — trades with no entry date', () => {
  const closedTrade = (o: Partial<Position>): Position =>
    ({
      id: 1,
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-07-01',
      entryTime: null,
      fees: 0,
      optionType: null,
      strike: null,
      expiration: null,
      multiplier: 1,
      status: 'closed',
      tags: [],
      grade: null,
      notes: null,
      checklist: [],
      stopPrice: null,
      targetPrice: null,
      sourceIntentId: null,
      accountId: null,
      createdAt: 0,
      updatedAt: 0,
      remainingQuantity: 0,
      exits: [
        {
          id: 1,
          positionId: 1,
          quantity: 10,
          exitPrice: 110,
          exitDate: '2026-07-10',
          fees: 0,
          notes: null,
          sourceIntentId: null,
          createdAt: 0,
        },
      ],
      ...o,
    }) as Position;

  // A trade is undated only when it has NO entry date AND no exit to fall back
  // on, so its realized P&L can only come from entry fees — which is enough to
  // make it a decisive loss, and so enough to prove where it is counted.
  const datedWinner = () => closedTrade({ id: 1 }); // +100
  const undatedLoser = () => closedTrade({ id: 2, entryDate: null, exits: [], fees: 50 }); // -50

  it('still counts an undated trade toward win rate and expectancy — those need only P&L', () => {
    const stats = computeJournalStats([datedWinner(), undatedLoser()]);
    expect(stats.totalClosed).toBe(2);
    // ...but only one of them can be placed in time.
    expect(stats.datedTrades).toBe(1);
    expect(stats.equityCurve).toHaveLength(1);

    // The assertions this test's own name promised, and originally lacked —
    // which is how the stats came to run over the dated subset unnoticed.
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(50); // not 100: the loser is a closed trade
    expect(stats.expectancy).toBe(25); // (100 - 50) / 2, not 100 / 1
    expect(stats.totalRealized).toBe(50);
    expect(stats.profitFactor).toBe(2); // 100 / 50, not ∞
    expect(stats.worstTrade).toBe(-50); // not +100
  });

  it('keeps wins + losses + breakeven equal to totalClosed', () => {
    // The UI prints "N closed" next to "XW · YL", so a subtotal that doesn't
    // reconcile reads as broken arithmetic rather than a filtered population.
    const stats = computeJournalStats([datedWinner(), undatedLoser(), closedTrade({ id: 3, exits: [] })]);
    expect(stats.wins + stats.losses + stats.breakeven).toBe(stats.totalClosed);
  });

  it('leaves drawdown and streaks over the dated trades only', () => {
    // Not an oversight: a drawdown is the path the equity took and a streak is a
    // run of consecutive trades, so a trade with no place in the order cannot
    // enter either. The dated winner alone never draws down.
    const stats = computeJournalStats([datedWinner(), undatedLoser()]);
    expect(stats.maxDrawdown).toBe(0);
    expect(stats.currentStreak).toEqual({ type: 'win', count: 1 });
  });

  it('agrees with the R-multiple stats about which trades exist', () => {
    // rTrades always counted every closed trade with a stop. Before the fix
    // wins/losses counted only the dated ones, so the two halves of the same
    // report disagreed about the size of the book.
    const stats = computeJournalStats([
      closedTrade({ id: 1, stopPrice: 90 }),
      closedTrade({ id: 2, entryDate: null, exits: [], fees: 50, stopPrice: 90 }),
    ]);
    expect(stats.rTrades).toBe(2);
    expect(stats.wins + stats.losses + stats.breakeven).toBe(stats.rTrades);
  });

  it('leaves an undated trade out of the hold-time and weekday breakdowns', () => {
    // An undated trade used to reach holdBucket() as NaN, which matched no
    // bucket and fell through to the LAST one — quietly filing every one of
    // them under "30+ days".
    const undated = closedTrade({ id: 2, entryDate: null });
    const stats = computeJournalStats([undated]);
    expect(stats.byHold).toEqual([]);
    // The exit date still places it on a weekday, since that only needs the exit.
    expect(stats.byWeekday.map((g) => g.key)).toEqual(['Fri']);
  });

  it('keeps an undated trade in the weekday breakdown when its exit date is known', () => {
    const stats = computeJournalStats([closedTrade({ entryDate: null })]);
    expect(stats.byWeekday.reduce((s, g) => s + g.trades, 0)).toBe(1);
    expect(stats.byHold.reduce((s, g) => s + g.trades, 0)).toBe(0);
  });
});
