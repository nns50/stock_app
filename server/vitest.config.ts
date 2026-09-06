import { defineConfig } from 'vitest/config';
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

export default defineConfig({
  test: {
    fileParallelism: false,
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
