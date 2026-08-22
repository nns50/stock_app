import { getProvider } from '../../providers';
import { Candle } from '../../providers/types';
import { TtlCache } from '../cache';
import { etToday } from '../../util/marketDate';

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
  const key = `${symbol.toUpperCase()}:${etToday(now)}`;
  const cached = vwapCache.get(key);
  if (cached !== undefined) return cached;
  let vwap: number | null;
  try {
    // A full session is 78 five-minute bars; 90 leaves margin for providers
    // that pad the range with pre-market bars (the session filter drops them).
    const candles = await getProvider().getCandles(symbol, '5min', { limit: 90 });
    vwap = computeSessionVwap(candles, now);
  } catch {
    vwap = null;
  }
  vwapCache.set(key, vwap);
  return vwap;
}
