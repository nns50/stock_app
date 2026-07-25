import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

afterEach(() => cleanup());

// This workspace's vitest config runs test files in parallel (no
// fileParallelism: false, unlike the server workspace — jsdom component
// tests don't share a SQLite file, so there's no correctness reason to
// serialize them). That means genuine CPU contention between concurrently-
// running files is a normal, expected condition here, not a rare edge case
// — testing-library's default 1000ms waitFor/findBy* timeout occasionally
// wasn't enough margin for a state update to settle under that contention,
// surfacing as an intermittent failure in an otherwise-correct test (seen
// directly: a full-suite run failing where 10+ consecutive isolated runs of
// the same test passed).
//
// 2026-07-17: raising this once (to 5000ms) wasn't enough on its own — CI
// still flaked (a different random AutoTradePage.test.tsx assertion timing
// out each time) under real load. vitest.config.ts's own maxWorkers cap now
// addresses the contention itself, not just the margin around it; this
// timeout stays raised too as a second line of defense, since capping
// workers reduces contention but doesn't guarantee zero.
configure({ asyncUtilTimeout: 8000 });

// Recharts' ResponsiveContainer sizes itself from a ResizeObserver and the
// element's offset box — neither of which jsdom implements — so chart render
// smokes can intermittently observe a 0×0 container and flake. Provide a no-op
// observer and a deterministic element size so charts render the same every run.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
