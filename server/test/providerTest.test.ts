import { describe, it, expect } from 'vitest';
import { runProviderTest } from '../src/services/providerTest';

// With no env configured, the default provider is the keyless mock — a good way
// to verify the connectivity-check wiring end to end without a real key.
describe('runProviderTest (mock provider)', () => {
  it('passes all checks against the mock provider', async () => {
    const r = await runProviderTest('AAPL');
    expect(r.provider).toBe('mock');
    expect(r.synthetic).toBe(true);
    expect(r.configured).toBe(true);
    expect(r.ok).toBe(true);
    const names = r.checks.map((c) => c.name);
    expect(names).toContain('quote');
    expect(names).toContain('options expirations');
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
});
