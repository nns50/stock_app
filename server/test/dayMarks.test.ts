import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { saveDailyBaseline } from '../src/db/dailyBaseline';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { importPositions } from '../src/db/positions';
import { listDayMarks, saveDayMark, type DayMark } from '../src/db/dayMarks';
import { recordDayMark, summarizeDayMarks, toPoint } from '../src/services/autotrading/dayMarks';
import { getProvider } from '../src/providers';
import { etToday } from '../src/util/marketDate';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

// ---------------------------------------------------------------------------
// "We were over 3% for five minutes this morning, and now we're not."
//
// That was unanswerable on 2026-09-15: the app kept the day's OPENING equity
// and overwrote the current figure every tick, so nothing recorded the shape of
// the day in between. These cases pin the three series and the summary that
// answers the question — and, most of all, that REALIZED and MARKED are
// genuinely different numbers, because the whole reason this table exists is
// that on that morning they were.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-15T14:00:00Z'); // 10:00 ET, in session
const TODAY = etToday(NOW);
const BASE = 3_694.39;

const quoting = (prices: Record<string, number>) =>
  ({
    getQuote: vi.fn(async (symbol: string) => {
      if (!(symbol in prices)) throw new Error(`no quote for ${symbol}`);
      return { symbol, last: prices[symbol], timestamp: NOW };
    }),
    getCandles: vi.fn(async () => []),
  }) as unknown as ReturnType<typeof getProvider>;

/** A closed autotrade stock trade booking `usd` today. */
function seedRealized(usd: number, symbol = 'SWKS'): void {
  const qty = 10;
  importPositions(
    [
      {
        assetType: 'stock',
        symbol,
        side: 'long',
        quantity: qty,
        entryPrice: 100,
        entryDate: TODAY,
        status: 'closed',
        tags: ['live', 'autotrade'],
        createdAt: NOW,
        updatedAt: NOW,
        exits: [{ quantity: qty, exitPrice: 100 + usd / qty, exitDate: TODAY, createdAt: NOW }],
      },
    ],
    'merge',
  );
}

/** An OPEN autotrade stock position, which is what the mark is of. */
function seedOpen(symbol: string, qty: number, entry: number): void {
  importPositions(
    [
      {
        assetType: 'stock',
        symbol,
        side: 'long',
        quantity: qty,
        entryPrice: entry,
        entryDate: TODAY,
        status: 'open',
        tags: ['live', 'autotrade'],
        createdAt: NOW,
        updatedAt: NOW,
        exits: [],
      },
    ],
    'merge',
  );
}

const mark = (over: Partial<DayMark> = {}): DayMark => ({
  etDate: TODAY,
  at: NOW,
  baselineEquityUsd: BASE,
  realizedUsd: 0,
  unrealizedEquityUsd: 0,
  accountEquityUsd: BASE,
  openEquity: 0,
  openOptions: 0,
  ...over,
});

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_day_marks; DELETE FROM autotrade_daily_baseline; DELETE FROM position_exits; ' +
      'DELETE FROM positions; DELETE FROM autotrade_live_options_positions; DELETE FROM autotrade_config;',
  );
  setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: BASE, targetDailyGainPct: 3 });
  vi.mocked(getProvider).mockReturnValue(quoting({}));
});

describe('recordDayMark', () => {
  it('records realized and the MARK as separate numbers — the whole point of the table', () => {
    // 2026-09-15 to the dollar: SWKS closed +101.92 and DELL -0.32 (realized
    // +101.60 = +2.75%), while QCOM and CRWD sat open and DOWN 15.26. The
    // account showed +2.34% and the loop's banked day +2.75%: on a session with
    // no hand trading the difference is the mark, and nothing else.
    saveDailyBaseline(TODAY, BASE);
    seedRealized(101.6);
    seedOpen('QCOM', 6, 189.28);
    seedOpen('CRWD', 4, 237.41);
    vi.mocked(getProvider).mockReturnValue(quoting({ QCOM: 187.05, CRWD: 236.94 }));

    return recordDayMark(NOW).then((m) => {
      expect(m).not.toBeNull();
      expect(m!.realizedUsd).toBeCloseTo(101.6, 2);
      expect(m!.unrealizedEquityUsd).toBeCloseTo(-15.26, 2);
      expect(m!.openEquity).toBe(2);
      const p = toPoint(m!);
      expect(p.realizedPct).toBeCloseTo(2.75, 2);
      expect(p.markedPct).toBeCloseTo(2.34, 2);
      // The two differ by the mark. A table that could not show this would not
      // have been worth building.
      expect(p.realizedPct).not.toBe(p.markedPct);
    });
  });

  it('keeps the row when a quote is missing, and says the book is bigger than the mark', async () => {
    // A partial mark with a known position count beats no row: the reader can
    // see the mark is short of the book instead of trusting it as complete.
    saveDailyBaseline(TODAY, BASE);
    seedOpen('QCOM', 6, 189.28);
    seedOpen('NOQUOTE', 5, 50);
    vi.mocked(getProvider).mockReturnValue(quoting({ QCOM: 190.28 }));

    const m = await recordDayMark(NOW);
    expect(m!.unrealizedEquityUsd).toBeCloseTo(6, 2); // QCOM only
    expect(m!.openEquity).toBe(2); // …but TWO were open
  });

  it('does nothing before a baseline exists — no denominator, no percentage', async () => {
    expect(await recordDayMark(NOW)).toBeNull();
    saveDailyBaseline('2026-09-14', BASE); // yesterday's row must not measure today
    expect(await recordDayMark(NOW)).toBeNull();
    expect(listDayMarks(TODAY)).toHaveLength(0);
  });

  it('overwrites its own sample rather than doubling the series', async () => {
    saveDailyBaseline(TODAY, BASE);
    await recordDayMark(NOW);
    await recordDayMark(NOW);
    expect(listDayMarks(TODAY)).toHaveLength(1);
  });

  it('counts open OPTIONS without pricing them, so a partial mark is visible', async () => {
    // Pricing a contract needs a chain fetch, far too expensive per tick. The
    // count is the honest alternative to a number that would be wrong.
    saveDailyBaseline(TODAY, BASE);
    db.prepare(
      `INSERT INTO autotrade_live_options_positions
         (symbol, side, kind, contract_symbol, strike, expiration, quantity, entry_price, entry_at,
          risk_amount, risk_profile, rationale, status, created_at, updated_at)
       VALUES ('INTC','put','single_leg','INTC260915P00096000',96,?,1,0.5,?,50,'moderate','seed','open',?,?)`,
    ).run(TODAY, NOW, NOW, NOW);
    const m = await recordDayMark(NOW);
    expect(m!.openOptions).toBe(1);
    expect(m!.unrealizedEquityUsd).toBe(0); // not in the mark, by decision
  });
});

describe('summarizeDayMarks', () => {
  const at = (min: number) => NOW + min * 60_000;

  it('answers "we were over 3% for five minutes" from the MARKED series', () => {
    // A morning that marks over the goal for five samples and then fades —
    // exactly 2026-09-15's shape, where the realized day never got there.
    const marks = [
      mark({ at: at(0), realizedUsd: 101.6, unrealizedEquityUsd: 4 }), // 2.86%
      mark({ at: at(1), realizedUsd: 101.6, unrealizedEquityUsd: 12 }), // 3.07%
      mark({ at: at(2), realizedUsd: 101.6, unrealizedEquityUsd: 14 }), // 3.13%
      mark({ at: at(3), realizedUsd: 101.6, unrealizedEquityUsd: 13 }), // 3.10%
      mark({ at: at(4), realizedUsd: 101.6, unrealizedEquityUsd: 11 }), // 3.05%
      mark({ at: at(5), realizedUsd: 101.6, unrealizedEquityUsd: 10 }), // 3.02%
      mark({ at: at(6), realizedUsd: 101.6, unrealizedEquityUsd: -15.26 }), // 2.34%
    ];
    const s = summarizeDayMarks(TODAY, marks, 3);

    expect(s.markedAtOrAboveGoal).toBe(5);
    expect(s.markedAboveGoalMinutes).toBeCloseTo(5, 1);
    expect(s.markedPeak!.pct).toBeCloseTo(3.13, 2);
    expect(s.markedPeak!.at).toBe(at(2));
    // …and the REALIZED day never reached it, which is why nothing banked.
    expect(s.realizedAtOrAboveGoal).toBe(0);
    expect(s.realizedPeak!.pct).toBeCloseTo(2.75, 2);
  });

  it('measures the above-goal span from the sample CADENCE, not a wall clock', () => {
    // A gap in the samples — a restart, a stalled tick — must not read as time
    // spent above the goal. Two samples 30 minutes apart are two samples.
    const s = summarizeDayMarks(
      TODAY,
      [
        mark({ at: at(0), realizedUsd: 120 }),
        mark({ at: at(30), realizedUsd: 120 }),
        mark({ at: at(60), realizedUsd: 0 }),
      ],
      3,
    );
    expect(s.markedAtOrAboveGoal).toBe(2);
    expect(s.markedAboveGoalMinutes).toBeCloseTo(60, 1); // 2 samples x 30-min step
  });

  it('reports each series’ peak and trough independently', () => {
    const s = summarizeDayMarks(
      TODAY,
      [
        mark({ at: at(0), realizedUsd: 0, unrealizedEquityUsd: 40, accountEquityUsd: BASE + 40 }),
        mark({ at: at(1), realizedUsd: 120, unrealizedEquityUsd: -60, accountEquityUsd: BASE + 60 }),
        mark({ at: at(2), realizedUsd: 70, unrealizedEquityUsd: 0, accountEquityUsd: BASE - 20 }),
      ],
      3,
    );
    expect(s.realizedPeak!.at).toBe(at(1)); // 120 realized
    expect(s.realizedTrough!.at).toBe(at(0)); // 0 realized
    expect(s.markedPeak!.at).toBe(at(2)); // 70 marked beats 120-60=60 and 0+40
    expect(s.accountPeak!.at).toBe(at(1));
    expect(s.accountTrough!.at).toBe(at(2));
  });

  it('keeps the EARLIEST sample when two tie — "when did it first get there"', () => {
    // A tie is the ordinary case at 60-second resolution on a quiet stretch,
    // and the peak is read to answer when the day first reached a level. The
    // strict comparison that produces this is easy to flip to >= by accident.
    const s = summarizeDayMarks(TODAY, [mark({ at: at(0), realizedUsd: 60 }), mark({ at: at(1), realizedUsd: 60 })], 3);
    expect(s.realizedPeak!.at).toBe(at(0));
    expect(s.realizedTrough!.at).toBe(at(0));
  });

  it('leaves the account series absent when the broker never read', () => {
    const s = summarizeDayMarks(TODAY, [mark({ accountEquityUsd: null })], 3);
    expect(s.accountPeak).toBeNull();
    expect(s.accountTrough).toBeNull();
    expect(s.realizedPeak).not.toBeNull();
  });

  it('says nothing about a goal it was not given', () => {
    const s = summarizeDayMarks(TODAY, [mark({ realizedUsd: 400 })], null);
    expect(s.goalPct).toBeNull();
    expect(s.markedAboveGoalMinutes).toBeNull();
    expect(s.markedAtOrAboveGoal).toBe(0);
  });

  it('is empty, not broken, on a day with no samples', () => {
    const s = summarizeDayMarks(TODAY, [], 3);
    expect(s).toMatchObject({ samples: 0, firstAt: null, lastAt: null, realizedPeak: null });
  });
});

describe('toPoint', () => {
  it('derives every percentage from the dollars, so they cannot disagree', () => {
    const p = toPoint(mark({ realizedUsd: 110.83, unrealizedEquityUsd: -10, accountEquityUsd: BASE + 100.83 }));
    expect(p.realizedPct).toBeCloseTo(3, 2);
    expect(p.markedPct).toBeCloseTo(2.73, 2);
    expect(p.accountPct).toBeCloseTo(2.73, 2);
  });

  it('does not divide by a zero baseline', () => {
    const p = toPoint(mark({ baselineEquityUsd: 0, realizedUsd: 50 }));
    expect(p.realizedPct).toBe(0);
    expect(p.accountPct).toBeNull();
  });
});

describe('saveDayMark', () => {
  it('round-trips every field, including the nullable account figure', () => {
    saveDayMark(mark({ realizedUsd: 1.5, unrealizedEquityUsd: -2.5, accountEquityUsd: null, openOptions: 2 }));
    const [row] = listDayMarks(TODAY);
    expect(row).toMatchObject({
      realizedUsd: 1.5,
      unrealizedEquityUsd: -2.5,
      accountEquityUsd: null,
      openOptions: 2,
    });
  });
});
