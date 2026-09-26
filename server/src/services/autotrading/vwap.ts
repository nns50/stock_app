import { getProvider } from '../../providers';
import { Candle } from '../../providers/types';
import { TtlCache } from '../cache';
import { etToday } from '../../util/marketDate';
import { computeSessionRange, SessionRange } from './entryExtension';

// ---------------------------------------------------------------------------
// Session VWAP, as an OBSERVER (2026-08-22) — deliberately not a filter yet.
//
// "Longs above VWAP, shorts below" is the classic day-trade alignment rule,
// and it plausibly raises win rate — but plausibly is not evidence, and every
// extra entry filter costs trade flow the daily-gain goal needs. So this
// module only MEASURES: at each live equity entry, today's session VWAP is
// computed once and stamped on the order → position as at-entry context
// (positions.entry_vwap), exactly like entry_score/market_regime/
// market_atr_pct before it. After enough closed trades, the journal itself
// answers whether VWAP-aligned entries actually win more HERE — and only then
// does an alignment filter deserve to exist. Same evidence-before-action
// pattern as the method-performance ledger.
//
// Cost is deliberately tiny: it runs only for entries actually being placed
// (a handful per day, never per screened candidate), from one 5-minute-bar
// fetch per symbol, cached 5 minutes, AFTER the broker placement so it can
// never delay or fail a real order. Every failure path returns null — an
// unmeasured entry simply has no context, never an invented one.
// ---------------------------------------------------------------------------

/** Regular-session bounds, minutes since ET midnight (9:30–16:00). */
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

const etMinutesFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function etMinutes(ms: number): number {
  const parts = etMinutesFmt.formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/**
 * Volume-weighted average price over `candles`, restricted to bars that START
 * inside today's regular ET session (pre/after-market prints trade thin and
 * would skew the day's real average). Standard typical-price VWAP:
 * Σ((H+L+C)/3 × V) / ΣV. Null when nothing usable — no bars from today's
 * session, or zero total volume.
 */
export function computeSessionVwap(candles: Candle[], now: number): number | null {
  const today = etToday(now);
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    if (!(c.volume > 0)) continue;
    if (etToday(c.time) !== today) continue;
    const m = etMinutes(c.time);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
  }
  if (!(vol > 0)) return null;
  return Math.round((pv / vol) * 10000) / 10000;
}

// Keyed by symbol; 5 minutes matches the bar size — a fresher fetch could
// only add one partial bar.
const vwapCache = new TtlCache<number | null>(5 * 60 * 1000);

/** Today's session VWAP for `symbol`, from the provider's 5-minute bars.
 *  Cached; NEVER throws — every failure reads as null (unmeasured). */
export async function fetchTodayVwap(symbol: string, now: number = Date.now()): Promise<number | null> {
  return (await fetchTodaySessionContext(symbol, now)).vwap;
}

/** Session VWAP and the session high/low, from ONE candle fetch. */
export interface SessionContext {
  vwap: number | null;
  range: SessionRange | null;
}

// Keyed by symbol; same 5-minute TTL and the same reasoning as vwapCache.
const contextCache = new TtlCache<SessionContext>(5 * 60 * 1000);

/**
 * Today's session VWAP *and* range for `symbol`, from a single 5-minute fetch.
 *
 * The range is derived from the SAME bars as the VWAP on purpose: two separate
 * fetches could straddle a bar boundary and describe slightly different
 * sessions, which is exactly the sort of quiet disagreement between two
 * derivations of one quantity this codebase has been bitten by. One fetch, one
 * session, both numbers.
 *
 * Cached; NEVER throws — every failure reads as nulls (unmeasured), never an
 * invented value, so a provider hiccup can never fabricate an entry context.
 */
export async function fetchTodaySessionContext(symbol: string, now: number = Date.now()): Promise<SessionContext> {
  const key = `${symbol.toUpperCase()}:${etToday(now)}`;
  const cached = contextCache.get(key);
  if (cached !== undefined) return cached;
  let ctx: SessionContext;
  try {
    // A full session is 78 five-minute bars; 90 leaves margin for providers
    // that pad the range with pre-market bars (the session filter drops them).
    const candles = await getProvider().getCandles(symbol, '5min', { limit: 90 });
    ctx = { vwap: computeSessionVwap(candles, now), range: computeSessionRange(candles, now) };
  } catch {
    ctx = { vwap: null, range: null };
  }
  contextCache.set(key, ctx);
  vwapCache.set(key, ctx.vwap);
  return ctx;
}

// ---------------------------------------------------------------------------
// The tape score's index legs (2026-09-26; marketTape.ts). The score reads
// SPY's and QQQ's price against three references a quote does not carry: the
// session VWAP, the session's opening bar (when the quote has no `open`), and
// the price 30 minutes ago. All three come from ONE 5-minute fetch per index,
// cached like the session context above, and the VWAP is computeSessionVwap's,
// so an entry's stamped VWAP and the tape's are one derivation.
// ---------------------------------------------------------------------------

/** What the tape score reads off an index's 5-minute bars. */
export interface IndexBarContext {
  /** Today's session VWAP (computeSessionVwap); null when unmeasured. */
  vwap: number | null;
  /** The open of today's first regular-session bar: the reference when the
   *  quote carries no `open`. */
  sessionOpen: number | null;
  /** The close of the latest session bar that had ENDED 30 minutes before
   *  `now`: the price the 30-minute slope is measured from. Null until a bar
   *  has (from 10:05 ET). */
  closeThirtyMinAgo: number | null;
}

const BAR_MS = 5 * 60_000;
const SLOPE_WINDOW_MS = 30 * 60_000;

/**
 * The tape's bar references from `candles`: today's regular-session bars only
 * (the same session rule as computeSessionVwap), none of them from after
 * `now`. Pure.
 */
export function indexLegsFromBars(candles: Candle[], now: number): IndexBarContext {
  const today = etToday(now);
  const session = candles
    .filter((c) => {
      if (etToday(c.time) !== today || c.time > now) return false;
      const m = etMinutes(c.time);
      return m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
    })
    .sort((a, b) => a.time - b.time);
  const first = session[0];
  let thirtyAgo: Candle | null = null;
  for (const c of session) if (c.time + BAR_MS <= now - SLOPE_WINDOW_MS) thirtyAgo = c;
  return {
    vwap: computeSessionVwap(session, now),
    sessionOpen: first !== undefined && first.open > 0 ? first.open : null,
    closeThirtyMinAgo: thirtyAgo !== null && thirtyAgo.close > 0 ? thirtyAgo.close : null,
  };
}

// Keyed by symbol and ET day; 5 minutes, the bar size, as for the contexts above.
const indexContextCache = new TtlCache<IndexBarContext>(5 * 60 * 1000);

/** The tape's bar references for an index, from one cached 5-minute fetch.
 *  NEVER throws: a failed fetch reads as nulls (the legs go unmeasured). */
export async function fetchTodayIndexContext(symbol: string, now: number = Date.now()): Promise<IndexBarContext> {
  const key = `${symbol.toUpperCase()}:${etToday(now)}`;
  const cached = indexContextCache.get(key);
  if (cached !== undefined) return cached;
  let ctx: IndexBarContext;
  try {
    const candles = await getProvider().getCandles(symbol, '5min', { limit: 90 });
    ctx = indexLegsFromBars(candles, now);
  } catch {
    ctx = { vwap: null, sessionOpen: null, closeThirtyMinAgo: null };
  }
  indexContextCache.set(key, ctx);
  return ctx;
}
