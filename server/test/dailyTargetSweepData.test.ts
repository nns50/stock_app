import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { listPositions } from '../src/db/positions';
import {
  openPaperPosition,
  closePaperPosition,
  listPaperPositions,
  paperRealizedR,
} from '../src/db/autotradePaperPositions';
import {
  createLiveOptionsPosition,
  closeLiveOptionsPosition,
  listLiveOptionsPositions,
  liveOptionsPnl,
} from '../src/db/autotradeLiveOptionsPositions';
import {
  collectBook,
  collectLiveTrades,
  collectPaperTrades,
  lastCompletedSessionDate,
  sessionWindowFor,
} from '../src/services/autotrading/dailyTargetSweepData';
import { initialRiskOf, realizedPnlOf } from '../src/services/pnl';
import { etDateTimeToMs } from '../src/util/marketDate';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';

// The collector maps each book's closed rows to SweepTrades with NO second
// derivation of R — each book's own helper is the oracle these tests compare
// against. A row that cannot be placed or scored is dropped AND counted.

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_paper_positions; ' +
      'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_live_options_positions;',
  );
});

const at = (date: string, time: string): number => etDateTimeToMs(date, time) as number;

describe('collectLiveTrades', () => {
  it('maps a journal autotrade row to its entry moment, last exit moment and realizedPnlOf / initialRiskOf', () => {
    seedClosedAutotradeSessions({ sessions: { '2026-09-01': [{ entryTime: '10:15', exitTime: '14:00', r: 1.5 }] } });
    const closed = listPositions({ status: 'closed' });
    const { trades, droppedTrades, approximatedExits } = collectLiveTrades(closed, []);
    expect(droppedTrades).toBe(0);
    expect(approximatedExits).toBe(0);
    expect(trades).toHaveLength(1);
    const p = closed[0];
    expect(trades[0]).toEqual({
      id: `pos:${p.id}`,
      entryAt: at('2026-09-01', '10:15'),
      exitAt: p.exits[0].createdAt,
      r: realizedPnlOf(p) / (initialRiskOf(p) as number),
    });
    expect(trades[0].r).toBeCloseTo(1.5, 9);
  });

  it('ignores rows that are not autotrade-tagged, and drops (counting) undated or stopless ones', () => {
    seedClosedAutotradeSessions({
      sessions: {
        '2026-09-01': [
          { entryTime: '10:00', r: 1, tags: ['manual'] },
          { entryTime: '11:00', r: -1 },
        ],
      },
    });
    // A tagged row with no entry date at all, and one with no stop.
    const now = Date.now();
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, fees, multiplier, status, tags, stop_price, created_at, updated_at)
       VALUES ('stock', 'NODATE', 'long', 10, 100, NULL, 0, 1, 'closed', '["autotrade"]', 95, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees, multiplier, status, tags, stop_price, created_at, updated_at)
       VALUES ('stock', 'NOSTOP', 'long', 10, 100, '2026-09-01', '12:00', 0, 1, 'closed', '["autotrade"]', NULL, ?, ?)`,
    ).run(now, now);
    const { trades, droppedTrades } = collectLiveTrades(listPositions({ status: 'closed' }), []);
    expect(trades.map((t) => t.r)).toEqual([-1]);
    expect(droppedTrades).toBe(2);
  });

  it('falls back to createdAt for a row with no entry time only when it lands on the entry date', () => {
    const onDate = at('2026-09-02', '10:30');
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees, multiplier, status, tags, stop_price, created_at, updated_at)
       VALUES ('stock', 'SAMEDAY', 'long', 10, 100, '2026-09-02', NULL, 0, 1, 'closed', '["autotrade"]', 95, ?, ?)`,
    ).run(onDate, onDate);
    const offDate = at('2026-09-03', '10:30');
    db.prepare(
      `INSERT INTO positions (asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees, multiplier, status, tags, stop_price, created_at, updated_at)
       VALUES ('stock', 'OTHERDAY', 'long', 10, 100, '2026-09-02', NULL, 0, 1, 'closed', '["autotrade"]', 95, ?, ?)`,
    ).run(offDate, offDate);
    for (const symbol of ['SAMEDAY', 'OTHERDAY']) {
      const id = (db.prepare('SELECT id FROM positions WHERE symbol = ?').get(symbol) as { id: number }).id;
      db.prepare(
        `INSERT INTO position_exits (position_id, quantity, exit_price, exit_date, fees, created_at) VALUES (?, 10, 105, '2026-09-02', 0, ?)`,
      ).run(id, at('2026-09-02', '15:00'));
    }
    const { trades, droppedTrades } = collectLiveTrades(listPositions({ status: 'closed' }), []);
    expect(trades).toHaveLength(1);
    expect(trades[0].entryAt).toBe(onDate);
    expect(droppedTrades).toBe(1);
  });

  it('approximates an exit whose reconcile timestamp fell on another day to the close of its exit date', () => {
    seedClosedAutotradeSessions({
      sessions: { '2026-09-02': [{ entryTime: '10:00', exitTime: '15:00', r: 0.5 }] },
    });
    db.prepare('UPDATE position_exits SET created_at = ?').run(at('2026-09-03', '01:00'));
    const { trades, approximatedExits } = collectLiveTrades(listPositions({ status: 'closed' }), []);
    expect(approximatedExits).toBe(1);
    expect(trades[0].exitAt).toBe(at('2026-09-02', '16:00'));
  });

  it('maps a closed live options row with liveOptionsPnl / riskAmount and drops an unscored one', () => {
    const pos = createLiveOptionsPosition({
      symbol: 'SPY',
      side: 'call',
      contractSymbol: 'SPY-fixture',
      strike: 500,
      expiration: '2026-09-18',
      quantity: 1,
      entryPrice: 2,
      riskAmount: 200,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      accountId: 'acct',
    });
    closeLiveOptionsPosition(pos.id, { exitPrice: 3, exitReason: 'take_profit' });
    createLiveOptionsPosition({
      symbol: 'QQQ',
      side: 'put',
      contractSymbol: 'QQQ-fixture',
      strike: 400,
      expiration: '2026-09-18',
      quantity: 1,
      entryPrice: 1,
      riskAmount: 100,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
      accountId: 'acct',
    });
    const closed = listLiveOptionsPositions({ status: 'closed' });
    const { trades, droppedTrades } = collectLiveTrades(
      [],
      [...closed, ...listLiveOptionsPositions({ status: 'open' })],
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe(`lopt:${pos.id}`);
    expect(trades[0].r).toBeCloseTo(liveOptionsPnl(closed[0], 3) / 200, 9);
    expect(trades[0].r).toBeCloseTo(0.5, 9);
    expect(droppedTrades).toBe(1);
  });
});

describe('collectPaperTrades', () => {
  it('maps a closed paper row with paperRealizedR and drops an open one', () => {
    const open = openPaperPosition({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    closePaperPosition(open.id, { exitPrice: 110, exitReason: 'target' });
    openPaperPosition({
      symbol: 'MSFT',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const all = listPaperPositions();
    const { trades, droppedTrades } = collectPaperTrades(all, []);
    const closed = all.find((p) => p.status === 'closed')!;
    expect(trades).toEqual([
      { id: `paper:${closed.id}`, entryAt: closed.entryAt, exitAt: closed.exitAt, r: paperRealizedR(closed) },
    ]);
    expect(trades[0].r).toBeCloseTo(2, 9);
    expect(droppedTrades).toBe(1);
  });
});

describe('the session window', () => {
  it('ends at the last completed session: today after the close, otherwise the previous session', () => {
    // Tuesday 2026-09-08 16:30 ET → today; 12:00 ET → Friday 09-04 (09-07 is Labor Day).
    expect(lastCompletedSessionDate(at('2026-09-08', '16:30'))).toBe('2026-09-08');
    expect(lastCompletedSessionDate(at('2026-09-08', '12:00'))).toBe('2026-09-04');
    // A Saturday → Friday.
    expect(lastCompletedSessionDate(at('2026-09-05', '12:00'))).toBe('2026-09-04');
  });

  it("is read as of the book's last exit, truncated at its first entry, never past the completed session", () => {
    const trades = [
      { id: 'a', entryAt: at('2026-09-01', '10:00'), exitAt: at('2026-09-01', '11:00'), r: 1 },
      { id: 'b', entryAt: at('2026-09-03', '10:00'), exitAt: at('2026-09-03', '11:00'), r: -1 },
    ];
    expect(sessionWindowFor(trades, 40, at('2026-09-08', '17:00'))).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    // A narrower lookback keeps the most recent sessions.
    expect(sessionWindowFor(trades, 2, at('2026-09-08', '17:00'))).toEqual(['2026-09-02', '2026-09-03']);
    // With no trades at all the window is simply the last n completed sessions.
    expect(sessionWindowFor([], 3, at('2026-09-08', '17:00'))).toEqual(['2026-09-03', '2026-09-04', '2026-09-08']);
  });

  it('collectBook reads the live journal (and reuses prefetched lists) or the paper book', () => {
    seedClosedAutotradeSessions({
      sessions: { '2026-09-01': [{ entryTime: '10:00', r: 1 }], '2026-09-02': [{ entryTime: '10:00', r: -0.5 }] },
    });
    const live = collectBook('live', 40, at('2026-09-08', '17:00'));
    expect(live.book).toBe('live');
    expect(live.trades.map((t) => t.r).sort((a, b) => a - b)).toEqual([-0.5, 1]);
    expect(live.sessionDates).toEqual(['2026-09-01', '2026-09-02']);
    expect(live.lookbackSessions).toBe(40);
    const prefetched = collectBook('live', 40, at('2026-09-08', '17:00'), { closed: [], liveOptionsClosed: [] });
    expect(prefetched.trades).toEqual([]);
    const paper = collectBook('paper', 40, at('2026-09-08', '17:00'));
    expect(paper.book).toBe('paper');
    expect(paper.trades).toEqual([]);
  });
});
