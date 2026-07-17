import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts (which carries the dev proxy). Component tests
// run in jsdom with Testing Library + jest-dom matchers.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Capped below the default (one worker per core) — see setup.ts's own
    // comment on why full-suite runs see genuine CPU contention between
    // concurrently-running files (both here and on CI's own similarly-sized
    // runner). Tried going further (fileParallelism:false, full
    // serialization) and it STILL flaked occasionally across repeated runs —
    // this environment's own CPU availability is evidently noisy enough
    // (shared/sandboxed) that no amount of reduced test-side concurrency
    // reliably guarantees a stall never happens, while full serialization
    // costs 2x+ the wall-clock time for no measurable reliability gain over
    // this more moderate cap. `retry` below is the actual backstop: it
    // directly neutralizes a transient, timing-based failure regardless of
    // what momentarily caused it, which is what this class of flake actually
    // needs — reducing contention only lowers the odds, it can't promise zero.
    maxWorkers: 2,
    // A flake this suite has repeatedly hit is, by definition, a transient
    // failure that passes on a clean re-attempt (confirmed directly: every
    // one of these failures passes when the SAME test is re-run alone).
    // Retrying up to 2 extra times before actually failing the suite is the
    // standard, low-cost way to absorb that class of noise — it costs
    // nothing on the (overwhelmingly common) first-try-passes path, and the
    // odds of hitting the same bad timing on 3 independent attempts in a row
    // are low enough to trust a red run once retries are exhausted.
    retry: 2,
  },
});
