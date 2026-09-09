import { beforeEach } from 'vitest';
import { resetOncePerDayEvents } from '../src/services/autotrading/oncePerDayEvents';

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
// Add every process-global cache to this list as it appears. Deliberately
// central: eleven files patched the config row without spreading defaults
// before #46 made that a shared setup instead of eleven local fixes.
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetOncePerDayEvents();
});
