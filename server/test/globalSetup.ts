import { removeDbFile, sweepStaleTestDbs } from './dbFile';

/**
 * Guarantee the suite starts on an EMPTY database and does not leave one
 * behind. See dbFile.ts for what reusing one costs (task #46).
 *
 * `DATABASE_PATH` is set by vitest.config.ts, in this same process, before this
 * runs — so reading it here and in the workers yields the same file.
 */
export default function setup(): () => void {
  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) return () => {};
  // Belt and braces: the name is unique per run, so nothing should exist yet.
  // If something does, it is a collision we did not anticipate and starting on
  // it is exactly the failure this file exists to prevent.
  removeDbFile(dbPath);
  sweepStaleTestDbs();
  return () => removeDbFile(dbPath);
}
