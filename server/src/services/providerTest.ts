import { getProvider, getProviderStatus } from '../providers';

// ---------------------------------------------------------------------------
// Live provider connectivity check. Exercises the configured provider with real
// calls (quote + options) and reports per-step timing and clear failure detail.
// Lets a user confirm a freshly-added Tradier token works — without exposing it.
// ---------------------------------------------------------------------------

export interface ProviderCheck {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  configured: boolean;
  synthetic: boolean;
  symbol: string;
  checks: ProviderCheck[];
}

export async function runProviderTest(symbol = 'AAPL'): Promise<ProviderTestResult> {
  const status = getProviderStatus();
  const base: Omit<ProviderTestResult, 'ok' | 'checks'> = {
    provider: status.name,
    configured: status.configured,
    synthetic: status.synthetic,
    symbol: symbol.toUpperCase(),
  };

  if (!status.configured) {
    return {
      ...base,
      ok: false,
      checks: [{ name: 'configuration', ok: false, ms: 0, detail: status.message ?? 'Provider not configured' }],
    };
  }

  const provider = getProvider();
  const checks: ProviderCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    const t = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: Date.now() - t, detail });
    } catch (e) {
      checks.push({ name, ok: false, ms: Date.now() - t, detail: (e as Error).message });
    }
  };

  await step('quote', async () => {
    const q = await provider.getQuote(symbol);
    return `last=${q.last}`;
  });

  if (status.capabilities.options) {
    await step('options expirations', async () => {
      const exps = await provider.getOptionsExpirations(symbol);
      return `${exps.length} expirations`;
    });
  }

  return { ...base, ok: checks.every((c) => c.ok), checks };
}
