import YahooFinance from 'yahoo-finance2';
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
import { bsGreeks, yearsToExpiration } from '../options/blackScholes';
import { sleep } from '../util/http';

// ---------------------------------------------------------------------------
// Yahoo Finance provider via `yahoo-finance2`. Free and key-less, and the only
// free source that also returns option chains — Greeks are computed locally from
// Yahoo's implied vol via Black–Scholes. UNOFFICIAL (personal use; may break or
// rate-limit), so it's flagged accordingly in providers/index.ts.
// ---------------------------------------------------------------------------

const RISK_FREE = 0.04;

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function isoUTC(d: Date | number | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

const INTERVAL: Record<Timeframe, string> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  daily: '1d',
  weekly: '1wk',
};

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  readonly synthetic = false;
  readonly capabilities: ProviderCapabilities = {
    quotes: true,
    candles: true,
    options: true,
    fundamentals: true,
  };

  // v3 requires an instance. suppressNotices silences the first-run survey log.
  private readonly yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  /** Prime Yahoo's cookie/crumb handshake so the first user request is fast.
   *  (The first call to Yahoo fetches an auth cookie + crumb; it's cached after.) */
  async warmup(): Promise<void> {
    try {
      await this.yf.quote('SPY');
    } catch {
      // ignore — this is only priming the auth handshake
    }
  }

  // Yahoo's free endpoints occasionally blip (especially the first chart call).
  // Retry transient failures with backoff so they self-heal; don't retry
  // deterministic ones (not-found / schema-validation).
  private async call<T>(label: string, fn: () => Promise<T>, retries = 2): Promise<T> {
    const deterministic = /not found|no data|404|validation/i;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const message = (err as Error).message || String(err);
        if (deterministic.test(message) || attempt === retries) break;
        await sleep(250 * 2 ** attempt + Math.random() * 150);
      }
    }
    const message = (lastErr as Error)?.message || String(lastErr);
    const status = /not found|no data|404/i.test(message) ? 404 : 502;
    throw new ProviderError(`Yahoo ${label} failed: ${message}`, status, lastErr);
  }

  private mapQuote(q: any): Quote {
    return {
      symbol: String(q.symbol).toUpperCase(),
      last: num(q.regularMarketPrice) ?? num(q.postMarketPrice) ?? num(q.regularMarketPreviousClose) ?? 0,
      bid: num(q.bid),
      ask: num(q.ask),
      open: num(q.regularMarketOpen),
      high: num(q.regularMarketDayHigh),
      low: num(q.regularMarketDayLow),
      prevClose: num(q.regularMarketPreviousClose),
      change: num(q.regularMarketChange),
      changePct: num(q.regularMarketChangePercent),
      volume: num(q.regularMarketVolume),
      avgVolume: num(q.averageDailyVolume3Month) ?? num(q.averageDailyVolume10Day),
      timestamp: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : Date.now(),
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const q = await this.call('quote', () => this.yf.quote(symbol));
    if (!q) throw new ProviderError(`No quote for ${symbol}`, 404);
    return this.mapQuote(q);
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    // Prefer the single batched call (one network round-trip), but never let a
    // batch issue break callers: fall back to resolving symbols individually.
    try {
      const res = await this.yf.quote(symbols);
      const arr = Array.isArray(res) ? res : [res];
      const mapped = arr.filter(Boolean).map((q) => this.mapQuote(q));
      if (mapped.length > 0) return mapped;
    } catch {
      // fall through to per-symbol resolution
    }
    const settled = await Promise.allSettled(symbols.map((s) => this.getQuote(s)));
    return settled
      .filter((r): r is PromiseFulfilledResult<Quote> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  private lookbackStart(timeframe: Timeframe, limit: number, end: Date): Date {
    const day = 24 * 3600 * 1000;
    let days: number;
    if (timeframe === '1min') days = 7;
    else if (timeframe === '5min' || timeframe === '15min') days = 59;
    else if (timeframe === 'weekly') days = limit * 9;
    else days = Math.max(limit * 2, 200);
    return new Date(end.getTime() - days * day);
  }

  async getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]> {
    const limit = query?.limit ?? 120;
    const end = query?.end ? new Date(`${query.end}T23:59:59Z`) : new Date();
    const start = query?.start ? new Date(`${query.start}T00:00:00Z`) : this.lookbackStart(timeframe, limit, end);

    const res = await this.call('chart', () =>
      this.yf.chart(symbol, { period1: start, period2: end, interval: INTERVAL[timeframe] as any }),
    );
    const quotes: any[] = (res as any)?.quotes ?? [];
    const candles: Candle[] = quotes
      .filter((q) => q && q.open != null && q.close != null)
      .map((q) => ({
        time: new Date(q.date).getTime(),
        open: round2(num(q.open) ?? 0),
        high: round2(num(q.high) ?? 0),
        low: round2(num(q.low) ?? 0),
        close: round2(num(q.close) ?? 0),
        volume: num(q.volume) ?? 0,
      }));
    candles.sort((a, b) => a.time - b.time);
    return candles.slice(-limit);
  }

  async getOptionsExpirations(symbol: string): Promise<string[]> {
    const res = await this.call('options', () => this.yf.options(symbol));
    const dates: any[] = (res as any)?.expirationDates ?? [];
    return dates.map((d) => isoUTC(d));
  }

  private mapContract(c: any, type: 'call' | 'put', underlying: string, expiration: string, S: number | undefined, T: number): OptionContract {
    const bid = num(c.bid);
    const ask = num(c.ask);
    const last = num(c.lastPrice);
    const strike = num(c.strike) ?? 0;
    const mark = bid !== undefined && ask !== undefined && bid + ask > 0 ? round2((bid + ask) / 2) : last;

    let greeks: OptionGreeks | undefined;
    const iv = num(c.impliedVolatility);
    if (iv !== undefined && iv > 0 && S !== undefined && strike > 0 && T > 0) {
      const g = bsGreeks({ type, S, K: strike, T, r: RISK_FREE, sigma: iv });
      greeks = {
        delta: round4(g.delta),
        gamma: round4(g.gamma),
        theta: round4(g.theta),
        vega: round4(g.vega),
        rho: round4(g.rho),
        iv: round4(iv),
        computed: true,
      };
    }

    return {
      symbol: String(c.contractSymbol ?? `${underlying}${strike}${type[0].toUpperCase()}`),
      underlying: underlying.toUpperCase(),
      type,
      strike,
      expiration,
      bid,
      ask,
      last,
      mark,
      volume: num(c.volume),
      openInterest: num(c.openInterest),
      greeks,
    };
  }

  async getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
    const res = await this.call('options', () =>
      this.yf.options(symbol, { date: new Date(`${expiration}T00:00:00Z`) }),
    );
    const chain = (res as any)?.options?.[0] ?? { calls: [], puts: [] };
    const underlyingPrice = num((res as any)?.quote?.regularMarketPrice);
    const T = yearsToExpiration(expiration);

    const calls = (chain.calls ?? []).map((c: any) => this.mapContract(c, 'call', symbol, expiration, underlyingPrice, T));
    const puts = (chain.puts ?? []).map((c: any) => this.mapContract(c, 'put', symbol, expiration, underlyingPrice, T));
    calls.sort((a: OptionContract, b: OptionContract) => a.strike - b.strike);
    puts.sort((a: OptionContract, b: OptionContract) => a.strike - b.strike);
    return { underlying: symbol.toUpperCase(), expiration, underlyingPrice, calls, puts };
  }

  async getFundamentals(symbol: string): Promise<Fundamentals> {
    const res = await this.call('quoteSummary', () =>
      this.yf.quoteSummary(symbol, { modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile'] }),
    );
    const price = (res as any)?.price ?? {};
    const sd = (res as any)?.summaryDetail ?? {};
    const ks = (res as any)?.defaultKeyStatistics ?? {};
    const ap = (res as any)?.assetProfile ?? {};
    return {
      symbol: symbol.toUpperCase(),
      name: price.longName ?? price.shortName ?? undefined,
      marketCap: num(price.marketCap) ?? num(sd.marketCap),
      peRatio: num(sd.trailingPE),
      eps: num(ks.trailingEps),
      dividendYield: num(sd.dividendYield),
      beta: num(sd.beta) ?? num(ks.beta),
      high52: num(sd.fiftyTwoWeekHigh),
      low52: num(sd.fiftyTwoWeekLow),
      averageVolume: num(sd.averageVolume) ?? num(sd.averageVolume10days),
      sector: ap.sector ?? undefined,
      industry: ap.industry ?? undefined,
    };
  }
}
