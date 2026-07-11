import { MarketDataProvider, ProviderCapabilities } from './MarketDataProvider';
import { Candle, CandleQuery, Fundamentals, OptionsChain, Quote, Timeframe } from './types';
import { TtlCache } from '../services/cache';

/**
 * Decorator that caches quotes and candles with TTLs to cut provider calls and
 * respect rate limits. Options chains and fundamentals are passed straight
 * through (they're user-initiated and change more meaningfully per request).
 */
export class CachingProvider implements MarketDataProvider {
  readonly name: string;
  readonly synthetic: boolean;
  readonly capabilities: ProviderCapabilities;

  private readonly quoteCache: TtlCache<Quote>;
  private readonly candleCache: TtlCache<Candle[]>;

  constructor(
    private readonly base: MarketDataProvider,
    opts: { quoteTtlMs: number; candleTtlMs: number },
  ) {
    this.name = base.name;
    this.synthetic = base.synthetic;
    this.capabilities = base.capabilities;
    this.quoteCache = new TtlCache<Quote>(opts.quoteTtlMs);
    this.candleCache = new TtlCache<Candle[]>(opts.candleTtlMs);
  }

  getQuote(symbol: string): Promise<Quote> {
    return this.quoteCache.getOrLoad(symbol.toUpperCase(), () => this.base.getQuote(symbol));
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const upper = symbols.map((s) => s.toUpperCase());
    const missing = upper.filter((s) => this.quoteCache.get(s) === undefined);
    if (missing.length > 0) {
      const fetched = this.base.getQuotes
        ? await this.base.getQuotes(missing)
        : await Promise.all(missing.map((s) => this.base.getQuote(s)));
      for (const q of fetched) this.quoteCache.set(q.symbol.toUpperCase(), q);
    }
    return upper.map((s) => this.quoteCache.get(s)).filter((q): q is Quote => q !== undefined);
  }

  async getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]> {
    // A start/end range is its own exact cache entry — rare, mostly backtest
    // usage, not the every-60s hot path the plain-limit branch below exists for.
    if (query?.start != null || query?.end != null) {
      const key = `${symbol.toUpperCase()}:${timeframe}:${query.limit ?? ''}:${query.start ?? ''}:${query.end ?? ''}`;
      return this.candleCache.getOrLoad(key, () => this.base.getCandles(symbol, timeframe, query));
    }
    // Plain "last N bars" queries share ONE cache entry per symbol+timeframe
    // regardless of the requested limit, instead of keying on limit too — the
    // autotrade loop asks for the same symbol's recent daily candles under at
    // least three different limits within one tick (screen, options-decision,
    // correlation risk-check), which used to mean three separate upstream
    // fetches for identical data. A cached array shorter than the newly
    // requested limit is refetched (replacing the entry) rather than served
    // short; each caller still gets back exactly the limit it asked for.
    const key = `${symbol.toUpperCase()}:${timeframe}`;
    const cached = this.candleCache.get(key);
    if (cached && (query?.limit == null || cached.length >= query.limit)) {
      return query?.limit == null ? cached : cached.slice(-query.limit);
    }
    const fetched = await this.base.getCandles(symbol, timeframe, query);
    this.candleCache.set(key, fetched);
    return fetched;
  }

  getOptionsExpirations(symbol: string): Promise<string[]> {
    return this.base.getOptionsExpirations(symbol);
  }

  getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
    return this.base.getOptionsChain(symbol, expiration);
  }

  getFundamentals(symbol: string): Promise<Fundamentals> {
    return this.base.getFundamentals(symbol);
  }

  warmup(): Promise<void> {
    return this.base.warmup ? this.base.warmup() : Promise.resolve();
  }

  /** Invalidate cached quotes/candles (used by a forced "Refresh"). */
  clearCaches(): void {
    this.quoteCache.clear();
    this.candleCache.clear();
  }
}
