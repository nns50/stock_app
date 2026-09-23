import { describe, it, expect } from 'vitest';
import { MARKETABLE_LIMIT_BUFFER_PCT } from '../src/services/autotrading/marketableLimit';
import {
  BatchRefusal,
  buildAttribution,
  buildDayLevel,
  CONTROL_MIN_TRADES,
  DIMENSIONS,
  equivalentPaceFloor,
  JournalSkip,
  LeakTrade,
  ONCE_PER_DAY_SKIP_ACTIONS,
  LEAK_MIN_TRADES,
  mulberry32,
  PAIR_TOLERANCE_MS,
  paceFloorDrift,
  paperControlDrift,
  reentryCooldownFinding,
  reentryGapReadings,
  runEdgeLeakScan,
  SLIPPAGE_MIN_TRADES,
  ENTRY_DRIFT_MIN_TRADES,
  verdictFor,
  WATCH_MIN_TRADES,
} from '../src/services/autotrading/edgeLeakScan';
import { etDateTimeToMs } from '../src/util/marketDate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The scan's whole reason for existing is that leaks were only ever found when
// a human looked. So these tests are written the other way round from most:
// each one BUILDS a book with a known leak in it and asserts the scan names
// that leak, its lever, and its severity — rather than asserting the arithmetic
// of a bucket, which would prove nothing about whether the scan reports it
// (CLAUDE.md: assert at the consumer).
// ---------------------------------------------------------------------------

const RNG = (): (() => number) => mulberry32(42);

let seq = 0;
function trade(over: Partial<LeakTrade> = {}): LeakTrade {
  seq += 1;
  const etDate = over.etDate ?? '2026-09-08';
  const entryAt = over.entryAt ?? (etDateTimeToMs(etDate, '10:00') as number) + seq * 1000;
  return {
    id: `t:${seq}`,
    book: 'live',
    symbol: 'AAA',
    sector: 'Technology',
    assetKind: 'equity',
    entryAt,
    exitAt: entryAt + 30 * 60_000,
    etDate,
    entryMinuteEt: 600,
    r: 0.1,
    pnlUsd: 10,
    round: 1,
    score: 75,
    exitReason: 'target',
    holdMinutes: 30,
    quantity: 50,
    mlRegime: 'Low-Vol Bullish',
    weekday: 2,
    vwapExtPct: 0.2,
    pctOfRange: 60,
    ...over,
  };
}

/** n trades in one bucket, alternating around `mean` so the bootstrap has real
 *  spread rather than a degenerate zero-variance sample. */
function bucket(n: number, mean: number, over: Partial<LeakTrade> = {}): LeakTrade[] {
  return Array.from({ length: n }, (_, i) => trade({ ...over, r: mean + (i % 2 === 0 ? 0.02 : -0.02) }));
}

const scan = (live: LeakTrade[], paper: LeakTrade[] = [], over: Partial<Parameters<typeof runEdgeLeakScan>[0]> = {}) =>
  runEdgeLeakScan({
    books: ['live', 'paper'],
    live: { trades: live, sessionDates: ['2026-09-08'], droppedTrades: 0 },
    paper: { trades: paper, sessionDates: ['2026-09-08'], droppedTrades: 0 },
    lookbackSessions: 40,
    storedTargetR: 2.4,
    execution: [],
    configuration: [],
    entrySlippagePct: [],
    entryLimitBufferPct: MARKETABLE_LIMIT_BUFFER_PCT,
    entryDriftPct: [],
    journalSkips: [],
    asOf: Date.parse('2026-09-08T21:00:00Z'),
    rng: RNG(),
    ...over,
  });

describe('the bar — one rule for every dimension', () => {
  it('calls a bucket a LEAK only when the paper control agrees', () => {
    const live = {
      bucket: 'r2',
      n: 20,
      meanR: -0.2,
      totalR: -4,
      totalPnlUsd: -400,
      ciLow: -0.3,
      ciHigh: -0.1,
      pValue: 0.01,
    };
    const agreeing = { ...live, bucket: 'r2', n: 12, meanR: -0.05, totalR: -0.6, totalPnlUsd: -60 };
    expect(verdictFor(live, agreeing).verdict).toBe('leak');
    // Paper made money in the same bucket → this is execution, not the
    // decision, and the scan must not hand it the decision's lever.
    expect(verdictFor(live, { ...agreeing, meanR: 0.2 }).verdict).toBe('watch');
    // Paper has too few trades to say anything at all.
    expect(verdictFor(live, { ...agreeing, n: CONTROL_MIN_TRADES - 1 }).verdict).toBe('unconfirmed');
    expect(verdictFor(live, null).verdict).toBe('unconfirmed');
  });

  it('will not call a thin bucket a leak, however bad it looks', () => {
    const thin = {
      bucket: 'x',
      n: LEAK_MIN_TRADES - 1,
      meanR: -0.5,
      totalR: -7,
      totalPnlUsd: -700,
      ciLow: -0.7,
      ciHigh: -0.3,
      pValue: 0.001,
    };
    const control = { ...thin, n: 30 };
    expect(verdictFor(thin, control).verdict).toBe('watch');
    const tooThin = { ...thin, n: WATCH_MIN_TRADES - 1 };
    expect(verdictFor(tooThin, control).verdict).toBe('ok');
  });

  it('a bucket whose interval straddles zero is not a leak, whatever its mean', () => {
    const noisy = {
      bucket: 'x',
      n: 40,
      meanR: -0.3,
      totalR: -12,
      totalPnlUsd: -1200,
      ciLow: -0.9,
      ciHigh: 0.4,
      pValue: 0.4,
    };
    expect(verdictFor(noisy, { ...noisy, n: 30 }).verdict).toBe('ok');
  });
});

describe('the round dimension — the leak the operator had to point at', () => {
  it('reports round 2 as a leak in both books, with the cooldown as its lever', () => {
    const live = [...bucket(30, 0.12, { round: 1 }), ...bucket(20, -0.14, { round: 2, symbol: 'BBB' })];
    const paper = [...bucket(30, 0.2, { round: 1, book: 'paper' }), ...bucket(14, -0.05, { round: 2, book: 'paper' })];
    const result = scan(live, paper);

    const leak = result.leaks.find((l) => l.dimension === 'round' && l.bucket === '2');
    expect(leak).toBeTruthy();
    expect(leak?.verdict).toBe('leak');
    expect(leak?.lever).toMatchObject({ kind: 'config', field: 'symbolReentryCooldownMinutes', value: 390 });
    // A leak's severity is the R it took off the table, so the report can be
    // ordered by what it actually cost.
    expect(leak?.severityR).toBeGreaterThan(2);
    // …and round 1, which carries the edge, is not reported at all.
    expect(result.leaks.some((l) => l.dimension === 'round' && l.bucket === '1')).toBe(false);
  });

  it('a lever only ever attaches to a bucket that failed the bar', () => {
    const result = scan(bucket(30, 0.2, { round: 2 }), bucket(30, 0.2, { round: 2, book: 'paper' }));
    const round = result.dimensions.find((d) => d.id === 'round');
    expect(round?.buckets.every((b) => b.lever === null)).toBe(true);
  });
});

describe('coverage — a trade with no value for a cut is excluded, never pooled', () => {
  it('counts uncovered trades rather than filing them under "unknown"', () => {
    const live = [...bucket(10, 0.1, { score: null }), ...bucket(10, 0.1, { score: 75 })];
    const result = scan(live);
    const dim = result.dimensions.find((d) => d.id === 'scoreBand');
    expect(dim?.covered).toBe(10);
    expect(dim?.uncovered).toBe(10);
    expect(dim?.buckets.map((b) => b.bucket)).toEqual(['70-79']);
  });

  it('drops a per-symbol bucket too thin to mean anything', () => {
    const live = [...bucket(4, -0.5, { symbol: 'THIN' }), ...bucket(12, 0.1, { symbol: 'DEEP' })];
    const dim = scan(live).dimensions.find((d) => d.id === 'symbol');
    expect(dim?.buckets.map((b) => b.bucket)).toEqual(['DEEP']);
  });

  it('every dimension in the catalog is reported, so a cut cannot silently vanish', () => {
    const result = scan(bucket(20, 0.1));
    expect(result.dimensions.map((d) => d.id)).toEqual(DIMENSIONS.map((d) => d.id));
  });
});

describe('the session window — every section reads the same trades (2026-09-18)', () => {
  // The collector hands over EVERY closed trade beside the window it chose,
  // and until this only the day level and `coverage.sessions` honoured
  // `sessionDates`: `?sessions=1` returned forty sessions of buckets labelled
  // as one, and paired them against journal skips that WERE bounded to the
  // window, so a one-session read inflated `no_live_row` (145 against 104 on
  // the deployed book) with paper trades from sessions the skip read never
  // covered.
  const at = (date: string, time: string): number => etDateTimeToMs(date, time) as number;
  const on = (date: string, over: Partial<LeakTrade> = {}): LeakTrade =>
    trade({ etDate: date, entryAt: at(date, '10:00'), exitAt: at(date, '10:30'), ...over });
  const many = (n: number, date: string, over: Partial<LeakTrade> = {}): LeakTrade[] =>
    Array.from({ length: n }, (_, i) => on(date, { r: -0.2 + (i % 2 === 0 ? 0.02 : -0.02), ...over }));

  it('narrows the buckets, the attribution and the coverage to the window, and counts what it left out', () => {
    const live = [...many(12, '2026-09-08'), ...many(12, '2026-09-09'), ...many(12, '2026-09-10')];
    const paper = [
      on('2026-09-08', { book: 'paper', symbol: 'OLD', r: 0.5 }),
      on('2026-09-10', { book: 'paper', symbol: 'NEW', r: 0.5 }),
    ];
    const result = scan(live, paper, {
      live: { trades: live, sessionDates: ['2026-09-10'], droppedTrades: 0 },
      paper: { trades: paper, sessionDates: ['2026-09-10'], droppedTrades: 0 },
    });
    expect(result.coverage).toMatchObject({
      liveTrades: 12,
      paperTrades: 1,
      liveOutsideWindow: 24,
      paperOutsideWindow: 1,
      sessions: 1,
    });
    // The buckets read the window's twelve, not the book's thirty-six.
    const round = result.dimensions.find((d) => d.id === 'round');
    expect(round?.buckets.find((b) => b.bucket === '1')?.n).toBe(12);
    expect(round?.covered).toBe(12);
    // The paper trade from a session outside the window is not an unexplained
    // refusal of it — that is exactly the inflation this removes.
    expect(result.attribution.untaken).toHaveLength(1);
    expect(result.attribution.untaken[0]).toMatchObject({ reason: 'no_live_row', n: 1 });
    expect(result.dayLevel.sessions).toBe(1);
  });

  it('keeps a trade stamped on a non-session date INSIDE the window, for the day level to remap', () => {
    // 2026-09-07 is Labor Day. A row the calendar disagrees with is the day
    // level's to fold onto its neighbouring session (buildSessionPaths already
    // does), not the window's to drop — so the window is a date range, not a
    // membership test against the calendar's sessions.
    const live = [...many(12, '2026-09-04'), ...many(12, '2026-09-07'), ...many(12, '2026-09-08')];
    const result = scan(live, [], {
      live: { trades: live, sessionDates: ['2026-09-04', '2026-09-08'], droppedTrades: 0 },
    });
    expect(result.coverage.liveTrades).toBe(36);
    expect(result.coverage.liveOutsideWindow).toBe(0);
  });

  it('reads the whole book when the window covers it, so a full read is unchanged', () => {
    const result = scan(bucket(20, 0.1));
    expect(result.coverage.liveTrades).toBe(20);
    expect(result.coverage.liveOutsideWindow).toBe(0);
    expect(result.coverage.paperOutsideWindow).toBe(0);
  });
});

describe('the day level — the goal rate and what the red days were made of', () => {
  const at = (date: string, time: string): number => etDateTimeToMs(date, time) as number;

  it('counts the sessions that REACHED the goal, not the ones that closed above it', () => {
    const dates = ['2026-09-08', '2026-09-09', '2026-09-10'];
    const live: LeakTrade[] = [
      // Session 1 reaches 2.4R and then gives half of it back — reached.
      trade({ etDate: dates[0], entryAt: at(dates[0], '09:35'), exitAt: at(dates[0], '10:00'), r: 2.5 }),
      trade({ etDate: dates[0], entryAt: at(dates[0], '09:40'), exitAt: at(dates[0], '11:00'), r: -1.2 }),
      // Session 2 clears 1R but never gets near the stored goal.
      trade({ etDate: dates[1], entryAt: at(dates[1], '09:35'), exitAt: at(dates[1], '10:00'), r: 1.1 }),
      // Session 3 does.
      trade({ etDate: dates[2], entryAt: at(dates[2], '09:35'), exitAt: at(dates[2], '10:00'), r: 3 }),
    ];
    const day = buildDayLevel(live, dates, 2.4);
    expect(day.activeSessions).toBe(3);
    expect(day.goalReachedSessions).toBe(2);
    expect(day.goalRatePct).toBeCloseTo(66.67, 1);
    // The same book against a 1R goal reaches it on all three — the goal's
    // height in R is the whole mechanism, and the only thing that changed
    // between these two counts is where the line sits.
    expect(buildDayLevel(live, dates, 1).goalReachedSessions).toBe(3);
    expect(buildDayLevel(live, dates, 1).goalRatePct).toBe(100);
  });

  it('names what produced the red days, biggest loss first', () => {
    const dates = ['2026-09-08', '2026-09-09'];
    const live: LeakTrade[] = [
      trade({
        etDate: dates[0],
        entryAt: at(dates[0], '09:35'),
        exitAt: at(dates[0], '10:00'),
        r: -1.5,
        exitReason: 'stop_loss',
      }),
      trade({
        etDate: dates[0],
        entryAt: at(dates[0], '10:05'),
        exitAt: at(dates[0], '11:00'),
        r: -0.4,
        exitReason: 'stagnation',
      }),
      trade({
        etDate: dates[1],
        entryAt: at(dates[1], '09:35'),
        exitAt: at(dates[1], '10:00'),
        r: 1.2,
        exitReason: 'target',
      }),
    ];
    const day = buildDayLevel(live, dates, 2.4);
    expect(day.redSessions).toBe(1);
    expect(day.meanRedSessionR).toBeCloseTo(-1.9, 4);
    expect(day.worstSessionR).toBeCloseTo(-1.9, 4);
    expect(day.redSessionDrivers.map((d) => d.reason)).toEqual(['stop_loss', 'stagnation']);
    // A winner on a red day is not a driver of it.
    expect(day.redSessionDrivers.every((d) => d.totalR < 0)).toBe(true);
    // Each driver says when it last contributed.
    expect(day.redSessionDrivers.every((d) => d.lastSeenEtDate === dates[0])).toBe(true);
  });

  it('dates an unrecorded exit reason, so old gaps do not read as current losses', () => {
    // The live book on 2026-09-12: `unknown` was the LARGEST red-day driver at
    // -4.32R over 3 trades — worse PER TRADE than an actual stop, which reads
    // like trades blowing through their stops. All 35 such rows were from
    // 2026-07-13..08-24, before exit-reason recording was fixed; none since.
    // A forty-session window shows that for weeks, and Decision 9's review
    // reads this list, so the date has to travel with it.
    const dates = ['2026-09-08', '2026-09-09'];
    const live = [
      trade({
        etDate: dates[0],
        entryAt: at(dates[0], '09:35'),
        exitAt: at(dates[0], '10:00'),
        r: -1.5,
        exitReason: null,
      }),
      trade({
        etDate: dates[1],
        entryAt: at(dates[1], '09:35'),
        exitAt: at(dates[1], '10:00'),
        r: -0.5,
        exitReason: 'stop_loss',
      }),
    ];
    const day = buildDayLevel(live, dates, 2.4);
    const byReason = new Map(day.redSessionDrivers.map((d) => [d.reason, d]));
    expect(byReason.get('unknown')?.lastSeenEtDate).toBe(dates[0]);
    expect(byReason.get('stop_loss')?.lastSeenEtDate).toBe(dates[1]);
  });

  it('reports no goal rate at all when no goal is armed', () => {
    const day = buildDayLevel(bucket(3, 0.5), ['2026-09-08'], null);
    expect(day.storedTargetR).toBeNull();
    expect(day.goalReachedSessions).toBe(0);
  });
});

describe('attribution — where the live book loses the paper book’s edge', () => {
  const date = '2026-09-08';
  const at = (time: string): number => etDateTimeToMs(date, time) as number;
  /** A batch-level refusal row — the kind that names no symbol. */
  const ewc = (ms: number): BatchRefusal => ({ at: ms, action: 'entry_window_closed' });
  const halted = (ms: number): BatchRefusal => ({ at: ms, action: 'live_entries_halted' });

  it('pairs the same decision in both books and reports the difference', () => {
    const live = [trade({ symbol: 'NVDA', entryAt: at('09:35'), r: 0.1 })];
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35') + 20_000, r: 0.4 })];
    // Slippage rows are NEGATIVE by construction — a marketable limit fills at
    // or inside its own price — so the fixture uses numbers the producer can
    // actually emit. It used to use +0.3/+0.5, a shape no fill can have.
    const a = buildAttribution(live, paper, [], [], [-0.3, -0.5], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(1);
    expect(a.meanDiffR).toBeCloseTo(-0.3, 4);
    expect(a.meanEntrySlippagePct).toBeCloseTo(-0.4, 2);
    // …and the readable version of the same rows: 0.5% buffer, 0.4% given back
    // at the fill, so 0.1% of the concession was actually paid.
    expect(a.entryLimitBufferPct).toBe(MARKETABLE_LIMIT_BUFFER_PCT);
    expect(a.meanEntryBufferConsumedPct).toBeCloseTo(0.1, 2);
    expect(a.untaken).toEqual([]);
  });

  it('pairs the same name on the same session even half an hour apart, and says how far', () => {
    // The old rule required 60 seconds, on the premise that both books decide
    // in one tick. Measured on the deployed book: of 39 paper entries with a
    // live entry on the same symbol AND date, only SEVEN were inside 60s and
    // the median gap was 1,613s — 27 minutes. The books diverge by design
    // (paper waits for no buying power, live's floor is 72 against paper's 60,
    // live's cooldowns defer what paper takes at once), so the window was
    // throwing away 32 of 39 real pairs — and those 32 then fell through to
    // classifyUntaken and were reported as `no_live_row`, i.e. a name the live
    // book genuinely traded counted as an unexplained refusal.
    const live = [trade({ symbol: 'NVDA', entryAt: at('09:35'), r: 0.1 })];
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('10:05'), r: 0.4 })];
    const a = buildAttribution(live, paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(1);
    expect(a.untaken).toEqual([]);
    // The looseness is REPORTED, not hidden in a constant.
    expect(a.medianPairGapMinutes).toBe(30);
  });

  // 2026-09-23: COIN on 09-21. Paper entered at 09:36:53 (the same tick the
  // live book placed COIN) and again at 10:02:07; live entered once, 09:36.
  // Walking the paper list newest first, the 10:02 re-entry took the live
  // trade and the 09:36 twin read `no_live_row`.
  it('gives the live trade to the paper entry nearest it, whatever order the paper book lists them in', () => {
    const live = [trade({ symbol: 'COIN', entryAt: at('09:36'), r: -0.02 })];
    const twin = trade({ symbol: 'COIN', book: 'paper', entryAt: at('09:36') + 53_000, r: -1 });
    const reentry = trade({ symbol: 'COIN', book: 'paper', entryAt: at('10:02') + 7_000, r: -1.1 });
    const cooldown = {
      symbol: 'COIN',
      at: at('10:02') + 7_000,
      action: 'symbol_reentry_cooldown_skipped',
      failedRule: null,
    };
    for (const paper of [
      [reentry, twin],
      [twin, reentry],
    ]) {
      const a = buildAttribution(live, paper, [cooldown], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
      expect(a.pairedTrades).toBe(1);
      // Paired with its twin: -0.02 - (-1), not -0.02 - (-1.1).
      expect(a.meanDiffR).toBeCloseTo(0.98, 4);
      expect(a.medianPairGapMinutes).toBeCloseTo(0.88, 2);
      // The re-entry is the one left over, filed under the live journal's word for it.
      expect(a.untaken).toEqual([
        expect.objectContaining({ reason: 'symbol_reentry_cooldown_skipped', n: 1, paperTotalR: -1.1 }),
      ]);
    }
  });

  // 2026-09-23. Both books carry their option trades, and the pairing matched
  // on symbol and date alone: COIN 09-18's paper stock entry at 11:18 was set
  // against the live OPTION at 11:10 rather than the live stock trade at 09:56,
  // and an untaken paper option was filed under whatever stock refusal hit the
  // same name that minute (7 of the 10 under the live floor were options).
  it('keeps option trades out of the stock attribution, and counts them', () => {
    const live = [
      trade({ symbol: 'COIN', assetKind: 'options', entryAt: at('11:10'), r: 0.84 }),
      trade({ symbol: 'COIN', entryAt: at('09:56'), r: 0.63 }),
    ];
    const paper = [
      trade({ symbol: 'COIN', book: 'paper', entryAt: at('11:18'), r: 0.27 }),
      trade({ symbol: 'SMCI', book: 'paper', assetKind: 'options', entryAt: at('10:00'), r: 0.3 }),
    ];
    const floor: JournalSkip = {
      symbol: 'SMCI',
      at: at('10:00'),
      action: 'live_score_floor_skipped',
      failedRule: null,
    };
    const a = buildAttribution(live, paper, [floor], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(1);
    // The stock trade, 82 minutes away, not the option 8 minutes away.
    expect(a.pairs).toEqual([expect.objectContaining({ symbol: 'COIN', liveR: 0.63, paperR: 0.27 })]);
    expect(a.meanDiffR).toBeCloseTo(0.36, 4);
    // The paper option is not a stock refusal's: it is counted, not classified.
    expect(a.untaken).toEqual([]);
    expect(a.optionsExcluded).toEqual({ live: 1, paper: 1 });
  });

  // IRD, 09-09: paper entered at 09:36:31, live placed at 09:36:34. Live's
  // resting stop filled at 6.13 inside three minutes; paper's once-a-minute
  // quote never read under its stop and it went on to +0.40R. TNON, 09-11:
  // the same name 22 minutes apart, a pair but not the same entry.
  it('lists every pair, newest first, and marks the ones made in one tick', () => {
    const live = [
      trade({ symbol: 'IRD', entryAt: at('09:36'), entryMinuteEt: 576, r: -1.18, exitReason: 'stop' }),
      trade({ symbol: 'TNON', entryAt: at('12:16'), entryMinuteEt: 736, r: -1.16, exitReason: 'stop' }),
    ];
    const paper = [
      trade({
        symbol: 'IRD',
        book: 'paper',
        entryAt: at('09:36') + 31_000,
        entryMinuteEt: 576,
        r: 0.4,
        exitReason: 'stop',
      }),
      trade({ symbol: 'TNON', book: 'paper', entryAt: at('11:54'), entryMinuteEt: 714, r: 1.25, exitReason: 'target' }),
    ];
    const a = buildAttribution(live, paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairs.map((p) => p.symbol)).toEqual(['TNON', 'IRD']);
    expect(a.pairs[1]).toEqual({
      symbol: 'IRD',
      etDate: date,
      paperEntryTimeEt: '09:36',
      liveEntryTimeEt: '09:36',
      liveLagMinutes: -0.52,
      paperR: 0.4,
      liveR: -1.18,
      diffR: -1.58,
      paperExitReason: 'stop',
      liveExitReason: 'stop',
      sameTick: true,
    });
    expect(a.pairs[0]).toMatchObject({ liveLagMinutes: 22, sameTick: false, paperExitReason: 'target' });
    // The same-tick reading is IRD alone; TNON's later entry is not in it.
    expect(a.sameTick).toMatchObject({ n: 1, meanDiffR: -1.58 });
    expect(a.pairedTrades).toBe(2);
  });

  it('counts a pair as one tick up to PAIR_TOLERANCE_MS and no further', () => {
    const live = [
      trade({ symbol: 'AAA', entryAt: at('10:00'), r: 0 }),
      trade({ symbol: 'BBB', entryAt: at('10:00'), r: 0 }),
    ];
    const paper = [
      trade({ symbol: 'AAA', book: 'paper', entryAt: at('10:00') + PAIR_TOLERANCE_MS, r: 0.2 }),
      trade({ symbol: 'BBB', book: 'paper', entryAt: at('10:00') + PAIR_TOLERANCE_MS + 1000, r: 0.5 }),
    ];
    const a = buildAttribution(live, paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(2);
    expect(a.sameTick).toMatchObject({ n: 1, meanDiffR: -0.2 });
  });

  it('reads nothing into the same tick when no pair was made in one', () => {
    const a = buildAttribution([], [], [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.sameTick).toEqual({ n: 0, meanDiffR: null, ciLow: null, ciHigh: null });
    expect(a.pairs).toEqual([]);
    expect(a.optionsExcluded).toEqual({ live: 0, paper: 0 });
  });

  it('still refuses to pair across DIFFERENT sessions', () => {
    // Symbol + ET date, not symbol alone: yesterday's trade in the same name is
    // a different decision by any reading.
    const live = [trade({ symbol: 'NVDA', etDate: '2026-09-07', entryAt: at('09:35') - 86_400_000, r: 0.1 })];
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35'), r: 0.4 })];
    const a = buildAttribution(live, paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(0);
    expect(a.untaken).toHaveLength(1);
  });

  it('classifies an untaken paper winner by the live journal’s own word for it', () => {
    const paper = [
      trade({ symbol: 'HOOD', book: 'paper', entryAt: at('09:35'), r: 0.9 }),
      trade({ symbol: 'SMCI', book: 'paper', entryAt: at('10:35'), r: -0.5 }),
      trade({ symbol: 'QQQ', book: 'paper', entryAt: at('11:35'), r: 0.2 }),
    ];
    const a = buildAttribution(
      [],
      paper,
      [
        { symbol: 'HOOD', at: at('09:35') + 5_000, action: 'live_score_floor_skipped', failedRule: null },
        { symbol: 'SMCI', at: at('10:35'), action: 'live_risk_blocked', failedRule: 'max_concurrent_positions' },
      ],
      [],
      [],
      MARKETABLE_LIMIT_BUFFER_PCT,
      RNG(),
    );
    const byReason = new Map(a.untaken.map((u) => [u.reason, u]));
    expect(byReason.get('live_score_floor_skipped')?.paperTotalR).toBeCloseTo(0.9, 4);
    expect(byReason.get('live_risk_blocked:max_concurrent_positions')?.n).toBe(1);
    // Nothing in the journal is "no_live_row", not a guess at a cause.
    expect(byReason.get('no_live_row')?.n).toBe(1);
  });

  it('lists each class’s entries newest first, so a count can be checked trade by trade', () => {
    // 2026-09-23: `no_live_row` read 53 entries (+4.42R) and nothing said which,
    // so "explain the 53" had nothing to check against the journal.
    const paper = [
      trade({ symbol: 'HOOD', book: 'paper', entryAt: at('09:35'), entryMinuteEt: 9 * 60 + 35, r: 0.9 }),
      trade({ symbol: 'QQQ', book: 'paper', entryAt: at('11:35'), entryMinuteEt: 11 * 60 + 35, r: 0.2 }),
      trade({ symbol: 'IWM', book: 'paper', entryAt: at('10:05'), entryMinuteEt: null, r: -0.12344 }),
    ];
    const a = buildAttribution([], paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.untaken).toHaveLength(1);
    expect(a.untaken[0]).toMatchObject({ reason: 'no_live_row', n: 3 });
    expect(a.untaken[0].trades).toEqual([
      { symbol: 'QQQ', etDate: date, entryTimeEt: '11:35', r: 0.2 },
      { symbol: 'IWM', etDate: date, entryTimeEt: null, r: -0.1234 },
      { symbol: 'HOOD', etDate: date, entryTimeEt: '09:35', r: 0.9 },
    ]);
  });

  it('attributes a batch entry_window_closed refusal BY TIME, not by symbol', () => {
    // The end-of-day cutoff refuses the whole batch before the per-candidate
    // loop, so its journal row carries a count and NO symbol — the one live
    // refusal nothing else here can see. Before this, every paper entry it
    // declined was reported as `no_live_row`: the largest untaken bucket, the
    // one the evening routine watches, and the bucket whose whole meaning is
    // "nothing the journal explains". A gate doing exactly its job was reading
    // as a hole in the record.
    const paper = [
      trade({ symbol: 'GAP', book: 'paper', entryAt: at('15:56'), r: -0.2 }),
      trade({ symbol: 'ESTC', book: 'paper', entryAt: at('15:56') + 30_000, r: 0.1 }),
    ];
    const a = buildAttribution([], paper, [], [ewc(at('15:56') + 2_000)], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    const byReason = new Map(a.untaken.map((u) => [u.reason, u]));
    expect(byReason.get('entry_window_closed')?.n).toBe(2);
    expect(byReason.get('no_live_row')).toBeUndefined();
  });

  it('attributes the live book standing down on a BANKED day', () => {
    // The other batch refusal, and the one that matters more as the book gets
    // better: when the day has banked at +3% the live path journals nothing
    // per symbol while paper keeps trading, so every paper entry after the
    // reach read as `no_live_row`. Fourteen of the ninety-seven unexplained
    // entries on the book were exactly this, all on the three days the target
    // was reached. Banking the day is the plan's GOAL — it must not accumulate
    // evidence that the strategy is leaking.
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('14:10'), r: 0.6 })];
    const a = buildAttribution([], paper, [], [halted(at('14:10') + 3_000)], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.untaken[0].reason).toBe('live_entries_halted');
  });

  // 2026-09-23. The live path journals most refusals ONCE per symbol per day,
  // so the only row for the live floor refusing NVDA all day is the first one.
  // A paper entry on NVDA hours later found no row within its minute and read
  // as "nothing the journal explains", the largest untaken bucket on the book.
  describe('a refusal the journal records once a day stands for the rest of that day', () => {
    const skip = (symbol: string, time: string, action: string, day = date): JournalSkip => ({
      symbol,
      at: etDateTimeToMs(day, time) as number,
      action,
      failedRule: null,
    });
    const classify = (paperAt: number, skips: JournalSkip[], batch: BatchRefusal[] = []) =>
      buildAttribution(
        [],
        [trade({ symbol: 'NVDA', book: 'paper', entryAt: paperAt, r: 0.4 })],
        skips,
        batch,
        [],
        MARKETABLE_LIMIT_BUFFER_PCT,
        RNG(),
      ).untaken[0].reason;

    it('files a paper entry under the floor refusal journaled at 09:40, not under no_live_row', () => {
      expect(classify(at('11:00'), [skip('NVDA', '09:40', 'live_score_floor_skipped')])).toBe(
        'live_score_floor_skipped',
      );
      // The latest standing refusal wins when there are several.
      expect(
        classify(at('11:00'), [
          skip('NVDA', '09:40', 'live_score_floor_skipped'),
          skip('NVDA', '10:15', 'symbol_cooldown_skipped'),
        ]),
      ).toBe('symbol_cooldown_skipped');
    });

    it('does not let an every-tick refusal from earlier stand in for a later one', () => {
      // These journal on every tick they refuse, so silence at 11:00 means they
      // had stopped refusing by then.
      expect(classify(at('11:00'), [skip('NVDA', '09:40', 'symbol_reentry_cooldown_skipped')])).toBe('no_live_row');
      expect(classify(at('11:00'), [{ ...skip('NVDA', '09:40', 'live_risk_blocked'), failedRule: 'x' }])).toBe(
        'no_live_row',
      );
    });

    it('reads only the same day, only before the entry, and only this symbol', () => {
      expect(classify(at('11:00'), [skip('NVDA', '09:40', 'live_score_floor_skipped', '2026-09-04')])).toBe(
        'no_live_row',
      );
      expect(classify(at('11:00'), [skip('NVDA', '11:30', 'live_score_floor_skipped')])).toBe('no_live_row');
      expect(classify(at('11:00'), [skip('AMD', '09:40', 'live_score_floor_skipped')])).toBe('no_live_row');
    });

    it('still prefers the refusal in the same minute, and a batch refusal of that tick', () => {
      expect(
        classify(at('11:00'), [
          skip('NVDA', '09:40', 'live_score_floor_skipped'),
          {
            symbol: 'NVDA',
            at: at('11:00') + 5_000,
            action: 'live_risk_blocked',
            failedRule: 'max_concurrent_positions',
          },
        ]),
      ).toBe('live_risk_blocked:max_concurrent_positions');
      expect(classify(at('15:56'), [skip('NVDA', '09:40', 'live_score_floor_skipped')], [ewc(at('15:56'))])).toBe(
        'entry_window_closed',
      );
    });

    it('covers exactly the once-a-day writers, and none of the every-tick ones', () => {
      // Every action the declined-entry path journals through its once-per-day
      // writer is in the set (liveExecute.ts, journalDeclinedEntry). A new one
      // added there without joining the set would fall back into no_live_row.
      for (const a of [
        'live_score_floor_skipped',
        'regime_score_floor_skipped',
        'finish_line_skipped',
        'symbol_cooldown_skipped',
        'live_symbol_held_skipped',
        'risk_atr_unreachable_skipped',
        'symbol_unplaceable_skipped',
        'absorbed_price_skipped',
        'live_short_skipped',
      ]) {
        expect(ONCE_PER_DAY_SKIP_ACTIONS.has(a)).toBe(true);
      }
      expect(ONCE_PER_DAY_SKIP_ACTIONS.has('symbol_reentry_cooldown_skipped')).toBe(false);
      expect(ONCE_PER_DAY_SKIP_ACTIONS.has('live_risk_blocked')).toBe(false);

      // And read off the source, so a writer added later cannot slip past a
      // list someone forgot to update: every literal action the live equity
      // path hands journalDeclinedEntry, and every action the score gate can
      // return, is a once-a-day row.
      const live = readFileSync(join(__dirname, '../src/services/autotrading/liveExecute.ts'), 'utf8');
      const declined = [...live.matchAll(/journalDeclinedEntry\(\s*candidateSignal,\s*'([a-z_]+)'/g)].map((m) => m[1]);
      expect(declined.length).toBeGreaterThanOrEqual(5);
      const gate = readFileSync(join(__dirname, '../src/services/autotrading/entryScoreGate.ts'), 'utf8');
      const gateActions = [...gate.matchAll(/action: ('[a-z_]+'(?:\s*\|\s*'[a-z_]+')*)/g)]
        .flatMap((m) => m[1].split('|'))
        .map((a) => a.trim().replace(/'/g, ''));
      expect(gateActions).toContain('live_score_floor_skipped');
      for (const a of [...declined, ...gateActions]) expect([a, ONCE_PER_DAY_SKIP_ACTIONS.has(a)]).toEqual([a, true]);
    });
  });

  it('leaves a paper entry OUTSIDE any batch refusal as no_live_row', () => {
    // The honest half. A tick where the live book had no candidates journals
    // nothing, and nothing refused that name — so the gap stays a gap rather
    // than borrowing the nearest batch row for a cause.
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35'), r: 0.4 })];
    const a = buildAttribution([], paper, [], [ewc(at('15:56'))], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.untaken).toHaveLength(1);
    expect(a.untaken[0].reason).toBe('no_live_row');
  });

  it('prefers the symbol-named refusal over the batch one when both cover the tick', () => {
    // A named reason is strictly more informative than "the window was shut",
    // and the two can overlap: the batch row is written once per tick while a
    // per-symbol skip names this candidate.
    const paper = [trade({ symbol: 'HOOD', book: 'paper', entryAt: at('15:56'), r: 0.3 })];
    const a = buildAttribution(
      [],
      paper,
      [{ symbol: 'HOOD', at: at('15:56'), action: 'live_score_floor_skipped', failedRule: null }],
      [ewc(at('15:56'))],
      [],
      MARKETABLE_LIMIT_BUFFER_PCT,
      RNG(),
    );
    expect(a.untaken[0].reason).toBe('live_score_floor_skipped');
  });

  it('never pairs one live trade with two paper trades', () => {
    const live = [trade({ symbol: 'NVDA', entryAt: at('09:35'), r: 0.1 })];
    const paper = [
      trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35') + 5_000, r: 0.4 }),
      trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35') + 10_000, r: 0.6 }),
    ];
    const a = buildAttribution(live, paper, [], [], [], MARKETABLE_LIMIT_BUFFER_PCT, RNG());
    expect(a.pairedTrades).toBe(1);
    expect(a.untaken.reduce((s, u) => s + u.n, 0)).toBe(1);
  });
});

describe('is the CONTROL the same book all the way through', () => {
  // Every "leak" verdict requires the paper control to agree in sign, so a
  // control that changed behaviour mid-window can make a bucket read as a leak
  // (or not) because of WHEN its trades happened. On 2026-09-12 that was not
  // hypothetical: the paper book gained the end-of-day flatten on 09-05 and
  // inside one 40-session window read as two books — 37 of 71 earlier trades
  // were overnight holds against 0 of 37 later ones, and its own mean R went
  // +0.262 to +0.013.
  const at = (mins: number): number => Date.parse('2026-09-08T13:30:00Z') + mins * 60_000;

  it('reports the drift between the control’s two halves', () => {
    const paper = [
      ...Array.from({ length: 5 }, (_, i) => trade({ book: 'paper', entryAt: at(i), r: 0.5 })),
      ...Array.from({ length: 5 }, (_, i) => trade({ book: 'paper', entryAt: at(100 + i), r: -0.1 })),
    ];
    const d = paperControlDrift(paper);
    expect(d.earlyMeanR).toBeCloseTo(0.5, 4);
    expect(d.lateMeanR).toBeCloseTo(-0.1, 4);
    expect(d.driftR).toBeCloseTo(0.6, 4);
  });

  it('says nothing rather than guessing on a control too small to split', () => {
    // Seven trades cannot tell drift from noise, and a confident number there
    // would be worse than no number.
    const paper = Array.from({ length: 7 }, (_, i) => trade({ book: 'paper', entryAt: at(i), r: 0.2 }));
    expect(paperControlDrift(paper)).toEqual({ earlyMeanR: null, lateMeanR: null, driftR: null });
  });

  it('is ordered by entry time, not by the order the rows arrived', () => {
    const paper = [
      trade({ book: 'paper', entryAt: at(200), r: -1 }),
      ...Array.from({ length: 4 }, (_, i) => trade({ book: 'paper', entryAt: at(i), r: 1 })),
      ...Array.from({ length: 3 }, (_, i) => trade({ book: 'paper', entryAt: at(210 + i), r: -1 })),
    ];
    const d = paperControlDrift(paper);
    expect(d.earlyMeanR).toBeCloseTo(1, 4); // the four earliest, whatever order they came in
    expect(d.lateMeanR).toBeCloseTo(-1, 4);
  });
});

describe('findings — a thing that happened, not a distribution', () => {
  it('reports any execution occurrence and any configuration mismatch', () => {
    const result = scan(bucket(5, 0.1), [], {
      execution: [{ action: 'live_options_exit_failed', count: 3 }],
      configuration: [
        {
          id: 'configuration:frozen:liveOptionsMaxOrderUsd',
          kind: 'configuration',
          label: 'liveOptionsMaxOrderUsd is frozen out of re-anchoring',
          count: 1,
          detail: 'stored $300 vs $273 derived',
          lever: {
            kind: 'config',
            field: 'liveOptionsMaxOrderUsd',
            value: 273,
            direction: 'safe',
            detail: 'hand it back to the anchor',
          },
        },
      ],
    });
    expect(result.findings.map((f) => f.kind)).toEqual(['execution', 'configuration']);
    expect(result.findings[0].count).toBe(3);
    // An execution failure is a defect to FIX, never a setting to loosen.
    expect(result.findings[0].lever?.kind).toBe('code');
  });
});

describe('entry drift — the price we place at vs the price we decided at', () => {
  // Two quantities both called slippage. `entrySlippagePct` measures the FILL
  // against the LIMIT and is structurally <= 0; this measures the placement
  // quote against the price the risk budget was computed from, and has no sign
  // restriction. Mixing them is how "mean slippage is negative, so we are
  // fine" hid an entry risking 1.46x what it was approved for.
  const drift = (n: number, pct: number) => Array.from({ length: n }, () => pct);

  it('says nothing when the drift is inside the buffer the loop concedes on purpose', () => {
    const result = scan(bucket(20, 0.1), [], { entryDriftPct: drift(20, 0.4) });
    expect(result.findings.some((f) => f.id === 'execution:entry_drift')).toBe(false);
  });

  it('raises a finding once the drift exceeds the buffer', () => {
    const result = scan(bucket(20, 0.1), [], { entryDriftPct: drift(20, 1.2) });
    const finding = result.findings.find((f) => f.id === 'execution:entry_drift');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(20);
    expect(finding?.detail).toContain('1.2%');
    expect(finding?.lever?.direction).toBe('safe');
  });

  it('stays quiet under the minimum count, however bad the drift', () => {
    const result = scan(bucket(20, 0.1), [], { entryDriftPct: drift(ENTRY_DRIFT_MIN_TRADES - 1, 5) });
    expect(result.findings.some((f) => f.id === 'execution:entry_drift')).toBe(false);
  });

  it('does not let favourable drift cancel adverse drift', () => {
    // The reason the collector signs the number instead of taking |x|: a book
    // that pays up 3% half the time and saves 3% the other half is not a calm
    // book, but a mean of zero would read as one. Signed, the mean is honest —
    // and here it is 0, which is genuinely below the bar, so the assertion is
    // that the SHAPE survives: ten 3% rows on their own do fire.
    const mixed = [...drift(10, 3), ...drift(10, -3)];
    expect(
      scan(bucket(20, 0.1), [], { entryDriftPct: mixed }).findings.some((f) => f.id === 'execution:entry_drift'),
    ).toBe(false);
    expect(
      scan(bucket(20, 0.1), [], { entryDriftPct: drift(10, 3) }).findings.some((f) => f.id === 'execution:entry_drift'),
    ).toBe(true);
  });
});

describe('determinism — the same book must produce the same scan', () => {
  it('reads identically twice, so a leak cannot appear and vanish between runs', () => {
    const live = [...bucket(30, 0.12, { round: 1 }), ...bucket(20, -0.14, { round: 2 })];
    const paper = [...bucket(20, -0.1, { round: 2, book: 'paper' })];
    const a = runEdgeLeakScan({
      books: ['live', 'paper'],
      live: { trades: live, sessionDates: ['2026-09-08'], droppedTrades: 0 },
      paper: { trades: paper, sessionDates: ['2026-09-08'], droppedTrades: 0 },
      lookbackSessions: 40,
      storedTargetR: 2.4,
      execution: [],
      configuration: [],
      entrySlippagePct: [],
      entryLimitBufferPct: MARKETABLE_LIMIT_BUFFER_PCT,
      entryDriftPct: [],
      journalSkips: [],
      asOf: 1,
    });
    const b = runEdgeLeakScan({
      books: ['live', 'paper'],
      live: { trades: live, sessionDates: ['2026-09-08'], droppedTrades: 0 },
      paper: { trades: paper, sessionDates: ['2026-09-08'], droppedTrades: 0 },
      lookbackSessions: 40,
      storedTargetR: 2.4,
      execution: [],
      configuration: [],
      entrySlippagePct: [],
      entryLimitBufferPct: MARKETABLE_LIMIT_BUFFER_PCT,
      entryDriftPct: [],
      journalSkips: [],
      asOf: 1,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// The slippage rule has to be able to FIRE (2026-09-12).
//
// The playbook's pre-committed rule was "mean entry slippage above 0.5% is an
// execution finding", measured on a quantity that is <= 0 for every filled
// marketable limit. These cases pin the fireable version: the share of the
// buffer the fills paid away, against a half-buffer bar.
// ---------------------------------------------------------------------------
describe('entry slippage — the buffer is the thing that gets consumed', () => {
  const B = MARKETABLE_LIMIT_BUFFER_PCT;
  /** n rows at `pct`, the sign a real fill produces. */
  const rows = (n: number, pct: number): number[] => Array.from({ length: n }, () => pct);
  const slippage = (r: number[]) =>
    scan([], [], { entrySlippagePct: r }).findings.find((f) => f.id === 'execution:entry_slippage');

  it('a fill at the QUOTE consumes nothing; a fill at the LIMIT consumes the whole buffer', () => {
    const atQuote = buildAttribution([], [], [], [], rows(4, -B), B, RNG());
    expect(atQuote.meanEntryBufferConsumedPct).toBeCloseTo(0, 4);
    const atLimit = buildAttribution([], [], [], [], rows(4, 0), B, RNG());
    expect(atLimit.meanEntryBufferConsumedPct).toBeCloseTo(B, 4);
  });

  it('says nothing when the fills are landing near the quote', () => {
    expect(slippage(rows(40, -0.45))).toBeUndefined();
  });

  it('raises a finding once more than half the buffer is being paid away', () => {
    const f = slippage(rows(40, -0.1));
    expect(f?.kind).toBe('execution');
    expect(f?.count).toBe(40);
    expect(f?.detail).toContain('0.4%');
    expect(f?.lever?.direction).toBe('safe');
  });

  it('will not call two bad fills a regime', () => {
    expect(slippage(rows(SLIPPAGE_MIN_TRADES - 1, -0.1))).toBeUndefined();
    expect(slippage(rows(SLIPPAGE_MIN_TRADES, -0.1))).toBeDefined();
  });

  it('reports no buffer at all when there were no fills to measure', () => {
    const a = buildAttribution([], [], [], [], [], B, RNG());
    expect(a.meanEntrySlippagePct).toBeNull();
    expect(a.entryLimitBufferPct).toBeNull();
    expect(a.meanEntryBufferConsumedPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Translating the floor (2026-09-12). "Re-fit liveMinSignalScore against the
// pace-scored distribution" is a distribution question, and the screen's score
// ladder answers it: the floor that preserves today's SELECTIVITY is the pace
// rung admitting as many symbols as the live floor admits under raw scoring.
// ---------------------------------------------------------------------------
describe('equivalentPaceFloor — the re-fit, not a mean shift', () => {
  // Counts are non-increasing in the rung, as a "how many reach at least this"
  // curve must be. Pace scoring lifts the distribution, so at every rung it
  // admits more — the shape the deployed shadow actually shows.
  const LADDER = [60, 64, 68, 72, 76, 80];
  const RAW = [300, 200, 140, 100, 60, 30];
  const PACE = [400, 300, 200, 140, 100, 60];

  it('lands on the rung where pace admits what the live floor admits under raw', () => {
    // raw at 72 admits 100; pace admits 100 at 76.
    expect(equivalentPaceFloor(LADDER, RAW, PACE, 72)).toBe(76);
  });

  it('interpolates between rungs at both ends of the translation', () => {
    // raw at 70 = halfway between 140 and 100 = 120; pace reaches 120 between
    // 72 (140) and 76 (100), half a span up = 74.
    expect(equivalentPaceFloor(LADDER, RAW, PACE, 70)).toBe(74);
  });

  it('is always ABOVE the live floor when pace scoring lifts the distribution', () => {
    for (const floor of [64, 66, 68, 70, 72]) {
      const f = equivalentPaceFloor(LADDER, RAW, PACE, floor);
      expect(f, `floor ${floor}`).not.toBeNull();
      expect(f!, `floor ${floor}`).toBeGreaterThan(floor);
    }
  });

  it('says nothing rather than extrapolating off either end of the measured ladder', () => {
    expect(equivalentPaceFloor(LADDER, RAW, PACE, 50)).toBeNull();
    expect(equivalentPaceFloor(LADDER, RAW, PACE, 95)).toBeNull();
    // A live floor inside the ladder whose admitted count is below everything
    // the PACE curve reaches: no rung is that selective, so there is no answer.
    expect(equivalentPaceFloor(LADDER, RAW, [90, 80, 75, 72, 71, 70], 80)).toBeNull();
  });

  it('refuses a malformed ladder instead of guessing at it', () => {
    expect(equivalentPaceFloor([72], [100], [140], 72)).toBeNull();
    expect(equivalentPaceFloor(LADDER, RAW.slice(1), PACE, 72)).toBeNull();
    expect(equivalentPaceFloor(LADDER, RAW, PACE.slice(1), 72)).toBeNull();
  });

  it('returns the floor unchanged when the two scorings agree', () => {
    expect(equivalentPaceFloor(LADDER, RAW, RAW, 72)).toBe(72);
  });

  // The re-check once the flag is on (2026-09-19): the same translation, run
  // against the floor in force, saying which way it has drifted and by how much.
  describe('paceFloorDrift', () => {
    it('reads a floor sitting ABOVE its equivalence as tighter, with both admissions', () => {
      // raw at 72 admits 100 → pace equivalent 76; a floor of 80 admits 60 under pace.
      expect(paceFloorDrift(LADDER, RAW, PACE, 72, 80)).toEqual({
        equivalentFloor: 76,
        driftPoints: -4,
        admittedAtFloor: 60,
        admittedAtReference: 100,
      });
    });

    it('reads a floor sitting BELOW its equivalence as looser', () => {
      expect(paceFloorDrift(LADDER, RAW, PACE, 72, 72)).toMatchObject({ equivalentFloor: 76, driftPoints: 4 });
    });

    it('reads zero drift when the floor IS the equivalence', () => {
      expect(paceFloorDrift(LADDER, RAW, PACE, 72, 76)?.driftPoints).toBe(0);
    });

    it('says nothing rather than extrapolating when either floor is off the ladder', () => {
      expect(paceFloorDrift(LADDER, RAW, PACE, 72, 90)).toBeNull();
      expect(paceFloorDrift(LADDER, RAW, PACE, 50, 76)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The re-entry cooldown finding (2026-09-19): what a SHORTER cooldown would
// have admitted, judged at the scan's own bar in the other direction — the
// whole interval ABOVE zero, because the lever adds exposure. Built the way
// the rest of this file is: a record with a known reading in it, and the scan
// asked to name it.
// ---------------------------------------------------------------------------
describe('the re-entry cooldown finding — what a shorter cooldown would have admitted', () => {
  const rng = () => mulberry32(7);
  const gap = (minMinutesSinceExit: number, exitRs: number[]) => ({ minMinutesSinceExit, exitRs });
  const same = (n: number, r: number) => Array.from({ length: n }, () => r);
  /** Twenty trades whose mean is zero: an interval that straddles it. */
  const noise = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.5 : -0.5));
  const record = (gaps: { minMinutesSinceExit: number; exitRs: number[] }[], journalTruncated = false) => ({
    etDate: '2026-09-18',
    journalTruncated,
    gaps,
  });

  it('names the gap that clears the bar, with an exposure lever the app never applies', () => {
    const [f, ...rest] = reentryCooldownFinding(
      record([gap(0, same(20, 0.15)), gap(60, same(20, -0.1)), gap(120, same(20, 0.3)), gap(180, same(9, 0.5))]),
      390,
      rng(),
    );
    expect(rest).toEqual([]);
    expect(f.id).toBe('configuration:reentry_cooldown_shadow');
    expect(f.kind).toBe('configuration');
    expect(f.label).toMatch(/120 minutes after the exit/);
    expect(f.count).toBe(20);
    expect(f.lastSeenEtDate).toBe('2026-09-18');
    // Every gap is in the detail, cleared or not, so the reader sees the shape
    // and not only the winner; the nine-trade gap is there with its n.
    expect(f.detail).toMatch(/cooldown is 390 minutes/);
    expect(f.detail).toMatch(/0 min — n=20, avg \+0\.15R/);
    expect(f.detail).toMatch(/60 min — n=20, avg -0\.10R/);
    expect(f.detail).toMatch(/120 min — n=20, avg \+0\.30R/);
    expect(f.detail).toMatch(/180 min — n=9, avg \+0\.50R/);
    expect(f.detail).toMatch(/The 120-minute gap clears the bar/);
    expect(f.detail).toMatch(/as does 0 min/);
    expect(f.detail).toMatch(/No paper control exists/);
    expect(f.lever).toMatchObject({
      kind: 'config',
      field: 'symbolReentryCooldownMinutes',
      value: 120,
      direction: 'exposure',
    });
    expect(f.lever?.detail).toMatch(/operator’s call, never applied by the app/);
  });

  it('is silent below the bar — fewer than 15 trades, or an interval that touches zero', () => {
    expect(reentryCooldownFinding(record([gap(120, same(LEAK_MIN_TRADES - 1, 0.5))]), 390, rng())).toEqual([]);
    expect(reentryCooldownFinding(record([gap(120, noise)]), 390, rng())).toEqual([]);
    expect(reentryCooldownFinding(record([gap(120, same(20, -0.2))]), 390, rng())).toEqual([]);
  });

  it('never proposes a gap at or past the cooldown in force, and nothing at all when the cooldown is off', () => {
    const cleared = record([gap(60, same(20, 0.2)), gap(120, same(20, 0.3)), gap(180, same(20, 0.4))]);
    // At 120 the 120- and 180-minute gaps would lower nothing; 60 still would.
    expect(reentryCooldownFinding(cleared, 120, rng())[0]?.lever?.value).toBe(60);
    expect(reentryCooldownFinding(cleared, 60, rng())).toEqual([]);
    expect(reentryCooldownFinding(cleared, 0, rng())).toEqual([]);
    // The first refusal clearing under a cooldown of 60 names 0: no cooldown.
    expect(reentryCooldownFinding(record([gap(0, same(20, 0.2))]), 60, rng())[0]?.lever?.value).toBe(0);
  });

  it('says nothing without a record', () => {
    expect(reentryCooldownFinding(null, 390, rng())).toEqual([]);
  });

  it('prefers the higher mean among clearing gaps, and the longer gap on a tie', () => {
    expect(
      reentryCooldownFinding(record([gap(60, same(20, 0.3)), gap(120, same(20, 0.2))]), 390, rng())[0].lever?.value,
    ).toBe(60);
    expect(
      reentryCooldownFinding(record([gap(60, same(20, 0.2)), gap(120, same(20, 0.2))]), 390, rng())[0].lever?.value,
    ).toBe(120);
  });

  it('carries the record’s incompleteness into the detail', () => {
    const [f] = reentryCooldownFinding(record([gap(120, same(20, 0.3))], true), 390, rng());
    expect(f.detail).toMatch(/window is incomplete/);
  });

  it('reads each gap with the scan’s own statistics', () => {
    const readings = reentryGapReadings(record([gap(120, same(20, 0.3)), gap(0, noise)]), rng());
    // Sorted by gap, whatever order the record held them in.
    expect(readings.map((r) => r.minMinutesSinceExit)).toEqual([0, 120]);
    expect(readings[0]).toMatchObject({ n: 20, meanR: 0, winRatePct: 50, clearsBar: false });
    expect(readings[1]).toMatchObject({ n: 20, meanR: 0.3, ciLow: 0.3, ciHigh: 0.3, winRatePct: 100, clearsBar: true });
  });
});
