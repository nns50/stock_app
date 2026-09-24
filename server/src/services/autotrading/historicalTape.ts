import { atr as wilderAtr } from '../../indicators/indicators';
import { Candle, Timeframe, isIntradayTimeframe } from '../../providers/types';
import { etDateTimeToMs, etDayAndMinute, isRegularSessionMinute } from '../../util/marketDate';
import type { CandleSource } from '../excursion';
import { mulberry32 } from './edgeLeakScan';
import {
  breadthOf,
  DirectionExitBand,
  directionJournalKey,
  HeldDirection,
  holdMarketDirection,
  MarketDirection,
  MarketDirectionReading,
} from './marketDirection';
import type { DirectionIndex } from './marketDirectionIndex';

// ---------------------------------------------------------------------------
// The market-direction tape, rebuilt for sessions before the loop journaled it
// (the tape plan's PR 3, 2026-09-26).
//
// The loop has journaled a `market_direction_read` row on every change of the
// reading since 2026-09-24. Nothing before that carries a tape label, so "do
// shorts pay on red days" could not be asked of the two months of trades that
// came before. This rebuilds the reading for those sessions from bars, with
// the SAME functions the loop calls — breadthOf, then holdMarketDirection with
// the hold carried from slot to slot — so a rebuilt session and a live one
// differ only in their inputs, never in the rule.
//
// The inputs differ, and each difference is named:
//
//   the clock     one reading per 5-minute bar, stamped at the bar's END: the
//                 09:30 bar's close is known at 09:35, never before, so no
//                 reading can see a price from after the moment it labels. The
//                 loop reads every ~2m10s.
//   the index     the index's 5-minute close against the PREVIOUS SESSION'S
//                 daily close: what the live quote's change is measured from.
//   breadth       a sample of the universe (the script draws it), each name's
//                 5-minute close against its own previous daily close. A name
//                 with no bar in the slot is left out of that slot's sample:
//                 the live quote would carry its last trade, and leaving it out
//                 only shrinks the sample, never tilts it. Fewer than
//                 MIN_BREADTH_SAMPLE names is no reading, exactly as live.
//   the session   REGULAR-session bars only (09:30-16:00 ET). Polygon's minute
//                 aggregates run 04:00-20:00 ET, and a premarket print must not
//                 move a reading of the session, or be replayed as a fill.
//
// Pure: the bars come in, readings and rows go out. The script that fetches the
// bars and reads the database is scripts/tapeBackfill.ts, through
// historicalTapeData.ts.
// ---------------------------------------------------------------------------

/** One name's bars: its intraday bars at any hours (the rebuild keeps the
 *  regular session) and its daily bars (for the previous session's close). */
export interface TapeSeries {
  symbol: string;
  intraday: Candle[];
  daily: Candle[];
}

/** The bar a reading is judged against, and the band a one-sided reading is
 *  held inside: the four market-direction settings. */
export interface TapeThresholds extends DirectionExitBand {
  indexPct: number;
  breadthPct: number;
}

/** A reading the rebuild produced, stamped at the moment it became known. */
export interface TapeReading {
  /** Epoch ms: the END of the slot whose bars it was read from. */
  at: number;
  /** The ET session it belongs to. */
  day: string;
  reading: MarketDirectionReading;
}

/** Minutes per slot: the loop's 5-minute bars, the finest the rebuild reads. */
export const TAPE_SLOT_MINUTES = 5;

/** A Polygon DAILY bar's ET date. Polygon stamps a day at midnight ET and
 *  polygonClient floors it to midnight UTC of the same calendar date, so the
 *  UTC date IS the trading day. etDayAndMinute would read the evening before:
 *  midnight UTC is 20:00 ET the previous day. */
export function dailyBarDate(bar: Candle): string {
  return new Date(bar.time).toISOString().slice(0, 10);
}

/** The bars that START inside the regular session, 09:30-16:00 ET, and, when
 *  `day` is given, on that ET day. */
export function regularSessionBars(bars: Candle[], day?: string): Candle[] {
  return bars.filter((b) => {
    const t = etDayAndMinute(b.time);
    return (day === undefined || t.day === day) && isRegularSessionMinute(t.minute);
  });
}

/** Each bar array's regular-session bars by ET day, computed once per array: a
 *  rebuild asks for every name's bars on every session, and converting each
 *  bar's time to ET is the expensive part. Keyed weakly by the array itself. */
const sessionDaysOf = new WeakMap<Candle[], Map<string, Candle[]>>();

function regularSessionByDay(bars: Candle[]): Map<string, Candle[]> {
  let byDay = sessionDaysOf.get(bars);
  if (!byDay) {
    byDay = new Map();
    for (const b of bars) {
      const t = etDayAndMinute(b.time);
      if (!isRegularSessionMinute(t.minute)) continue;
      const list = byDay.get(t.day) ?? [];
      list.push(b);
      byDay.set(t.day, list);
    }
    sessionDaysOf.set(bars, byDay);
  }
  return byDay;
}

/** The previous session's close: the latest daily bar dated before `day`.
 *  Null when the daily bars do not reach back that far. */
export function priorClose(daily: Candle[], day: string): number | null {
  let found: Candle | null = null;
  for (const b of daily) {
    const d = dailyBarDate(b);
    if (d < day && (found === null || d > dailyBarDate(found))) found = b;
  }
  return found !== null && found.close > 0 ? found.close : null;
}

function changePct(price: number | undefined, prev: number | null): number | null {
  if (price === undefined || prev === null || !Number.isFinite(price)) return null;
  return ((price - prev) / prev) * 100;
}

/**
 * One session's readings, one per 5-minute slot from 09:30 to the index's last
 * regular-session bar that day, each stamped at its slot's END.
 *
 * The hold is carried from slot to slot through holdMarketDirection, the
 * function the loop's readMarketDirectionForTick calls, so hysteresis and the
 * data-gap hold behave as they do live. It starts empty: neither hold crosses
 * the ET day. No readings when the index has no bars that day.
 */
export function readingsFromBars(
  day: string,
  index: TapeSeries,
  names: TapeSeries[],
  thresholds: TapeThresholds,
): TapeReading[] {
  // regularSessionBars(bars, day), from each array's per-day buckets.
  const sessionOf = (bars: Candle[]) => regularSessionByDay(bars).get(day) ?? [];
  const indexBars = sessionOf(index.intraday);
  const open = etDateTimeToMs(day, '09:30');
  if (indexBars.length === 0 || open === null) return [];
  const closes = (bars: Candle[]) => new Map(bars.map((b) => [b.time, b.close]));
  const indexAt = closes(indexBars);
  const indexPrev = priorClose(index.daily, day);
  const series = names.map((n) => ({ at: closes(sessionOf(n.intraday)), prev: priorClose(n.daily, day) }));

  const step = TAPE_SLOT_MINUTES * 60_000;
  const lastStart = indexBars[indexBars.length - 1].time;
  const out: TapeReading[] = [];
  let held: HeldDirection | null = null;
  for (let start = open; start <= lastStart; start += step) {
    // Known at the END of the slot: a bar's close is its last trade before the
    // next bar opens.
    const at = start + step;
    const next = holdMarketDirection(
      {
        indexSymbol: index.symbol,
        indexChangePct: changePct(indexAt.get(start), indexPrev),
        breadth: breadthOf(series.map((s) => changePct(s.at.get(start), s.prev))),
        ...thresholds,
      },
      held,
      at,
      day,
    );
    held = next.held;
    out.push({ at, day, reading: next.reading });
  }
  return out;
}

/**
 * The rows the loop would have journaled for these readings: the first of each
 * ET day, then one per change of direction or hold (directionJournalKey, the
 * key the loop's claimDirectionChange uses).
 */
export function directionChangeRows(readings: TapeReading[]): TapeReading[] {
  const out: TapeReading[] = [];
  let last: { day: string; key: string } | null = null;
  for (const r of [...readings].sort((a, b) => a.at - b.at)) {
    const key = directionJournalKey(r.reading.direction, r.reading.heldBy);
    if (last !== null && last.day === r.day && last.key === key) continue;
    last = { day: r.day, key };
    out.push(r);
  }
  return out;
}

/** Rows as the index the edge-leak scan and the shadow replays read: by ET
 *  day, oldest first (marketDirectionIndex.ts). */
export function toDirectionIndex(rows: TapeReading[]): DirectionIndex {
  const out: DirectionIndex = new Map();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const day = out.get(r.day) ?? [];
    day.push({ at: r.at, direction: r.reading.direction });
    out.set(r.day, day);
  }
  return out;
}

/** The rebuilt index with the journal's own rows laid over it: a day the loop
 *  journaled is taken whole from the journal, never from the rebuild. */
export function mergeDirectionIndex(rebuilt: DirectionIndex, live: DirectionIndex): DirectionIndex {
  const out: DirectionIndex = new Map(rebuilt);
  for (const [day, rows] of live) if (rows.length > 0) out.set(day, rows);
  return out;
}

/** Per session: how many rows, and how many FLIPS — a change of direction
 *  between consecutive rows. A row can also mark a change of hold, so the two
 *  counts differ (marketDirection.ts). */
export function flipsPerSession(index: DirectionIndex): { day: string; rows: number; flips: number }[] {
  return [...index.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, rows]) => {
      let flips = 0;
      for (let i = 1; i < rows.length; i++) if (rows[i].direction !== rows[i - 1].direction) flips += 1;
      return { day, rows: rows.length, flips };
    });
}

/** How a session's readings split across the four directions, in slots. */
export function directionSlots(readings: TapeReading[]): Record<MarketDirection, number> {
  const out: Record<MarketDirection, number> = { red: 0, green: 0, mixed: 0, unknown: 0 };
  for (const r of readings) out[r.reading.direction] += 1;
  return out;
}

/** What fetches a symbol's bars over a window of ET days, inclusive
 *  (historicalData.getHistoricalBars: Polygon, cached). */
export type WindowBarFetch = (symbol: string, timeframe: Timeframe, from: string, to: string) => Promise<Candle[]>;

/**
 * A CandleSource over a window fetch, keeping the provider contract
 * (providers/types.ts) the replays are written against: `start`/`end` are ET
 * days, inclusive; intraday bars are the REGULAR session; an explicit window
 * comes back whole unless a `limit` is passed.
 *
 * Each symbol is fetched once for the whole window and sliced per query, so a
 * replay asking for twenty days of one name costs one call. A query outside the
 * window is fetched on its own. A failed fetch is not remembered.
 */
export function windowCandleSource(fetch: WindowBarFetch, window: { from: string; to: string }): CandleSource {
  const cache = new Map<string, Promise<Candle[]>>();
  const load = (symbol: string, timeframe: Timeframe, from: string, to: string): Promise<Candle[]> => {
    const key = `${symbol.toUpperCase()}|${timeframe}|${from}|${to}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = fetch(symbol, timeframe, from, to);
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
    }
    return hit;
  };
  return {
    async getCandles(symbol, timeframe, query) {
      const start = query?.start ?? window.from;
      const end = query?.end ?? window.to;
      const inWindow = start >= window.from && end <= window.to;
      const bars = await (inWindow
        ? load(symbol, timeframe, window.from, window.to)
        : load(symbol, timeframe, start, end));
      const intraday = isIntradayTimeframe(timeframe);
      const kept = bars.filter((b) => {
        if (!intraday) {
          const d = dailyBarDate(b);
          return d >= start && d <= end;
        }
        const t = etDayAndMinute(b.time);
        return t.day >= start && t.day <= end && isRegularSessionMinute(t.minute);
      });
      return query?.limit != null ? kept.slice(-query.limit) : kept;
    },
  };
}

// --- the readings' consumers: which trades, under which floor ---------------

/** A seeded draw of `n` names: the same names every run for the same universe
 *  and seed, whatever order the universe is listed in. */
export function seededSample(symbols: string[], n: number, seed: number): string[] {
  const pool = [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
  const rng = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, n)).sort();
}

/** A name's 14-day ATR as of the previous session's close: Wilder's, over the
 *  daily bars dated before `day` (the screen's definition, indicators.ts). The
 *  live signal's ATR may also have read the day's bar so far; this cannot, and
 *  says so where it is reported. */
export function atrBefore(daily: Candle[], day: string, period = 14): number | null {
  const prior = daily.filter((b) => dailyBarDate(b) < day).sort((a, b) => a.time - b.time);
  return wilderAtr(prior, period);
}

/** A moment the journal recorded the live score floor: every declined live
 *  entry carries `liveMinSignalScore` (declinedEntry.ts). */
export interface FloorObservation {
  at: number;
  floor: number;
}

/** How far after a moment a floor observation still belongs to it: the signal
 *  row is written first and the refusal that records the floor a few seconds
 *  later, in the same loop tick. Under the ~2m10s tick, so it never reaches the
 *  next one. */
export const FLOOR_SAME_TICK_MS = 60_000;

/**
 * The live score floor in force at each moment, read from the journal's own
 * observations rather than from a list of dates: on 2026-09-14 the floor moved
 * 72 -> 81 at 11:42 ET, mid-session.
 *
 * The latest observation that day at or before the moment (plus the same
 * tick); failing that, the day's first (the floor is set between sessions); a
 * day with none carries the last one before it. Before the first observation
 * there was no live floor: `liveMinSignalScore` shipped at 0 and was first
 * raised on 2026-09-06 (OPTIONS_TUNING_PLAN.md).
 */
export function floorReader(observations: FloorObservation[]): (at: number) => number {
  const sorted = [...observations].sort((a, b) => a.at - b.at);
  const days = sorted.map((o) => etDayAndMinute(o.at).day);
  // The first index whose value passes `test`, over a sorted prefix (days and
  // times are both ascending): a signal read tens of thousands of times.
  const firstIndex = (test: (i: number) => boolean): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  return (at) => {
    const day = etDayAndMinute(at).day;
    const dayStart = firstIndex((i) => days[i] >= day);
    const dayEnd = firstIndex((i) => days[i] > day);
    if (dayStart < dayEnd) {
      // The latest that day at or before the moment's tick, else the day's first.
      const upTo = firstIndex((i) => days[i] > day || sorted[i].at > at + FLOOR_SAME_TICK_MS);
      return upTo > dayStart ? sorted[upTo - 1].floor : sorted[dayStart].floor;
    }
    return dayStart > 0 ? sorted[dayStart - 1].floor : 0;
  };
}

/** A `signal_generated` row: what the decision step produced, every tick. */
export interface JournaledSignal {
  symbol: string;
  at: number;
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
}

/** A `candidate_found` row: the screen's score for the name that tick. */
export interface JournaledCandidate {
  symbol: string;
  at: number;
  direction: 'long' | 'short';
  total: number;
}

/** How much earlier than its signal a candidate row can be and still be the
 *  same tick's: the screen journals the candidate, then the decision step the
 *  signal (measured on the 2026-09-23 copy: median 19 ms, the largest 54 s). */
export const SIGNAL_CANDIDATE_MAX_GAP_MS = 120_000;

/**
 * Each signal's score. `signal_generated` does not carry one; the tick's
 * `candidate_found` row does (the signal's score IS the candidate's total,
 * decide.ts). A signal whose candidate cannot be found within one tick is left
 * out, and counted by the caller.
 */
export function scoreSignals(
  signals: JournaledSignal[],
  candidates: JournaledCandidate[],
): (JournaledSignal & { score: number })[] {
  const byKey = new Map<string, JournaledCandidate[]>();
  for (const c of candidates) {
    const key = `${c.symbol.toUpperCase()}|${c.direction}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.at - b.at);
  const out: (JournaledSignal & { score: number })[] = [];
  for (const s of signals) {
    const list = byKey.get(`${s.symbol.toUpperCase()}|${s.side === 'sell' ? 'short' : 'long'}`) ?? [];
    // The last candidate at or before the signal (binary search: a window holds
    // ~50,000 short signals).
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].at > s.at) hi = mid;
      else lo = mid + 1;
    }
    const hit = lo > 0 ? list[lo - 1] : null;
    if (hit !== null && s.at - hit.at <= SIGNAL_CANDIDATE_MAX_GAP_MS) out.push({ ...s, score: hit.total });
  }
  return out;
}

/** The tape a trade met, as a report groups it: a direction the loop read, or
 *  `unlabeled` — no reading yet that day, or one the loop could not see. */
export type TapeBucket = 'red' | 'mixed' | 'green' | 'unlabeled';

export const TAPE_BUCKETS: readonly TapeBucket[] = ['red', 'mixed', 'green', 'unlabeled'];

export function tapeBucketOf(direction: MarketDirection | null): TapeBucket {
  return direction === null || direction === 'unknown' ? 'unlabeled' : direction;
}
