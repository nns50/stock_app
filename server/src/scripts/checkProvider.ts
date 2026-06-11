import { runProviderTest } from '../services/providerTest';

// CLI: `npm run check:provider [SYMBOL]` — verifies the configured provider
// (e.g. confirms a Tradier token works) and exits non-zero on failure.
async function main(): Promise<void> {
  const symbol = process.argv[2] || 'AAPL';
  const r = await runProviderTest(symbol);
  // eslint-disable-next-line no-console
  console.log(`Provider: ${r.provider}${r.synthetic ? ' (synthetic)' : ''}  configured=${r.configured}  symbol=${r.symbol}`);
  for (const c of r.checks) {
    // eslint-disable-next-line no-console
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  (${c.ms}ms)  ${c.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(r.ok ? 'RESULT: OK' : 'RESULT: FAILED');
  process.exit(r.ok ? 0 : 1);
}

void main();
