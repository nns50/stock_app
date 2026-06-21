import { config } from '../config';
import { CapabilityError, MarketDataProvider, ProviderCapabilities, ProviderError } from './MarketDataProvider';
import { Candle, Fundamentals, OptionsChain, Quote } from './types';
import { MockProvider } from './MockProvider';
import { TradierProvider } from './TradierProvider';
import { YahooProvider } from './YahooProvider';
import { WebullProvider } from './WebullProvider';
import { WebullClient } from './webull/client';
import { CachingProvider } from './CachingProvider';

export interface ProviderStatus {
  name: string;
  synthetic: boolean;
  configured: boolean;
  capabilities: ProviderCapabilities;
  message?: string;
}

/**
 * Stand-in used when a real provider is selected but missing credentials. It
 * keeps the app booting and surfaces a clear, actionable "not configured" state
 * instead of crashing — every data call throws a 503 with guidance.
 */
class UnconfiguredProvider implements MarketDataProvider {
  readonly synthetic = false;
  readonly capabilities: ProviderCapabilities = {
    quotes: true,
    candles: true,
    options: true,
    fundamentals: true,
  };
  constructor(
    readonly name: string,
    readonly message: string,
  ) {}

  private fail(): never {
    throw new ProviderError(this.message, 503);
  }
  getQuote(): Promise<Quote> {
    return this.fail();
  }
  getCandles(): Promise<Candle[]> {
    return this.fail();
  }
  getOptionsExpirations(): Promise<string[]> {
    return this.fail();
  }
  getOptionsChain(): Promise<OptionsChain> {
    return this.fail();
  }
  getFundamentals(): Promise<Fundamentals> {
    return this.fail();
  }
}

let cached: { provider: MarketDataProvider; status: ProviderStatus } | null = null;

function build(): { provider: MarketDataProvider; status: ProviderStatus } {
  if (config.provider === 'tradier') {
    if (!config.tradier.token) {
      const message =
        'Tradier is selected but TRADIER_API_TOKEN is not set. Add it to server/.env (or set MARKET_DATA_PROVIDER=mock) to use the app.';
      const provider = new UnconfiguredProvider('tradier', message);
      return {
        provider,
        status: { name: 'tradier', synthetic: false, configured: false, capabilities: provider.capabilities, message },
      };
    }
    const base = new TradierProvider(config.tradier.token, config.tradier.baseUrl);
    const provider = new CachingProvider(base, {
      quoteTtlMs: config.quoteCacheTtlMs,
      candleTtlMs: config.candleCacheTtlMs,
    });
    return {
      provider,
      status: { name: 'tradier', synthetic: false, configured: true, capabilities: base.capabilities },
    };
  }

  if (config.provider === 'webull') {
    // Composite: Webull (real-time licensed US stocks) + Yahoo (option chains,
    // fundamentals). Webull market data needs an active OpenAPI quote subscription.
    if (!config.webull.appKey || !config.webull.appSecret) {
      const message =
        'Webull is selected but WEBULL_APP_KEY / WEBULL_APP_SECRET are not set. Add them to server/.env (or set MARKET_DATA_PROVIDER=yahoo) to use the app.';
      const provider = new UnconfiguredProvider('webull', message);
      return {
        provider,
        status: { name: 'webull', synthetic: false, configured: false, capabilities: provider.capabilities, message },
      };
    }
    const client = WebullClient.fromEnv({
      appKey: config.webull.appKey,
      appSecret: config.webull.appSecret,
      region: config.webull.region,
      apiHost: config.webull.apiHost,
      quotesHost: config.webull.quotesHost,
      accessToken: config.webull.accessToken,
    });
    const base = new WebullProvider(client, new YahooProvider());
    const provider = new CachingProvider(base, {
      quoteTtlMs: config.quoteCacheTtlMs,
      candleTtlMs: config.candleCacheTtlMs,
    });
    return {
      provider,
      status: {
        name: 'webull',
        synthetic: false,
        configured: true,
        capabilities: base.capabilities,
        message:
          'Webull (real-time US stocks) · Yahoo (option chains + fundamentals). Stock market data needs an active OpenAPI quote subscription on your Webull account.',
      },
    };
  }

  if (config.provider === 'yahoo') {
    // Free, key-less, and covers stocks + options (Greeks computed locally).
    const base = new YahooProvider();
    const provider = new CachingProvider(base, {
      quoteTtlMs: config.quoteCacheTtlMs,
      candleTtlMs: config.candleCacheTtlMs,
    });
    return {
      provider,
      status: {
        name: 'yahoo',
        synthetic: false,
        configured: true,
        capabilities: base.capabilities,
        message:
          'Yahoo Finance (free, no key). Unofficial — for personal use; may rate-limit or change without notice.',
      },
    };
  }

  // Default: keyless synthetic provider.
  const base = new MockProvider();
  const provider = new CachingProvider(base, {
    quoteTtlMs: config.quoteCacheTtlMs,
    candleTtlMs: config.candleCacheTtlMs,
  });
  return {
    provider,
    status: {
      name: 'mock',
      synthetic: true,
      configured: true,
      capabilities: base.capabilities,
      message: 'Synthetic demo data — no API key required. Set MARKET_DATA_PROVIDER=tradier for live data.',
    },
  };
}

export function getProvider(): MarketDataProvider {
  if (!cached) cached = build();
  return cached.provider;
}

export function getProviderStatus(): ProviderStatus {
  if (!cached) cached = build();
  return cached.status;
}

/** Throws a CapabilityError unless the active provider supports `capability`. */
export function requireCapability(capability: keyof ProviderCapabilities): void {
  const status = getProviderStatus();
  if (!status.configured) {
    throw new ProviderError(status.message ?? 'Provider not configured', 503);
  }
  if (!status.capabilities[capability]) {
    throw new CapabilityError(capability, status.name);
  }
}

export { MarketDataProvider } from './MarketDataProvider';
