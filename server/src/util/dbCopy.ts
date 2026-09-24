import fs from 'fs';
import path from 'path';
import { resolveFromRoot } from './paths';

// ---------------------------------------------------------------------------
// Which database a research script may open: a COPY, never the one an app
// runs on (2026-09-26, for the tape rebuild, scripts/tapeBackfill.ts).
//
// Such a script caches what it fetches in the database it opens and runs the
// app's own readers against it. Pointed at the live file, it would write into
// the database a running loop is trading from. So the script is handed a path
// and refuses one that is missing, or is the file the app itself would open:
// the default local database, the production container's, or whatever
// DATABASE_PATH is set to in the environment the script runs in.
// ---------------------------------------------------------------------------

/** Where the app's database lives when nothing overrides it: locally, and in
 *  the production container (Dockerfile). */
export const APP_DATABASE_PATHS: readonly string[] = ['./data/stock_app.db', '/app/data/stock_app.db'];

function canonical(p: string): string {
  const abs = path.resolve(p);
  return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
}

export type DatabaseCopyCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The absolute path of a database copy a script may open, or why not.
 * `arg` is resolved against `cwd` — the directory the command was typed in
 * (npm sets INIT_CWD to it; `npm run -w server` itself runs in server/).
 */
export function databaseCopyPath(
  arg: string | undefined,
  env: { DATABASE_PATH?: string } = process.env,
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
): DatabaseCopyCheck {
  if (!arg) return { ok: false, reason: '--db <path to a COPY of the database> is required' };
  const abs = path.resolve(cwd, arg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, reason: `${abs} does not exist: take a copy first (GET /api/export/backup.db)` };
  }
  const real = canonical(abs);
  const own = [...APP_DATABASE_PATHS, ...(env.DATABASE_PATH ? [env.DATABASE_PATH] : [])].map((p) =>
    canonical(resolveFromRoot(p)),
  );
  if (own.includes(real)) {
    return { ok: false, reason: `${abs} is a database the app itself runs on: point --db at a copy of it` };
  }
  return { ok: true, path: real };
}
