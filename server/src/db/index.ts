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

// autotrade_paper_positions DDL, factored out so the fresh-create (SCHEMA) and
// the migration that widens exit_reason share one definition (added
// 2026-07-11 for the 'time_exit' value — max-hold-days force-close).
//
// initial_stop_price / best_price_since_entry / partial_exit_taken (added
// 2026-07-11, trailing stop / breakeven / partial profit-taking — paper and
// backtest only, see AutotradeConfig's own doc comment on why LIVE is
// untouched): stop_price itself is now MUTABLE (ratcheted toward breakeven
// or trailed, never loosened) once a position is open, so R-multiple
// triggers need a snapshot of the ORIGINAL stop distance that never changes
// — initial_stop_price is that snapshot, set once at open and never
// touched again. best_price_since_entry is the running high-water mark (a
// long) / low-water mark (a short) the trailing calculation ratchets
// against — nullable for pre-existing rows (both fields), which simply
// never trail/ratchet again once this migrates (nothing to backfill: their
// history before this feature existed is unrecoverable, and they'll close
// out normally via stop/target/time-exit regardless).
const AUTOTRADE_PAPER_POSITIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS autotrade_paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK(side IN ('buy','sell')),
  quantity      REAL NOT NULL,
  entry_price   REAL NOT NULL,
  entry_at      INTEGER NOT NULL,       -- ms epoch (real time, not a backtest date)
  stop_price    REAL NOT NULL,
  target_price  REAL NOT NULL,
  risk_amount   REAL NOT NULL,          -- $ risked at entry, for R-multiple stats
  risk_profile  TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exit_price    REAL,
  exit_at       INTEGER,
  exit_reason   TEXT CHECK(exit_reason IN ('stop','target','time_exit','manual') OR exit_reason IS NULL),
  initial_stop_price      REAL,          -- snapshot of stop_price at open; never mutated again
  best_price_since_entry  REAL,          -- running high/low-water mark since entry
  partial_exit_taken      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
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

-- Movers auto-promotion: one row per (symbol, calendar day) it showed up as a
-- movers-sourced, filters-passing screen candidate. Once-per-day dedup shape,
-- same as iv_history above, so many loop ticks the same day still only count once.
CREATE TABLE IF NOT EXISTS movers_occurrences (
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,           -- YYYY-MM-DD
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_movers_occurrences_symbol ON movers_occurrences(symbol);

-- Append-only ledger of symbols auto-promotion has ever added to universe.
-- Gates promotion so a symbol is never reconsidered once handled, whether
-- it's still in universe or a user later removed it, and backs the lifetime
-- growth cap. Kept separate from universe itself rather than a source column
-- there, so the already-deployed universe table needs no migration.
CREATE TABLE IF NOT EXISTS auto_promoted_symbols (
  symbol       TEXT PRIMARY KEY,
  promoted_at  INTEGER NOT NULL
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

-- The automated loop's most recently COMPLETED tick's diagnostics (candidates
-- screened, entries opened, why it skipped, etc.) — previously computed fresh
-- every 60s and discarded the moment the next tick overwrote it in memory.
CREATE TABLE IF NOT EXISTS autotrade_last_tick (
  id          INTEGER PRIMARY KEY CHECK(id = 1),   -- singleton row
  summary     TEXT NOT NULL,           -- JSON LoopTickSummary
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

-- Local cache of Polygon/Massive historical bars for the backtest harness
-- (docs/AUTOTRADING_SPEC.md, Phase 5) — a walk-forward run re-queries the same
-- symbol/period repeatedly, and Polygon Starter's depth is finite, so this
-- avoids re-fetching from the network every run.
CREATE TABLE IF NOT EXISTS backtest_bars (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  time        INTEGER NOT NULL,        -- ms epoch, bar start
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      REAL NOT NULL,
  PRIMARY KEY (symbol, timeframe, time)
);

-- Tracks which [from,to] ranges have actually been FETCHED from Polygon, per
-- symbol/timeframe — deliberately separate from backtest_bars' own min/max,
-- since trading data has gaps (weekends/holidays) that never align exactly
-- with a requested calendar boundary. Inferring "is this range cached" from
-- the data's own earliest/latest bar was tried and is wrong (see the fix in
-- historicalData.ts) — this explicit log is the correct source of truth for
-- "did we already ask for this."
CREATE TABLE IF NOT EXISTS backtest_fetch_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  from_date   TEXT NOT NULL,          -- YYYY-MM-DD, as requested
  to_date     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

-- Reference data for which OPTION CONTRACTS (strike/expiration/type) existed
-- for an underlying (docs/AUTOTRADING_SPEC.md, Phase 11) — genuinely
-- different shape from backtest_bars (no OHLCV here, this is metadata about
-- which tickers exist at all), so it gets its own table. A contract's own
-- PRICE history, once its ticker is known, is cached in backtest_bars/
-- backtest_fetch_log UNCHANGED (an options ticker works there exactly like a
-- stock symbol) — no schema change needed for that half.
CREATE TABLE IF NOT EXISTS backtest_option_contracts (
  underlying    TEXT NOT NULL,
  ticker        TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK(contract_type IN ('call','put')),
  strike        REAL NOT NULL,
  expiration    TEXT NOT NULL,        -- YYYY-MM-DD
  PRIMARY KEY (underlying, ticker)
);

-- Tracks which [fromExpiration,toExpiration] ranges have actually been
-- fetched per underlying — same "explicit fetch log, not inferred from the
-- data's own min/max" rationale as backtest_fetch_log, since an underlying
-- with zero contracts expiring in some sub-range would otherwise look
-- indistinguishable from "never fetched."
CREATE TABLE IF NOT EXISTS backtest_option_contracts_fetch_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  underlying    TEXT NOT NULL,
  from_expiration TEXT NOT NULL,
  to_expiration   TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

-- The Phase 6 paper execution loop's own journal of simulated trades —
-- deliberately separate from positions/position_exits (the human's real
-- trading journal): mixing autonomous synthetic fills into that would
-- corrupt the one thing it exists to be honest about. One row per round
-- trip (open, and — once closed — exit fields on the SAME row), not a
-- split positions/exits table: the auto-trading engine (decide.ts,
-- riskCheck.ts, backtest.ts's SimulatedTrade) never models partial fills or
-- partial exits, so there's nothing a second table would need to hold.
${AUTOTRADE_PAPER_POSITIONS_TABLE_SQL}

-- Phase 12 (options paper execution): the options counterpart to
-- autotrade_paper_positions. Separate table, not a shared/unioned one — a
-- long option is identified by contract (strike/expiration/side), not a
-- buy/sell direction + stop/target price the way a stock paper position is,
-- so the two shapes don't overlay cleanly onto one schema. exit_reason is
-- 'time_exit' (phase 12's original automated trigger — see options/
-- exitRules.ts's timeExitDaysBeforeExpiry), 'stop_loss'/'take_profit'
-- (2026-07-16 follow-up — same exitRules.ts engine's %-of-premium rules,
-- net debit for a spread; PAPER/BACKTEST only, mirroring
-- autotrade_paper_positions's own live-exclusion for its analogous
-- trailing-stop/breakeven/partial-exit fields), or 'manual', mirroring
-- autotrade_paper_positions's own reserved-but-not-yet-used 'manual' value.
-- kind/short_* (Task #69): a 'debit_spread' row reuses contract_symbol/strike/
-- entry_price/exit_price for the LONG leg and adds the short_* columns for the
-- further-OTM short leg; both null for 'single_leg'. quantity is spreads, not
-- contracts-per-leg (one spread = one long + one short contract).
-- best_basis_since_entry/stop_floor_pct/partial_exit_taken (added
-- 2026-07-17, options trailing-stop/breakeven/partial-exit — PAPER and
-- BACKTEST only, mirroring autotrade_paper_positions's own
-- initial_stop_price/best_price_since_entry/partial_exit_taken trio, adapted
-- to options' %-of-premium model instead of a price-based stop): a long
-- option has no stop PRICE to ratchet, so stop_floor_pct instead stores the
-- ratcheted MINIMUM acceptable unrealized gain % (net debit basis, for a
-- spread) — null until a breakeven/trailing event first fires, at which
-- point checkOptionsPaperExits() prefers it over the live
-- optionsStopLossPct config for that position from then on, exactly as
-- stopPrice's own "once ratcheted, always position-specific" precedent.
-- best_basis_since_entry is the running peak of the SAME basis, seeded at
-- entryPrice (minus shortEntryPrice, for a spread) — options are always
-- opened long, so this is always a running MAX, never a long/short branch.
CREATE TABLE IF NOT EXISTS autotrade_options_paper_positions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                 TEXT NOT NULL,        -- underlying
  side                   TEXT NOT NULL CHECK(side IN ('call','put')),
  kind                   TEXT NOT NULL DEFAULT 'single_leg', -- 'single_leg' | 'debit_spread'
  contract_symbol        TEXT NOT NULL,        -- provider contract symbol (e.g. OCC code); long leg for a spread
  strike                 REAL NOT NULL,        -- long leg's strike for a spread
  short_contract_symbol  TEXT,                 -- short leg's contract symbol (debit spreads only)
  short_strike           REAL,                 -- short leg's strike (debit spreads only)
  expiration             TEXT NOT NULL,        -- YYYY-MM-DD
  quantity               REAL NOT NULL,        -- contracts (spreads, for a debit_spread row)
  entry_price            REAL NOT NULL,        -- premium per share at fill; long leg for a spread
  short_entry_price      REAL,                 -- short leg's premium per share at fill (debit spreads only)
  entry_at               INTEGER NOT NULL,     -- ms epoch (real time, not a backtest date)
  risk_amount            REAL NOT NULL,        -- $ risked at entry (full premium for single_leg; net debit x 100 for a spread)
  risk_profile           TEXT NOT NULL,
  rationale              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exit_price             REAL,                 -- premium per share at exit; long leg for a spread
  short_exit_price       REAL,                 -- short leg's premium per share at exit (debit spreads only)
  exit_at                INTEGER,
  exit_reason            TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL),
  best_basis_since_entry REAL,                 -- running peak of (mark - short mark); null pre-feature or unchecked
  stop_floor_pct         REAL,                 -- ratcheted minimum acceptable gain %; null until first ratcheted
  partial_exit_taken     INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- Durable cache of real-estate sector/industry classification results
-- (services/autotrading/realEstateClassifier.ts) — classification is a live
-- Yahoo fundamentals fetch for any symbol outside the seeded universe, and
-- without this cache the autonomous loop re-fetched it from Yahoo on EVERY
-- 60-second tick for every non-seeded symbol, forever — enough sustained
-- concurrent traffic to trip Yahoo's free-tier rate limiting. A symbol's
-- sector essentially never changes, so a positive result (real_estate/clear)
-- is cached for a long time; an 'unknown' result (fetch failed) gets a much
-- shorter TTL so it's retried reasonably soon without immediately hammering
-- an already-rate-limited API again on the very next cycle.
CREATE TABLE IF NOT EXISTS autotrade_sector_cache (
  symbol      TEXT PRIMARY KEY,
  outcome     TEXT NOT NULL CHECK(outcome IN ('real_estate','clear','unknown')),
  sector      TEXT,
  industry    TEXT,
  updated_at  INTEGER NOT NULL
);

-- Phase 8 (live-trading gate): metadata for order_intents the AUTOTRADE loop
-- placed (vs. the human Trade page), since order_intents itself carries no
-- "who placed this" column. NOT a duplicate of order/position data -- just
-- enough to (a) identify autotrade's own intents for the probation-trade
-- count and dashboard, and (b) remember the signal's intended stop/target/
-- risk so the real positions row created on fill (services/autotrading/
-- liveExecute.ts) can carry them, same as a paper position does. Live
-- entries are placed as BRACKET orders (entry + linked stop-loss + linked
-- take-profit), so the stop/target are ALSO enforced by the broker directly
-- -- this table is bookkeeping for OUR OWN tracking, not the sole mechanism
-- protecting the position the way autotrade_paper_positions's polling is.
-- role (added 2026-07-11, max-hold-days force-close): 'entry' (the original
-- bracket order, sole use of this table until now) or 'exit' -- a SEPARATE
-- closing order this loop places itself once maxHoldDays elapses without a
-- stop/target hit, mirroring autotrade_live_options_orders's own role split
-- (equity's own bracket has no such precedent -- every OTHER equity exit is
-- still 100% broker-bracket-driven; this is the one exception). An 'exit'
-- row has no real stop/target/risk of its own (it's closing, not sizing a
-- new position) but the columns stay NOT NULL for a pre-existing DB's sake,
-- so it stores 0 rather than NULL -- see recordLiveExitOrder.
CREATE TABLE IF NOT EXISTS autotrade_live_orders (
  intent_id     INTEGER PRIMARY KEY REFERENCES order_intents(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'entry',
  stop_price    REAL NOT NULL,
  target_price  REAL NOT NULL,
  risk_amount   REAL NOT NULL,
  risk_profile  TEXT NOT NULL,
  position_id   INTEGER,              -- entry: set once the fill materializes into positions.
                                       -- exit: known upfront (the position this order will close).
  created_at    INTEGER NOT NULL
);

-- Task #70 (live options trading): the options counterpart to
-- autotrade_live_orders/positions above, kept as its own parallel pair of
-- tables rather than reusing positions -- a debit spread has no short-leg
-- column there (same reasoning as autotrade_options_paper_positions's own
-- header comment). Autotrade's options signals never carried a price-based
-- stop/target to begin with (Phase 12's confirmed "close-only, time-based"
-- exit design), so there is no bracket order here for either single-leg or
-- spread entries -- an exit is a SEPARATE closing order this loop places
-- itself when the time-exit trigger fires, tracked via the role column
-- below rather than a bracket leg.
CREATE TABLE IF NOT EXISTS autotrade_live_options_positions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                 TEXT NOT NULL,        -- underlying
  side                   TEXT NOT NULL CHECK(side IN ('call','put')),
  kind                   TEXT NOT NULL DEFAULT 'single_leg', -- 'single_leg' | 'debit_spread'
  contract_symbol        TEXT NOT NULL,        -- long leg for a spread
  strike                 REAL NOT NULL,        -- long leg's strike for a spread
  short_contract_symbol  TEXT,                 -- short leg's contract symbol (debit spreads only)
  short_strike           REAL,                 -- short leg's strike (debit spreads only)
  expiration             TEXT NOT NULL,        -- YYYY-MM-DD
  quantity               REAL NOT NULL,        -- contracts (spreads, for a debit_spread row)
  entry_price            REAL NOT NULL,        -- filled premium per share; long leg for a spread
  short_entry_price      REAL,                 -- short leg's filled premium (debit spreads only)
  entry_at               INTEGER NOT NULL,     -- ms epoch
  risk_amount            REAL NOT NULL,        -- $ risked at entry (full premium for single_leg; net debit x 100 for a spread)
  risk_profile           TEXT NOT NULL,
  rationale              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exit_price             REAL,                 -- filled premium per share at exit; long leg for a spread
  short_exit_price       REAL,                 -- short leg's filled premium at exit (debit spreads only)
  exit_at                INTEGER,
  exit_reason            TEXT CHECK(exit_reason IN ('time_exit','manual') OR exit_reason IS NULL),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autotrade_live_options_orders (
  intent_id             INTEGER PRIMARY KEY REFERENCES order_intents(id) ON DELETE CASCADE,
  symbol                TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK(role IN ('entry','exit')),
  kind                  TEXT NOT NULL DEFAULT 'single_leg',
  -- Entry rows only: contract detail needed to materialize a position once
  -- the fill is later observed (a separate reconcile pass, not the same call
  -- that placed the order) -- order_intents has no column for a spread's
  -- SECOND leg, and never stores the provider's own contract symbol at all.
  -- Exit rows leave these null; an exit already knows everything it needs to
  -- close from the open position it references via position_id.
  side                  TEXT CHECK(side IN ('call','put') OR side IS NULL),
  contract_symbol       TEXT,
  strike                REAL,
  short_contract_symbol TEXT,
  short_strike          REAL,
  expiration            TEXT,
  risk_amount   REAL,                 -- entry rows only (risk-checked $ amount); null for exit rows
  risk_profile  TEXT NOT NULL,
  position_id   INTEGER,              -- entry: set once the fill materializes a position; exit: known upfront (which position this closes)
  -- Exit rows only (2026-07-16): why this closing order was placed, carried
  -- through to closeLiveOptionsPosition() once the fill materializes so the
  -- position's own stored exit_reason isn't hardcoded to 'time_exit' for a
  -- manually-triggered close. Null for entry rows.
  exit_reason   TEXT CHECK(exit_reason IN ('time_exit','manual') OR exit_reason IS NULL),
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_exits_position ON position_exits(position_id);
CREATE INDEX IF NOT EXISTS idx_picks_snapshot ON screener_picks(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_order_events_intent ON order_events(intent_id);
-- Serves countTodaysOrders' WHERE state = 'submitted' AND created_at >= ? --
-- hit on every order placement/preview -- which otherwise full-scans a
-- table that only ever grows (no retention).
CREATE INDEX IF NOT EXISTS idx_order_events_state_created ON order_events(state, created_at);
CREATE INDEX IF NOT EXISTS idx_autotrade_events_symbol ON autotrade_events(symbol);
-- stage pairs with id (not a standalone column) so a WHERE stage = ? ORDER
-- BY id DESC LIMIT N read (services/autotrading/dashboard.ts, hit on every
-- dashboard poll) can walk the index directly in id order instead of
-- collecting every row for that stage -- an ever-growing set, since nothing
-- prunes this table -- before it can sort and cut to N.
CREATE INDEX IF NOT EXISTS idx_autotrade_events_stage ON autotrade_events(stage, id);
CREATE INDEX IF NOT EXISTS idx_autotrade_events_created ON autotrade_events(created_at);
CREATE INDEX IF NOT EXISTS idx_backtest_fetch_log_lookup ON backtest_fetch_log(symbol, timeframe);
-- status-leading: listOpenXxxPositions() queries WHERE status = 'open' with
-- no symbol filter (every autotrade loop tick), which a symbol-leading index
-- can't serve without a full scan. status still pairs with symbol here so
-- the OTHER query shape (hasOpenXxxPosition: WHERE symbol = ? AND status = ?)
-- stays just as well served -- SQLite can seek a multi-column equality index
-- regardless of which order the columns appear in the WHERE clause.
CREATE INDEX IF NOT EXISTS idx_autotrade_paper_positions_status ON autotrade_paper_positions(status, symbol);
CREATE INDEX IF NOT EXISTS idx_autotrade_options_paper_positions_status ON autotrade_options_paper_positions(status, symbol);
CREATE INDEX IF NOT EXISTS idx_autotrade_live_orders_symbol ON autotrade_live_orders(symbol);
CREATE INDEX IF NOT EXISTS idx_autotrade_live_options_positions_status ON autotrade_live_options_positions(status, symbol);
CREATE INDEX IF NOT EXISTS idx_autotrade_live_options_orders_symbol ON autotrade_live_options_orders(symbol);
CREATE INDEX IF NOT EXISTS idx_backtest_option_contracts_lookup ON backtest_option_contracts(underlying, expiration);
CREATE INDEX IF NOT EXISTS idx_backtest_option_contracts_fetch_log_lookup ON backtest_option_contracts_fetch_log(underlying);
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

const UNIVERSE_TOPUP_SETTING_KEY = 'universeTopUp';

/**
 * One-time top-up that expands an already-seeded universe table with the
 * symbols added when sp500.json grew from ~124 mega-caps to the full S&P 500
 * (the small starter set was clearing the autotrade screener's
 * relative-volume bar too rarely, see docs/AUTOTRADING_SPEC.md).
 * seedUniverseIfEmpty() only acts on a genuinely empty table, so it never
 * revisits a production DB that was already seeded before this expansion
 * shipped. Deliberately reads a FROZEN delta file (sp500_topup_2026_07.json —
 * just the newly-added symbols) rather than diffing against sp500.json
 * itself: sp500.json also contains the original 124, and diffing the full
 * file against "not currently in the table" can't tell a symbol that was
 * never seeded apart from one a user deliberately removed, so it would
 * resurrect any original-124 removal. Applies the frozen delta via the same
 * INSERT OR IGNORE addSymbols()-style upsert, gated by a settings marker so
 * it runs exactly once and never re-fights a later removal of one of ITS
 * symbols either. Exported + db-injectable for the migration test.
 */
export function topUpUniverseOnce(database: Database.Database): void {
  const marker = database.prepare('SELECT 1 FROM settings WHERE key = ?').get(UNIVERSE_TOPUP_SETTING_KEY);
  if (marker) return;

  const file = path.join(DATA_DIR, 'sp500_topup_2026_07.json');
  let list: SeedRow[];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')) as SeedRow[];
  } catch {
    list = [];
  }

  const insert = database.prepare('INSERT OR IGNORE INTO universe(symbol, name, sector, added_at) VALUES (?, ?, ?, ?)');
  const setMarker = database.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  const tx = database.transaction((items: SeedRow[]) => {
    let added = 0;
    for (const it of items) {
      if (!it.symbol) continue;
      const res = insert.run(it.symbol.toUpperCase(), it.name ?? null, it.sector ?? null, now);
      added += res.changes;
    }
    setMarker.run(UNIVERSE_TOPUP_SETTING_KEY, JSON.stringify({ appliedAt: now, added }), now);
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

  rebuildAutotradePaperPositionsTable(db);
  rebuildAutotradeOptionsPaperPositionsTable(db);

  // autotrade_paper_positions gained trailing-stop/breakeven/partial-exit
  // tracking (added AFTER the rebuild above, so a table that just got
  // rebuilt already has these from AUTOTRADE_PAPER_POSITIONS_TABLE_SQL and
  // these three checks correctly no-op for it).
  const appCols = db.prepare('PRAGMA table_info(autotrade_paper_positions)').all() as { name: string }[];
  const hasApp = (c: string) => appCols.some((col) => col.name === c);
  if (!hasApp('initial_stop_price')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN initial_stop_price REAL');
  }
  if (!hasApp('best_price_since_entry')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN best_price_since_entry REAL');
  }
  if (!hasApp('partial_exit_taken')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN partial_exit_taken INTEGER NOT NULL DEFAULT 0');
  }

  // autotrade_options_paper_positions gained a debit-spread shape (Task #69):
  // a kind discriminator plus the short leg's contract/strike/entry/exit.
  const oppCols = db.prepare('PRAGMA table_info(autotrade_options_paper_positions)').all() as { name: string }[];
  const hasOpp = (c: string) => oppCols.some((col) => col.name === c);
  if (!hasOpp('kind')) {
    db.exec("ALTER TABLE autotrade_options_paper_positions ADD COLUMN kind TEXT NOT NULL DEFAULT 'single_leg'");
  }
  if (!hasOpp('short_contract_symbol')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN short_contract_symbol TEXT');
  }
  if (!hasOpp('short_strike')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN short_strike REAL');
  }
  if (!hasOpp('short_entry_price')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN short_entry_price REAL');
  }
  if (!hasOpp('short_exit_price')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN short_exit_price REAL');
  }

  // autotrade_options_paper_positions gained trailing-stop/breakeven/
  // partial-exit tracking (added 2026-07-17, mirroring autotrade_paper_positions's
  // own three columns above — see the fresh-create DDL's own doc comment for why
  // stop_floor_pct is a % floor, not a price).
  if (!hasOpp('best_basis_since_entry')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN best_basis_since_entry REAL');
  }
  if (!hasOpp('stop_floor_pct')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN stop_floor_pct REAL');
  }
  if (!hasOpp('partial_exit_taken')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN partial_exit_taken INTEGER NOT NULL DEFAULT 0');
  }

  // autotrade_live_options_orders gained contract detail (Task #70 Step C):
  // an entry row needs enough to materialize a position from a LATER reconcile
  // pass, which order_intents can't supply (no second-leg column, no
  // provider contract symbol at all).
  const aloCols = db.prepare('PRAGMA table_info(autotrade_live_options_orders)').all() as { name: string }[];
  const hasAlo = (c: string) => aloCols.some((col) => col.name === c);
  if (!hasAlo('side')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN side TEXT');
  if (!hasAlo('contract_symbol')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN contract_symbol TEXT');
  if (!hasAlo('strike')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN strike REAL');
  if (!hasAlo('short_contract_symbol')) {
    db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN short_contract_symbol TEXT');
  }
  if (!hasAlo('short_strike')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN short_strike REAL');
  if (!hasAlo('expiration')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN expiration TEXT');
  // Exit rows only (2026-07-16, manual close from the Auto page) -- why this
  // closing order was placed, so materializeOptionsExitFill() doesn't have to
  // hardcode 'time_exit' for every close regardless of what actually triggered it.
  if (!hasAlo('exit_reason')) {
    db.exec(
      "ALTER TABLE autotrade_live_options_orders ADD COLUMN exit_reason TEXT CHECK(exit_reason IN ('time_exit','manual') OR exit_reason IS NULL)",
    );
  }

  // autotrade_live_orders gained a role split (max-hold-days force-close):
  // every existing row IS an entry (the only kind this table held before),
  // so backfilling the default onto old rows is exactly correct, not a guess.
  const aloEquityCols = db.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[];
  if (!aloEquityCols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE autotrade_live_orders ADD COLUMN role TEXT NOT NULL DEFAULT 'entry'");
  }

  // Must run AFTER the ADD COLUMNs above so the explicit-column copy finds them.
  rebuildAutotradeLiveOrdersTable(db);
  rebuildAutotradeLiveOptionsOrdersTable(db);

  // Reorder the three open-position "status" indexes to lead with status —
  // listOpenXxxPositions() queries WHERE status = 'open' with no symbol
  // filter, on every autotrade loop tick, which a symbol-leading index can't
  // serve without a full table scan. A fresh DB already gets the new order
  // straight from SCHEMA above, so this only ever does real work once, on a
  // DB carrying the old (symbol, status) definition.
  reorderStatusLeadingIndex(db, 'idx_autotrade_paper_positions_status', 'autotrade_paper_positions');
  reorderStatusLeadingIndex(db, 'idx_autotrade_options_paper_positions_status', 'autotrade_options_paper_positions');
  reorderStatusLeadingIndex(db, 'idx_autotrade_live_options_positions_status', 'autotrade_live_options_positions');
  reorderAutotradeEventsStageIndex(db);
}

/**
 * Drop and recreate `indexName` as `(status, symbol)` when its stored
 * definition still shows the old `(symbol, status)` order. CREATE INDEX IF
 * NOT EXISTS in SCHEMA can't fix this on its own — an index with a matching
 * name already exists on any pre-existing DB, so it silently no-ops rather
 * than picking up the new column order. Exported + db-injectable for the
 * migration test, same convention as the rebuildXxxTable functions above.
 */
export function reorderStatusLeadingIndex(database: Database.Database, indexName: string, tableName: string): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(indexName) as
    | { sql: string | null }
    | undefined;
  if (!row?.sql || /\(\s*status\s*,/i.test(row.sql)) return; // already status-leading, or doesn't exist yet
  database.exec(`DROP INDEX ${indexName}; CREATE INDEX ${indexName} ON ${tableName}(status, symbol);`);
}

/**
 * Reorder autotrade_events' stage index from (stage) to (stage, id) — see
 * the SCHEMA comment above idx_autotrade_events_stage for why. Same
 * reasoning as reorderStatusLeadingIndex above (CREATE INDEX IF NOT EXISTS
 * can't fix an existing same-named index), just a different target shape,
 * so it's its own small function rather than a shared generic one.
 */
export function reorderAutotradeEventsStageIndex(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_autotrade_events_stage'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /\(\s*stage\s*,\s*id\s*\)/i.test(row.sql)) return;
  database.exec(
    'DROP INDEX idx_autotrade_events_stage; CREATE INDEX idx_autotrade_events_stage ON autotrade_events(stage, id);',
  );
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

/**
 * Rebuild `autotrade_paper_positions` when its exit_reason CHECK predates
 * 'time_exit' (max-hold-days force-close, added 2026-07-11). SQLite can't
 * widen a CHECK in place, so copy rows through a fresh table — same
 * rename/create/copy/drop dance as rebuildAlertsTable, plus re-creating the
 * one index this table has (rebuildAlertsTable/rebuildOrderIntentsTable have
 * none, so neither needed this step). Guarded on 'time_exit' already being in
 * the stored CHECK text, so it runs once and no-ops on a fresh DB.
 */
export function rebuildAutotradePaperPositionsTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_paper_positions'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /time_exit/i.test(row.sql)) return;

  database.exec(`
    ALTER TABLE autotrade_paper_positions RENAME TO autotrade_paper_positions_old;
    ${AUTOTRADE_PAPER_POSITIONS_TABLE_SQL}
    INSERT INTO autotrade_paper_positions (id, symbol, side, quantity, entry_price, entry_at, stop_price,
                        target_price, risk_amount, risk_profile, rationale, status, exit_price, exit_at,
                        exit_reason, created_at, updated_at)
      SELECT id, symbol, side, quantity, entry_price, entry_at, stop_price,
             target_price, risk_amount, risk_profile, rationale, status, exit_price, exit_at,
             exit_reason, created_at, updated_at
      FROM autotrade_paper_positions_old;
    DROP TABLE autotrade_paper_positions_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_paper_positions_status ON autotrade_paper_positions(status, symbol);
  `);
}

/**
 * Rebuild `autotrade_options_paper_positions` when its exit_reason CHECK
 * predates 'stop_loss'/'take_profit' (options price-based exits, added
 * 2026-07-16 — see AUTOTRADING_SPEC.md phase 17). Same rename/create/copy/
 * drop dance as rebuildAutotradePaperPositionsTable above, plus re-creating
 * the one index this table has. Guarded on 'stop_loss' already being in the
 * stored CHECK text, so it runs once and no-ops on a fresh DB.
 */
export function rebuildAutotradeOptionsPaperPositionsTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_options_paper_positions'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /stop_loss/i.test(row.sql)) return;

  database.exec(`
    ALTER TABLE autotrade_options_paper_positions RENAME TO autotrade_options_paper_positions_old;
    CREATE TABLE autotrade_options_paper_positions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol                 TEXT NOT NULL,
      side                   TEXT NOT NULL CHECK(side IN ('call','put')),
      kind                   TEXT NOT NULL DEFAULT 'single_leg',
      contract_symbol        TEXT NOT NULL,
      strike                 REAL NOT NULL,
      short_contract_symbol  TEXT,
      short_strike           REAL,
      expiration             TEXT NOT NULL,
      quantity               REAL NOT NULL,
      entry_price            REAL NOT NULL,
      short_entry_price      REAL,
      entry_at               INTEGER NOT NULL,
      risk_amount            REAL NOT NULL,
      risk_profile           TEXT NOT NULL,
      rationale              TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      exit_price             REAL,
      short_exit_price       REAL,
      exit_at                INTEGER,
      exit_reason            TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL),
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    INSERT INTO autotrade_options_paper_positions (id, symbol, side, kind, contract_symbol, strike,
                        short_contract_symbol, short_strike, expiration, quantity, entry_price,
                        short_entry_price, entry_at, risk_amount, risk_profile, rationale, status,
                        exit_price, short_exit_price, exit_at, exit_reason, created_at, updated_at)
      SELECT id, symbol, side, kind, contract_symbol, strike,
             short_contract_symbol, short_strike, expiration, quantity, entry_price,
             short_entry_price, entry_at, risk_amount, risk_profile, rationale, status,
             exit_price, short_exit_price, exit_at, exit_reason, created_at, updated_at
      FROM autotrade_options_paper_positions_old;
    DROP TABLE autotrade_options_paper_positions_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_options_paper_positions_status ON autotrade_options_paper_positions(status, symbol);
  `);
}

/**
 * Rebuild `autotrade_live_orders` when its intent_id FK predates ON DELETE
 * CASCADE. Without the cascade, a row left behind here (e.g. by a test that
 * didn't clean up after itself) blocks any DELETE FROM order_intents with a
 * FOREIGN KEY constraint error, even for an unrelated intent -- order_events
 * already cascades off order_intents the same way; this table and the
 * options-side sibling below were the two that didn't. Guarded on the stored
 * FK text lacking CASCADE, so it runs once and no-ops on a fresh DB.
 */
export function rebuildAutotradeLiveOrdersTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_live_orders'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /ON DELETE CASCADE/i.test(row.sql)) return;

  database.exec(`
    ALTER TABLE autotrade_live_orders RENAME TO autotrade_live_orders_old;
    CREATE TABLE autotrade_live_orders (
      intent_id     INTEGER PRIMARY KEY REFERENCES order_intents(id) ON DELETE CASCADE,
      symbol        TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'entry',
      stop_price    REAL NOT NULL,
      target_price  REAL NOT NULL,
      risk_amount   REAL NOT NULL,
      risk_profile  TEXT NOT NULL,
      position_id   INTEGER,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO autotrade_live_orders (intent_id, symbol, role, stop_price, target_price, risk_amount,
                        risk_profile, position_id, created_at)
      SELECT intent_id, symbol, role, stop_price, target_price, risk_amount,
             risk_profile, position_id, created_at
      FROM autotrade_live_orders_old;
    DROP TABLE autotrade_live_orders_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_live_orders_symbol ON autotrade_live_orders(symbol);
  `);
}

/**
 * Rebuild `autotrade_live_options_orders` for the same reason as
 * rebuildAutotradeLiveOrdersTable above -- see that function's header.
 */
export function rebuildAutotradeLiveOptionsOrdersTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_live_options_orders'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /ON DELETE CASCADE/i.test(row.sql)) return;

  database.exec(`
    ALTER TABLE autotrade_live_options_orders RENAME TO autotrade_live_options_orders_old;
    CREATE TABLE autotrade_live_options_orders (
      intent_id             INTEGER PRIMARY KEY REFERENCES order_intents(id) ON DELETE CASCADE,
      symbol                TEXT NOT NULL,
      role                  TEXT NOT NULL CHECK(role IN ('entry','exit')),
      kind                  TEXT NOT NULL DEFAULT 'single_leg',
      side                  TEXT CHECK(side IN ('call','put') OR side IS NULL),
      contract_symbol       TEXT,
      strike                REAL,
      short_contract_symbol TEXT,
      short_strike          REAL,
      expiration            TEXT,
      risk_amount   REAL,
      risk_profile  TEXT NOT NULL,
      position_id   INTEGER,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO autotrade_live_options_orders (intent_id, symbol, role, kind, side, contract_symbol, strike,
                        short_contract_symbol, short_strike, expiration, risk_amount, risk_profile, position_id,
                        created_at)
      SELECT intent_id, symbol, role, kind, side, contract_symbol, strike,
             short_contract_symbol, short_strike, expiration, risk_amount, risk_profile, position_id, created_at
      FROM autotrade_live_options_orders_old;
    DROP TABLE autotrade_live_options_orders_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_live_options_orders_symbol ON autotrade_live_options_orders(symbol);
  `);
}

/** Run migrations and seed the default universe. Call once at startup. */
export function initDb(): void {
  db.exec(SCHEMA);
  migrate();
  seedUniverseIfEmpty();
  topUpUniverseOnce(db);
  seedAutotradeExclusionsIfEmpty();
}
