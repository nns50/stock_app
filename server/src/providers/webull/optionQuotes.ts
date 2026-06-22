import { webullClient, webullConfigured } from './account';
import { TtlCache } from '../../services/cache';

// ---------------------------------------------------------------------------
// Real-time option quotes from Webull's /option/snapshot, keyed by full OCC
// symbol. Overlays live bid/ask/last/size/volume/OI/greeks onto the (delayed)
// Yahoo-sourced option chain. Independent of MARKET_DATA_PROVIDER — works
// whenever Webull keys are set AND the app carries an OPRA options entitlement.
// Read-only; never throws.
//
// Confirmed live row shape (every value is a STRING; a bare array, not wrapped):
//   { symbol, price, open, high, low, volume, change, close, gamma, delta,
//     rho, theta, vega, bid, ask, instrument_id, pre_close, change_ratio,
//     last_trade_time, strike_price, imp_vol, open_interest, quote_time,
//     ask_size, bid_size, deal_amount }
// `price` is the last trade, `imp_vol`/greeks are fractions (0.147 = 14.7%),
// matching the chain's greeks; `change_ratio` is a fraction of prior close.
// ---------------------------------------------------------------------------

export interface OptionQuote {
  /** Full OCC contract symbol, e.g. AAPL260622C00300000. */
  symbol: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  /** (bid+ask)/2 when both sides are present, else the last trade. */
  mark?: number;
  volume?: number;
  openInterest?: number;
  /** Implied volatility as a fraction (0.147 = 14.7%), as the chain reports it. */
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  /** Percent change vs prior close. */
  changePct?: number;
  /** Epoch ms of the quote. */
  quoteTime?: number;
}

export interface OptionQuotesResult {
  ok: boolean;
  quotes: OptionQuote[];
  error?: string;
}

// Short TTL — fresh enough to feel live, but caps how hard auto-refresh and
// multiple viewers can hit OPRA for the same contract.
const cache = new TtlCache<OptionQuote>(4 * 1000);

// One /option/snapshot call can carry several OCC symbols; cap the batch so a
// stray request can't fan out unbounded.
const MAX_SYMBOLS = 40;

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function rows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const d = (data as { data?: unknown })?.data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

function mapQuote(r: Record<string, unknown>): OptionQuote {
  const bid = num(r.bid);
  const ask = num(r.ask);
  const last = num(r.price);
  const cr = num(r.change_ratio);
  return {
    symbol: String(r.symbol ?? '').toUpperCase(),
    bid,
    ask,
    bidSize: num(r.bid_size),
    askSize: num(r.ask_size),
    last,
    mark: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : last,
    volume: num(r.volume),
    openInterest: num(r.open_interest),
    iv: num(r.imp_vol),
    delta: num(r.delta),
    gamma: num(r.gamma),
    theta: num(r.theta),
    vega: num(r.vega),
    changePct: cr !== undefined ? cr * 100 : undefined,
    quoteTime: num(r.quote_time),
  };
}

/**
 * Fetch live option quotes for up to ~40 OCC symbols. Serves cached quotes and
 * only calls Webull for the misses; preserves the requested order. Read-only;
 * never throws.
 */
export async function webullOptionQuotes(symbols: string[]): Promise<OptionQuotesResult> {
  if (!webullConfigured()) {
    return { ok: false, quotes: [], error: 'Webull is not configured.' };
  }
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_SYMBOLS);
  if (!wanted.length) return { ok: true, quotes: [] };

  const found = new Map<string, OptionQuote>();
  const misses: string[] = [];
  for (const s of wanted) {
    const hit = cache.get(s);
    if (hit) found.set(s, hit);
    else misses.push(s);
  }

  if (misses.length) {
    const r = await webullClient().call('GET', '/openapi/market-data/option/snapshot', {
      query: { symbols: misses.join(','), category: 'US_OPTION' },
      surface: 'market',
    });
    if (r.ok) {
      for (const row of rows(r.data)) {
        const q = mapQuote(row);
        if (q.symbol) {
          cache.set(q.symbol, q);
          found.set(q.symbol, q);
        }
      }
    } else if (found.size === 0) {
      // Nothing cached to fall back on — surface the Webull error.
      const j = (r.data ?? {}) as { msg?: string; message?: string };
      return { ok: false, quotes: [], error: j.msg || j.message || `Webull request failed (${r.status})` };
    }
    // Otherwise keep the cached hits we do have rather than failing the whole call.
  }

  return { ok: true, quotes: wanted.map((s) => found.get(s)).filter((q): q is OptionQuote => q !== undefined) };
}

/** Test/maintenance helper. */
export function clearOptionQuotesCache(): void {
  cache.clear();
}
