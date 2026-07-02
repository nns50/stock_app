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

// order_intents DDL, factored out so the fresh-create (SCHEMA) and the migration
// that rebuilds older tables share one definition. `order_type` has NO CHECK:
// stop orders (stop_loss / stop_loss_limit) joined the original market/limit set,
// and a stale CHECK silently rejected them at INSERT (the same trap the
// alerts.kind column hit). It's validated by the route's Zod enum + the
// OrderType union instead. Parameterised by table name so the rebuild can create
// `order_intents_new` before swapping it in.
const orderIntentsTableSql = (name: string): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,   -- client key; guards double-submit
  symbol          TEXT NOT NULL,
  asset_kind      TEXT NOT NULL CHECK(asset_kind IN ('stock','option')),
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  open_close      TEXT NOT NULL CHECK(open_close IN ('open','close')),
  quantity        REAL NOT NULL,
  order_type      TEXT NOT NULL,         -- market|limit|stop_loss|stop_loss_limit (validated at the route)
  limit_price     REAL,
  option_type     TEXT CHECK(option_type IN ('call','put') OR option_type IS NULL),
  strike          REAL,
  expiration      TEXT,
  option_strategy TEXT,                  -- SINGLE|VERTICAL|COVERED|IRON_CONDOR (NULL = stock)
  is_bracket      INTEGER NOT NULL DEFAULT 0,  -- 1 = placed as a bracket (MASTER + exit legs)
  state           TEXT NOT NULL,         -- OrderState (validated by the lifecycle machine)
  broker_order_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);`;

/** The order_intents columns, in DDL order — used for the explicit-column copy in
 *  the rebuild (so it's robust to ALTER-appended columns in an older table). */
const ORDER_INTENTS_COLS =
  'id, idempotency_key, symbol, asset_kind, side, open_close, quantity, order_type, limit_price, ' +
  'option_type, strike, expiration, option_strategy, is_bracket, state, broker_order_id, created_at, updated_at';

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
  source_intent_id INTEGER,            -- order_intents.id that produced this fill (live-traded only; no FK — a manually logged/imported position has none, and order_intents isn't guaranteed to persist forever)
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
  source_intent_id INTEGER,            -- order_intents.id that produced this exit fill (live-traded only; see positions.source_intent_id)
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

${orderIntentsTableSql('order_intents')}

CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   INTEGER NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,           -- the state entered at this event
  detail      TEXT,                    -- human note or raw broker payload
  created_at  INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS autotrade_config (
  id          INTEGER PRIMARY KEY CHECK(id = 1),   -- singleton row
  config      TEXT NOT NULL,           -- JSON AutotradeConfig (risk profile + enabled)
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autotrade_exclusions (
  symbol      TEXT PRIMARY KEY,
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default','user')),
  created_at  INTEGER NOT NULL
);

-- No CHECK on stage/action: both vocabularies grow as later auto-trading phases
-- land (mirrors alerts.kind / order_intents.order_type — a stale CHECK there
-- silently rejected new values at INSERT). Validated by the AutotradeStage type
-- + route-level Zod enum instead.
CREATE TABLE IF NOT EXISTS autotrade_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT,
  stage        TEXT NOT NULL,
  action       TEXT NOT NULL,
  detail       TEXT,                   -- JSON payload
  risk_profile TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_exits_position ON position_exits(position_id);
CREATE INDEX IF NOT EXISTS idx_picks_snapshot ON screener_picks(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_order_events_intent ON order_events(intent_id);
CREATE INDEX IF NOT EXISTS idx_autotrade_events_symbol ON autotrade_events(symbol);
CREATE INDEX IF NOT EXISTS idx_autotrade_events_stage ON autotrade_events(stage);
CREATE INDEX IF NOT EXISTS idx_autotrade_events_created ON autotrade_events(created_at);
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

interface ExclusionSeedRow {
  symbol: string;
  reason?: string;
}

/**
 * Starter set of well-known real-estate ETFs (docs/AUTOTRADING_SPEC.md's
 * EXCLUDED SECTOR requirement), seeded once so the auto-trading screener never
 * has an empty exclusion list out of the box. Not meant to be exhaustive —
 * individual REITs/real-estate operating companies are caught by the
 * sector/industry classification check, not a hand-maintained list. Rows are
 * freely add/removable afterwards (see db/autotradeExclusions.ts); only the
 * initial seed lives here.
 */
function seedAutotradeExclusionsIfEmpty(): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM autotrade_exclusions').get() as { n: number };
  if (row.n > 0) return;

  const file = path.join(DATA_DIR, 'reExclusions.json');
  let list: ExclusionSeedRow[];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')) as ExclusionSeedRow[];
  } catch {
    list = [];
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO autotrade_exclusions (symbol, reason, source, created_at) VALUES (?, ?, 'default', ?)",
  );
  const now = Date.now();
  const tx = db.transaction((items: ExclusionSeedRow[]) => {
    for (const it of items) {
      if (!it.symbol) continue;
      insert.run(it.symbol.toUpperCase(), it.reason ?? null, now);
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
  if (!has('source_intent_id')) db.exec('ALTER TABLE positions ADD COLUMN source_intent_id INTEGER');

  // position_exits gained the same provenance link, for exit-side slippage.
  const exitCols = db.prepare('PRAGMA table_info(position_exits)').all() as { name: string }[];
  if (!exitCols.some((c) => c.name === 'source_intent_id')) {
    db.exec('ALTER TABLE position_exits ADD COLUMN source_intent_id INTEGER');
  }

  // order_intents gained a combo marker so a stored order knows whether it's a
  // multi-leg spread / bracket (which the single-key replace can't safely modify).
  const oiCols = db.prepare('PRAGMA table_info(order_intents)').all() as { name: string }[];
  const hasOi = (c: string) => oiCols.some((col) => col.name === c);
  if (!hasOi('option_strategy')) db.exec('ALTER TABLE order_intents ADD COLUMN option_strategy TEXT');
  if (!hasOi('is_bracket')) db.exec('ALTER TABLE order_intents ADD COLUMN is_bracket INTEGER NOT NULL DEFAULT 0');
  // Must run AFTER the ADD COLUMNs above so the explicit-column copy finds them.
  rebuildOrderIntentsTable(db);

  rebuildAlertsTable(db);
}

/**
 * Drop the obsolete `order_type` CHECK on `order_intents`. The original schema
 * pinned it to ('market','limit'); stop orders (stop_loss / stop_loss_limit)
 * later joined the set, so on an older DB any stop order threw a CHECK violation
 * at INSERT (dry-run or place). SQLite can't drop a CHECK in place, so rebuild the
 * table. `order_intents` has a child (`order_events` FK with ON DELETE CASCADE),
 * so the rebuild runs with foreign keys OFF and uses the create-copy-drop-rename
 * dance, preserving rows and the child FK. Guarded on the CHECK still being
 * present, so it runs once. Exported + db-injectable for the migration test.
 */
export function rebuildOrderIntentsTable(database: Database.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_intents'").get() as
    | { sql: string | null }
    | undefined;
  // Fresh DBs create it without the CHECK; a rebuilt DB has none either → bail.
  if (!row?.sql || !/CHECK\s*\(\s*order_type/i.test(row.sql)) return;

  const hadForeignKeys = database.pragma('foreign_keys', { simple: true }) === 1;
  database.pragma('foreign_keys = OFF'); // so dropping the old table doesn't cascade order_events
  try {
    database.transaction(() => {
      database.exec(orderIntentsTableSql('order_intents_new'));
      database.exec(
        `INSERT INTO order_intents_new (${ORDER_INTENTS_COLS}) SELECT ${ORDER_INTENTS_COLS} FROM order_intents;`,
      );
      database.exec('DROP TABLE order_intents;');
      database.exec('ALTER TABLE order_intents_new RENAME TO order_intents;');
    })();
  } finally {
    if (hadForeignKeys) database.pragma('foreign_keys = ON');
  }
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
  seedAutotradeExclusionsIfEmpty();
}
