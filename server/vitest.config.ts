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
    },
  },
});
