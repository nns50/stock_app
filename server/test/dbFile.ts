import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The throwaway SQLite file the (integration) tests run against.
//
// This used to be `stock-app-vitest-${process.pid}.db`, and nothing ever
// deleted it. Two consequences, and both bit:
//
//   1. THE FILES ACCUMULATE. 603 of them were sitting in /tmp on 2026-09-06.
//   2. PIDS ARE RECYCLED. `/proc/sys/kernel/pid_max` is 32768 here, and Linux
//      hands them out sequentially and wraps, so a later run eventually opens a
//      file a previous run left behind — with its rows, and its schema, still
//      in it. initDb() is all `CREATE TABLE IF NOT EXISTS`, so it adopts that
//      state rather than replacing it.
//
// That is the whole of task #46's "2 in 6 runs, unattributed". Its SIGNATURE A
// reproduces exactly — all four named tests, same messages — by pointing the
// suite at one of the stale files:
//
//   autotradeRealEstateClassifier "caches a successful classification"
//   historicalData "fetches from Polygon and caches"
//   historicalData "serves from cache without a second fetch"
//   historicalData "re-fetches when the requested range extends"
//
// All four are cache tests, and all four fail the same way: the fetch mock is
// never called, because a previous run already populated the cache the test
// expects to be empty. `autotrade_sector_cache` had 72 rows, `backtest_bars`
// and `backtest_fetch_log` were populated, `universe` had 509.
//
// Two nastier variants exist. A stale file whose WAL sidecar is gone is
// MALFORMED, and better-sqlite3 throws "database disk image is malformed" on
// the very first pragma — taking out a whole test file before a single test
// runs. And a stale file carries an OLD SCHEMA (one had an `autotrade_config`
// with 3 columns), which migrate() only partially repairs since it names
// specific tables.
//
// CI never saw any of this: it gets a fresh container per run, so there is
// never a file to collide with. That is exactly why the suite could be red
// locally and green on every PR.
//
// The fix is to make reuse impossible rather than to detect it: a unique name
// per run, plus deletion afterwards.
// ---------------------------------------------------------------------------

/** Same prefix as before, so old files are still recognisable (and sweepable). */
const PREFIX = 'stock-app-vitest-';

/**
 * A database path no other run can be holding.
 *
 * The pid stays for readability when you are staring at /tmp mid-run; the
 * random suffix is what actually makes it unique. Do NOT reduce this to the pid
 * alone — that is the bug.
 */
export function freshTestDbPath(): string {
  return path.join(os.tmpdir(), `${PREFIX}${process.pid}-${randomBytes(6).toString('hex')}.db`);
}

/** A SQLite database is three files in WAL mode, and leaving the sidecars
 *  behind is what turns a stale main file into a MALFORMED one. */
export function removeDbFile(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** One day. Anything younger might belong to a run happening right now — on a
 *  machine where someone has two suites going, or CI with a matrix — and this
 *  must never delete a live run's database. */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete leftovers from runs that crashed before their teardown.
 *
 * Bounded three ways so it can only ever touch this suite's own droppings:
 * the system temp directory, this exact filename prefix, and a full day old.
 * Best-effort — a file that vanishes underneath us, or that we cannot remove,
 * is not a reason to fail the suite.
 */
export function sweepStaleTestDbs(now: number = Date.now()): number {
  const dir = os.tmpdir();
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.db')) continue;
    const full = path.join(dir, name);
    try {
      if (now - statSync(full).mtimeMs < SWEEP_AGE_MS) continue;
      removeDbFile(full);
      removed += 1;
    } catch {
      // Someone else's to worry about.
    }
  }
  return removed;
}
