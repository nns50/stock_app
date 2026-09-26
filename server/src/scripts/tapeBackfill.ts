// FIRST, and it must stay first: points DATABASE_PATH at the copy before
// anything below loads config (tapeBackfillDatabase.ts says why).
import { DATABASE_COPY_PATH } from './tapeBackfillDatabase';
import fs from 'node:fs';
import { config } from '../config';
import { initDb } from '../db';
import { isRangeFetched } from '../db/backtestBars';
import { getHistoricalBars } from '../services/autotrading/historicalData';
import {
  formatTapeBackfill,
  runTapeBackfill,
  TAPE_DEFAULT_SESSIONS,
  TAPE_SAMPLE_SEED,
} from '../services/autotrading/historicalTapeData';

// ---------------------------------------------------------------------------
// CLI: `npm run backfill:tape -- --db <copy>` — rebuild the market-direction
// tape for past sessions and read the record against it (the tape plan's PR 3;
// services/autotrading/historicalTape.ts and historicalTapeData.ts).
//
// AGAINST A COPY OF THE DATABASE, NEVER THE LIVE ONE. Download it first
// (GET /api/export/backup.db); the script refuses a missing path and any path
// the app itself opens (util/dbCopy.ts). The bars it fetches are cached in the
// copy's backtest_bars, so a re-run pays only for what is new, and nothing it
// computes is written anywhere else.
//
// Usage:
//   npm run backfill:tape -- --db ./stock_app-copy.db
//   npm run backfill:tape -- --db ./stock_app-copy.db --sessions 60 --out tape.json
//
// Options:
//   --db PATH      the database copy (required; relative to where you typed it)
//   --sessions N   completed sessions to rebuild, newest last (default 40, the
//                  edge-leak scan's window)
//   --sample N     read breadth from a seeded sample of N names instead of the
//                  whole universe (fewer calls, for a rate-limited key)
//   --seed N       the sample's seed (default 20260926)
//   --out FILE     also write the whole result as JSON
//
// Needs POLYGON_API_KEY: two calls per name (5-minute and daily bars over the
// window), about 1,100 over the whole universe, of which the short replays'
// names are mostly a part. Polygon's free tier allows 5 calls a minute; with a
// key not held to that, a first run took about 20 minutes. Markdown goes to
// stdout, progress to stderr.
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function positiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

async function main(): Promise<void> {
  // Checked again before the first write: had anything reordered the imports
  // above, config would have resolved the app's own database.
  if (config.databasePath !== DATABASE_COPY_PATH) {
    throw new Error(`config opened ${config.databasePath}, not the copy ${DATABASE_COPY_PATH}; nothing was written`);
  }
  if (!config.polygon.apiKey) throw new Error('POLYGON_API_KEY is not set (see docs/DEPLOY.md)');
  const sessions = positiveInt('sessions', TAPE_DEFAULT_SESSIONS);
  const sampleSize = argValue('sample') === undefined ? undefined : positiveInt('sample', 0);
  const seed = positiveInt('seed', TAPE_SAMPLE_SEED);

  initDb();
  let polygonCalls = 0;
  const result = await runTapeBackfill({
    fetch: async (symbol, timeframe, from, to) => {
      if (!isRangeFetched(symbol, timeframe, from, to)) polygonCalls += 1;
      return getHistoricalBars(symbol, timeframe, from, to);
    },
    sessions,
    sampleSize,
    seed,
    progress: (line) => console.error(line),
  });
  console.error(`Polygon fetches this run: ${polygonCalls} (the rest came from the copy's cache)`);
  process.stdout.write(formatTapeBackfill(result));
  const out = argValue('out');
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(`backfill:tape: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
