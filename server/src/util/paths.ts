import fs from 'fs';
import path from 'path';

/**
 * Absolute path to the `server/` package root. Resolved by walking up from this
 * file until a package.json is found, so it works the same whether we run from
 * source (tsx -> server/src/util) or compiled (node -> server/dist/util).
 */
export const SERVER_ROOT: string = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();

/** Directory holding bundled data (sp500.json) and the runtime SQLite db. */
export const DATA_DIR: string = path.join(SERVER_ROOT, 'data');

/** Ensure a directory exists (mkdir -p). */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolve a possibly-relative path against the server root. */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(SERVER_ROOT, p);
}
