import YahooFinance from 'yahoo-finance2';
import { TtlCache } from './cache';
import { mapPool } from '../util/async';

// ---------------------------------------------------------------------------
// Recent stock-split detection from Yahoo — services/events.ts's sibling for
// a different question. events.ts answers "when is the NEXT earnings/ex-div
// date" (a single forward-looking value); this answers "did a split happen
// in the last N days" (a backward-looking window — a split has to be caught
// AFTER it takes effect for an open position to be flagged at all).
// Standalone and provider-agnostic for the same reason events.ts is: of the
// three configured providers (Tradier, Webull, Yahoo), Yahoo is the only one
// confirmed to expose split history at all.
//
// Deliberately DETECTION ONLY — this never adjusts any position's quantity
// or price. See docs/AUTOTRADING_SPEC.md for the fuller reasoning on why
// auto-adjustment is out of scope for now.
// ---------------------------------------------------------------------------

export interface SplitEvent {
  /** YYYY-MM-DD the split took effect. */
  date: string;
  /** Yahoo's own formatted ratio string, e.g. "4:1". */
  splitRatio: string;
  numerator: number;
  denominator: number;
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
// Splits are rare and this is checked at most once per ET day (see
// splitCheck.ts) — a long TTL just avoids a redundant re-fetch if this ever
// gets called more than once before that daily gate would anyway.
const cache = new TtlCache<SplitEvent[]>(12 * 60 * 60 * 1000); // 12 hours

/** Yahoo uses a hyphen for class shares (BRK.B → BRK-B). */
function toYahoo(s: string): string {
  return s.replace(/\.([A-Za-z])$/, '-$1');
}

function isoDate(d: Date | number | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

async function fetchRecentSplits(symbol: string, lookbackDays: number): Promise<SplitEvent[]> {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  try {
    const res = await yf.chart(toYahoo(symbol), { period1, period2, events: 'split' });
    const splits = (res as { events?: { splits?: Array<Record<string, unknown>> } })?.events?.splits ?? [];
    return splits.map((s) => ({
      date: isoDate(s.date as Date | string),
      splitRatio: String(s.splitRatio),
      numerator: Number(s.numerator),
      denominator: Number(s.denominator),
    }));
  } catch {
    return []; // best-effort; callers treat absence as "no split found," not "unknown"
  }
}

/** Splits in the last `lookbackDays` days for each symbol (cached; a fetch
 *  failure or a symbol with no recent split both resolve to an empty array —
 *  never throws). */
export async function getRecentSplits(symbols: string[], lookbackDays: number): Promise<Map<string, SplitEvent[]>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  const out = new Map<string, SplitEvent[]>();
  await mapPool(uniq, 6, async (symbol) => {
    const cacheKey = `${symbol}:${lookbackDays}`;
    let splits = cache.get(cacheKey);
    if (splits === undefined) {
      splits = await fetchRecentSplits(symbol, lookbackDays);
      cache.set(cacheKey, splits);
    }
    out.set(symbol, splits);
  });
  return out;
}

/** Test/maintenance helper. */
export function clearSplitsCache(): void {
  cache.clear();
}
