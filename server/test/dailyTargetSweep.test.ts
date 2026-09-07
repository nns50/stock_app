import { describe, it, expect } from 'vitest';
import {
  buildSessionPaths,
  computeRealizedEdge,
  emptyRealizedEdge,
  MIN_RELIABLE_SESSIONS,
  SweepTrade,
} from '../src/services/autotrading/dailyTargetSweep';
import { etDateTimeToMs } from '../src/util/marketDate';

// Pure fixtures: an ET wall-clock moment on a given date. The window below is
// the week of 2026-08-31 .. 2026-09-04 plus Tuesday 2026-09-08 — Monday
// 2026-09-07 is Labor Day, so the calendar has a hole in it on purpose.
const at = (date: string, time: string): number => {
  const ms = etDateTimeToMs(date, time);
  if (ms === null) throw new Error(`bad fixture moment ${date} ${time}`);
  return ms;
};
const trade = (id: string, entry: [string, string], exit: [string, string], r: number): SweepTrade => ({
  id,
  entryAt: at(entry[0], entry[1]),
  exitAt: at(exit[0], exit[1]),
  r,
});
const WEEK = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08'];

describe('buildSessionPaths', () => {
  it('places an entry on its session and an exit on its own, so a two-day hold is an entry on D and R on D+1', () => {
    const t = trade('a', ['2026-09-01', '10:00'], ['2026-09-02', '11:00'], 1.5);
    const { paths, remappedEvents, eventsOutsideWindow } = buildSessionPaths([t], WEEK);
    expect(paths.map((p) => p.date)).toEqual(WEEK);
    expect(paths[1]).toMatchObject({ entries: 1, exits: 0 });
    expect(paths[1].events).toEqual([{ kind: 'entry', tradeId: 'a', at: t.entryAt, r: 0 }]);
    expect(paths[2]).toMatchObject({ entries: 0, exits: 1 });
    expect(paths[2].events).toEqual([{ kind: 'exit', tradeId: 'a', at: t.exitAt, r: 1.5 }]);
    expect(remappedEvents).toBe(0);
    expect(eventsOutsideWindow).toBe(0);
  });

  it('orders a session by time, exits before entries at the same instant, then by id', () => {
    const early = trade('b', ['2026-09-01', '09:35'], ['2026-09-01', '10:00'], -1);
    const sameTick = trade('a', ['2026-09-01', '10:00'], ['2026-09-01', '15:00'], 0.5);
    const { paths } = buildSessionPaths([sameTick, early], WEEK);
    expect(paths[1].events.map((e) => `${e.kind}:${e.tradeId}`)).toEqual(['entry:b', 'exit:b', 'entry:a', 'exit:a']);
  });

  it('attaches an event dated on a non-session to the previous session and counts it', () => {
    // Exited on Labor Day (a weekend-style sweep) → belongs to Friday 09-04.
    const t = trade('a', ['2026-09-04', '10:00'], ['2026-09-07', '09:00'], 0.2);
    const { paths, remappedEvents } = buildSessionPaths([t], WEEK);
    expect(paths[4].exits).toBe(1);
    expect(paths[5].exits).toBe(0);
    expect(remappedEvents).toBe(1);
  });

  it('drops (and counts) an event dated before the window, keeping the exit that landed inside it', () => {
    const t = trade('a', ['2026-08-28', '10:00'], ['2026-08-31', '10:00'], 0.8);
    const { paths, eventsOutsideWindow } = buildSessionPaths([t], WEEK);
    expect(eventsOutsideWindow).toBe(1);
    expect(paths[0].entries).toBe(0);
    expect(paths[0].exits).toBe(1);
  });

  it('keeps a session with no events as a real 0R session', () => {
    const { paths } = buildSessionPaths([], WEEK);
    expect(paths).toHaveLength(WEEK.length);
    expect(paths.every((p) => p.events.length === 0 && p.entries === 0)).toBe(true);
  });
});

describe('computeRealizedEdge', () => {
  const trades: SweepTrade[] = [
    trade('a', ['2026-08-31', '10:00'], ['2026-08-31', '11:00'], 1),
    trade('b', ['2026-08-31', '12:00'], ['2026-08-31', '13:00'], -1),
    trade('c', ['2026-09-01', '10:00'], ['2026-09-01', '11:00'], 0.5),
    trade('d', ['2026-09-03', '10:00'], ['2026-09-03', '11:00'], -0.5),
    trade('e', ['2026-09-03', '10:30'], ['2026-09-03', '11:30'], 2),
    trade('f', ['2026-09-03', '11:00'], ['2026-09-03', '12:00'], 0),
  ];

  it('averages R over the trades that closed in the window and takes the median flow, idle sessions included', () => {
    const edge = computeRealizedEdge({ trades, sessionDates: WEEK, droppedTrades: 2, lookbackSessions: 40 });
    expect(edge.rTrades).toBe(6);
    expect(edge.avgR).toBeCloseTo((1 - 1 + 0.5 - 0.5 + 2 + 0) / 6, 4);
    // entries per session: [2, 1, 0, 3, 0, 0] → sorted [0,0,0,1,2,3] → median 0.5
    expect(edge.tradesPerSession).toBe(0.5);
    expect(edge.sessions).toBe(6);
    expect(edge.sessionsWithoutEntries).toBe(3);
    expect(edge.droppedTrades).toBe(2);
    expect(edge.lookbackSessions).toBe(40);
    expect(edge.reliable).toBe(false);
  });

  it('is reliable only past BOTH floors — 20 trades and 20 sessions', () => {
    const many: SweepTrade[] = [];
    for (let i = 0; i < 25; i += 1) many.push(trade(`t${i}`, ['2026-09-01', '10:00'], ['2026-09-01', '11:00'], 0.1));
    const fewSessions = computeRealizedEdge({
      trades: many,
      sessionDates: WEEK,
      droppedTrades: 0,
      lookbackSessions: 40,
    });
    expect(fewSessions.rTrades).toBe(25);
    expect(fewSessions.reliable).toBe(false);
    // Pad the calendar to 20 sessions by walking forward over real weekdays.
    const sessions = [...WEEK];
    let cursor = new Date(Date.UTC(2026, 8, 8));
    while (sessions.length < MIN_RELIABLE_SESSIONS) {
      cursor = new Date(cursor.getTime() + 86_400_000);
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) sessions.push(cursor.toISOString().slice(0, 10));
    }
    const enough = computeRealizedEdge({
      trades: many,
      sessionDates: sessions,
      droppedTrades: 0,
      lookbackSessions: 40,
    });
    expect(enough.sessions).toBe(20);
    expect(enough.reliable).toBe(true);
    const fewTrades = computeRealizedEdge({
      trades: many.slice(0, 19),
      sessionDates: sessions,
      droppedTrades: 0,
      lookbackSessions: 40,
    });
    expect(fewTrades.reliable).toBe(false);
  });

  it('reports nulls, not zeros, with nothing to measure', () => {
    expect(computeRealizedEdge({ trades: [], sessionDates: [], droppedTrades: 0, lookbackSessions: 40 })).toEqual(
      emptyRealizedEdge(40),
    );
    const noTrades = computeRealizedEdge({ trades: [], sessionDates: WEEK, droppedTrades: 0, lookbackSessions: 40 });
    expect(noTrades.avgR).toBeNull();
    expect(noTrades.tradesPerSession).toBe(0);
    expect(noTrades.sessions).toBe(6);
  });
});
