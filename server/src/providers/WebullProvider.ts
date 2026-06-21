import { MarketDataProvider, ProviderCapabilities, ProviderError } from './MarketDataProvider';
import { Candle, CandleQuery, Fundamentals, OptionsChain, Quote, Timeframe } from './types';
import { WebullClient } from './webull/client';

// ---------------------------------------------------------------------------
// Composite Webull provider.
//
// Webull's v2 OpenAPI is a licensed real-time feed for US *stocks* — it serves
// quotes (snapshot) and candles (bars). It has NO option-chain enumeration
// endpoint (only per-contract option data by OCC symbol) and no clean
// fundamentals bundle, so those two capabilities delegate to an auxiliary
// provider (`aux`, normally Yahoo). The result: real-time licensed stock data
// from Webull, option chains + fundamentals from Yahoo — behind one provider.
//
// Response shapes (snapshot/bars) are mapped defensively: prices arrive as
// strings, timestamps as epoch ms (occasionally seconds), and the payload may
// be a bare array or wrapped in `{ data: [...] }`.
// ---------------------------------------------------------------------------

const TIMESPAN: Record<Timeframe, string> = {
  '1min': 'M1',
  '5min': 'M5',
  '15min': 'M15',
  daily: 'D',
  weekly: 'W',
};

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Webull responses are sometimes a bare array, sometimes `{ data: [...] }`. */
function asArray(resp: unknown): Record<string, unknown>[] {
  if (Array.isArray(resp)) return resp as Record<string, unknown>[];
  if (resp && typeof resp === 'object') {
    const data = (resp as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return [];
}

/** Auth/entitlement failure — must surface (don't silently mask with the aux
 *  provider), since it usually means the OpenAPI quote subscription is inactive. */
function isAuthError(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === 401 || err.status === 403);
}

/** A symbol Webull's feed doesn't carry (e.g. class shares like BRK.B → 417
 *  INVALID_SYMBOL). Safe to fall back to the aux provider, which may have it. */
function isSymbolError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status === 404 || err.status === 417) return true;
  return /does not exist|invalid.?symbol|not found/i.test(err.message);
}

/**
 * Parse a Webull time field to epoch ms. Webull mixes formats across endpoints:
 * bars return an ISO-8601 string ("2026-06-18T19:59:00.000+0000"), while other
 * surfaces use an epoch number (seconds or ms) or its string form.
 */
function parseTime(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

export class WebullProvider implements MarketDataProvider {
  readonly name = 'webull';
  readonly synthetic = false;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly client: WebullClient,
    /** Auxiliary provider (Yahoo) for option chains + fundamentals. */
    private readonly aux: MarketDataProvider,
  ) {
    this.capabilities = {
      quotes: true,
      candles: true,
      options: aux.capabilities.options,
      fundamentals: aux.capabilities.fundamentals,
    };
  }

  /** Prime the auxiliary provider (e.g. Yahoo's cookie/crumb) — Webull has no warmup cost. */
  async warmup(): Promise<void> {
    if (this.aux.warmup) await this.aux.warmup();
  }

  private async marketGet(path: string, query: Record<string, string>): Promise<unknown> {
    const r = await this.client.call('GET', path, { query, surface: 'market' });
    if (!r.ok) {
      const j = (r.data ?? {}) as { msg?: string; message?: string; error_code?: string };
      const msg = j.msg || j.message || `Webull ${path} failed (${r.status})`;
      // Preserve the real 4xx status (e.g. 401 = no quote subscription, 417 =
      // INVALID_SYMBOL) so callers can decide whether to fall back to the aux
      // provider; collapse 5xx to a generic 502.
      throw new ProviderError(msg, r.status >= 400 && r.status < 500 ? r.status : 502);
    }
    return r.data;
  }

  private mapQuote(row: Record<string, unknown>): Quote {
    const changeRatio = num(row.change_ratio);
    return {
      symbol: String(row.symbol ?? '').toUpperCase(),
      last: num(row.price) ?? num(row.close) ?? num(row.pre_close) ?? 0,
      bid: num(row.bid),
      ask: num(row.ask),
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      prevClose: num(row.pre_close),
      change: num(row.change),
      // Webull's change_ratio is a fraction (0.0123 = 1.23%); the app wants percent.
      changePct: changeRatio !== undefined ? round2(changeRatio * 100) : undefined,
      volume: num(row.volume),
      timestamp: parseTime(row.last_trade_time ?? row.trade_time ?? row.time) ?? Date.now(),
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const quotes = await this.getQuotes([symbol]);
    const hit = quotes.find((q) => q.symbol === symbol.toUpperCase());
    if (!hit) throw new ProviderError(`No Webull quote for ${symbol}`, 404);
    return hit;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const got = new Map<string, Quote>();
    // Webull snapshot accepts at most 100 symbols per call — chunk larger scans.
    for (let i = 0; i < upper.length; i += 100) {
      try {
        const data = await this.marketGet('/openapi/market-data/stock/snapshot', {
          symbols: upper.slice(i, i + 100).join(','),
          category: 'US_STOCK',
        });
        for (const row of asArray(data)) {
          const q = this.mapQuote(row);
          if (q.symbol) got.set(q.symbol, q);
        }
      } catch (err) {
        // A bad symbol can 417 the whole chunk; leave its symbols missing so
        // they fall back to the aux provider below. Auth failures must surface.
        if (isAuthError(err)) throw err;
      }
    }
    // Symbols Webull doesn't carry (e.g. BRK.B) → resolve from the aux provider.
    const missing = upper.filter((s) => !got.has(s));
    if (missing.length) {
      const auxQuotes = this.aux.getQuotes
        ? await this.aux.getQuotes(missing)
        : (await Promise.all(missing.map((s) => this.aux.getQuote(s).catch(() => null)))).filter(
            (q): q is Quote => q !== null,
          );
      for (const q of auxQuotes) got.set(q.symbol.toUpperCase(), q);
    }
    return upper.map((s) => got.get(s)).filter((q): q is Quote => q !== undefined);
  }

  /** Pull the bar list out of Webull's response (array-of-instruments with a
   *  nested `bars` array, or a bare array of bars). */
  private extractBars(resp: unknown): Record<string, unknown>[] {
    const arr = asArray(resp);
    if (arr.length === 0) return [];
    if (Array.isArray((arr[0] as { bars?: unknown }).bars)) {
      return arr.flatMap((x) => (x.bars as Record<string, unknown>[]) ?? []);
    }
    return arr;
  }

  async getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]> {
    const limit = query?.limit ?? 120;
    let resp: unknown;
    try {
      resp = await this.marketGet('/openapi/market-data/stock/bars', {
        symbol: symbol.toUpperCase(),
        category: 'US_STOCK',
        timespan: TIMESPAN[timeframe],
        count: String(Math.min(Math.max(limit, 1), 1200)),
      });
    } catch (err) {
      // A symbol Webull doesn't carry (BRK.B → 417) falls back to the aux
      // provider; auth/other errors propagate so they stay visible.
      if (isSymbolError(err)) return this.aux.getCandles(symbol, timeframe, query);
      throw err;
    }
    const candles: Candle[] = this.extractBars(resp)
      .map((b) => ({
        time: parseTime(b.time ?? b.timestamp ?? b.trade_time) ?? 0,
        open: round2(num(b.open) ?? 0),
        high: round2(num(b.high) ?? 0),
        low: round2(num(b.low) ?? 0),
        close: round2(num(b.close) ?? 0),
        volume: num(b.volume) ?? 0,
      }))
      .filter((c) => c.time > 0);
    candles.sort((a, b) => a.time - b.time);
    return candles.slice(-limit);
  }

  // --- Delegated to the auxiliary provider (Webull can't enumerate chains) ---

  getOptionsExpirations(symbol: string): Promise<string[]> {
    return this.aux.getOptionsExpirations(symbol);
  }

  getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
    return this.aux.getOptionsChain(symbol, expiration);
  }

  /**
   * Fundamentals: the descriptive fields (name, sector, industry, beta) come
   * from the aux provider; Webull's snapshot carries licensed valuation metrics
   * (market cap, P/E, EPS, dividend yield, 52-week range), so overlay those on
   * top when available. A symbol Webull doesn't carry just keeps the aux data.
   */
  async getFundamentals(symbol: string): Promise<Fundamentals> {
    const base = await this.aux.getFundamentals(symbol);
    let row: Record<string, unknown> | undefined;
    try {
      const data = await this.marketGet('/openapi/market-data/stock/snapshot', {
        symbols: symbol.toUpperCase(),
        category: 'US_STOCK',
      });
      row = asArray(data)[0];
    } catch (err) {
      if (isAuthError(err)) throw err; // surface a missing quote subscription
      return base; // symbol not covered etc. — keep the aux fundamentals
    }
    if (!row) return base;
    const overlay: Partial<Fundamentals> = {};
    const set = <K extends keyof Fundamentals>(k: K, v: Fundamentals[K] | undefined) => {
      if (v !== undefined) overlay[k] = v;
    };
    set('marketCap', num(row.market_value));
    set('peRatio', num(row.pe_ratio));
    set('eps', num(row.eps_ttm) ?? num(row.eps));
    set('dividendYield', num(row.yield));
    set('high52', num(row.fifty_two_wk_high));
    set('low52', num(row.fifty_two_wk_low));
    return { ...base, ...overlay };
  }
}
