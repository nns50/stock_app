import {
  Candle,
  CandleQuery,
  Fundamentals,
  OptionsChain,
  Quote,
  Timeframe,
} from './types';

/** What a provider supports. Drives feature gating (e.g. the options module). */
export interface ProviderCapabilities {
  quotes: boolean;
  candles: boolean;
  options: boolean;
  fundamentals: boolean;
}

/**
 * The single seam between the app and any market-data vendor. Swap providers by
 * implementing this interface and registering it in providers/index.ts — no
 * other code changes. The required methods mirror the task spec:
 *   getQuote, getCandles, getOptionsChain, getFundamentals.
 * A few optional/extra methods (batch quotes, expirations) let providers expose
 * cheaper paths when they have them.
 */
export interface MarketDataProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** True for non-real data sources (mock). The UI shows a clear banner. */
  readonly synthetic: boolean;

  getQuote(symbol: string): Promise<Quote>;
  /** Optional batch optimization; defaults to N getQuote calls if absent. */
  getQuotes?(symbols: string[]): Promise<Quote[]>;

  getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]>;

  /** List available option expirations (YYYY-MM-DD). */
  getOptionsExpirations(symbol: string): Promise<string[]>;
  getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain>;

  getFundamentals(symbol: string): Promise<Fundamentals>;
}

/** Raised by providers for upstream failures so routes can map them to HTTP. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Thrown when a capability the provider does not support is requested. */
export class CapabilityError extends ProviderError {
  constructor(capability: keyof ProviderCapabilities, providerName: string) {
    super(`Provider "${providerName}" does not support ${capability}`, 501);
    this.name = 'CapabilityError';
  }
}
