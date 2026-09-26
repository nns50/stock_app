import { beforeEach } from 'vitest';
import { resetOncePerDayEvents } from '../src/services/autotrading/oncePerDayEvents';
import { resetUnplaceableSymbols } from '../src/services/autotrading/unplaceableSymbols';
import { resetRefusedShorts } from '../src/services/autotrading/refusedShorts';
import { resetBuyingPowerRefusals } from '../src/services/autotrading/buyingPowerRefusals';
import { resetMarketDirectionState } from '../src/services/autotrading/marketDirection';
import { resetMarketTapeState } from '../src/services/autotrading/marketTape';

// ---------------------------------------------------------------------------
// IN-MEMORY MODULE STATE IS RESET BEFORE EVERY TEST (2026-09-09, #43/#46).
//
// A module-level Map or Set lives for the whole worker process, so it outlives
// not just a test but a FILE — the same leak class task #46 exists for, one
// layer up from the shared config row and invisible in exactly the same way.
// `db.exec('DELETE FROM autotrade_events')` in a beforeEach does not touch it,
// so a test that clears the journal and re-runs a screen can find no event and
// blame the code.
//
// Per TEST here, not per file (setupConfigIsolation is per file): these caches
// exist to suppress repeat work, so a single test asserting "the second call
// writes nothing" is normal, and any test that wants the FIRST call's behaviour
// must start from empty.
//
// ---------------------------------------------------------------------------
// ONLY LEAF MODULES BELONG IN THIS FILE, and the reason is worth the space.
//
// A setup file is imported BEFORE every test file, so whatever it imports is
// already in the module registry when that file's own `vi.mock` factories run.
// Reaching for the obvious next candidates — screen.ts's two indicator caches,
// services/events.ts, splitCheck.ts — pulls in the provider layer, liveExecute
// and the notifier, all of which dozens of files mock. Tried on 2026-09-09:
// **321 tests failed**, across files that had nothing to do with the caches
// being reset. A cross-cutting reset is not worth a suite that can no longer
// mock its own dependencies.
//
// So the rule for adding one: the module must import nothing that any test
// mocks — in practice, nothing at all. `oncePerDayEvents` and
// `unplaceableSymbols` both have zero imports. `resizeRetryLatch` imports a
// type from providers/webull/orders, which several files mock, and is left out
// for that reason alone rather than because its state is harmless.
// `buyingPowerRefusals` (2026-09-14) qualifies on the same test: zero imports.
// So does `marketDirection` (2026-09-23): the loop journals the market's
// reading only when it changes, and a test that expects the day's first row
// must not find the previous test's reading already claimed.
// So does `refusedShorts` (2026-09-23): a short the broker refused holds that
// symbol's shorts for the ET day, and every live-execution file trades AAPL.
// It had to go here rather than in one file's beforeEach — the ceiling it
// learns is keyed by account and ET day, both of which every live-execution
// file shares, so one file's refusal shrank the next file's orders.
// So does `marketTape` (2026-09-26): its only import is `marketDirection`,
// itself import-free. Its breadth ring and journal claim are per process, and
// a test that expects the day's first tape row, or a momentum of null, must
// not inherit the previous test's ticks.
//
// Everything else stays where it already is: a file that warms a heavy cache
// resets it in its own `beforeEach` (autotradeScreen.test.ts does exactly
// this), which costs a line per file and cannot break anyone else's mocks.
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetOncePerDayEvents();
  resetUnplaceableSymbols();
  resetBuyingPowerRefusals();
  resetMarketDirectionState();
  resetMarketTapeState();
  resetRefusedShorts();
});
