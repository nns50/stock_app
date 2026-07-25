import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

// Point the (integration) tests at a throwaway DB so they never touch the real
// dev database. Pure unit tests don't open the DB, so this is harmless for them.
// Test files share that one SQLite file, so run them serially — otherwise
// parallel workers race on the `positions`/`alerts` tables (one file's
// `DELETE FROM …` cleanup wiping another's rows mid-test).
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_PATH: path.join(os.tmpdir(), `stock-app-vitest-${process.pid}.db`),
      // The Webull client paces each endpoint to its documented frequency
      // limit. That is real wall-clock time the tests have no reason to pay —
      // they assert on retry/timeout LOGIC, not on the pacing — and seconds per
      // request would add minutes to the suite.
      WEBULL_PACING_SCALE: '0',
    },
  },
});
