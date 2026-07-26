# stock-app — personal day-trading & options assistant

A local-first **decision-support and tracking** tool for day trading and options
trading. It screens a configurable universe with transparent, rule-based
heuristics, helps evaluate option entries/exits, and tracks positions, P&L, and a
trade journal.

> ⚠️ **Not financial advice.** Every "pick" and "signal" is a rule-based heuristic
> you configure yourself. Nothing here predicts the market or guarantees results.
> This is a personal research tool. Do your own due diligence.

---

## What it does

- **Daily screener** — ranks a watchlist with composable, weighted indicators
  (momentum, relative volume, RSI, ATR volatility, gap %, trend). Every score is
  fully explainable: you see each component's raw value, sub-score, weight, and
  contribution. Save filter presets and drill into a per-symbol chart with MA
  overlays. **Edge-tracking:** snapshot a run's top picks and later measure their
  direction-adjusted forward returns (hit rate, avg/median, best/worst) to see
  whether your rules actually work.
- **Options entry/exit** — pull the chain for a symbol + expiration (strikes,
  bid/ask, volume, OI, IV, Greeks). Greeks come from the provider when available,
  otherwise computed locally via Black–Scholes. Configure entry strategies
  (delta band, max spread %, min OI/volume, IV band, **IV rank**, DTE) and rank
  candidate contracts with a rule breakdown. Run exit rules (take-profit %,
  stop-loss %, time-based, delta-drift) against open option positions.
- **Multi-leg strategies** — build verticals, straddles, strangles, iron condors,
  or custom; get net debit/credit, a **payoff diagram**, breakevens, max
  profit/loss, **combined Greeks**, and a lognormal **probability-of-profit**.
- **Positions, journal & P&L** — log stock and option trades (entries + partial
  exits), see live realized/unrealized P&L per trade and in aggregate, and review
  a journal with tags, grades, and stats (win rate, avg win/loss, expectancy,
  profit factor, equity curve).
- **Alerts** — rule-based triggers on a stock (price / change % / relative volume /
  RSI / MA-spread / 52-week distance) **or a specific option contract** (underlying
  price, mark / bid / ask, |Δ|, IV) with an entry/exit **role** and a trade plan;
  an entry alert auto-attaches a suggested exit. One-shot, with acknowledge to re-arm.
  An optional **server-side poller** keeps watching with the app closed and pushes
  fired alerts to a **webhook** (Slack / Discord / phone via ntfy).
- **Risk / position-size calculator** — account size + risk % + entry/stop →
  suggested quantity (stock or option), R-multiple target, and guard-rails.
- **Providers** — swappable behind one interface: free **Yahoo Finance** (no key,
  stocks + options), **Tradier** (brokerage data), or a keyless **mock** provider.
  A built-in **connection test** (UI + `npm run check:provider`) verifies a live
  provider without exposing keys.

## Architecture

```
web/  (React + Vite + TS + Tailwind + Recharts)
  │  browser only ever calls same-origin /api/*  (Vite proxies to the API in dev)
  ▼
server/  (Node + Express + TS)            ← holds ALL market-data API keys
  ├─ MarketDataProvider  (single swappable interface)
  │    ├─ YahooProvider     (free, no key: quotes, candles, options + computed Greeks)
  │    ├─ TradierProvider   (brokerage data: quotes, candles, options + Greeks)
  │    ├─ MockProvider      (keyless deterministic synthetic data — default)
  │    └─ CachingProvider   (TTL cache + rate-limit backoff wrapper)
  ├─ indicators/  (pure indicator math + transparent scoring engine)
  ├─ options/     (Black–Scholes, entry/exit rules, multi-leg strategy analytics)
  ├─ services/    (P&L, IV rank, snapshot performance, alerts, provider test, …)
  └─ SQLite (better-sqlite3): universe, presets, positions, exits, quote cache,
       settings, iv_history, screener snapshots, alerts
```

The frontend **never** talks to a data provider and **never** holds a key — all
provider calls go through the backend. Swapping providers means implementing the
`MarketDataProvider` interface (`server/src/providers/MarketDataProvider.ts`) and
registering it in `server/src/providers/index.ts`; nothing else changes.

## Tech stack

| Layer    | Choice                                                        |
| -------- | ------------------------------------------------------------- |
| Frontend | React, Vite, TypeScript, Tailwind CSS, Recharts              |
| Backend  | Node, Express, TypeScript                                    |
| Storage  | SQLite via better-sqlite3 (local file)                       |
| Data     | Tradier (live) or built-in Mock provider (keyless)          |
| Tests    | Vitest (scoring + Greeks logic)                             |

## Prerequisites

- Node.js ≥ 20 (developed on 22)
- npm ≥ 10

## Quick start

```bash
# 1. install (root uses npm workspaces for server + web)
npm install

# 2. configure (optional — defaults to the keyless mock provider)
cp .env.example server/.env       # then edit if you want live Tradier data

# 3. run both API (:3001) and web (:5173) together
npm run dev
```

Open <http://localhost:5173>. With no `.env`, the app runs on **synthetic mock
data** (clearly labeled in the UI) so you can explore everything immediately.

**Want demo data to explore with?** Seed a handful of trades + a watchlist:

```bash
npm run seed       # 5 closed + 2 open trades, 7 watchlist symbols (idempotent)
```

## 📚 Documentation

- **[User Guide](docs/USER_GUIDE.md)** — a page-by-page walkthrough of every feature
  and a recommended daily workflow.
- **[Strategy Playbook](docs/STRATEGY_PLAYBOOK.md)** — how to use the app's tools
  (risk sizing, the screener Edge Report, R-multiple analytics, MAE/MFE, risk-of-ruin,
  the SPY benchmark) to trade with a real process edge — plus concrete long-stock,
  short-fade, and options playbooks.
- **[Auto-Trade Risk Settings](docs/AUTOTRADE_RISK_SETTINGS.md)** — a plain-English
  guide to every risk setting on the Auto-Trade page's Configuration card (risk per
  trade, daily drawdown, aggregate open risk, correlated exposure, and more), with
  worked examples for each.
- **[Tune from target daily gain](docs/TUNE_FROM_TARGET.md)** — how to set up the whole
  Auto-Trade risk config at once from a target daily gain % + your equity, with the
  Expected/Perfect-day basis explained and worked examples.
- In-app **About** page — the live, authoritative description of the scoring formulas
  and glossary.

For **free live data with no API key**, set `MARKET_DATA_PROVIDER=yahoo` (Yahoo
Finance — covers stocks **and** options chains; Greeks computed locally). It's
unofficial, so it's intended for personal use and may rate-limit or change. For
Tradier, set `MARKET_DATA_PROVIDER=tradier` and `TRADIER_API_TOKEN` (note: Tradier
requires a brokerage account / data subscription for real-time data). For
**Webull**, set `MARKET_DATA_PROVIDER=webull` with `WEBULL_APP_KEY` /
`WEBULL_APP_SECRET` — a **composite** provider that serves real-time US **stock**
quotes + candles from Webull's licensed feed and delegates **option chains** to
Yahoo (Webull's OpenAPI has no option-chain endpoint). **Fundamentals** blend
Webull's snapshot valuation metrics (market cap, P/E, EPS, dividend yield,
52-week range) with Yahoo's company profile (name, sector, beta). Symbols
Webull's feed doesn't carry (e.g. class shares like `BRK.B`) automatically fall
back to Yahoo; an inactive quote subscription still surfaces as an error rather
than silently falling back. Webull stock data needs an active **OpenAPI quote
subscription** on your account. Restart after changing.

Verify any provider with the **provider chip → "Run connection test"** in the UI,
or the CLI: `npm run check:provider [SYMBOL]`.

### Run with Docker

A multi-stage image builds both packages and serves the built frontend directly
from the Express server (single origin, single port):

```bash
cp .env.example .env          # optional — edit for live Tradier data
docker compose up --build     # then open http://localhost:3001
```

The SQLite database is persisted in the `stockdb` named volume. To run the image
directly without compose:

```bash
docker build -t stock-app .
docker run -p 3001:3001 -e MARKET_DATA_PROVIDER=mock stock-app
```

**Always-on alerts:** to have alerts fire with the app/browser closed, run this image
on a small always-on VPS or container host and enable the server-side poller. The repo
includes a ready **`fly.toml`** (one `shared-cpu-1x` / 512 MB machine + a 1 GB volume).
See the **[Deployment guide](docs/DEPLOY.md)** for the Fly.io and VPS runbooks —
including the important note that the app has no authentication, so keep it private
(Fly private networking / Tailscale / SSH tunnel / authed reverse proxy).

**Fresh builds after deploy:** the production server sends `index.html` with
`Cache-Control: no-cache` (always revalidated) while hashed `/assets/*` are cached
immutably for a year, so a new deploy can't leave a browser running an old bundle.
If the browser is still holding a previous build and hits a now-missing chunk, the
app reloads itself once to pull the current one. The footer shows the running build
id (a build timestamp by default); set `VITE_BUILD_ID` at build time — e.g. a commit
SHA — to override it.

## Environment variables

Copy `.env.example` to `server/.env`. All keys are read **server-side only**.

| Variable                | Default                            | Description                                                     |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `MARKET_DATA_PROVIDER`  | `mock`                             | `yahoo` (free, no key), `tradier`, `webull`, or `mock`.         |
| `TRADIER_API_TOKEN`     | _(empty)_                          | Tradier access token (sandbox or brokerage).                    |
| `TRADIER_BASE_URL`      | `https://sandbox.tradier.com/v1`   | Use `https://api.tradier.com/v1` for production data.           |
| `WEBULL_APP_KEY`        | _(empty)_                          | Webull OpenAPI app key (server-side only). Required for `webull`. |
| `WEBULL_APP_SECRET`     | _(empty)_                          | Webull OpenAPI app secret (server-side only).                   |
| `WEBULL_PACING_SCALE`   | `1`                                | Multiplier on the client's per-endpoint request spacing (Webull limits order/position queries to 2 requests per 2s). `0` disables pacing — used by the test suite; leave at `1` in normal use. |
| `POLYGON_API_KEY`       | _(empty)_                          | Polygon.io/Massive key for the auto-trading **backtest** harness only (docs/AUTOTRADING_SPEC.md). Separate from `MARKET_DATA_PROVIDER` — never used for live screening/quotes. |
| `TRADING_ENABLED`       | `false`                            | **Master gate for placing REAL orders.** Off ⇒ the Trade page can dry-run/live-preview but **never** places. Even on, placing also needs the guardrails to pass + kill switch off + type-to-confirm. |
| `PORT`                  | `3001`                             | API port.                                                       |
| `DATABASE_PATH`         | `./data/stock_app.db`              | SQLite file (relative to `server/`).                            |
| `QUOTE_CACHE_TTL_MS`    | `15000`                            | In-memory quote cache TTL.                                      |
| `CANDLE_CACHE_TTL_MS`   | `60000`                            | In-memory candle cache TTL.                                     |
| `CORS_ORIGINS`          | `http://localhost:5173`            | Comma-separated allowed origins for the API.                    |
| `RISK_FREE_RATE`        | `0.04`                             | Annual risk-free rate for Black–Scholes.                        |
| `SLACK_WEBHOOK_URL`     | _(empty)_                          | Slack Incoming Webhook for fired alerts (secret). Blank = off.   |
| `DISCORD_WEBHOOK_URL`   | _(empty)_                          | Discord channel webhook for fired alerts (secret). Blank = off.  |
| `ALERT_WEBHOOK_URL`     | _(empty)_                          | Generic/ntfy webhook for fired alerts (secret). Fires alongside Slack/Discord. |
| `ALERT_WEBHOOK_FORMAT`  | `json`                             | Body shape for `ALERT_WEBHOOK_URL`: `json`, `slack`, or `discord`. |
| `APP_PASSWORD`          | _(empty)_                          | Set to require a login (one shared password) before any data is served. Blank = no auth. |
| `AUTH_SECURE_COOKIE`    | `true` in prod                     | Session cookie `Secure` flag. Set `false` for plain-http access (e.g. `fly proxy`). |
| `DISABLE_MFA`           | `false`                            | Recovery switch — bypass two-factor (login = password only) if you lose your authenticator. |

### Getting a Tradier token

1. Create a developer account at <https://developer.tradier.com/>.
2. Use a **sandbox** token with `TRADIER_BASE_URL=https://sandbox.tradier.com/v1`
   (free, delayed data), or a brokerage token for production.
3. Put it in `server/.env` as `TRADIER_API_TOKEN=...` and set
   `MARKET_DATA_PROVIDER=tradier`.

## Provider & options gating

The options module is feature-gated on `capabilities.options`. The app reads
`GET /api/provider` and, if the active provider can't serve options (or isn't
configured), shows a clear **"data not configured"** state instead of fabricating
data. Tradier, Yahoo, Webull, and the mock provider all support options (Webull
delegates option chains to Yahoo; Yahoo's Greeks are computed locally from its
implied vol); the mock's data is flagged
`synthetic` everywhere so it's never mistaken for real quotes.

## Scripts

```bash
npm run dev            # run API + web together (concurrently)
npm run dev:server     # API only (tsx watch)
npm run dev:web        # web only (vite)
npm run build          # typecheck + build server and web
npm test               # unit tests (vitest) for server + web
npm run typecheck      # typecheck both packages
npm run lint           # ESLint (flat config) over the monorepo
npm run format         # Prettier --write
npm run check:provider # verify the configured market-data provider
npm run capture:broker # dump raw Webull field shapes (read-only; see below)
npm run backfill:exits # correct estimated exit prices from real fills (dry run; see below)
npm run check:journal  # audit the trade journal for rows that are already wrong (report only)
```

CI runs lint, format-check, typecheck, tests, and build on every PR.

### `check:journal` — auditing the journal for rows that are already wrong

**Report only. There is no `--apply`, by design.** It reads the local database
and prints; it opens no write path and never contacts the broker.

A bug that gets fixed stops writing bad rows — it does not repair the rows it
already wrote. And the defects worth worrying about here are the ones the UI
*cannot* show you: an exit dated a day late, a position whose exits close more
than it ever held (`remainingQuantity` clamps at zero, so it just reads as
closed), a lot that lost the account it belongs to. Each renders as a perfectly
ordinary row while feeding the Positions P&L, the Journal's expectancy and the
tax export.

```bash
npm run check:journal            # grouped by check, with why each one matters
npm run check:journal -- --json  # machine-readable, for diffing over time
```

Also available read-only at `GET /api/positions/integrity`.

On a deployed instance the `npm run` form doesn't work — the runtime image ships
compiled JS only. See [DEPLOY.md → Running the maintenance scripts on
Fly](docs/DEPLOY.md#running-the-maintenance-scripts-on-fly) for the `node` form,
and for the `DATABASE_PATH` trap that otherwise audits an empty database and
reports it clean.

Every check is listed in the output whether or not it fired — "we looked and
found none" is a different statement from "we didn't look". What it checks:
non-ISO dates · rows a background job dated in UTC rather than ET · an option
entered after its own contract expired · exits before their own entry · future
dates · exits exceeding the position's size · a status that contradicts the
remaining quantity · a zero/negative entry price · a zero/negative exit quantity
· a broker-tracked lot with no account recorded · an imported position with no
entry date (informational — see below).

Findings carry a severity: **high**, **medium** or **info**. The report's
`clean` flag means *nothing to fix* — it stays `true` when the only findings are
informational, because an undated import is a correct record of an incomplete
fact, not a defect. Read `findings` for everything reported; `clean` answers the
narrower question, and the summary line says which case you are in.

Findings are reported at their **cause**, not their symptoms. A row can violate
several checks for one underlying reason — an option whose entry was stamped
after the contract expired will also have an "exit before entry" — so the check
that proves what is wrong wins and the downstream ones stay quiet. Fix it,
re-run, and anything genuinely separate surfaces on the next pass.

An option's **expiration** is deliberately exempt from the future-date check: it
is a term of the contract rather than a record of something that happened, and
for any open contract it is supposed to be ahead of today.

The UTC-dating check deserves a note, because it is **exact rather than
heuristic**: until 2026-07-26 the Webull sync and the order reconciler dated
rows off the server's UTC clock, which on a UTC-deployed box is already tomorrow
from 20:00 ET onward. A row is flagged only when its date equals the UTC date at
the instant it was written *and* that differs from the market date — true of
every affected row and of no correctly-dated one. It reports the value the row
should carry; it never writes it.

### Positions with no entry date

Webull's positions endpoint returns current **holdings** — quantity and an
*average* cost. A lot built from several buys therefore has no single open date
for it to report, and in practice it often reports none at all; the order-history
endpoint that does carry dates only reaches back 7 days. Until 2026-07-26 the
importer papered over this by stamping the date of the **import**, which fed
hold-time buckets, the wash-sale window and the equity curve as though it were
fact — and occasionally produced an entry date *after* an already-expired
contract.

The import now records **no date** rather than inventing one, and `entry_date`
is nullable (a one-time table rebuild handles existing databases; it preserves
every position id and every exit). The cost is that an undated trade sits out of
the equity curve, rolling expectancy, and the weekday/hold-time breakdowns — the
Journal states how many trades those are computed from, inline, so a shorter
curve reads as "we don't know when those happened" rather than as missing data.
Win rate, expectancy and profit factor are unaffected: they need only P&L.

Manually logging a trade still requires a date — you know when you traded.
`check:journal` lists undated rows as **informational**, so you can fill them in
from memory via the position's journal dialog and have them rejoin the
time-based stats.

There is deliberately no repair mode. Several of these have more than one
defensible fix (is a future-dated exit a typo, or a genuinely mis-recorded
date?), and guessing at someone's real trading record is worse than naming the
row and stopping. Fix what it finds from the Positions page — **journal**,
**exit**, **del** — and re-run to confirm the count drops.

### `backfill:exits` — correcting estimated exit prices

A **dry-run-by-default** one-off repair. Until the bracket response shape was
confirmed (`capture:broker` Q3, above), a stop or target firing was invisible to
the order path: `combo_type` sits on the response *envelope* rather than on the
leg, and a bracket comes back as three separate envelopes sharing a
`combo_order_id` rather than one with nested legs. So what actually closed those
positions was the background Webull position sync, which notices a holding has
gone and books an exit priced from the latest **quote** — an estimate, flagged
as one in the exit's own note.

That matters more than tidiness. **Expectancy-weighted sizing** reads each closed
autotrade trade's realized R (`realizedPnl / initialRisk`) and turns a grade's
average into the multiplier that sizes the next trade in that grade; auto-tune's
walk-forward guard and the excursion tuner read the same closed-trade P&L. An
exit-price error lands directly in that numerator, so a grade whose exits were
booked worse than they filled gets sized down on evidence that never happened.

The real fill is recoverable: position → its entry order → the broker's combo →
the exit leg that filled, and its `filled_price`.

```bash
npm run backfill:exits              # report what WOULD change, write nothing
npm run backfill:exits -- --apply   # write the corrections
```

The dry run prints one line per trade (`recorded → real fill`, and the P&L
difference), then every skip with its reason. Read-only toward the broker; the
only write it ever makes is an exit row's price, and only under `--apply`.

Safe to re-run: correcting an exit rewrites its note, which is what the
candidate query keys on, so a corrected row drops **out** of the set entirely
rather than being re-examined. After an `--apply`, the next run's count falls by
exactly the number corrected and those rows are simply absent — that's the
success signal, not a "nothing to do here" line.

It refuses rather than guesses, on the same principle as the rest of the live
path: a combo that has aged out of order history, two exit legs both reporting
filled, a leg whose quantity doesn't match what the exit booked, or no usable
fill price all leave the row exactly as it was. An estimate that is known to be
an estimate is recoverable; a confident wrong "correction" writes fiction into
realized P&L and the tax export.

**It has an expiry date.** Webull's Trading API serves order history for the
**past 7 days only**, so a trade whose *entry* order is older than that can
never be corrected from the broker — re-running won't help, and those rows say
so explicitly rather than reporting a generic "no record". Anything older is
permanently an estimate.

### `capture:broker` — confirming broker field semantics

A **strictly read-only** diagnostic for live trading. It calls the same
whitelisted GET endpoints as the Settings → Webull probe (balance, positions,
open orders, order history) and writes the raw payloads to
`broker-capture.json` (gitignored) with account identifiers masked, so the
mappers that read those fields can be built against confirmed responses rather
than a plausible reading of a field name. It places nothing, cancels nothing,
and writes nothing to the database.

It highlights three fields the app currently has to assume the meaning of:

- `total_day_profit_loss` — mapped to `realizedPnlTodayUsd` and used by the
  daily-loss halt, which treats it as **realized only**. If the broker includes
  unrealized mark-to-market, the halt can trip on paper drawdown or be masked by
  an open gain.
- `filled_quantity` — whether it is **cumulative** across executions or reports
  each execution separately. Only cumulative values can be safely differenced
  when recording partial fills.
- `combo_type` — whether a bracket's response tags **each leg** (MASTER /
  STOP_LOSS / STOP_PROFIT) or only the order as a whole. This is what decides
  whether a bracket's outcome can be read per leg at all: it gates detecting
  "both exit legs reported filled", and it's why the stop-still-there check has
  to ask "is any exit-side order resting on this symbol" instead of "is *this*
  position's stop still there".

```bash
npm run capture:broker                              # snapshot + field report
npm run capture:broker -- --shapes-only             # field names/types, no balances
npm run capture:broker -- --watch-day-pnl           # settles total_day_profit_loss
npm run capture:broker -- --watch <client_order_id> # poll one order while it fills
```

The first two are settled by **watching a value over time**, since a single
snapshot can't distinguish the readings. The `combo_type` question is answered
straight from the plain snapshot — but only once the account has actually placed
a **bracket**: a spread's legs carry no MASTER/exit roles, so the report refuses
to let one stand in for a bracket and says `inconclusive` instead. Place a
bracketed stock entry, let it rest or fill, then re-run.

`--watch-day-pnl` samples the balance repeatedly (default 6 × 20s) while you hold
an open position and place **no** orders. Realized P&L is pinned for that window,
so anything that moves must be mark-to-market — it reports
`includes-unrealized`, `realized-only`, or `inconclusive`.

`--watch <client_order_id>` samples one order's reported fill while it works, and
reports `cumulative`, `per-execution`, or `inconclusive`.

Both deliberately return `inconclusive` rather than guessing when the value never
moved — identical samples would otherwise look like a clean answer while
containing no information.

The default output contains real balances and positions — review it before
sharing, or use `--shapes-only`.

## How the screener score works (no black boxes)

Each run computes indicators per symbol, maps each into a **0–100 sub-score**,
multiplies by your configurable weight, and reports the **weighted average** as
the total. The full breakdown travels with every result:

| Component       | Raw inputs                                   | Higher score when…                        |
| --------------- | -------------------------------------------- | ----------------------------------------- |
| Momentum        | % change, distance from short/long MA        | moving with the chosen direction          |
| Relative Volume | today's volume ÷ average volume              | unusually active                          |
| RSI             | Wilder RSI(14)                               | near a configurable sweet spot            |
| Volatility      | ATR(14) as % of price                        | more intraday range (capped)              |
| Gap             | open vs prior close                          | gapping in the trade direction            |
| Trend           | price vs MAs + MA alignment                  | aligned with the chosen direction         |

Weights, MA periods, RSI period, scaling knobs, direction (long/short), and hard
filters (min price, min volume, RSI bounds, trend alignment — daily and weekly) are
all configurable, and savable as presets.

## Greeks & units (Black–Scholes helper)

`server/src/options/blackScholes.ts`. Trader-friendly units:

- **delta** per $1 move · **gamma** delta-change per $1 · **vega** per +1% IV ·
  **theta** per calendar day · **rho** per +1% rate · IV as a decimal.

Computed Greeks are flagged `computed: true` so the UI distinguishes them from
provider-supplied Greeks.

## Data, persistence & resetting

State lives in a local SQLite file (`server/data/stock_app.db`, git-ignored). The
default universe is seeded from `server/data/sp500.json` (a curated set of liquid
S&P 500 names — editable in-app; paste in the full index if you like). To reset,
stop the server and delete the `.db` file; it's recreated and reseeded on boot.

## Rate limits & caching

Quotes/candles are cached in-memory with TTLs; the HTTP client backs off on 429 /
5xx with jitter and honors `Retry-After`. Last-known quotes are also persisted to
SQLite so P&L can render (flagged **stale**) when the provider is unavailable. The
UI has a manual **Refresh** and an **optional** polling interval (off by default).

## Testing

```bash
npm test   # ~100 unit tests: indicators, scoring engine, Black–Scholes, option
           # entry/exit rules, multi-leg strategy math, P&L, IV rank, risk sizing,
           # alerts, snapshot performance, the Yahoo provider mapping, and the web
           # formatters / UI / API client
```

CI runs lint, format-check, typecheck, tests, and build on every PR.

## Non-goals & safety

- Does **not** place real trades or connect to a broker.
- Does **not** claim predictive accuracy. A persistent footer disclaimer is shown
  throughout the app.
- Handles API failures, empty data, and rate limits with clear, explicit states.
