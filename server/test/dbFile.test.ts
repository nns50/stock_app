import { describe, expect, it } from 'vitest';
import { closeSync, existsSync, openSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshTestDbPath, removeDbFile, sweepStaleTestDbs } from './dbFile';

// ---------------------------------------------------------------------------
// Task #46's root cause, guarded.
//
// The suite's database was named `stock-app-vitest-${process.pid}.db` and never
// deleted. pid_max is 32768, Linux recycles pids, and 603 of these had piled
// into /tmp — so a run could adopt a previous run's rows and schema. Pointing
// the suite at one of those files reproduces the recorded failure signature
// exactly. See dbFile.ts.
//
// These tests are cheap and they exist for one reason: to fail loudly if the
// name ever collapses back to something a second run can collide with.
// ---------------------------------------------------------------------------

describe('freshTestDbPath', () => {
  it('is different on every call — the pid alone is what caused #46', () => {
    const paths = new Set(Array.from({ length: 200 }, () => freshTestDbPath()));
    expect(paths.size).toBe(200);
  });

  it('carries more than the pid, so two concurrent runs cannot collide', () => {
    const name = path.basename(freshTestDbPath());
    expect(name).not.toBe(`stock-app-vitest-${process.pid}.db`);
    expect(name.startsWith(`stock-app-vitest-${process.pid}-`)).toBe(true);
  });

  it('stays in the temp directory, under the sweepable prefix', () => {
    const p = freshTestDbPath();
    expect(path.dirname(p)).toBe(os.tmpdir());
    expect(path.basename(p).startsWith('stock-app-vitest-')).toBe(true);
    expect(p.endsWith('.db')).toBe(true);
  });
});

describe('removeDbFile', () => {
  it('removes the WAL sidecars too — a main file without them is MALFORMED', () => {
    // Not hypothetical: better-sqlite3 threw "database disk image is malformed"
    // on the first pragma against a stale file whose sidecars were gone, which
    // kills an entire test file before a single test runs.
    const base = freshTestDbPath();
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${base}${suffix}`, 'x');
    removeDbFile(base);
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(`${base}${suffix}`)).toBe(false);
  });

  it('is silent about a file that is not there', () => {
    expect(() => removeDbFile(freshTestDbPath())).not.toThrow();
  });
});

describe('sweepStaleTestDbs', () => {
  it('deletes an old leftover but never a file young enough to be a live run', () => {
    const old = freshTestDbPath();
    const fresh = freshTestDbPath();
    for (const p of [old, fresh]) closeSync(openSync(p, 'w'));
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    sweepStaleTestDbs();

    expect(existsSync(old)).toBe(false);
    // The whole reason for the age bound: a concurrent suite's database is
    // minutes old, and deleting it out from under that run would be a far worse
    // bug than the one being fixed.
    expect(existsSync(fresh)).toBe(true);
    removeDbFile(fresh);
  });

  it('leaves files that do not carry the prefix alone', () => {
    const bystander = path.join(os.tmpdir(), `not-ours-${Date.now()}.db`);
    closeSync(openSync(bystander, 'w'));
    const longAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(bystander, longAgo, longAgo);

    sweepStaleTestDbs();

    expect(existsSync(bystander)).toBe(true);
    removeDbFile(bystander);
  });
});
