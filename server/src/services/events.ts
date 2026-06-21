import YahooFinance from 'yahoo-finance2';
import { TtlCache } from './cache';

// ---------------------------------------------------------------------------
// Upcoming corporate events (next earnings date, ex-dividend date) from Yahoo.
// Standalone and provider-agnostic: earnings awareness should work whatever
// MARKET_DATA_PROVIDER is set to (Yahoo is free and reliable for this). Used to
// flag positions/watchlist symbols with earnings approaching — the classic
// "don't hold options into earnings (IV crush)" guardrail.
//
// Cached for an hour (earnings dates move rarely) and resolved in one batched
// quote call, since Yahoo's quote already carries earningsTimestamp + dividend
// dates — no extra round-trips per symbol.
// ---------------------------------------------------------------------------

export interface SymbolEvents {
  symbol: string;
  /** Next earnings date (YYYY-MM-DD), if known. */
  earningsDate?: string;
  /** True when Yahoo only has an estimated window rather than a confirmed date. */
  earningsEstimated?: boolean;
  /** Ex-dividend date (YYYY-MM-DD), if known. */
  exDividendDate?: string;
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const cache = new TtlCache<SymbolEvents>(60 * 60 * 1000); // 1 hour

/** Yahoo uses a hyphen for class shares (BRK.B → BRK-B). */
function toYahoo(s: string): string {
  return s.replace(/\.([A-Za-z])$/, '-$1');
}

function isoDate(d: Date | number | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

async function fetchEvents(symbols: string[]): Promise<Map<string, SymbolEvents>> {
  const reqByYahoo = new Map(symbols.map((s) => [toYahoo(s).toUpperCase(), s.toUpperCase()]));
  const out = new Map<string, SymbolEvents>();
  let arr: Array<Record<string, unknown>>;
  try {
    const res = await yf.quote(symbols.map(toYahoo));
    arr = (Array.isArray(res) ? res : [res]) as Array<Record<string, unknown>>;
  } catch {
    return out; // best-effort; callers treat absence as "unknown"
  }
  for (const q of arr) {
    if (!q?.symbol) continue;
    const sym = reqByYahoo.get(String(q.symbol).toUpperCase()) ?? String(q.symbol).toUpperCase();
    const ts = q.earningsTimestamp as Date | undefined;
    const start = q.earningsTimestampStart as Date | undefined;
    const end = q.earningsTimestampEnd as Date | undefined;
    const earningsDate = ts ? isoDate(ts) : start ? isoDate(start) : undefined;
    const estimated = !!(start && end && +new Date(start) !== +new Date(end));
    out.set(sym, {
      symbol: sym,
      earningsDate,
      earningsEstimated: earningsDate ? estimated : undefined,
      exDividendDate: q.exDividendDate ? isoDate(q.exDividendDate as Date) : undefined,
    });
  }
  return out;
}

/** Upcoming events for a set of symbols (cached; missing data resolves to a bare entry). */
export async function getSymbolEvents(symbols: string[]): Promise<SymbolEvents[]> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  if (uniq.length === 0) return [];
  const missing = uniq.filter((s) => cache.get(s) === undefined);
  if (missing.length) {
    const fetched = await fetchEvents(missing);
    // Cache a bare entry even when Yahoo had nothing, so we don't refetch it for an hour.
    for (const s of missing) cache.set(s, fetched.get(s) ?? { symbol: s });
  }
  return uniq.map((s) => cache.get(s)).filter((e): e is SymbolEvents => e !== undefined);
}

/** Test/maintenance helper. */
export function clearEventsCache(): void {
  cache.clear();
}
