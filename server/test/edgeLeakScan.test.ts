import { describe, it, expect } from 'vitest';
import {
  buildAttribution,
  buildDayLevel,
  CONTROL_MIN_TRADES,
  DIMENSIONS,
  LeakTrade,
  LEAK_MIN_TRADES,
  mulberry32,
  runEdgeLeakScan,
  verdictFor,
  WATCH_MIN_TRADES,
} from '../src/services/autotrading/edgeLeakScan';
import { etDateTimeToMs } from '../src/util/marketDate';

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

  it('pairs the same decision in both books and reports the difference', () => {
    const live = [trade({ symbol: 'NVDA', entryAt: at('09:35'), r: 0.1 })];
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35') + 20_000, r: 0.4 })];
    const a = buildAttribution(live, paper, [], [], [0.3, 0.5], RNG());
    expect(a.pairedTrades).toBe(1);
    expect(a.meanDiffR).toBeCloseTo(-0.3, 4);
    expect(a.meanEntrySlippagePct).toBeCloseTo(0.4, 2);
    expect(a.untaken).toEqual([]);
  });

  it('does NOT pair two entries 61 seconds apart — that is a different decision', () => {
    const live = [trade({ symbol: 'NVDA', entryAt: at('09:35'), r: 0.1 })];
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35') + 61_000, r: 0.4 })];
    const a = buildAttribution(live, paper, [], [], [], RNG());
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
      RNG(),
    );
    const byReason = new Map(a.untaken.map((u) => [u.reason, u]));
    expect(byReason.get('live_score_floor_skipped')?.paperTotalR).toBeCloseTo(0.9, 4);
    expect(byReason.get('live_risk_blocked:max_concurrent_positions')?.n).toBe(1);
    // Nothing in the journal is "no_live_row", not a guess at a cause.
    expect(byReason.get('no_live_row')?.n).toBe(1);
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
    const a = buildAttribution([], paper, [], [at('15:56') + 2_000], [], RNG());
    const byReason = new Map(a.untaken.map((u) => [u.reason, u]));
    expect(byReason.get('entry_window_closed')?.n).toBe(2);
    expect(byReason.get('no_live_row')).toBeUndefined();
  });

  it('leaves a paper entry OUTSIDE any batch refusal as no_live_row', () => {
    // The honest half. A tick where the live book had no candidates journals
    // nothing, and nothing refused that name — so the gap stays a gap rather
    // than borrowing the nearest batch row for a cause.
    const paper = [trade({ symbol: 'NVDA', book: 'paper', entryAt: at('09:35'), r: 0.4 })];
    const a = buildAttribution([], paper, [], [at('15:56')], [], RNG());
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
      [at('15:56')],
      [],
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
    const a = buildAttribution(live, paper, [], [], [], RNG());
    expect(a.pairedTrades).toBe(1);
    expect(a.untaken.reduce((s, u) => s + u.n, 0)).toBe(1);
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
      journalSkips: [],
      asOf: 1,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
