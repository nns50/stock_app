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
- **Alerts** — rule-based triggers on price / change % / relative volume / RSI
  (above or below a threshold), one-shot with acknowledge to re-arm.
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

For **free live data with no API key**, set `MARKET_DATA_PROVIDER=yahoo` (Yahoo
Finance — covers stocks **and** options chains; Greeks computed locally). It's
unofficial, so it's intended for personal use and may rate-limit or change. For
Tradier, set `MARKET_DATA_PROVIDER=tradier` and `TRADIER_API_TOKEN` (note: Tradier
requires a brokerage account / data subscription for real-time data). Restart
after changing.

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

## Environment variables

Copy `.env.example` to `server/.env`. All keys are read **server-side only**.

| Variable                | Default                            | Description                                                     |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `MARKET_DATA_PROVIDER`  | `mock`                             | `yahoo` (free, no key), `tradier`, or `mock`.                   |
| `TRADIER_API_TOKEN`     | _(empty)_                          | Tradier access token (sandbox or brokerage).                    |
| `TRADIER_BASE_URL`      | `https://sandbox.tradier.com/v1`   | Use `https://api.tradier.com/v1` for production data.           |
| `PORT`                  | `3001`                             | API port.                                                       |
| `DATABASE_PATH`         | `./data/stock_app.db`              | SQLite file (relative to `server/`).                            |
| `QUOTE_CACHE_TTL_MS`    | `15000`                            | In-memory quote cache TTL.                                      |
| `CANDLE_CACHE_TTL_MS`   | `60000`                            | In-memory candle cache TTL.                                     |
| `CORS_ORIGINS`          | `http://localhost:5173`            | Comma-separated allowed origins for the API.                    |
| `RISK_FREE_RATE`        | `0.04`                             | Annual risk-free rate for Black–Scholes.                        |

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
data. Tradier, Yahoo, and the mock provider all support options (Yahoo's Greeks
are computed locally from its implied vol); the mock's data is flagged
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
```

CI runs lint, format-check, typecheck, tests, and build on every PR.

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
filters (min price, min volume, RSI bounds, trend alignment) are all
configurable, and savable as presets.

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
