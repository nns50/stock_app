import { databaseCopyPath } from '../util/dbCopy';

// ---------------------------------------------------------------------------
// tapeBackfill.ts's FIRST import, and it has to stay first.
//
// config.ts resolves DATABASE_PATH once, when it is first imported, and dotenv
// never overrides a variable that is already set. So the script's database has
// to be decided before any module that reads config is loaded: here, as the
// side effect of the first import, not in main(). A refusal (or --help) exits
// before the app's database module has opened anything. tapeBackfill.ts checks
// the result again before it writes.
// ---------------------------------------------------------------------------

if (process.argv.includes('--help')) {
  console.log('npm run backfill:tape -- --db <copy> [--sessions N] [--sample N] [--seed N] [--out FILE]');
  process.exit(0);
}

const idx = process.argv.indexOf('--db');
const copy = databaseCopyPath(idx >= 0 ? process.argv[idx + 1] : undefined);
if (!copy.ok) {
  console.error(`backfill:tape refused: ${copy.reason}`);
  process.exit(1);
}
process.env.DATABASE_PATH = copy.path;

/** The copy this run opens. */
export const DATABASE_COPY_PATH: string = copy.path;
