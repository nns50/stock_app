import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { resolveFromRoot, SERVER_ROOT } from './paths';

// ---------------------------------------------------------------------------
// Which database a research script may open: a COPY, never the one an app
// runs on (2026-09-26, for the tape rebuild, scripts/tapeBackfill.ts).
//
// Such a script caches what it fetches in the database it opens and runs the
// app's own readers against it. Pointed at the live file, it would write into
// the database a running loop is trading from. So the script is handed a path
// and refuses one that is missing, or is the file the app itself would open:
// the default local database, the production container's, or whatever
// DATABASE_PATH is set to in the environment the script runs in or in
// server/.env.
// ---------------------------------------------------------------------------

/** Where the app's database lives when nothing overrides it: locally, and in
 *  the production container (Dockerfile). */
export const APP_DATABASE_PATHS: readonly string[] = ['./data/stock_app.db', '/app/data/stock_app.db'];

function canonical(p: string): string {
  const abs = path.resolve(p);
  return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
}

/** The file's identity on disk (device and inode), or null when it is not
 *  there. Two spellings of one file — a hard link, a case variant on a
 *  case-insensitive disk, a mount seen from two paths — share it. */
function identity(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

export type DatabaseCopyCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * DATABASE_PATH as server/.env sets it, read WITHOUT loading the file into the
 * environment (2026-09-24, on review). This check runs before config.ts, which
 * is what loads server/.env, so a path set only there was invisible to it: the
 * app's own database, named in the file the app reads, passed as a copy.
 */
function envFileDatabasePath(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return dotenv.parse(fs.readFileSync(file)).DATABASE_PATH || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute path of a database copy a script may open, or why not.
 * `arg` is resolved against `cwd` — the directory the command was typed in
 * (npm sets INIT_CWD to it; `npm run -w server` itself runs in server/).
 */
export function databaseCopyPath(
  arg: string | undefined,
  env: { DATABASE_PATH?: string } = process.env,
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
  envFile: string = path.join(SERVER_ROOT, '.env'),
): DatabaseCopyCheck {
  if (!arg) return { ok: false, reason: '--db <path to a COPY of the database> is required' };
  const abs = path.resolve(cwd, arg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, reason: `${abs} does not exist: take a copy first (GET /api/export/backup.db)` };
  }
  const real = canonical(abs);
  const fromEnvFile = envFileDatabasePath(envFile);
  const own = [
    ...APP_DATABASE_PATHS,
    ...(env.DATABASE_PATH ? [env.DATABASE_PATH] : []),
    ...(fromEnvFile ? [fromEnvFile] : []),
  ].map((p) => canonical(resolveFromRoot(p)));
  // By path, and by the file itself (2026-09-25, on the second review): a
  // hard link to the live file has its own path and passed as a copy, and the
  // script would then have migrated and written the live database, with two
  // WAL files for one database besides.
  const realId = identity(real);
  if (own.includes(real) || (realId !== null && own.some((p) => identity(p) === realId))) {
    return { ok: false, reason: `${abs} is a database the app itself runs on: point --db at a copy of it` };
  }
  return { ok: true, path: real };
}
