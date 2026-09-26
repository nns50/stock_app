import { describe, expect, it, vi } from 'vitest';
import { Candle } from '../src/providers/types';
import { etDateTimeToMs } from '../src/util/marketDate';
import { getMarketQuoteLegs } from '../src/services/autotrading/executionGuards';
import { readingsFromBars, scoresFromBars, TapeSeries } from '../src/services/autotrading/historicalTape';
import { pctFrom } from '../src/services/autotrading/marketTape';
import { readMarketTape } from '../src/services/autotrading/marketTapeData';
import { fetchTodayIndexContext, indexLegsFromBars } from '../src/services/autotrading/vwap';

// ---------------------------------------------------------------------------
// The rebuilt tape score against the loop's own scorer (the tape plan's PR 7,
// 2026-09-26). scoresFromBars claims to score a past session the way
// readMarketTape scores a live tick. This drives readMarketTape itself, slot by
// slot, with only its two fetches replaced by the same bars, and asserts the
// two agree on every slot: which index takes the reading's figure, how the
// indexes average, when the momentum ring is read and filled. A change to
// either side that the other does not share fails here.
// ---------------------------------------------------------------------------

vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/executionGuards')>()),
  getMarketQuoteLegs: vi.fn(),
}));
vi.mock('../src/services/autotrading/vwap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/vwap')>()),
  fetchTodayIndexContext: vi.fn(),
}));

const DAY = '2026-09-10';
const PREV = '2026-09-09';
const SLOT_MS = 5 * 60_000;
const at = (hhmm: string) => etDateTimeToMs(DAY, hhmm) as number;
const THRESHOLDS = { indexPct: 0.2, breadthPct: 65, exitIndexPct: 0.1, exitBreadthPct: 60 };
const SLOT_STARTS = Array.from({ length: 78 }, (_, i) => at('09:30') + i * SLOT_MS);

/** An index that opens under its prior close of 100 and climbs through it,
 *  wandering on uneven volume, so its VWAP, open and 30-minute legs all move. */
function index(symbol: string, level: number, trend: number, phase: number): TapeSeries {
  let prev = 100 * (1 + level / 100);
  const intraday: Candle[] = SLOT_STARTS.map((time, i) => {
    const close = 100 * (1 + (level + (trend * i) / 77 + 0.35 * Math.sin(i / 6 + phase)) / 100);
    const bar = {
      time,
      open: prev,
      high: Math.max(prev, close) + 0.04,
      low: Math.min(prev, close) - 0.03,
      close,
      volume: 1_000 + 137 * (i % 9),
    };
    prev = close;
    return bar;
  });
  return {
    symbol,
    intraday,
    daily: [{ time: Date.parse(`${PREV}T00:00:00Z`), open: 100, high: 101, low: 99, close: 100, volume: 1e6 }],
  };
}

/** 120 names, red at the open and turning green through the day: breadth,
 *  its momentum and the label (with its hold) all move. */
const NAMES: TapeSeries[] = Array.from({ length: 120 }, (_, j) => ({
  symbol: `N${j}`,
  intraday: SLOT_STARTS.map((time, i) => {
    const close = j < 110 - i * 1.2 ? 49 : 51;
    return { time, open: close, high: close, low: close, close, volume: 1_000 };
  }),
  daily: [{ time: Date.parse(`${PREV}T00:00:00Z`), open: 50, high: 51, low: 49, close: 50, volume: 1e6 }],
}));

describe('scoresFromBars against readMarketTape — one rule, live and rebuilt', () => {
  it('scores every slot of a session exactly as the loop scores the same tape', async () => {
    const spy = index('SPY', -0.4, 1.0, 0);
    const qqq = index('QQQ', -0.7, 1.2, 1.3);
    const byName = new Map([spy, qqq].map((s) => [s.symbol, s]));
    const readings = readingsFromBars(DAY, spy, NAMES, THRESHOLDS);
    const rebuilt = scoresFromBars(DAY, readings, [spy, qqq]);

    // The loop at the end of each slot: the quote is the slot's close (no
    // quote `open`, so the bars' is used), and the 5-minute fetch returns the
    // bars that had closed.
    let now = 0;
    vi.mocked(getMarketQuoteLegs).mockImplementation(async (symbol) => {
      const bar = byName.get(symbol)?.intraday.find((b) => b.time === now - SLOT_MS);
      return bar ? { last: bar.close, open: null, changePct: pctFrom(bar.close, 100) } : null;
    });
    vi.mocked(fetchTodayIndexContext).mockImplementation(async (symbol, t = Date.now()) =>
      indexLegsFromBars(byName.get(symbol)?.intraday.filter((b) => b.time < t) ?? [], t),
    );
    const live = [];
    for (const r of readings) {
      now = r.at;
      live.push(await readMarketTape({ reading: r.reading, breadth: r.breadth, readAt: r.at, day: DAY }, r.at));
    }

    expect(live.map((l) => [l.readAt, l.direction, l.score, l.coverage, l.components])).toEqual(
      rebuilt.map((r) => [r.at, r.direction, r.score, r.coverage, r.components]),
    );
    // And the session exercised what it claims to: a label that moves, every
    // leg measured by the afternoon, and a momentum that is not zero.
    expect(new Set(rebuilt.map((r) => r.direction))).toEqual(new Set(['red', 'mixed', 'green']));
    expect(new Set(rebuilt.map((r) => r.score)).size).toBeGreaterThan(20);
    expect(rebuilt[rebuilt.length - 1].coverage).toBe(100);
    const momentum = rebuilt.map((r) => r.components.find((c) => c.leg === 'breadthMomentum30')?.value ?? null);
    expect(momentum.some((m) => m !== null && m !== 0)).toBe(true);
  });
});
