import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { DATA_DIR } from '../util/paths';

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Alerts table DDL is factored out so the fresh-create (in SCHEMA) and the
// migration that rebuilds older tables share one definition. `kind` has no CHECK
// constraint — it's validated by the Zod enum at the route — because the kind set
// grows (RSI/MA/52w distance, then option mark/bid/ask/delta/IV) and a stale
// CHECK silently rejected the newer kinds on fresh DBs.
const ALERTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  asset_type        TEXT NOT NULL DEFAULT 'stock' CHECK(asset_type IN ('stock','option')),
  kind              TEXT NOT NULL,
  operator          TEXT NOT NULL CHECK(operator IN ('above','below')),
  threshold         REAL NOT NULL,
  option_type       TEXT CHECK(option_type IN ('call','put') OR option_type IS NULL),
  strike            REAL,
  expiration        TEXT,                  -- YYYY-MM-DD (option alerts)
  role              TEXT CHECK(role IN ('entry','exit') OR role IS NULL),
  plan              TEXT,                  -- JSON {entry, exit, suggestedExit}
  note              TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  triggered         INTEGER NOT NULL DEFAULT 0,
  last_value        REAL,
  trigger_message   TEXT,
  last_triggered_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS universe (
  symbol     TEXT PRIMARY KEY,
  name       TEXT,
  sector     TEXT,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- 'screener' | 'option_entry' | 'option_exit'
  config     TEXT NOT NULL,            -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(name, kind)
);

CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type  TEXT NOT NULL CHECK(asset_type IN ('stock','option')),
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('long','short')),
  quantity    REAL NOT NULL,           -- opened qty (shares or contracts)
  entry_price REAL NOT NULL,           -- per share / per-share premium
  entry_date  TEXT NOT NULL,           -- ISO date (YYYY-MM-DD)
  entry_time  TEXT,                    -- optional local entry time (HH:MM), for time-of-day stats
  fees        REAL NOT NULL DEFAULT 0,
  option_type TEXT CHECK(option_type IN ('call','put') OR option_type IS NULL),
  strike      REAL,
  expiration  TEXT,
  multiplier  INTEGER NOT NULL DEFAULT 1,   -- 1 stock, 100 option
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  tags        TEXT,                    -- JSON array of strings
  grade       TEXT,                    -- 'A'..'F' or null
  notes       TEXT,
  checklist   TEXT,                    -- JSON array of {rule, checked} (pre-trade discipline)
  stop_price  REAL,                    -- planned stop (price level)
  target_price REAL,                   -- planned target (price level)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS position_exits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  exit_price  REAL NOT NULL,
  exit_date   TEXT NOT NULL,
  fees        REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_cache (
  symbol      TEXT PRIMARY KEY,
  data        TEXT NOT NULL,           -- JSON Quote (durable last-known fallback)
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,           -- JSON
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_config (
  id          INTEGER PRIMARY KEY CHECK(id = 1),   -- singleton row
  config      TEXT NOT NULL,           -- JSON TradingConfig (caps + kill switch)
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS iv_history (
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,           -- YYYY-MM-DD
  atm_iv      REAL NOT NULL,           -- at-the-money implied vol (decimal)
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS screener_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('long','short')),
  note          TEXT
);

CREATE TABLE IF NOT EXISTS screener_picks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id   INTEGER NOT NULL REFERENCES screener_snapshots(id) ON DELETE CASCADE,
  rank          INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  score         REAL NOT NULL,
  price_at_run  REAL NOT NULL            -- entry-reference price when snapshotted
);

${ALERTS_TABLE_SQL}

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_exits_position ON position_exits(position_id);
CREATE INDEX IF NOT EXISTS idx_picks_snapshot ON screener_picks(snapshot_id);
`;

interface SeedRow {
  symbol: string;
  name?: string;
  sector?: string;
}

function seedUniverseIfEmpty(): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM universe').get() as { n: number };
  if (row.n > 0) return;

  const file = path.join(DATA_DIR, 'sp500.json');
  let list: SeedRow[];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')) as SeedRow[];
  } catch {
    list = [];
  }

  const insert = db.prepare('INSERT OR IGNORE INTO universe(symbol, name, sector, added_at) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  const tx = db.transaction((items: SeedRow[]) => {
    for (const it of items) {
      if (!it.symbol) continue;
      insert.run(it.symbol.toUpperCase(), it.name ?? null, it.sector ?? null, now);
    }
  });
  tx(list);
}

/** Add columns introduced after the initial schema (for already-created DBs). */
function migrate(): void {
  const cols = db.prepare('PRAGMA table_info(positions)').all() as { name: string }[];
  const has = (c: string) => cols.some((col) => col.name === c);
  if (!has('checklist')) db.exec('ALTER TABLE positions ADD COLUMN checklist TEXT');
  if (!has('stop_price')) db.exec('ALTER TABLE positions ADD COLUMN stop_price REAL');
  if (!has('target_price')) db.exec('ALTER TABLE positions ADD COLUMN target_price REAL');
  if (!has('entry_time')) db.exec('ALTER TABLE positions ADD COLUMN entry_time TEXT');
  rebuildAlertsTable(db);
}

/**
 * Rebuild the `alerts` table when it predates option-contract alerts. Older DBs
 * carry a `kind` CHECK that only allowed the original four kinds (silently
 * rejecting macross/high52/low52 and the option kinds) and lack the
 * option-contract columns. SQLite can't drop a CHECK or add CHECK'd columns in
 * place, so copy rows through a fresh table. Keyed on the new `asset_type`
 * column being absent, so it runs once. Exported (and db-injectable) so the
 * old→new copy can be tested directly.
 */
export function rebuildAlertsTable(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(alerts)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'asset_type')) return; // already on the new schema
  database.exec(`
    ALTER TABLE alerts RENAME TO alerts_old;
    ${ALERTS_TABLE_SQL}
    INSERT INTO alerts (id, symbol, kind, operator, threshold, note, enabled, triggered,
                        last_value, trigger_message, last_triggered_at, created_at, updated_at)
      SELECT id, symbol, kind, operator, threshold, note, enabled, triggered,
             last_value, trigger_message, last_triggered_at, created_at, updated_at
      FROM alerts_old;
    DROP TABLE alerts_old;
  `);
}

/** Run migrations and seed the default universe. Call once at startup. */
export function initDb(): void {
  db.exec(SCHEMA);
  migrate();
  seedUniverseIfEmpty();
}
