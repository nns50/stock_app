import { describe, expect, it } from 'vitest';
import { Candle, Timeframe } from '../src/providers/types';
import { etDateTimeToMs } from '../src/util/marketDate';
import { atrReachRefuses } from '../src/services/autotrading/atrReach';
import {
  atrBefore,
  directionChangeRows,
  floorReader,
  flipsPerSession,
  mergeDirectionIndex,
  readingsFromBars,
  scoreSignals,
  seededSample,
  TapeReading,
  TapeSeries,
  toDirectionIndex,
  windowCandleSource,
} from '../src/services/autotrading/historicalTape';
import { DirectionIndex, directionAt } from '../src/services/autotrading/marketDirectionIndex';
import {
  breadthOf,
  MarketDirectionReading,
  readMarketDirectionForTick,
  resetMarketDirectionState,
} from '../src/services/autotrading/marketDirection';

// ---------------------------------------------------------------------------
// The tape rebuild's pure half (the tape plan's PR 3). Each rule below is one a
// rebuilt reading could get wrong while still looking plausible — a reading
// stamped at its bar's start, a premarket print, the day's own open taken for
// the prior close — and each test fails if that rule is removed.
// ---------------------------------------------------------------------------

const DAY = '2026-09-10';
const PREV = '2026-09-09';
const at = (hhmm: string, day = DAY) => etDateTimeToMs(day, hhmm) as number;
const THRESHOLDS = { indexPct: 0.2, breadthPct: 65, exitIndexPct: 0.1, exitBreadthPct: 60 };

const bar = (time: number, close: number, extra: Partial<Candle> = {}): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1_000,
  ...extra,
});
/** A daily bar as Polygon's client stamps it: midnight UTC of its ET date. */
const dailyBar = (day: string, close: number, range = 2): Candle => ({
  time: Date.parse(`${day}T00:00:00Z`),
  open: close,
  high: close + range / 2,
  low: close - range / 2,
  close,
  volume: 1_000_000,
});

/** Regular-session start minutes, 09:30..15:55, as HH:MM. */
const SLOTS = Array.from({ length: 78 }, (_, i) => {
  const m = 9 * 60 + 30 + i * 5;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

/** One name: a prior close, and a close per slot (null leaves the slot's bar
 *  out). */
function series(symbol: string, prevClose: number, closeAt: (slot: string) => number | null): TapeSeries {
  const intraday: Candle[] = [];
  for (const slot of SLOTS) {
    const c = closeAt(slot);
    if (c !== null) intraday.push(bar(at(slot), c));
  }
  return { symbol, intraday, daily: [dailyBar(PREV, prevClose)] };
}

const redNames = (n: number, pct = -2) =>
  Array.from({ length: n }, (_, i) => series(`N${i}`, 50, () => 50 * (1 + pct / 100)));
const spy = (pct: number | ((slot: string) => number)) =>
  series('SPY', 100, (slot) => 100 * (1 + (typeof pct === 'number' ? pct : pct(slot)) / 100));

describe('readingsFromBars — the loop’s reading, rebuilt from bars', () => {
  it('stamps each reading at the END of its bar, so no moment is labeled by a price printed after it', () => {
    const readings = readingsFromBars(DAY, spy(-0.5), redNames(100), THRESHOLDS);
    expect(readings).toHaveLength(78);
    expect(readings[0].at).toBe(at('09:35'));
    expect(readings[readings.length - 1].at).toBe(at('16:00'));
    expect(readings[0].reading.direction).toBe('red');
    // An entry at 09:32 was taken before the first bar closed: no reading.
    const index = toDirectionIndex(directionChangeRows(readings));
    expect(directionAt(index, DAY, at('09:32'))).toBeNull();
    expect(directionAt(index, DAY, at('09:35'))).toBe('red');
  });

  it("reads the index against the previous session's daily close, not the day's own open", () => {
    // A gap down to 99.0 that recovers to 99.7 by the first bar's close: -0.3%
    // on the day, though +0.7% from the open.
    const index: TapeSeries = {
      symbol: 'SPY',
      intraday: SLOTS.map((slot) => bar(at(slot), 99.7, slot === '09:30' ? { open: 99.0 } : {})),
      daily: [dailyBar('2026-09-08', 97), dailyBar(PREV, 100)],
    };
    const [first] = readingsFromBars(DAY, index, redNames(100), THRESHOLDS);
    expect(first.reading.indexChangePct).toBe(-0.3);
    expect(first.reading.direction).toBe('red');
  });

  it('keeps premarket and after-hours bars out: no reading moves, and none is added past the close', () => {
    const plain = readingsFromBars(DAY, spy(-0.5), redNames(100), THRESHOLDS);
    // Polygon's minute aggregates run 04:00-20:00 ET. A green premarket print
    // and green after-hours bars on every name must change nothing.
    const withExtended = (s: TapeSeries): TapeSeries => ({
      ...s,
      intraday: [
        bar(at('04:00'), s.intraday[0].close * 1.03),
        ...s.intraday,
        bar(at('16:00'), s.intraday[0].close * 1.03),
        bar(at('16:30'), s.intraday[0].close * 1.03),
      ],
    });
    const extended = readingsFromBars(DAY, withExtended(spy(-0.5)), redNames(100).map(withExtended), THRESHOLDS);
    expect(extended.map((r) => [r.at, r.reading.direction])).toEqual(plain.map((r) => [r.at, r.reading.direction]));
  });

  it("leaves a name with no bar in a slot out of that slot's sample, rather than counting it flat", () => {
    const names = [...redNames(100), series('GAP', 50, (slot) => (slot === '10:00' ? null : 49))];
    const readings = readingsFromBars(DAY, spy(-0.5), names, THRESHOLDS);
    const bySlotEnd = new Map(readings.map((r) => [r.at, r.reading]));
    expect(bySlotEnd.get(at('10:00'))?.sample).toBe(101);
    expect(bySlotEnd.get(at('10:05'))?.sample).toBe(100);
    expect(bySlotEnd.get(at('10:05'))?.redPct).toBe(100);
  });

  it('reads nothing from fewer than 100 names, exactly as the loop', () => {
    const readings = readingsFromBars(DAY, spy(-0.5), redNames(99), THRESHOLDS);
    expect(new Set(readings.map((r) => r.reading.direction))).toEqual(new Set(['unknown']));
  });

  it('reads no session the index has no bars for', () => {
    expect(readingsFromBars(DAY, { symbol: 'SPY', intraday: [], daily: [] }, redNames(100), THRESHOLDS)).toEqual([]);
  });

  it('carries the hold from slot to slot, and agrees with the loop’s own reader tick for tick', () => {
    // Red at the bar, then breadth eases to 62% (inside the 60% exit band),
    // then to 55% (outside it).
    const share = (slot: string) => (slot < '10:30' ? 0.7 : slot < '11:00' ? 0.62 : 0.55);
    const names = Array.from({ length: 100 }, (_, i) =>
      series(`N${i}`, 50, (slot) => (i < share(slot) * 100 ? 49 : 51)),
    );
    const readings = readingsFromBars(DAY, spy(-0.5), names, THRESHOLDS);
    const dir = (hhmm: string) => readings.find((r) => r.at === at(hhmm))?.reading;
    expect(dir('10:30')).toMatchObject({ direction: 'red' });
    expect(dir('10:35')).toMatchObject({ direction: 'red', heldBy: 'hysteresis', rawDirection: 'mixed' });
    expect(dir('11:05')).toMatchObject({ direction: 'mixed' });

    // The live loop's reader, fed the same tape in the same order.
    resetMarketDirectionState();
    const live: MarketDirectionReading[] = SLOTS.map((slot) => {
      const t = at(slot);
      return readMarketDirectionForTick(
        {
          indexSymbol: 'SPY',
          indexChangePct: -0.5,
          breadth: breadthOf(names.map((n) => ((n.intraday.find((b) => b.time === t)?.close ?? 50) - 50) / 0.5)),
          ...THRESHOLDS,
        },
        t + 5 * 60_000,
        DAY,
      );
    });
    resetMarketDirectionState();
    expect(readings.map((r) => [r.reading.direction, r.reading.heldBy ?? null])).toEqual(
      live.map((r) => [r.direction, r.heldBy ?? null]),
    );
  });
});

describe('directionChangeRows — the rows the loop would have journaled', () => {
  const r = (hhmm: string, direction: MarketDirectionReading['direction'], heldBy?: 'hysteresis', day = DAY) =>
    ({
      at: at(hhmm, day),
      day,
      reading: { direction, ...(heldBy ? { heldBy } : {}) } as MarketDirectionReading,
    }) as TapeReading;

  it('writes the first reading of each day, then one per change of direction or hold', () => {
    const rows = directionChangeRows([
      r('09:35', 'red'),
      r('09:40', 'red'),
      r('09:45', 'red', 'hysteresis'),
      r('09:50', 'red', 'hysteresis'),
      r('09:55', 'mixed'),
      r('10:00', 'mixed'),
      r('10:05', 'red'),
      r('09:35', 'red', undefined, '2026-09-11'),
    ]);
    expect(rows.map((x) => [x.day, x.reading.direction, x.reading.heldBy ?? null, x.at])).toEqual([
      [DAY, 'red', null, at('09:35')],
      [DAY, 'red', 'hysteresis', at('09:45')],
      [DAY, 'mixed', null, at('09:55')],
      [DAY, 'red', null, at('10:05')],
      ['2026-09-11', 'red', null, at('09:35', '2026-09-11')],
    ]);
    // A row is not a flip: the hold change is a row, and the direction did
    // not change across it.
    expect(flipsPerSession(toDirectionIndex(rows))).toEqual([
      { day: DAY, rows: 4, flips: 2 },
      { day: '2026-09-11', rows: 1, flips: 0 },
    ]);
  });
});

describe('mergeDirectionIndex', () => {
  it('takes a day the journal read whole from the journal, and every other day from the rebuild', () => {
    const rebuilt: DirectionIndex = new Map([
      [
        DAY,
        [
          { at: at('09:35'), direction: 'red' },
          { at: at('11:00'), direction: 'mixed' },
        ],
      ],
      ['2026-09-11', [{ at: at('09:35', '2026-09-11'), direction: 'green' }]],
    ]);
    const live: DirectionIndex = new Map([
      [DAY, [{ at: at('09:37'), direction: 'mixed' }]],
      ['2026-09-14', []],
    ]);
    const merged = mergeDirectionIndex(rebuilt, live);
    expect(merged.get(DAY)).toEqual([{ at: at('09:37'), direction: 'mixed' }]);
    expect(merged.get('2026-09-11')).toEqual([{ at: at('09:35', '2026-09-11'), direction: 'green' }]);
    // An empty journal day is not a reading.
    expect(merged.has('2026-09-14')).toBe(false);
  });
});

describe('windowCandleSource — the provider contract, over one fetch per symbol', () => {
  const extendedDay = (day: string) => {
    const out: Candle[] = [];
    for (let m = 4 * 60; m < 20 * 60; m += 5) {
      const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      out.push(bar(at(hhmm, day), m));
    }
    return out;
  };

  it('serves the regular session of the asked-for days, and fetches each symbol once for the window', async () => {
    const calls: string[] = [];
    const source = windowCandleSource(
      async (symbol: string, timeframe: Timeframe, from: string, to: string) => {
        calls.push(`${symbol}|${timeframe}|${from}|${to}`);
        return timeframe === 'daily'
          ? [dailyBar(PREV, 10), dailyBar(DAY, 11)]
          : [...extendedDay(PREV), ...extendedDay(DAY)];
      },
      { from: '2026-09-01', to: DAY },
    );
    const day = await source.getCandles('AAA', '5min', { start: DAY, end: DAY });
    expect(day).toHaveLength(78);
    expect(day[0].time).toBe(at('09:30'));
    expect(day[day.length - 1].time).toBe(at('15:55'));
    const both = await source.getCandles('AAA', '5min', { start: PREV, end: DAY });
    expect(both).toHaveLength(156);
    expect(await source.getCandles('AAA', '5min', { start: PREV, end: DAY, limit: 3 })).toEqual(both.slice(-3));
    // A daily bar belongs to its UTC date, which is its ET trading day.
    expect((await source.getCandles('AAA', 'daily', { start: DAY, end: DAY })).map((b) => b.close)).toEqual([11]);
    expect(calls).toEqual(['AAA|5min|2026-09-01|2026-09-10', 'AAA|daily|2026-09-01|2026-09-10']);
    // A query outside the window is fetched on its own.
    await source.getCandles('AAA', '5min', { start: '2026-08-20', end: '2026-08-20' });
    expect(calls[calls.length - 1]).toBe('AAA|5min|2026-08-20|2026-08-20');
  });

  it('does not remember a failed fetch', async () => {
    let attempts = 0;
    const source = windowCandleSource(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('429');
        return extendedDay(DAY);
      },
      { from: DAY, to: DAY },
    );
    await expect(source.getCandles('AAA', '5min', { start: DAY, end: DAY })).rejects.toThrow('429');
    expect(await source.getCandles('AAA', '5min', { start: DAY, end: DAY })).toHaveLength(78);
  });
});

describe('seededSample', () => {
  const universe = Array.from({ length: 300 }, (_, i) => `S${String(i).padStart(3, '0')}`);

  it('draws the same names for the same universe and seed, whatever order the universe is listed in', () => {
    const a = seededSample(universe, 120, 20260926);
    expect(a).toHaveLength(120);
    expect(seededSample([...universe].reverse(), 120, 20260926)).toEqual(a);
    expect(seededSample(universe, 120, 1)).not.toEqual(a);
    expect(seededSample(universe.slice(0, 50), 120, 20260926)).toHaveLength(50);
  });
});

describe('atrBefore — as of the previous close', () => {
  it("reads the bars before the day, never the day's own", () => {
    const days = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 7, 10 + i)).toISOString().slice(0, 10));
    const bars = days.map((d) => dailyBar(d, 100, 4));
    const day = days[days.length - 1];
    const before = atrBefore(bars, day);
    expect(before).toBeCloseTo(4, 6);
    // A 40-point range ON the day changes nothing; the same range the day
    // before does.
    const onDay = bars.map((b, i) => (i === bars.length - 1 ? { ...b, high: 140, low: 100 } : b));
    expect(atrBefore(onDay, day)).toBeCloseTo(4, 6);
    const dayBefore = bars.map((b, i) => (i === bars.length - 2 ? { ...b, high: 140, low: 100 } : b));
    expect(atrBefore(dayBefore, day)!).toBeGreaterThan(4);
  });
});

describe('floorReader — the live floor in force, as the journal recorded it', () => {
  // 2026-09-14: 72 all morning, 81 from the 11:42 tick (pace scoring went on).
  const D = '2026-09-14';
  const obs = [
    { at: at('09:37', '2026-09-11'), floor: 72 },
    { at: at('09:37:17', D), floor: 72 },
    { at: at('11:16:21', D), floor: 72 },
    { at: at('11:42:27', D), floor: 81 },
    { at: at('09:36:54', '2026-09-15'), floor: 81 },
  ];
  const floorAt = floorReader(obs);

  it('reads the latest observation that day, its own tick included', () => {
    expect(floorAt(at('11:40:10', D))).toBe(72);
    // The signal row precedes the refusal that records the floor, in one tick.
    expect(floorAt(at('11:42:20', D))).toBe(81);
    expect(floorAt(at('15:00', D))).toBe(81);
  });

  it("takes the day's first observation before its first row, and carries a floor over a day without one", () => {
    expect(floorAt(at('09:31', '2026-09-15'))).toBe(81);
    expect(floorAt(at('10:00', '2026-09-16'))).toBe(81);
    expect(floorAt(at('10:00', '2026-09-12'))).toBe(72);
  });

  it('reads no floor before the first one was recorded', () => {
    expect(floorAt(at('10:00', '2026-08-20'))).toBe(0);
    expect(floorReader([])(at('10:00'))).toBe(0);
  });
});

describe('scoreSignals — a signal scored from its own tick', () => {
  it("takes the latest candidate of the signal's symbol and side at or before it, within one tick", () => {
    const signals = [
      { symbol: 'AAA', at: at('10:00:05'), side: 'sell' as const, entry: 10, stop: 10.25 },
      { symbol: 'BBB', at: at('10:00:05'), side: 'sell' as const, entry: 20, stop: 20.5 },
      { symbol: 'CCC', at: at('10:00:05'), side: 'sell' as const, entry: 30, stop: 30.75 },
    ];
    const scored = scoreSignals(signals, [
      { symbol: 'AAA', at: at('09:57:50'), direction: 'short', total: 70 },
      { symbol: 'AAA', at: at('10:00:04'), direction: 'short', total: 84 },
      { symbol: 'AAA', at: at('10:02:15'), direction: 'short', total: 90 }, // the next tick
      { symbol: 'BBB', at: at('09:57:50'), direction: 'short', total: 88 }, // a tick too old
      { symbol: 'CCC', at: at('10:00:04'), direction: 'long', total: 95 }, // the other side
    ]);
    expect(scored.map((s) => [s.symbol, s.score])).toEqual([['AAA', 84]]);
  });
});

describe('atrReachRefuses — the live entry path’s ATR gate', () => {
  it('refuses a stop further than the fraction of ATR, and nothing it cannot measure', () => {
    // 2.5% of 100 against an ATR of 3: 2.5 > 0.7 x 3 = 2.1.
    expect(atrReachRefuses(100, 102.5, 3, 0.7)).toBe(true);
    expect(atrReachRefuses(100, 102.5, 4, 0.7)).toBe(false);
    expect(atrReachRefuses(100, 102.1, 3, 0.7)).toBe(false); // at the line
    expect(atrReachRefuses(100, 102.5, 3, 0)).toBe(false); // off
    expect(atrReachRefuses(100, 102.5, null, 0.7)).toBe(false);
  });
});
