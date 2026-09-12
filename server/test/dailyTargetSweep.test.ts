import { describe, it, expect } from 'vitest';
import {
  buildSessionPaths,
  computeRealizedEdge,
  emptyRealizedEdge,
  goalInR,
  guardLevelsForR,
  MIN_RELIABLE_SESSIONS,
  runDailyTargetSweep,
  SessionPath,
  simulateSession,
  SWEEP_GRID_R,
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

  it("drops (and counts) an event on a SESSION outside the window — it is not the last day's", () => {
    // Wednesday 09-09 is a real session that the window does not include.
    const t = trade('a', ['2026-09-08', '10:00'], ['2026-09-09', '10:00'], 0.8);
    const { paths, eventsOutsideWindow, remappedEvents } = buildSessionPaths([t], WEEK);
    expect(paths[5].entries).toBe(1);
    expect(paths[5].exits).toBe(0);
    expect(eventsOutsideWindow).toBe(1);
    expect(remappedEvents).toBe(0);
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

  it('averages R over the trades that closed in the window and takes the median flow over ACTIVE sessions', () => {
    const edge = computeRealizedEdge({ trades, sessionDates: WEEK, droppedTrades: 2, lookbackSessions: 40 });
    expect(edge.rTrades).toBe(6);
    expect(edge.avgR).toBeCloseTo((1 - 1 + 0.5 - 0.5 + 2 + 0) / 6, 4);
    // entries per session: [2, 1, 0, 3, 0, 0] → the three ACTIVE sessions
    // [2, 1, 3] → median 2. The idle sessions are counted, not averaged in:
    // the first production read had 26 idle sessions of 40 and a median of 0.
    expect(edge.tradesPerSession).toBe(2);
    expect(edge.sessions).toBe(6);
    expect(edge.activeSessions).toBe(3);
    expect(edge.sessionsWithoutEntries).toBe(3);
    expect(edge.droppedTrades).toBe(2);
    expect(edge.lookbackSessions).toBe(40);
    expect(edge.reliable).toBe(false);
  });

  it('is reliable only past BOTH floors — 20 trades and 20 ACTIVE sessions', () => {
    // Pad the calendar to 20 sessions by walking forward over real weekdays.
    const sessions = [...WEEK];
    let cursor = new Date(Date.UTC(2026, 8, 8));
    while (sessions.length < MIN_RELIABLE_SESSIONS) {
      cursor = new Date(cursor.getTime() + 86_400_000);
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) sessions.push(cursor.toISOString().slice(0, 10));
    }
    // 25 trades on ONE session: 20 sessions in the window, but only one the
    // book traded on — a window is not a record.
    const oneDay: SweepTrade[] = [];
    for (let i = 0; i < 25; i += 1) oneDay.push(trade(`t${i}`, ['2026-09-01', '10:00'], ['2026-09-01', '11:00'], 0.1));
    const oneActive = computeRealizedEdge({
      trades: oneDay,
      sessionDates: sessions,
      droppedTrades: 0,
      lookbackSessions: 40,
    });
    expect(oneActive.sessions).toBe(20);
    expect(oneActive.activeSessions).toBe(1);
    expect(oneActive.rTrades).toBe(25);
    expect(oneActive.reliable).toBe(false);
    // One trade on each of the 20 sessions: both floors met.
    const spread: SweepTrade[] = sessions.map((d, i) => trade(`s${i}`, [d, '10:00'], [d, '11:00'], 0.1));
    const enough = computeRealizedEdge({
      trades: spread,
      sessionDates: sessions,
      droppedTrades: 0,
      lookbackSessions: 40,
    });
    expect(enough.activeSessions).toBe(20);
    expect(enough.tradesPerSession).toBe(1);
    expect(enough.reliable).toBe(true);
    const fewTrades = computeRealizedEdge({
      trades: spread.slice(0, 19),
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
    expect(noTrades.tradesPerSession).toBeNull(); // traded on no session — not "0 a day"
    expect(noTrades.sessions).toBe(6);
    expect(noTrades.activeSessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The counterfactual. Hand-computed sessions, one rule at a time: a trade
// ENTERED after the halt is dropped (none of its events count); a trade already
// open at the halt runs to its real exit; `reached` is sticky; the guard fires
// only on an armed, not-yet-banked day. Every number below is worked by hand
// in the comment beside it.
// ---------------------------------------------------------------------------
function session(
  date: string,
  events: [kind: 'entry' | 'exit', tradeId: string, time: string, r?: number][],
): SessionPath {
  const evs = events.map(([kind, tradeId, time, r]) => ({ kind, tradeId, at: at(date, time), r: r ?? 0 }));
  return {
    date,
    events: evs,
    entries: evs.filter((e) => e.kind === 'entry').length,
    exits: evs.filter((e) => e.kind === 'exit').length,
  };
}

describe('simulateSession', () => {
  // a: +1.5R at 10:30; b entered 10:00, exits +0.5R at 11:00; c entered 11:30, -1R at 12:00; d entered 12:30, +2R at 13:00.
  const day = session('2026-09-01', [
    ['entry', 'a', '09:35'],
    ['entry', 'b', '10:00'],
    ['exit', 'a', '10:30', 1.5],
    ['exit', 'b', '11:00', 0.5],
    ['entry', 'c', '11:30'],
    ['exit', 'c', '12:00', -1],
    ['entry', 'd', '12:30'],
    ['exit', 'd', '13:00', 2],
  ]);

  it('none: the record as it happened', () => {
    expect(simulateSession(day, 'none', 1)).toEqual({
      dayR: 3,
      halted: false,
      entries: 4,
      entriesDropped: 0,
      // `none` models no stopping rule at all, so nothing is ever "reached".
      reached: false,
    });
  });

  it('bank: halts new entries once cumulative R reaches the level, letting the open trade run to its real exit', () => {
    // Level 1R: reached at a's exit (+1.5). b is already open → its +0.5 still
    // counts; c and d are entered after the halt → dropped. Day = 2.0R.
    expect(simulateSession(day, 'bank', 1)).toEqual({
      dayR: 2,
      halted: true,
      entries: 4,
      entriesDropped: 2,
      reached: true,
    });
    // Level 3R is only reached on the last exit — nothing left to drop.
    expect(simulateSession(day, 'bank', 3)).toEqual({
      dayR: 3,
      halted: true,
      entries: 4,
      entriesDropped: 0,
      reached: true,
    });
    // Level 10R: never reached.
    expect(simulateSession(day, 'bank', 10)).toEqual({
      dayR: 3,
      halted: false,
      entries: 4,
      entriesDropped: 0,
      reached: false,
    });
  });

  it('giveBack: arms at 2/3 of the level, fires on a fade to 1/3 of it — only while armed and not banked', () => {
    // Level 3R: arm 2R, floor 1R. cum: 1.5 (below arm), 2.0 (armed), 1.0 after
    // c (≤ floor while armed and not reached) → halted; d dropped. Day = 1.0R.
    expect(guardLevelsForR(3)).toEqual({ armR: 2, floorR: 1 });
    expect(simulateSession(day, 'giveBack', 3)).toEqual({
      dayR: 1,
      halted: true,
      entries: 4,
      entriesDropped: 1,
      // Halted by the FADE, not by reaching 3R — the two are different facts,
      // which is why `reached` is not derivable from `halted`.
      reached: false,
    });
    // Level 6R: arm 4R never touched → the guard never arms, nothing fires.
    expect(simulateSession(day, 'giveBack', 6)).toEqual({
      dayR: 3,
      halted: false,
      entries: 4,
      entriesDropped: 0,
      reached: false,
    });
    // Level 1R: banked at the first exit, exactly like `bank` — a banked day never also fires the guard.
    expect(simulateSession(day, 'giveBack', 1)).toEqual(simulateSession(day, 'bank', 1));
  });

  it('bankTrail: keeps entering past the level and halts on the first exit that takes the day back below it', () => {
    // Level 1R: reached at 1.5; b's exit keeps it at 2.0 (≥ level, no halt);
    // c is entered (not halted yet), its -1 takes cum to 1.0 — NOT below the
    // 1R line — so still no halt; d enters, +2 → 3.0. Nothing dropped.
    expect(simulateSession(day, 'bankTrail', 1)).toEqual({
      dayR: 3,
      halted: false,
      entries: 4,
      entriesDropped: 0,
      // Reached 1R early and stayed above it — the day never halted, and a
      // `dayR >= levelR` test would agree here only by coincidence.
      reached: true,
    });
    // Level 1.8R: reached at 2.0 after b; c's -1 fades to 1.0 < 1.8 → halted; d dropped. Day = 1.0R.
    expect(simulateSession(day, 'bankTrail', 1.8)).toEqual({
      dayR: 1,
      halted: true,
      entries: 4,
      entriesDropped: 1,
      // The case `dayR` cannot answer: the day REACHED 2.0R and closed at 1.0R.
      reached: true,
    });
    // Its guard half is the give-back rule: level 3R (arm 2, floor 1), never
    // reached, armed at 2.0, faded to 1.0 → halted like giveBack.
    expect(simulateSession(day, 'bankTrail', 3)).toEqual(simulateSession(day, 'giveBack', 3));
  });

  it("a dropped trade's later exit never counts, even on a later session's path", () => {
    // Halted before e is entered; e's exit is on the SAME path here (the
    // reconstruction places a next-day exit on the next session, where the
    // drop set does not carry over — a next-day exit of a dropped trade is a
    // trade that, in production, would never have existed; see the caveat).
    const d = session('2026-09-02', [
      ['entry', 'a', '09:35'],
      ['exit', 'a', '10:00', 2],
      ['entry', 'e', '10:30'],
      ['exit', 'e', '11:00', 5],
    ]);
    expect(simulateSession(d, 'bank', 1)).toEqual({
      dayR: 2,
      halted: true,
      entries: 2,
      entriesDropped: 1,
      reached: true,
    });
  });
});

describe('runDailyTargetSweep', () => {
  // A seeded LCG so the bootstrap is reproducible across runs.
  const seeded = (seed: number) => {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  };
  const trades: SweepTrade[] = [
    trade('a', ['2026-08-31', '09:35'], ['2026-08-31', '10:30'], 1.5),
    trade('b', ['2026-08-31', '10:00'], ['2026-08-31', '11:00'], 0.5),
    trade('c', ['2026-08-31', '11:30'], ['2026-08-31', '12:00'], -1),
    trade('d', ['2026-08-31', '12:30'], ['2026-08-31', '13:00'], 2),
    trade('e', ['2026-09-01', '10:00'], ['2026-09-01', '11:00'], -1),
    trade('f', ['2026-09-01', '11:30'], ['2026-09-01', '12:00'], -0.5),
    trade('g', ['2026-09-03', '10:00'], ['2026-09-03', '11:00'], 1),
    trade('h', ['2026-09-03', '11:30'], ['2026-09-03', '12:00'], -2),
  ];
  const run = (over: Partial<Parameters<typeof runDailyTargetSweep>[0]> = {}) =>
    runDailyTargetSweep({
      book: 'live',
      trades,
      sessionDates: WEEK,
      droppedTrades: 1,
      approximatedExits: 0,
      lookbackSessions: 40,
      riskPerTradePct: 1.25,
      storedTargetPct: 3,
      rng: seeded(7),
      resamples: 300,
      ...over,
    });

  it('reconciles the two attributions: totalRAllSessions matches avgR x rTrades, actual.totalR need not', () => {
    // The distinction that read as a bug on 2026-09-09. `realized.avgR` is
    // ENTRY-attributed over every closed trade; `actual.totalR` is
    // EXIT-attributed over ACTIVE sessions only, and a trade closing on a
    // session with no entries falls out of the second and not the first.
    // `totalRAllSessions` exists so that gap is visible rather than derived.
    //
    // 'x' enters on an active session and exits on one with no entries of its
    // own, which is exactly the shape that separates them.
    const withCrossSession = [...trades, trade('x', ['2026-09-03', '15:00'], ['2026-09-04', '10:00'], -3)];
    const out = run({ trades: withCrossSession });

    const sumAll = 1.5 + 0.5 - 1 + 2 - 1 - 0.5 + 1 - 2 - 3;
    expect(out.totalRAllSessions).toBeCloseTo(sumAll, 2);
    // The identity that makes the field worth having.
    expect(out.totalRAllSessions).toBeCloseTo((out.realized.avgR as number) * out.realized.rTrades, 1);
    // And the one that must NOT hold — 09-04 has no entries, so its -3R is
    // outside the policy baseline. Asserting they DIFFER is the point: an
    // implementation that quietly made them agree would have re-broken the
    // session-set invariant every delta depends on.
    expect(out.actual.totalR).not.toBeCloseTo(out.totalRAllSessions, 2);
    expect(out.actual.totalR).toBeCloseTo(sumAll + 3, 2);
  });

  it('leaves the two identical when no trade crosses a session boundary', () => {
    // With every exit on a session that also had entries, the two bases agree.
    // Pins that the difference is attribution and not an unconditional offset.
    const out = run();
    expect(out.totalRAllSessions).toBeCloseTo(out.actual.totalR, 2);
  });

  it('carries the realized edge, the counts, and the record as it happened over the ACTIVE sessions', () => {
    const out = run();
    expect(out.book).toBe('live');
    expect(out.tradesUsed).toBe(8);
    expect(out.droppedTrades).toBe(1);
    expect(out.realized.avgR).toBeCloseTo((1.5 + 0.5 - 1 + 2 - 1 - 0.5 + 1 - 2) / 8, 4);
    expect(out.sessionDates).toEqual(WEEK);
    // Three of the six sessions had entries: day R [3, -1.5, -1] → total 0.5,
    // mean 0.17, median -1, worst -1.5. The three idle sessions are counted and
    // excluded — no stopping rule can change a day with no entries.
    expect(out.activeSessions).toBe(3);
    expect(out.idleSessions).toBe(3);
    expect(out.actual).toMatchObject({
      policy: 'none',
      totalR: 0.5,
      meanDayR: 0.17,
      medianDayR: -1,
      worstDayR: -1.5,
      delta: null,
    });
    expect(out.reliable).toBe(false); // 3 of 20 active sessions
  });

  it('puts the stored target on the grid in R, marks it, and labels every level in % at full size', () => {
    const out = run();
    // 3% / 1.25% = 2.4R — not on the half-R grid, so it is added.
    expect(out.storedTargetR).toBe(2.4);
    const stored = out.levels.find((l) => l.isStoredTarget);
    expect(stored).toBeDefined();
    expect(stored!.levelR).toBe(2.4);
    expect(stored!.levelPct).toBe(3);
    expect(out.levels.filter((l) => l.isStoredTarget)).toHaveLength(1);
    expect(out.levels.map((l) => l.levelR)).toEqual([...SWEEP_GRID_R, 2.4].sort((a, b) => a - b));
    expect(out.levels[0]).toMatchObject({ levelR: 0.5, levelPct: 0.63 });
    // No risk % → no % column and no stored-target row.
    const noRisk = run({ riskPerTradePct: null });
    expect(noRisk.storedTargetR).toBeNull();
    expect(noRisk.levels.every((l) => l.levelPct === null && !l.isStoredTarget)).toBe(true);
    expect(noRisk.levels).toHaveLength(SWEEP_GRID_R.length);
  });

  it('measures each policy at each level against the record, with a CI on the per-session delta', () => {
    const out = run();
    const one = out.levels.find((l) => l.levelR === 1)!;
    const bank = one.policies.find((p) => p.policy === 'bank')!;
    // Day 1 under bank@1R is 2.0 (c, d dropped: delta -1). Day 4 reaches
    // exactly 1R on g's exit, so h is dropped and the day is +1 instead of -1
    // (delta +2). Day 2 never reaches 1R. Deltas over the three ACTIVE
    // sessions: [-1, 0, 2] → mean 0.33; days [2, -1.5, 1] → total 1.5.
    expect(bank.sessionsHalted).toBe(2);
    expect(bank.entriesDropped).toBe(3);
    expect(bank.totalR).toBe(1.5);
    expect(bank.delta).toMatchObject({ meanR: 0.33, reliable: false });
    expect(bank.delta!.ciLowR).toBeLessThanOrEqual(bank.delta!.meanR);
    expect(bank.delta!.ciHighR).toBeGreaterThanOrEqual(bank.delta!.meanR);
    expect(one.policies.map((p) => p.policy)).toEqual(['bank', 'giveBack', 'bankTrail']);
    // giveBack@3R on day 1 fades to 1.0 (day 1: 1.0 vs 3.0 → delta -2); the
    // -1.5 day never arms. Day 4 (g +1, h -2): arm 2 never touched. Deltas
    // over the active sessions [-2, 0, 0] → mean -0.67.
    const three = out.levels.find((l) => l.levelR === 3)!;
    expect(three.policies.find((p) => p.policy === 'giveBack')!.delta!.meanR).toBe(-0.67);
  });

  it('is deterministic under a seeded rng', () => {
    const a = run({ rng: seeded(42) });
    const b = run({ rng: seeded(42) });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// The goal on the R axis has ONE derivation (2026-09-12).
//
// Four places computed `targetDailyGainPct / riskPerTradePct` themselves, each
// with a comment asserting it matched the others. They did match, which is how
// a divergence would have shipped: change the rounding or add a clamp in three
// of four and the fourth quietly answers a different question -- and the
// question is "did the book reach its goal today".
// ---------------------------------------------------------------------------
describe('goalInR', () => {
  it('converts the stored daily target into R at the configured risk', () => {
    expect(goalInR(3, 2.5)).toBe(1.2);
    expect(goalInR(3, 1.25)).toBe(2.4);
    // Two decimals, so a repeating quotient does not leak float noise into a
    // level comparison that uses an exact epsilon.
    expect(goalInR(1, 3)).toBe(0.33);
  });

  it('is null whenever the goal would be meaningless rather than large', () => {
    expect(goalInR(null, 2.5)).toBeNull();
    expect(goalInR(0, 2.5)).toBeNull();
    expect(goalInR(-1, 2.5)).toBeNull();
    // Risk of zero would make the goal infinite R, not an enormous number.
    expect(goalInR(3, 0)).toBeNull();
    expect(goalInR(3, null)).toBeNull();
  });

  it('is the same number the sweep marks as the stored target', () => {
    // The consumer, not the producer: whatever goalInR returns must be the
    // level the sweep flags, or the card and the sweep disagree about which
    // row is the goal.
    const r = runDailyTargetSweep({
      book: 'live',
      trades: [{ id: 'pos:1', entryAt: at('2026-09-10', '09:35'), exitAt: at('2026-09-10', '10:00'), r: 0.5 }],
      sessionDates: ['2026-09-10'],
      droppedTrades: 0,
      approximatedExits: 0,
      lookbackSessions: 40,
      storedTargetPct: 3,
      riskPerTradePct: 2.5,
      resamples: 50,
    });
    expect(r.storedTargetR).toBe(goalInR(3, 2.5));
    expect(r.levels.filter((l) => l.isStoredTarget).map((l) => l.levelR)).toEqual([1.2]);
  });
});
