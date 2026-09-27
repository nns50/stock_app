import { listAutotradeEventsInWindow } from '../db/autotradeEvents';
import { getAutotradeConfig } from '../db/autotradeConfig';
import { listMlRegimeReadings } from '../db/mlRegimeReadings';
import { etToday } from '../util/marketDate';
import type { MlRegime } from './regimeModel';

// ---------------------------------------------------------------------------
// The shock nowcast's evidence (2026-09-26).
//
// regimeTriggers' third trigger (autotrading/effectiveRisk.ts) treats a tick as
// High Volatility/Bearish once SPY's range so far today reaches
// regimeShockRangeRatio × its 14-day ATR. The spec keeps that ratio at 0 until
// shock days have been compared with the model's next-session label. The only
// row a shock day used to write, `market_shock_detected`, is written when the
// trigger FIRES, which it cannot do at 0, so that evidence could never exist.
//
// autotrading/shockShadow.ts now measures the same quantity every in-session
// tick whatever the trigger's setting, and journals the first time each ET day
// it reaches each level below. This module reads those rows back: every day
// that reached a level is paired with the first known model reading that has
// SEEN the day (a later reading whose data date is on or after it), and a
// level is met once at least SHOCK_MIN_DAYS such days have a reading and the
// model read High Volatility/Bearish on more than half of them. The lowest met
// candidate is what the evening review proposes for regimeShockRangeRatio;
// setting it stays the operator's.
// ---------------------------------------------------------------------------

export const SHOCK_SHADOW_ACTION = 'market_shock_shadow';
export const SHOCK_SHADOW_PROXY = 'SPY';
/** Level 0 is each session's first measurement (the coverage marker). Level 1
 *  is the base rate: a range of one ordinary day's ATR so far. From 1.5 up the
 *  levels are the candidate ratios (SHOCK_CANDIDATE_RATIOS). */
export const SHOCK_SHADOW_LEVELS = [0, 1, 1.5, 2, 2.5, 3] as const;
export const SHOCK_CANDIDATE_RATIOS: readonly number[] = [1.5, 2, 2.5, 3];
/** The spec's bar: at least this many shock days at a level with a reading. */
export const SHOCK_MIN_DAYS = 3;
/** A reading more than this many calendar days after the shock day is not the
 *  model's next-session label; the day stays undecided. */
export const SHOCK_NEXT_READING_MAX_DAYS = 7;

export const SHOCK_NOWCAST_RULE =
  `A level is met once at least ${SHOCK_MIN_DAYS} sessions reached it and the model read ` +
  'High Volatility/Bearish on the first reading that had seen the day for more than half of ' +
  "them; the lowest met level from 1.5 is proposed as regimeShockRangeRatio (the operator's call).";

/** One journaled measurement: the ET day, the level it reached, and when. */
export interface ShockShadowRow {
  date: string;
  level: number;
  /** HH:MM ET when the range first reached the level; null when not recorded. */
  at: string | null;
}

/** The slice of a persisted reading the pairing needs. */
export interface ShockReading {
  etDate: string;
  regime: MlRegime;
  asOf: string | null;
}

export interface ShockDay {
  date: string;
  at: string | null;
  /** The model's reading ON the day, null when none was stored. */
  dayRegime: MlRegime | null;
  /** The first known reading that has seen the day, within a week; null while none has. */
  next: { etDate: string; asOf: string; regime: MlRegime } | null;
}

export interface ShockLevelEvidence {
  level: number;
  /** A ratio the evening review may propose (1.5 and up). */
  candidate: boolean;
  /** Measured sessions whose range reached the level. */
  days: number;
  /** Of those, the ones a later reading has seen. */
  decided: number;
  /** Of the decided, the model read High Volatility/Bearish on that later reading. */
  highVolNext: number;
  /** Of the decided, the model already read High Volatility/Bearish on the day itself. */
  highVolSameDay: number;
  meets: boolean;
  shockDays: ShockDay[];
}

export interface ShockNowcastEvidence {
  proxy: string;
  /** Sessions with at least one measurement (a level-0 row). */
  measuredSessions: number;
  firstMeasured: string | null;
  lastMeasured: string | null;
  levels: ShockLevelEvidence[];
  /** The lowest candidate level that meets the rule; null while none does or
   *  while the trigger is already on. */
  proposal: { regimeShockRangeRatio: number } | null;
  /** regimeShockRangeRatio today; 0 = the trigger is off. */
  triggerRatio: number;
  rule: string;
  /** True when the journal read hit its cap, so the counts are a floor. */
  journalTruncated: boolean;
}

function shiftDays(etDate: string, n: number): string {
  const [y, m, d] = etDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The first KNOWN reading after `day` whose data date is on or after it: the
 *  model's label once it has seen the day. Readings sorted by etDate. */
function firstReadingThatSaw(day: string, readings: readonly ShockReading[]): ShockDay['next'] {
  const latest = shiftDays(day, SHOCK_NEXT_READING_MAX_DAYS);
  for (const r of readings) {
    if (r.etDate <= day) continue;
    if (r.etDate > latest) break;
    if (r.regime === 'unknown' || r.asOf === null || r.asOf < day) continue;
    return { etDate: r.etDate, asOf: r.asOf, regime: r.regime };
  }
  return null;
}

/** Pure: the rows (any order, repeats allowed) against the readings. A day's
 *  level is kept once, at its earliest recorded time. */
export function computeShockNowcastEvidence(
  rows: readonly ShockShadowRow[],
  readings: readonly ShockReading[],
  triggerRatio: number,
  journalTruncated = false,
): ShockNowcastEvidence {
  const byDayLevel = new Map<string, ShockShadowRow>();
  for (const r of rows) {
    const key = `${r.date}|${r.level}`;
    const seen = byDayLevel.get(key);
    if (!seen || (r.at !== null && (seen.at === null || r.at < seen.at))) byDayLevel.set(key, r);
  }
  const sorted = [...readings].sort((a, b) => (a.etDate < b.etDate ? -1 : a.etDate > b.etDate ? 1 : 0));
  const dayReading = new Map(sorted.map((r) => [r.etDate, r]));
  const measured = [...byDayLevel.values()]
    .filter((r) => r.level === 0)
    .map((r) => r.date)
    .sort();

  const levels: ShockLevelEvidence[] = SHOCK_SHADOW_LEVELS.filter((l) => l > 0).map((level) => {
    const shockDays: ShockDay[] = [...byDayLevel.values()]
      .filter((r) => r.level === level)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((r) => {
        const own = dayReading.get(r.date);
        return {
          date: r.date,
          at: r.at,
          dayRegime: own && own.regime !== 'unknown' ? own.regime : null,
          next: firstReadingThatSaw(r.date, sorted),
        };
      });
    const decidedDays = shockDays.filter((d) => d.next !== null);
    const highVolNext = decidedDays.filter((d) => d.next!.regime === 'high_vol_bearish').length;
    const highVolSameDay = decidedDays.filter((d) => d.dayRegime === 'high_vol_bearish').length;
    return {
      level,
      candidate: SHOCK_CANDIDATE_RATIOS.includes(level),
      days: shockDays.length,
      decided: decidedDays.length,
      highVolNext,
      highVolSameDay,
      meets: decidedDays.length >= SHOCK_MIN_DAYS && highVolNext * 2 > decidedDays.length,
      shockDays,
    };
  });
  const met = levels.find((l) => l.candidate && l.meets);
  return {
    proxy: SHOCK_SHADOW_PROXY,
    measuredSessions: measured.length,
    firstMeasured: measured[0] ?? null,
    lastMeasured: measured[measured.length - 1] ?? null,
    levels,
    proposal: met && !(triggerRatio > 0) ? { regimeShockRangeRatio: met.level } : null,
    triggerRatio,
    rule: SHOCK_NOWCAST_RULE,
    journalTruncated,
  };
}

/** Parse one journal row's detail; null for anything this module did not write. */
function rowOf(detail: string | null): ShockShadowRow | null {
  if (!detail) return null;
  try {
    const d = JSON.parse(detail) as { date?: unknown; level?: unknown; at?: unknown };
    if (typeof d.date !== 'string' || typeof d.level !== 'number' || !Number.isFinite(d.level)) return null;
    return { date: d.date, level: d.level, at: typeof d.at === 'string' ? d.at : null };
  } catch {
    return null;
  }
}

/** The evidence from the database: every shadow row ever journaled and the
 *  readings from the first measured day on. Rows only; never fetches. */
export function readShockNowcastEvidence(now: number = Date.now()): ShockNowcastEvidence {
  const { events, truncated } = listAutotradeEventsInWindow({ stage: 'screen', actions: [SHOCK_SHADOW_ACTION] });
  const rows = events.map((e) => rowOf(e.detail)).filter((r): r is ShockShadowRow => r !== null);
  const triggerRatio = getAutotradeConfig().regimeShockRangeRatio;
  if (rows.length === 0) return computeShockNowcastEvidence([], [], triggerRatio, truncated);
  const since = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
  const readings = listMlRegimeReadings({ since, until: etToday(now), limit: 100_000 }).map((r) => ({
    etDate: r.etDate,
    regime: r.regime,
    asOf: r.asOf,
  }));
  return computeShockNowcastEvidence(rows, readings, triggerRatio, truncated);
}
