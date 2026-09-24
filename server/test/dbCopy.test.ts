import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { databaseCopyPath } from '../src/util/dbCopy';

// ---------------------------------------------------------------------------
// The tape rebuild writes into the database it opens (the bar cache) and runs
// the app's readers on it, so it must never open the one a loop is trading
// from. Two layers, both tested: which paths are refused (util/dbCopy.ts), and
// that the script really opens the copy — config.ts resolves DATABASE_PATH at
// its first import, so the refusal only protects anything if it runs first.
// ---------------------------------------------------------------------------

let dir: string;
let copy: string;
let live: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-copy-'));
  copy = path.join(dir, 'copy.db');
  live = path.join(dir, 'live.db');
  fs.writeFileSync(copy, '');
  fs.writeFileSync(live, '');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('databaseCopyPath — a copy, never the database an app runs on', () => {
  it('requires a path, and one that exists as a file', () => {
    expect(databaseCopyPath(undefined, {}, dir)).toEqual({
      ok: false,
      reason: expect.stringContaining('--db'),
    });
    expect(databaseCopyPath('missing.db', {}, dir)).toEqual({
      ok: false,
      reason: expect.stringContaining('does not exist'),
    });
    expect(databaseCopyPath('.', {}, dir)).toMatchObject({ ok: false });
  });

  it('refuses the file DATABASE_PATH names, however it is reached', () => {
    expect(databaseCopyPath(live, { DATABASE_PATH: live }, dir)).toEqual({
      ok: false,
      reason: expect.stringContaining('the app itself runs on'),
    });
    const link = path.join(dir, 'link.db');
    fs.symlinkSync(live, link);
    expect(databaseCopyPath('link.db', { DATABASE_PATH: live }, dir)).toMatchObject({ ok: false });
  });

  it('accepts a copy, resolved against the directory the command was typed in', () => {
    expect(databaseCopyPath('copy.db', { DATABASE_PATH: live }, dir)).toEqual({
      ok: true,
      path: fs.realpathSync(copy),
    });
  });
});

describe('scripts/tapeBackfill.ts — the refusal runs before the database opens', () => {
  const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
  const script = path.resolve(__dirname, '../src/scripts/tapeBackfill.ts');
  const runScript = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, INIT_CWD: dir };
    delete env.POLYGON_API_KEY;
    return spawnSync(tsx, [script, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  };

  it('refuses to start without a copy', () => {
    const out = runScript([]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('backfill:tape refused: --db');
  });

  it('opens the copy it was given: the key check is reached only once config points at it', () => {
    // With the imports reordered, config would resolve the test run's own
    // DATABASE_PATH first and the script would stop on the mismatch instead.
    const out = runScript(['--db', 'copy.db']);
    expect(out.stderr).toContain('POLYGON_API_KEY is not set');
    expect(out.status).toBe(1);
  });
});
