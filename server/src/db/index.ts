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
  add_ons_taken           INTEGER NOT NULL DEFAULT 0,  -- scale-into-winners count
  grade         TEXT,                  -- conviction grade (A/B/C) from the screener score at entry
  -- At-entry context (2026-07-26): the raw screener total the grade above was
  -- bucketed from, plus the market regime label and market (SPY) ATR% the loop
  -- read that cycle. Recorded so realized outcomes can later be sliced by
  -- score band / regime instead of only the three-letter grade; all nullable —
  -- a pre-existing row, or a cycle where the regime read failed (it is
  -- best-effort), simply has no context rather than an invented one.
  entry_score   REAL,
  market_regime TEXT,                 -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct REAL,
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
  stop_price      REAL,                  -- trigger price (stop_loss / stop_loss_limit); NULL otherwise
  option_type     TEXT CHECK(option_type IN ('call','put') OR option_type IS NULL),
  strike          REAL,
  expiration      TEXT,
  option_strategy TEXT,                  -- SINGLE|VERTICAL|COVERED|IRON_CONDOR (NULL = stock)
  is_bracket      INTEGER NOT NULL DEFAULT 0,  -- 1 = placed as a bracket (MASTER + exit legs)
  state           TEXT NOT NULL,         -- OrderState (validated by the lifecycle machine)
  broker_order_id TEXT,
  -- How much of this order has already been mirrored into the Positions ledger,
  -- and at what total cost. Partial fills are materialized INCREMENTALLY (see
  -- services/trading/reconcile.ts), so these two are the high-water mark that
  -- makes repeated reconciles idempotent: three independent callers can observe
  -- the same fill and only the unbooked delta is ever written. Notional is
  -- tracked alongside quantity because the broker reports an AVERAGE fill price
  -- over all executions — the incremental price of a new partial is only
  -- recoverable by differencing notionals.
  materialized_qty      REAL NOT NULL DEFAULT 0,
  materialized_notional REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);`;

/** The order_intents columns, in DDL order — used for the explicit-column copy in
 *  the rebuild (so it's robust to ALTER-appended columns in an older table). */
const ORDER_INTENTS_COLS =
  'id, idempotency_key, symbol, asset_kind, side, open_close, quantity, order_type, limit_price, stop_price, ' +
  'option_type, strike, expiration, option_strategy, is_bracket, state, broker_order_id, ' +
  'materialized_qty, materialized_notional, created_at, updated_at';

/**
 * The `positions` table, parameterised by name so the fresh schema and the
 * nullable-entry_date rebuild below share ONE definition rather than two that
 * can drift.
 *
 * `entry_date` is nullable (2026-07-26). It used to be NOT NULL, which forced
 * the Webull import to invent a date whenever the broker's holdings payload
 * carried none — and that endpoint is an aggregate of current holdings, so for
 * a lot built from several buys there is no single open date for it to report.
 * The invented date then fed hold-time buckets, the wash-sale window and the
 * equity curve as though it were fact. Null means "we genuinely do not know",
 * and every statistic that needs a date now excludes those rows and says so.
 * Manually logged trades still require one — you know when you traded.
 */
function positionsTableSql(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type  TEXT NOT NULL CHECK(asset_type IN ('stock','option')),
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('long','short')),
  quantity    REAL NOT NULL,           -- opened qty (shares or contracts)
  entry_price REAL NOT NULL,           -- per share / per-share premium
  entry_date  TEXT,                    -- ISO date (YYYY-MM-DD), or NULL when genuinely unknown (see above)
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
  account_id  TEXT,                    -- the Webull account this lot lives in (imported/live-traded only; null for a manually-logged position, or a legacy row from before this column existed)
  -- At-entry context (2026-07-26), stamped by autotrade's live materialization
  -- (services/autotrading/liveExecute.ts) and null for manually logged /
  -- imported trades: the raw screener total behind grade, the market regime
  -- label, and the market (SPY) ATR% at entry. Exists so realized performance
  -- can be sliced by the system's own at-entry conviction and conditions —
  -- the letter grade alone collapses a 0-100 score into three buckets, and
  -- nothing else recorded the day's regime at all.
  entry_score REAL,
  market_regime TEXT,                  -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct REAL,
  -- Session VWAP at entry (2026-08-22) — an OBSERVER, stamped like the trio
  -- above so realized outcomes can later be split by VWAP alignment BEFORE
  -- any filter acts on it (services/autotrading/vwap.ts). Null: manual/
  -- imported rows, rows predating the column, or a failed/unmeasurable fetch.
  entry_vwap REAL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);`;
}

/** The positions columns, in DDL order — for the explicit-column copy in the
 *  rebuild, intersected with what the live table actually has (same
 *  never-silently-drop-an-ALTER-added-column property as ORDER_INTENTS_COLS). */
const POSITIONS_COLS =
  'id, asset_type, symbol, side, quantity, entry_price, entry_date, entry_time, fees, option_type, ' +
  'strike, expiration, multiplier, status, tags, grade, notes, checklist, stop_price, target_price, ' +
  'source_intent_id, account_id, entry_score, market_regime, market_atr_pct, entry_vwap, created_at, updated_at';

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

${positionsTableSql('positions')}

CREATE TABLE IF NOT EXISTS position_exits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  exit_price  REAL NOT NULL,
  exit_date   TEXT NOT NULL,
  fees        REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  source_intent_id INTEGER,            -- order_intents.id that produced this exit fill (live-traded only; see positions.source_intent_id)
  -- Why this exit happened (2026-07-26): 'stop' | 'target' | 'time_exit' |
  -- 'manual', stamped by autotrade's live exit materialization (which KNOWS
  -- which bracket leg filled) and null for hand-logged exits and legacy rows.
  -- No CHECK on purpose — a widened value set would otherwise need a table
  -- rebuild (the exact trap order_intents.order_type documents); validated by
  -- the TS union in db/positions.ts instead.
  exit_reason TEXT,
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

-- The account's equity at the START of the current ET day, and whether the
-- daily-gain target has been reached today (services/autotrading/dailyTarget.ts).
-- Singleton: only "today" matters — the journal already records each day's
-- daily_target_reached event, so no history is kept here.
CREATE TABLE IF NOT EXISTS autotrade_daily_baseline (
  id          INTEGER PRIMARY KEY CHECK(id = 1),   -- singleton row
  et_date     TEXT NOT NULL,           -- YYYY-MM-DD in America/New_York
  equity_usd  REAL NOT NULL,           -- synced equity at the day's first tick
  reached_at  INTEGER,                 -- epoch ms the target was first reached today, or NULL
  -- Give-back guard (dailyTarget.ts): armed when the day's gain first touches
  -- the arm level, fired (= live entries halted, sticky like reached_at) if an
  -- ARMED day then falls back to the floor. Both clear on the day roll.
  give_back_armed_at   INTEGER,        -- epoch ms the guard armed today, or NULL
  give_back_halted_at  INTEGER         -- epoch ms the guard fired today, or NULL
);

CREATE TABLE IF NOT EXISTS autotrade_exclusions (
  symbol      TEXT PRIMARY KEY,
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default','user')),
  created_at  INTEGER NOT NULL
);

-- Scheduled macro-event blackout (2026-07-18): a user-maintained list of
-- market-wide catalyst date-times (FOMC, CPI, jobs reports, ...) — there's no
-- economic-calendar data feed anywhere in this app, so unlike the earnings
-- blackout (which reads a real per-symbol date already fetched from Yahoo),
-- this is entirely hand-maintained, same "add/remove your own list" pattern
-- as autotrade_exclusions above. Starts empty; nothing is pre-seeded.
CREATE TABLE IF NOT EXISTS macro_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  event_at    INTEGER NOT NULL,
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
  -- 2026-07-27: 1 = fetched by the client that includes EXPIRED contracts
  -- (Polygon's endpoint defaults to active-only, which cached a contract set
  -- missing nearly every historical expiration). isExpirationRangeFetched()
  -- only honors rows with 1, so legacy active-only fetches re-fetch.
  includes_expired INTEGER NOT NULL DEFAULT 0,
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
  -- At-entry context (2026-07-26), mirroring autotrade_paper_positions plus
  -- the two options-only readings: the underlying's conviction grade + raw
  -- screener total (this table never had a grade column at all), the IV rank
  -- the decision stage gated on, and the market regime / SPY ATR% that cycle.
  -- All nullable — pre-existing rows and failed best-effort reads stay null.
  grade                  TEXT,                 -- conviction grade (A/B/C) from the underlying's screener score
  entry_score            REAL,
  iv_rank                REAL,                 -- IV rank (0-100) at decision time
  market_regime          TEXT,                 -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct         REAL,
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
  account_id    TEXT,                 -- entry: the Webull account this order executed in, carried to positions.account_id at materialization. null for exit rows and legacy rows.
  addon_of_position_id INTEGER,       -- scale-in add-on: the already-open position this order pyramids into. null for normal entries/exits. Its fill MERGES into that position (blended entry) rather than creating a new one.
  grade         TEXT,                 -- entry: conviction grade (A/B/C) from the signal's screener score, carried to positions.grade at materialization. null for exit rows and legacy rows.
  -- At-entry context (2026-07-26), carried to the same-named positions columns
  -- at materialization exactly like grade above. null for exit/legacy rows.
  entry_score   REAL,
  market_regime TEXT,                 -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct REAL,
  entry_vwap    REAL,                 -- session VWAP at placement (2026-08-22 observer) — see positions.entry_vwap
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
  -- 'stop_loss'/'take_profit' joined 2026-07-26 (live price-based exits, the
  -- paper table's own value set) -- an older DB's narrower CHECK is widened by
  -- rebuildAutotradeLiveOptionsPositionsTable in migrate().
  exit_reason            TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL),
  account_id             TEXT,                 -- the Webull account this fill executed in; null for a legacy row from before this column existed
  -- At-entry context (2026-07-26), carried from the entry order's own row at
  -- materialization — same five fields as autotrade_options_paper_positions.
  grade                  TEXT,                 -- conviction grade (A/B/C) from the underlying's screener score
  entry_score            REAL,
  iv_rank                REAL,                 -- IV rank (0-100) at decision time
  market_regime          TEXT,                 -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct         REAL,
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
  -- manually-triggered close. Null for entry rows. 'stop_loss'/'take_profit'
  -- joined 2026-07-26 (live price-based exits); an older DB's narrower CHECK
  -- is widened by rebuildAutotradeLiveOptionsOrdersTable in migrate().
  exit_reason   TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL),
  account_id    TEXT,                 -- entry: the Webull account this order executed in, carried to autotrade_live_options_positions.account_id at materialization. null for exit rows and legacy rows.
  -- Entry rows only (2026-07-26): at-entry context carried to the same-named
  -- autotrade_live_options_positions columns at materialization, exactly like
  -- the equity table's grade. Null for exit rows and legacy rows.
  grade         TEXT,
  entry_score   REAL,
  iv_rank       REAL,
  market_regime TEXT,                 -- 'risk-on' | 'neutral' | 'risk-off'
  market_atr_pct REAL,
  created_at    INTEGER NOT NULL
);

-- Debounces the broker-preview close-detection in closePositionsFromPreview
-- (providers/webull/positions.ts) and syncLiveOptionsPositionsFromBroker
-- (services/autotrading/liveOptionsExecute.ts). Both used to auto-close the
-- instant a SINGLE preview fetch didn't include a contract still genuinely
-- held at the broker -- an intermittent/incomplete Webull response was
-- enough to trigger a false close, and the very next successful sync would
-- re-import it as a brand-new position, repeating indefinitely (observed in
-- production: a low-priced symbol cycling open/closed every ~60-150s for
-- hours, each cycle booking a fabricated realized loss). Requiring the same
-- contract to be missing on MISS_CONFIRM_THRESHOLD consecutive syncs, with no
-- successful "still held" observation in between, before actually writing
-- the close absorbs that class of single-tick flakiness at the cost of a
-- short delay before a REAL sell is detected -- an acceptable tradeoff for a
-- tracking-only journal that never itself places a trade based on this.
CREATE TABLE IF NOT EXISTS webull_miss_streak (
  account_id    TEXT NOT NULL,
  contract_key  TEXT NOT NULL,
  streak        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, contract_key)
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

  const aloEqCols = db.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[];
  if (!aloEqCols.some((c) => c.name === 'account_id')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN account_id TEXT');
  }
  const aloOptCols = db.prepare('PRAGMA table_info(autotrade_live_options_orders)').all() as { name: string }[];
  if (!aloOptCols.some((c) => c.name === 'account_id')) {
    db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN account_id TEXT');
  }
  // 2026-07-17: without this, the Webull sync's broker-truth reconciliation
  // had no way to tell "opened under account A" from "opened under account
  // B" — every locally-tracked open position was compared against whichever
  // ONE account happened to be configured at sync time, so switching the
  // configured account wrongly auto-closed the other account's real open
  // positions and merged a same-symbol buy in the new account onto the old
  // account's row. See providers/webull/positions.ts for the scoped fix.
  if (!has('account_id')) db.exec('ALTER TABLE positions ADD COLUMN account_id TEXT');

  // At-entry context (2026-07-26) — see the positions DDL comment. Nullable,
  // so every pre-existing row simply has no context rather than a guessed one.
  if (!has('entry_score')) db.exec('ALTER TABLE positions ADD COLUMN entry_score REAL');
  if (!has('market_regime')) db.exec('ALTER TABLE positions ADD COLUMN market_regime TEXT');
  if (!has('market_atr_pct')) db.exec('ALTER TABLE positions ADD COLUMN market_atr_pct REAL');

  // position_exits gained the same provenance link, for exit-side slippage.
  const exitCols = db.prepare('PRAGMA table_info(position_exits)').all() as { name: string }[];
  if (!exitCols.some((c) => c.name === 'source_intent_id')) {
    db.exec('ALTER TABLE position_exits ADD COLUMN source_intent_id INTEGER');
  }
  // ...and a reason (2026-07-26) — see the position_exits DDL comment.
  if (!exitCols.some((c) => c.name === 'exit_reason')) {
    db.exec('ALTER TABLE position_exits ADD COLUMN exit_reason TEXT');
  }

  // order_intents gained a combo marker so a stored order knows whether it's a
  // multi-leg spread / bracket (which the single-key replace can't safely modify).
  const oiCols = db.prepare('PRAGMA table_info(order_intents)').all() as { name: string }[];
  const hasOi = (c: string) => oiCols.some((col) => col.name === c);
  if (!hasOi('option_strategy')) db.exec('ALTER TABLE order_intents ADD COLUMN option_strategy TEXT');
  if (!hasOi('is_bracket')) db.exec('ALTER TABLE order_intents ADD COLUMN is_bracket INTEGER NOT NULL DEFAULT 0');
  // order_intents gained a persisted stop price (2026-07-28). It was never
  // stored before, so a replace of a stop order had to rebuild the intent
  // WITHOUT its trigger price — the guardrails' stop_price check then failed
  // and every quantity/limit-only modify of a stop order was falsely blocked.
  // Nullable; a legacy stop order's row simply has no stored stop (its replace
  // keeps requiring an explicit stopPrice in the patch, same as before).
  if (!hasOi('stop_price')) db.exec('ALTER TABLE order_intents ADD COLUMN stop_price REAL');
  // order_intents gained incremental-materialization tracking so partial fills
  // can be mirrored into Positions as they happen (reconcile.ts) instead of only
  // at the terminal `filled` state.
  //
  // The backfill is the load-bearing part: an intent already sitting at `filled`
  // had its position booked in full by the OLD code, so it must start at its
  // full quantity or the first reconcile after this upgrade would book it a
  // SECOND time. (`filled` is terminal and returns early, so this is belt-and-
  // braces — but a default of 0 would be a live double-booking hazard the moment
  // any future path re-examines a filled intent, which is exactly the class of
  // bug the migration audit found.) Notional is backfilled at the intent's own
  // limit price purely so the column is self-consistent; it is never read again
  // for these rows, since a fully-materialized order has no remaining delta.
  if (!hasOi('materialized_qty')) {
    db.exec('ALTER TABLE order_intents ADD COLUMN materialized_qty REAL NOT NULL DEFAULT 0');
    db.exec("UPDATE order_intents SET materialized_qty = quantity WHERE state = 'filled'");
  }
  if (!hasOi('materialized_notional')) {
    db.exec('ALTER TABLE order_intents ADD COLUMN materialized_notional REAL NOT NULL DEFAULT 0');
    db.exec(
      "UPDATE order_intents SET materialized_notional = quantity * COALESCE(limit_price, 0) WHERE state = 'filled'",
    );
  }
  // Must run AFTER the ADD COLUMNs above so the explicit-column copy finds them.
  rebuildOrderIntentsTable(db);

  rebuildAlertsTable(db);

  // Must run AFTER the positions ADD COLUMNs above (checklist, stop_price,
  // target_price, entry_time, source_intent_id, account_id) so the
  // explicit-column copy finds them rather than leaving them behind.
  rebuildPositionsTableForNullableEntryDate(db);

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
  if (!hasApp('add_ons_taken')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN add_ons_taken INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasApp('grade')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN grade TEXT');
  }
  // At-entry context (2026-07-26) — see the table DDL comment.
  if (!hasApp('entry_score')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN entry_score REAL');
  }
  if (!hasApp('market_regime')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN market_regime TEXT');
  }
  if (!hasApp('market_atr_pct')) {
    db.exec('ALTER TABLE autotrade_paper_positions ADD COLUMN market_atr_pct REAL');
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
  // At-entry context (2026-07-26) — see the table DDL comment. grade is new
  // here outright: unlike the equity paper table, options never recorded one.
  if (!hasOpp('grade')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN grade TEXT');
  }
  if (!hasOpp('entry_score')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN entry_score REAL');
  }
  if (!hasOpp('iv_rank')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN iv_rank REAL');
  }
  if (!hasOpp('market_regime')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN market_regime TEXT');
  }
  if (!hasOpp('market_atr_pct')) {
    db.exec('ALTER TABLE autotrade_options_paper_positions ADD COLUMN market_atr_pct REAL');
  }

  // 2026-07-17: same account-blindness fix as positions.account_id above,
  // for the separate live options ledger — see providers/webull/positions.ts
  // and services/autotrading/liveOptionsExecute.ts's syncLiveOptionsPositionsFromBroker.
  const alopCols = db.prepare('PRAGMA table_info(autotrade_live_options_positions)').all() as { name: string }[];
  if (!alopCols.some((c) => c.name === 'account_id')) {
    db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN account_id TEXT');
  }
  // At-entry context (2026-07-26) — see the table DDL comment.
  const hasAlop = (c: string) => alopCols.some((col) => col.name === c);
  if (!hasAlop('grade')) db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN grade TEXT');
  if (!hasAlop('entry_score')) db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN entry_score REAL');
  if (!hasAlop('iv_rank')) db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN iv_rank REAL');
  if (!hasAlop('market_regime')) db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN market_regime TEXT');
  if (!hasAlop('market_atr_pct')) {
    db.exec('ALTER TABLE autotrade_live_options_positions ADD COLUMN market_atr_pct REAL');
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
      "ALTER TABLE autotrade_live_options_orders ADD COLUMN exit_reason TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL)",
    );
  }
  // Entry rows' at-entry context (2026-07-26) — see the table DDL comment.
  if (!hasAlo('grade')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN grade TEXT');
  if (!hasAlo('entry_score')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN entry_score REAL');
  if (!hasAlo('iv_rank')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN iv_rank REAL');
  if (!hasAlo('market_regime')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN market_regime TEXT');
  if (!hasAlo('market_atr_pct')) db.exec('ALTER TABLE autotrade_live_options_orders ADD COLUMN market_atr_pct REAL');

  // autotrade_live_orders gained a role split (max-hold-days force-close):
  // every existing row IS an entry (the only kind this table held before),
  // so backfilling the default onto old rows is exactly correct, not a guess.
  const aloEquityCols = db.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[];
  if (!aloEquityCols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE autotrade_live_orders ADD COLUMN role TEXT NOT NULL DEFAULT 'entry'");
  }
  // Scale-into-winners on LIVE positions: an add-on order marks the position it
  // pyramids into here (null for every pre-existing row — none were add-ons).
  if (!aloEquityCols.some((c) => c.name === 'addon_of_position_id')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN addon_of_position_id INTEGER');
  }
  // Conviction grade carried from the signal to positions.grade at materialization
  // (null for every pre-existing/legacy row — they predate grading).
  if (!aloEquityCols.some((c) => c.name === 'grade')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN grade TEXT');
  }
  // At-entry context carried the same way (2026-07-26) — see the table DDL comment.
  if (!aloEquityCols.some((c) => c.name === 'entry_score')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN entry_score REAL');
  }
  if (!aloEquityCols.some((c) => c.name === 'market_regime')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN market_regime TEXT');
  }
  if (!aloEquityCols.some((c) => c.name === 'market_atr_pct')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN market_atr_pct REAL');
  }

  // Must run AFTER the ADD COLUMNs above so the explicit-column copy finds them.
  rebuildAutotradeLiveOrdersTable(db);
  rebuildAutotradeLiveOptionsOrdersTable(db);
  // Widens the live options positions exit_reason CHECK for 'stop_loss'/
  // 'take_profit' (2026-07-26) — after the alop ALTERs above for the same
  // copy-list reason.
  rebuildAutotradeLiveOptionsPositionsTable(db);

  normalizeBacktestBarTimes(db);

  // 2026-07-27: see the backtest_option_contracts_fetch_log DDL comment —
  // legacy rows (pre-expired-contracts client) default to 0 and stop
  // satisfying isExpirationRangeFetched, forcing a corrective re-fetch.
  const bocflCols = db.prepare('PRAGMA table_info(backtest_option_contracts_fetch_log)').all() as { name: string }[];
  if (!bocflCols.some((c) => c.name === 'includes_expired')) {
    db.exec('ALTER TABLE backtest_option_contracts_fetch_log ADD COLUMN includes_expired INTEGER NOT NULL DEFAULT 0');
  }

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

  // 2026-08-22: the VWAP observer's at-entry stamp (see the positions DDL
  // comment) — on the order row at placement, carried to the position at
  // materialization like the 2026-07-26 context trio. Runs AFTER the table
  // rebuilds above so a rebuilt table gets the column too. Nullable: a
  // pre-existing row simply has no VWAP context rather than an invented one.
  const posVwapCols = db.prepare('PRAGMA table_info(positions)').all() as { name: string }[];
  if (!posVwapCols.some((c) => c.name === 'entry_vwap')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_vwap REAL');
  }
  const aloVwapCols = db.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[];
  if (!aloVwapCols.some((c) => c.name === 'entry_vwap')) {
    db.exec('ALTER TABLE autotrade_live_orders ADD COLUMN entry_vwap REAL');
  }

  // 2026-08-22: the daily baseline singleton gained the give-back guard's two
  // sticky timestamps (see the DDL comment). Nullable, so a pre-existing row
  // simply reads as "guard not armed/fired today".
  const adbCols = db.prepare('PRAGMA table_info(autotrade_daily_baseline)').all() as { name: string }[];
  if (!adbCols.some((c) => c.name === 'give_back_armed_at')) {
    db.exec('ALTER TABLE autotrade_daily_baseline ADD COLUMN give_back_armed_at INTEGER');
  }
  if (!adbCols.some((c) => c.name === 'give_back_halted_at')) {
    db.exec('ALTER TABLE autotrade_daily_baseline ADD COLUMN give_back_halted_at INTEGER');
  }
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
    { sql: string | null } | undefined;
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
    { sql: string | null } | undefined;
  // Fresh DBs create it without the CHECK; a rebuilt DB has none either → bail.
  if (!row?.sql || !/CHECK\s*\(\s*order_type/i.test(row.sql)) return;

  // Copy only the columns the OLD table actually has. ORDER_INTENTS_COLS is the
  // full modern list, including ALTER-added ones — intersecting it with the live
  // table keeps the "never silently drop an ALTER-added column" property while
  // staying safe on a table that predates the newest ones (they take the new
  // table's DEFAULT instead of failing the copy with "no such column"). Without
  // this the rebuild is correct only if every ADD COLUMN happened to run first —
  // the exact ordering fragility behind the earlier rebuild data loss.
  const present = new Set(
    (database.prepare('PRAGMA table_info(order_intents)').all() as { name: string }[]).map((c) => c.name),
  );
  const cols = ORDER_INTENTS_COLS.split(', ')
    .filter((c) => present.has(c))
    .join(', ');

  const hadForeignKeys = database.pragma('foreign_keys', { simple: true }) === 1;
  database.pragma('foreign_keys = OFF'); // so dropping the old table doesn't cascade order_events
  try {
    database.transaction(() => {
      database.exec(orderIntentsTableSql('order_intents_new'));
      database.exec(`INSERT INTO order_intents_new (${cols}) SELECT ${cols} FROM order_intents;`);
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
/** Run a table-rebuild's multi-statement DDL (RENAME → CREATE → INSERT…SELECT →
 *  DROP) atomically. Without this, a throw mid-way (a constraint violation, a
 *  full disk) leaves the original table already renamed to *_old and the new
 *  table empty or missing — a half-migrated DB that crashes startup with no
 *  recovery. A transaction rolls the whole thing back so the original survives. */
function execAtomic(database: Database.Database, sql: string): void {
  database.transaction(() => database.exec(sql))();
}

/**
 * Drop the NOT NULL from `positions.entry_date` (2026-07-26). SQLite cannot
 * relax a column constraint in place, so the rows go through a fresh table.
 *
 * This is the ONE rebuild in this file with a dependent table, and that makes
 * it the dangerous one: `position_exits.position_id` is
 * `REFERENCES positions(id) ON DELETE CASCADE`, so a careless rebuild deletes
 * every exit in the journal — realized P&L, the whole trade history.
 *
 * Two specific defences, both deliberate:
 *
 *  1. It follows rebuildOrderIntentsTable's create-new → copy → drop-old →
 *     RENAME order, NOT rebuildAlertsTable's rename-old-first order. Renaming
 *     `positions` out of the way first would make SQLite helpfully rewrite
 *     position_exits' foreign key to point at `positions_old`, which is then
 *     dropped — leaving the FK dangling at a table that no longer exists.
 *     Nothing references `positions_new`, so renaming it INTO place at the end
 *     rewrites nothing and the existing FK text resolves correctly again.
 *  2. Foreign keys are switched off across the copy so that dropping the old
 *     table cannot cascade, and restored afterwards only if they were on.
 *
 * `id` is copied explicitly and first: position_exits.position_id points at
 * those values, so a rebuild that let them be reassigned would silently
 * re-parent every exit.
 *
 * Guarded on the stored DDL still saying NOT NULL, so it runs exactly once and
 * no-ops on a fresh database.
 */
export function rebuildPositionsTableForNullableEntryDate(database: Database.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='positions'").get() as
    { sql: string | null } | undefined;
  if (!row?.sql || !/entry_date\s+TEXT\s+NOT\s+NULL/i.test(row.sql)) return;

  const present = new Set(
    (database.prepare('PRAGMA table_info(positions)').all() as { name: string }[]).map((c) => c.name),
  );
  const cols = POSITIONS_COLS.split(', ')
    .filter((c) => present.has(c))
    .join(', ');

  const hadForeignKeys = database.pragma('foreign_keys', { simple: true }) === 1;
  database.pragma('foreign_keys = OFF'); // so dropping the old table cannot cascade position_exits away
  try {
    database.transaction(() => {
      database.exec(positionsTableSql('positions_new'));
      database.exec(`INSERT INTO positions_new (${cols}) SELECT ${cols} FROM positions;`);
      database.exec('DROP TABLE positions;');
      database.exec('ALTER TABLE positions_new RENAME TO positions;');
    })();
  } finally {
    if (hadForeignKeys) database.pragma('foreign_keys = ON');
  }
}

export function rebuildAlertsTable(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(alerts)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'asset_type')) return; // already on the new schema
  execAtomic(
    database,
    `
    ALTER TABLE alerts RENAME TO alerts_old;
    ${ALERTS_TABLE_SQL}
    INSERT INTO alerts (id, symbol, kind, operator, threshold, note, enabled, triggered,
                        last_value, trigger_message, last_triggered_at, created_at, updated_at)
      SELECT id, symbol, kind, operator, threshold, note, enabled, triggered,
             last_value, trigger_message, last_triggered_at, created_at, updated_at
      FROM alerts_old;
    DROP TABLE alerts_old;
  `,
  );
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

  execAtomic(
    database,
    `
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
  `,
  );
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

  execAtomic(
    database,
    `
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
  `,
  );
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

  // The CREATE below MUST stay in sync with the canonical CREATE TABLE in
  // SCHEMA above. The INSERT's copy list is the canonical column list
  // INTERSECTED with what the old table actually has (same approach as
  // rebuildPositionsTableForNullableEntryDate): in migrate()'s real order the
  // ALTER-added columns (account_id/addon_of_position_id/grade, and the 2026-07-26
  // at-entry context trio) all exist by the time this runs, and intersecting
  // means a column that doesn't (an isolated test, a reordered migration)
  // is skipped instead of failing the whole rebuild on "no such column" —
  // while every column that IS present keeps its data.
  const present = new Set(
    (database.prepare('PRAGMA table_info(autotrade_live_orders)').all() as { name: string }[]).map((c) => c.name),
  );
  const cols = (
    'intent_id, symbol, role, stop_price, target_price, risk_amount, risk_profile, position_id, ' +
    'account_id, addon_of_position_id, grade, entry_score, market_regime, market_atr_pct, entry_vwap, created_at'
  )
    .split(', ')
    .filter((c) => present.has(c))
    .join(', ');
  execAtomic(
    database,
    `
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
      account_id    TEXT,
      addon_of_position_id INTEGER,
      grade         TEXT,
      entry_score   REAL,
      market_regime TEXT,
      market_atr_pct REAL,
      entry_vwap    REAL,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO autotrade_live_orders (${cols})
      SELECT ${cols}
      FROM autotrade_live_orders_old;
    DROP TABLE autotrade_live_orders_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_live_orders_symbol ON autotrade_live_orders(symbol);
  `,
  );
}

/**
 * Rebuild `autotrade_live_options_orders` when its FK predates ON DELETE
 * CASCADE (same reason as rebuildAutotradeLiveOrdersTable above -- see that
 * function's header) OR when its exit_reason CHECK predates
 * 'stop_loss'/'take_profit' (live price-based exits, 2026-07-26 -- SQLite
 * can't widen a CHECK in place, the same constraint that forced
 * rebuildAutotradeOptionsPaperPositionsTable). One rebuild handles both:
 * the recreated table always carries the current shape, so whichever
 * deficiency triggered it, both are fixed and the guard below never fires
 * again.
 */
export function rebuildAutotradeLiveOptionsOrdersTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_live_options_orders'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || (/ON DELETE CASCADE/i.test(row.sql) && /stop_loss/i.test(row.sql))) return;

  // The CREATE below MUST stay in sync with the canonical CREATE TABLE in
  // SCHEMA above; the INSERT intersects the canonical column list with what
  // the old table actually has — same reasoning as
  // rebuildAutotradeLiveOrdersTable directly above.
  const present = new Set(
    (database.prepare('PRAGMA table_info(autotrade_live_options_orders)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const cols = (
    'intent_id, symbol, role, kind, side, contract_symbol, strike, short_contract_symbol, short_strike, ' +
    'expiration, risk_amount, risk_profile, position_id, exit_reason, account_id, grade, entry_score, ' +
    'iv_rank, market_regime, market_atr_pct, created_at'
  )
    .split(', ')
    .filter((c) => present.has(c))
    .join(', ');
  execAtomic(
    database,
    `
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
      exit_reason   TEXT CHECK(exit_reason IN ('time_exit','stop_loss','take_profit','manual') OR exit_reason IS NULL),
      account_id    TEXT,
      grade         TEXT,
      entry_score   REAL,
      iv_rank       REAL,
      market_regime TEXT,
      market_atr_pct REAL,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO autotrade_live_options_orders (${cols})
      SELECT ${cols}
      FROM autotrade_live_options_orders_old;
    DROP TABLE autotrade_live_options_orders_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_live_options_orders_symbol ON autotrade_live_options_orders(symbol);
  `,
  );
}

/**
 * Rebuild `autotrade_live_options_positions` when its exit_reason CHECK
 * predates 'stop_loss'/'take_profit' (live price-based exits, 2026-07-26).
 * SQLite can't widen a CHECK in place, so this is the same rename/create/
 * copy/drop dance as rebuildAutotradeOptionsPaperPositionsTable — guarded on
 * 'stop_loss' already being in the stored table SQL, so it runs once and
 * no-ops on a fresh DB. The copy list intersects the canonical column list
 * with what the old table actually has (see rebuildAutotradeLiveOrdersTable
 * for the reasoning), and the status index is recreated in its
 * status-leading order.
 */
export function rebuildAutotradeLiveOptionsPositionsTable(database: Database.Database): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='autotrade_live_options_positions'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || /stop_loss/i.test(row.sql)) return;

  const present = new Set(
    (database.prepare('PRAGMA table_info(autotrade_live_options_positions)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const cols = (
    'id, symbol, side, kind, contract_symbol, strike, short_contract_symbol, short_strike, expiration, ' +
    'quantity, entry_price, short_entry_price, entry_at, risk_amount, risk_profile, rationale, status, ' +
    'exit_price, short_exit_price, exit_at, exit_reason, account_id, grade, entry_score, iv_rank, ' +
    'market_regime, market_atr_pct, created_at, updated_at'
  )
    .split(', ')
    .filter((c) => present.has(c))
    .join(', ');
  execAtomic(
    database,
    `
    ALTER TABLE autotrade_live_options_positions RENAME TO autotrade_live_options_positions_old;
    CREATE TABLE autotrade_live_options_positions (
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
      account_id             TEXT,
      grade                  TEXT,
      entry_score            REAL,
      iv_rank                REAL,
      market_regime          TEXT,
      market_atr_pct         REAL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    INSERT INTO autotrade_live_options_positions (${cols})
      SELECT ${cols}
      FROM autotrade_live_options_positions_old;
    DROP TABLE autotrade_live_options_positions_old;
    CREATE INDEX IF NOT EXISTS idx_autotrade_live_options_positions_status ON autotrade_live_options_positions(status, symbol);
  `,
  );
}

/** 2026-07-27: repair cached Polygon daily/weekly bars stamped at midnight
 *  EASTERN (04:00/05:00 UTC) instead of midnight UTC. The backtest engines
 *  match bars to simulated days by exact UTC-midnight equality, so every
 *  un-normalized cached bar made the simulation silently skip its own trading
 *  day — a backtest over real Polygon data reported zero trades and zero
 *  errors. polygonClient.ts now floors day-level timestamps at fetch time;
 *  this floors the rows cached before that fix. UPDATE OR REPLACE: if a
 *  normalized twin of a raw row already exists (a re-fetch after the client
 *  fix), the (symbol, timeframe, time) primary-key conflict resolves by
 *  replacing it instead of failing the migration. Idempotent — a floored row
 *  can never match the WHERE clause again. Intraday timeframes keep their
 *  real timestamps, exactly like the fetch-time fix. */
export function normalizeBacktestBarTimes(database: Database.Database): void {
  database.exec(
    `UPDATE OR REPLACE backtest_bars
     SET time = time - (time % 86400000)
     WHERE timeframe IN ('daily', 'weekly') AND time % 86400000 != 0`,
  );
}

/** Run migrations and seed the default universe. Call once at startup. */
export function initDb(): void {
  db.exec(SCHEMA);
  migrate();
  seedUniverseIfEmpty();
  topUpUniverseOnce(db);
  seedAutotradeExclusionsIfEmpty();
}
