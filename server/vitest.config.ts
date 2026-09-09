import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';
import { freshTestDbPath } from './test/dbFile';

// Point the (integration) tests at a throwaway DB so they never touch the real
// dev database. Pure unit tests don't open the DB, so this is harmless for them.
// Test files share that one SQLite file, so run them serially — otherwise
// parallel workers race on the `positions`/`alerts` tables (one file's
// `DELETE FROM …` cleanup wiping another's rows mid-test).
//
// The path is UNIQUE PER RUN and deleted afterwards (globalSetup.ts). It was
// keyed on process.pid alone until 2026-09-06, and nothing cleaned it up: 603
// files had piled into /tmp, pid_max is 32768, and Linux recycles pids — so a
// run could open a previous run's database, complete with its rows and its
// schema. That is task #46's intermittent failure, and dbFile.ts records how it
// was reproduced.
const DATABASE_PATH = freshTestDbPath();
// `test.env` below reaches the WORKERS. globalSetup runs in this process, so it
// would not see it — and a globalSetup that silently cleans nothing is worse
// than none at all. Setting it here covers both: this assignment is what
// globalSetup reads, and `test.env` is what the workers inherit.
process.env.DATABASE_PATH = DATABASE_PATH;

// ---------------------------------------------------------------------------
// RUN THE FILES IN A FIXED ORDER (2026-09-08, task #46).
//
// Vitest's default BaseSequencer does NOT order files deterministically. When
// its results cache has entries for both files it sorts FAILED FIRST, then
// SLOWEST FIRST, and only falls back to largest-file-size-first on a cold
// cache. The cache lives in node_modules/.vite/vitest/<hash>/results.json.
//
// So the order tracked the PREVIOUS run's timings and failures. Durations move
// a little every run; one red run reorders the next. That is the missing half
// of task #46's "2 in 6 runs, unattributed" — the other half being the stale
// database in dbFile.ts.
//
// It matters here because setAutotradeConfig is a PARTIAL patch over one config
// row every test file shares. A file that does not pin a field inherits
// whatever the file before it left there, so a reordering silently changes what
// a test runs against. finishLineWiring.test.ts has been bitten three times
// this way, most recently when adding tests to two UNRELATED files changed
// their sizes and moved a config-writing file in front of it.
//
// Sorting by path does not remove that coupling — only spreading the defaults
// in each file does that, and finishLineWiring now does. What it removes is the
// GHOST: from here on a config leak fails the same way on every machine and
// every run, so it can be reproduced, bisected and fixed instead of being
// rediscovered under a new signature. Comments elsewhere that claim some file
// "always runs first" were written against this false assumption; do not add
// more.
//
// It earned its place the same afternoon. Pinning the order made
// liveOptionsExpiry.test.ts and livePreview.test.ts adjacent, and a leak that
// had been occasional became permanent and obvious: the expiry file closes a
// $200 option at $0 and cleared the table only in beforeEach, so
// realizedTodayFromBook() handed the preview file's guardrails a realized loss
// it never traded and daily_loss_halt refused two of its assertions. Both files
// are fixed. That bug was in the tree the whole time; the randomness was the
// only thing keeping it out of sight.
class PathOrderSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}

export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { sequencer: PathOrderSequencer },
    // setupConfigIsolation runs once per TEST FILE; setupProcessState runs
    // before every TEST. See each file for why its granularity is what it is.
    setupFiles: ['./test/setupConfigIsolation.ts', './test/setupProcessState.ts'],
    globalSetup: './test/globalSetup.ts',
    env: {
      DATABASE_PATH,
      // The Webull client paces each endpoint to its documented frequency
      // limit. That is real wall-clock time the tests have no reason to pay —
      // they assert on retry/timeout LOGIC, not on the pacing — and seconds per
      // request would add minutes to the suite.
      WEBULL_PACING_SCALE: '0',
    },
  },
});
