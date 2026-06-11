import { MarketDataProvider, ProviderCapabilities, ProviderError } from './MarketDataProvider';
import {
  Candle,
  CandleQuery,
  Fundamentals,
  OptionContract,
  OptionGreeks,
  OptionsChain,
  Quote,
  Timeframe,
} from './types';
import { getJson } from '../util/http';
import { bsGreeks, impliedVol, yearsToExpiration } from '../options/blackScholes';

// ---------------------------------------------------------------------------
// Tradier (https://documentation.tradier.com/) concrete provider.
// Endpoints used:
//   GET /markets/quotes              - quotes (batchable via comma list)
//   GET /markets/history             - daily/weekly OHLCV
//   GET /markets/timesales           - intraday OHLCV
//   GET /markets/options/expirations - expirations
//   GET /markets/options/chains      - chain w/ greeks + mid_iv
// Fundamentals are derived from quote fields (52w hi/lo, avg volume) since the
// dedicated fundamentals API isn't reliably available on sandbox tokens.
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Tradier returns a single object (not an array) when there's one element. */
function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const RISK_FREE = 0.04;

export class TradierProvider implements MarketDataProvider {
  readonly name = 'tradier';
  readonly synthetic = false;
  readonly capabilities: ProviderCapabilities = {
    quotes: true,
    candles: true,
    options: true,
    fundamentals: true,
  };

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {
    if (!token) {
      throw new ProviderError('TRADIER_API_TOKEN is not set; cannot use the Tradier provider', 500);
    }
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    const url = `${this.baseUrl}${path}?${qs}`;
    return getJson<T>(url, { headers: { Authorization: `Bearer ${this.token}` } });
  }

  private mapQuote(q: any): Quote {
    const last = num(q.last) ?? num(q.close) ?? num(q.prevclose) ?? 0;
    return {
      symbol: String(q.symbol).toUpperCase(),
      last,
      bid: num(q.bid),
      ask: num(q.ask),
      open: num(q.open),
      high: num(q.high),
      low: num(q.low),
      prevClose: num(q.prevclose),
      change: num(q.change),
      changePct: num(q.change_percentage),
      volume: num(q.volume),
      avgVolume: num(q.average_volume),
      timestamp: num(q.trade_date) ?? Date.now(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const data = await this.get<any>('/markets/quotes', {
      symbols: symbols.join(','),
      greeks: false,
    });
    return asArray(data?.quotes?.quote).map((q) => this.mapQuote(q));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const [q] = await this.getQuotes([symbol]);
    if (!q) throw new ProviderError(`No quote for ${symbol}`, 404);
    return q;
  }

  async getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]> {
    const limit = query?.limit ?? 120;
    const intraday = timeframe === '1min' || timeframe === '5min' || timeframe === '15min';
    let candles: Candle[];

    if (intraday) {
      const end = query?.end ?? fmtDate(new Date());
      const start = query?.start ?? fmtDate(new Date(Date.now() - 5 * 24 * 3600 * 1000));
      const data = await this.get<any>('/markets/timesales', {
        symbol,
        interval: timeframe,
        start,
        end,
        session_filter: 'open',
      });
      candles = asArray(data?.series?.data).map((d: any) => ({
        time: (num(d.timestamp) ?? Date.parse(d.time) / 1000) * 1000,
        open: num(d.open) ?? num(d.price) ?? 0,
        high: num(d.high) ?? num(d.price) ?? 0,
        low: num(d.low) ?? num(d.price) ?? 0,
        close: num(d.close) ?? num(d.price) ?? 0,
        volume: num(d.volume) ?? 0,
      }));
    } else {
      const end = query?.end ?? fmtDate(new Date());
      const lookbackDays = timeframe === 'weekly' ? limit * 9 : limit * 2;
      const start = query?.start ?? fmtDate(new Date(Date.now() - lookbackDays * 24 * 3600 * 1000));
      const data = await this.get<any>('/markets/history', {
        symbol,
        interval: timeframe === 'weekly' ? 'weekly' : 'daily',
        start,
        end,
      });
      candles = asArray(data?.history?.day).map((d: any) => ({
        time: Date.parse(`${d.date}T00:00:00Z`),
        open: num(d.open) ?? 0,
        high: num(d.high) ?? 0,
        low: num(d.low) ?? 0,
        close: num(d.close) ?? 0,
        volume: num(d.volume) ?? 0,
      }));
    }

    candles.sort((a, b) => a.time - b.time);
    return candles.slice(-limit);
  }

  async getOptionsExpirations(symbol: string): Promise<string[]> {
    const data = await this.get<any>('/markets/options/expirations', {
      symbol,
      includeAllRoots: true,
      strikes: false,
    });
    return asArray<string>(data?.expirations?.date).map(String);
  }

  async getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
    const [data, quote] = await Promise.all([
      this.get<any>('/markets/options/chains', { symbol, expiration, greeks: true }),
      this.getQuote(symbol).catch(() => undefined),
    ]);
    const underlyingPrice = quote?.last;
    const T = yearsToExpiration(expiration);

    const calls: OptionContract[] = [];
    const puts: OptionContract[] = [];
    for (const o of asArray<any>(data?.options?.option)) {
      const type: 'call' | 'put' = o.option_type === 'put' ? 'put' : 'call';
      const strike = num(o.strike) ?? 0;
      const bid = num(o.bid);
      const ask = num(o.ask);
      const last = num(o.last);
      const mark = bid !== undefined && ask !== undefined && bid + ask > 0 ? (bid + ask) / 2 : last;

      const greeks = this.mapOrComputeGreeks(o.greeks, {
        type,
        strike,
        mark,
        underlyingPrice,
        T,
      });

      const contract: OptionContract = {
        symbol: String(o.symbol),
        underlying: symbol.toUpperCase(),
        type,
        strike,
        expiration,
        bid,
        ask,
        last,
        mark: mark !== undefined ? Math.round(mark * 100) / 100 : undefined,
        volume: num(o.volume),
        openInterest: num(o.open_interest),
        greeks,
      };
      (type === 'call' ? calls : puts).push(contract);
    }

    calls.sort((a, b) => a.strike - b.strike);
    puts.sort((a, b) => a.strike - b.strike);
    return { underlying: symbol.toUpperCase(), expiration, underlyingPrice, calls, puts };
  }

  /** Use provider greeks when present; otherwise compute via Black–Scholes. */
  private mapOrComputeGreeks(
    raw: any,
    ctx: { type: 'call' | 'put'; strike: number; mark?: number; underlyingPrice?: number; T: number },
  ): OptionGreeks | undefined {
    if (raw && num(raw.mid_iv) !== undefined) {
      return {
        delta: num(raw.delta),
        gamma: num(raw.gamma),
        theta: num(raw.theta),
        vega: num(raw.vega),
        rho: num(raw.rho),
        iv: num(raw.mid_iv) ?? num(raw.smv_vol),
        computed: false,
      };
    }
    const { type, strike, mark, underlyingPrice, T } = ctx;
    if (mark === undefined || underlyingPrice === undefined || strike <= 0 || T <= 0) return undefined;
    const iv = impliedVol({ type, marketPrice: mark, S: underlyingPrice, K: strike, T, r: RISK_FREE });
    if (iv === undefined) return undefined;
    const g = bsGreeks({ type, S: underlyingPrice, K: strike, T, r: RISK_FREE, sigma: iv });
    return {
      delta: round4(g.delta),
      gamma: round4(g.gamma),
      theta: round4(g.theta),
      vega: round4(g.vega),
      rho: round4(g.rho),
      iv: round4(iv),
      computed: true,
    };
  }

  async getFundamentals(symbol: string): Promise<Fundamentals> {
    // Derive from the quote endpoint (reliable on sandbox). PE/EPS aren't
    // exposed here, so they're left undefined rather than faked.
    const data = await this.get<any>('/markets/quotes', { symbols: symbol, greeks: false });
    const q = asArray(data?.quotes?.quote)[0];
    if (!q) throw new ProviderError(`No data for ${symbol}`, 404);
    return {
      symbol: String(q.symbol).toUpperCase(),
      name: q.description ? String(q.description) : undefined,
      high52: num(q.week_52_high),
      low52: num(q.week_52_low),
      averageVolume: num(q.average_volume),
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
