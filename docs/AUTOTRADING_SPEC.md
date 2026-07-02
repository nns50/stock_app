# Automated Trading — Specification

**Status: draft — not yet implemented.** This is the reference spec for adding a fully
**autonomous** execution loop (screen → decide → risk-check → place orders) to the app.

This is a different capability from the existing live-trading feature described in
[`LIVE_TRADING_DESIGN.md`](./LIVE_TRADING_DESIGN.md), which requires a human to type a
confirmation phrase before **every** order. The loop below places orders **without
per-trade confirmation** — the only brakes are the paper/live flag and a kill switch.
That's a meaningfully higher-stakes system, so treat this doc as the place to work out
the design *before* writing execution-capable code, not as a backlog to build
top-to-bottom.

Edit this file directly as the plan evolves — it's the living reference for this
initiative, not a frozen requirements doc.

## Fit with the current codebase

A few places where the spec below was written against different assumptions than this
repo, worth resolving before implementation:

- **Market data.** The opening line assumes a Finnhub WebSocket feed. This repo has no
  Finnhub integration — the current providers are `mock` (synthetic demo, default),
  `tradier`, `yahoo`, and `webull` (`server/src/providers/index.ts`), selected by the
  `MARKET_DATA_PROVIDER` env var. Whichever provider is active would feed the
  Research & Screen stage.
- **Broker.** The spec asks to confirm the broker (Alpaca, IBKR, etc.) before wiring a
  live connection. This repo already has one broker integrated: **Webull**, via the v2
  OpenAPI, with a substantial working order pipeline —
  guardrails (`server/src/services/trading/guardrails.ts`), the kill switch and
  `TRADING_ENABLED` gate, bracket orders, multi-leg spreads, order reconcile, and
  Positions/Journal sync (see `LIVE_TRADING_DESIGN.md`). The natural path is to place
  orders through that existing pipeline rather than integrate a new broker — but
  confirm this explicitly, since it's a real fork in how much of this spec is new work
  versus reuse.
- **Sector/industry data for the real-estate exclusion.** The `universe` table already
  has a `sector` column, seeded from `server/data/sp500.json`. That covers the S&P 500;
  it does **not** cover every possible screened ticker (e.g. small/mid-cap gappers
  outside the index), so a sector-classification lookup for symbols outside the seeded
  universe is still an open question — options include a data provider that returns
  sector/industry (check Tradier/Yahoo's fundamentals responses), or a maintained
  supplementary list. The configurable symbol exclusion list (VNQ, IYR, XLRE, etc.)
  works today regardless; the "catch unlisted/new REITs by classification" requirement
  needs that data source decided.
- **Execution-loop hosting.** Nothing in this app currently runs a persistent
  background loop except the alerts poller (an optional in-process interval, gated by
  a DB flag, alongside the Express server — see Settings → Alerts → "background alert
  poller"). The same pattern — an in-process scheduled loop, on/off in the DB, checked
  every cycle — is the natural fit for the research → decide → risk-check → execute →
  journal cycle below, given the app's single always-on Node process on Fly.io.

## Resolved decisions

Answers to the open questions worked through before implementation started. Update
this list as decisions change — don't let it drift from what's actually built.

- **Broker: Webull**, via the existing v2 OpenAPI order pipeline (guardrails, order
  lifecycle state machine, brackets, reconcile). No new broker integration — the
  execution stage places orders through the same pipeline the human-confirmed
  live-trading feature already uses, just without the per-trade confirmation prompt.
- **Real-estate exclusion**: checked at the Research & Screen stage against *both* a
  configurable symbol list (VNQ, IYR, XLRE, etc.) *and* sector/industry classification
  pulled from the market-data provider (fundamentals lookup), so REITs and real-estate
  operating companies outside the seeded S&P 500 `universe.sector` data still get
  caught. Either match excludes the candidate before it reaches Decision.
- **Correlated-ticker exposure cap**: defined by **statistical price correlation**
  (pairwise correlation of returns across open + candidate positions), not sector
  membership. The specific lookback window and correlation threshold (e.g. rolling
  N-day return correlation, block above some |r|) still need to be pinned down during
  the risk-engine phase — flagged there, not decided yet.
- **Kill switch**: cancels all new and working orders and disables the auto-trading
  loop immediately. It does **not** force-close existing positions — their existing
  hard stop-losses remain in place as the exit mechanism. This is a deliberate,
  narrower blast radius than "flatten everything."
- **Backtest data source: Polygon.io Stocks "Starter" plan (paid, ~$29/mo)**. Polygon
  rebranded to [Massive](https://massive.com) on 2025-10-30 — same accounts/APIs, old
  `polygon.io` endpoints still work, no forced migration. Starter's headline
  restriction is 15-minute-delayed data, which is irrelevant for backtesting (a
  walk-forward harness only ever queries *past* bars — "delayed" doesn't apply to
  history that's already months or years old). Reasonably confirmed: unlimited
  requests/minute on paid plans (no free-tier-style throttling), multi-year historical
  aggregates. Not independently confirmed — verify at signup before relying on it:
  whether the ~10-year depth quoted for Starter applies to **minute**-granularity
  aggregates specifically, versus daily bars (direct fetches of Polygon/Massive's own
  pricing docs were blocked by bot protection during research, so this is based on
  secondary sources, not the primary doc). Action item: this requires the user to
  create a Massive/Polygon account and pay for the plan directly — not something that
  can be done from here; the resulting API key goes server-side only in
  `server/.env`, same as every other provider key.

  Superseded candidates, kept for the record: **FirstRate Data**'s free tier (~1yr of
  1-min bars via bulk CSV download, no account needed) was the original free-tier
  recommendation before the user opted to pay for Polygon/Massive instead — still a
  reasonable fallback if the Polygon minute-bar depth doesn't pan out. **Tiingo** was
  considered and ruled out regardless of price sensitivity: its IEX intraday endpoint
  caps at the most recent ~2000 bars at any frequency (~5 trading days at 1-min),
  *shallower* than Yahoo's already-free 7-day cap already in this repo, so it's a
  downgrade even as a paid option wouldn't fix. **Alpha Vantage** (25 req/day free) and
  **Polygon's own free tier** (daily-bar-oriented) were ruled out for the reasons
  already noted when they were free-tier candidates.

  This is decoupled from the live Research & Screen stage's data source (still
  whatever `MARKET_DATA_PROVIDER` is configured, e.g. Yahoo) — Polygon/Massive is
  scoped to Phase 5's historical corpus only, not a replacement for the app's live
  market-data provider. If live scanning ever needs Polygon/Massive too, note Starter's
  15-min delay would matter there (unlike for backtesting) and a higher tier would be
  needed — that's a separate decision, not part of this one.

## Phased roadmap

Sequenced so that execution-capable (order-placing) code is built **last**, after the
strategy and risk logic have been validated by backtesting — matching the spec's own
gate below. Each phase should be independently mergeable and testable before the next
starts.

1. **Foundations — shipped.** DB schema for risk-profile config (`autotrade_config`),
   the RE exclusion list (`autotrade_exclusions`, seeded from
   `server/data/reExclusions.json`), and the shared journal (`autotrade_events`) every
   later phase logs into (candidate found, excluded, signal generated, risk-check
   pass/block, order placed, fill) — see `db/autotradeConfig.ts`,
   `db/autotradeExclusions.ts`, `db/autotradeEvents.ts`, routed at `/api/autotrade/*`
   (`routes/autotrade.ts`). Switching to AGGRESSIVE requires `confirmAggressive: true`
   in the request — the route's stand-in for the spec's "explicit manual confirmation
   in the UI" until a real confirmation dialog exists. No screening or trading logic
   yet — just the scaffolding everything else writes to. Deliberately backend-only:
   no web UI yet, since nothing (no screener, no loop) consumes these settings until
   Phase 2+ — a settings panel lands once there's something real for it to control,
   likely alongside Phase 2 or the Phase 7 dashboard rather than as inert controls now.
2. **Screening & real-estate exclusion — shipped (backend).** Discovers candidates
   from `universe` plus (when Webull is configured) its pre-market "unusual volume"
   and gainers movers — the only source in this app that finds gappers outside the
   ~124-symbol seeded universe; falls back to universe-only otherwise. Each candidate
   is checked against the exclusion list, then (`services/autotrading/realEstateClassifier.ts`)
   `universe.sector`, then — for the common case of a symbol outside that seed — a
   live Yahoo fundamentals fetch (independent of `MARKET_DATA_PROVIDER`, since Tradier
   returns no sector/industry at all), matching sector/industry against
   `/real estate|reit/i`. A fetch failure classifies as **unknown**, not clear — that
   candidate is skipped for this cycle and re-tried next cycle, never silently waved
   through. Only symbols that clear both checks are scored, reusing the existing
   `indicators/screener.ts` engine unmodified (`services/autotrading/screen.ts`) —
   this stage adds discovery + the exclusion gate on top of it, not a parallel scoring
   engine. Real-estate exclusions and confirmed candidates are journaled
   (`autotrade_events`, stage `screen`); routine non-matches aren't, to avoid flooding
   the journal every cycle. Routed at `POST /api/autotrade/screen`. Read-only — no
   orders. UI still pending: bundling with a small Auto-Trade settings page next.
3. **Strategy / Decision module** — generate buy/sell signals (entry, stop, target)
   from the screened candidates. Still fully read-only/logged-only — no risk engine,
   no orders yet. This isolates "does the signal logic make sense" from "is it sized
   and risk-checked correctly."
4. **Risk engine** — `riskProfile` config (Moderate default / Aggressive, with the
   required explicit UI confirmation to switch), per-trade sizing, daily-drawdown
   halt, step-down sizing after consecutive losses, concurrent-position cap, the
   pre-trade **max aggregate open risk** check, the statistical-correlation exposure
   cap (window/threshold decided here), and the daily trade cap. Pure computation over
   inputs from phases 2-3 plus current open positions — no market or broker
   connection needed, so this is the most heavily unit-tested phase given it's the
   safety-critical core.
5. **Backtesting & walk-forward harness — the validation gate.** Ingest FirstRate
   Data's historical bars and run phases 2-4 against them; produce an out-of-sample
   walk-forward report (a strategy that only works on its tuning window must fail
   this). Nothing downstream of this phase is allowed to place even a paper order
   until it produces a credible result on a given strategy configuration.
6. **Paper execution loop** — wire Research → Decision → Risk Check → Execution →
   Journal into a recurring scheduled loop (reusing the alerts-poller's in-process
   interval pattern), placing **paper** orders only through the existing Webull order
   pipeline. Idempotent placement, explicit partial-fill/rejection/rate-limit
   handling, no entries in the first/last N minutes of the session, volatility filter.
7. **Monitoring dashboard & kill switch** — real-time panel (active risk profile, open
   positions, aggregate open risk used vs. limit, day P&L, drawdown vs. halt, trade
   count vs. max, consecutive loss streak) and the kill switch behavior resolved above.
8. **Live-trading gate** — the manual flag flip that lets the loop place real orders,
   after reviewing phase 5's backtest/walk-forward results and a period of phase 6
   paper-trading track record. Deliberately the last and smallest phase: it mostly
   unlocks what phases 1-7 already built, rather than adding new logic.

---

## Original spec

I want to add automated trading capability to my stock/options trading app
(React/Vite/TypeScript, currently uses Finnhub WebSocket for market data).

### STRATEGY OBJECTIVE
Build a strategy focused on capturing volatility and high-probability volume
breakouts (e.g. pre-market gappers, high-momentum tickers on unusual volume).
Do not target a specific daily return number in the strategy logic — the
return should be a measured output of a sound edge, not an input the
system optimizes toward. I'll evaluate performance against my own targets
separately, after backtesting.

### RISK PROFILES (configurable, not hardcoded — I need to switch between these)
Implement a `riskProfile` setting with two presets:

**MODERATE:**
- Risk per trade: 1% of account equity
- Max daily drawdown (halt trading): 3%
- Step-down sizing trigger: after 2 consecutive losing trades (cut size 50%)
- Max concurrent open positions: 2
- Max aggregate open risk (see below): 2%
- Max exposure to correlated tickers (capital, not risk): 6% of capital
- Max trades per day: 6

**AGGRESSIVE:**
- Risk per trade: 1.5% of account equity
- Max daily drawdown (halt trading): 5%
- Step-down sizing trigger: after 2 consecutive losing trades (cut size 50%)
- Max concurrent open positions: 3
- Max aggregate open risk (see below): 4.5%
- Max exposure to correlated tickers (capital, not risk): 10% of capital
- Max trades per day: 10

Default to MODERATE. Switching to AGGRESSIVE requires an explicit manual
confirmation in the UI (not just a config file edit), since it's the
higher-risk profile.

### CRITICAL: MAX AGGREGATE OPEN RISK
This is distinct from the daily drawdown halt. The daily halt only reacts to
REALIZED losses after trades close. Max aggregate open risk is a PRE-TRADE
check: before opening any new position, sum (position size × stop-loss
distance) across ALL currently open positions, including the proposed new
one. If that sum would exceed the active profile's max aggregate open risk,
block the trade — even if per-trade risk and concurrent position count are
individually within limits. This prevents a scenario where multiple
positions get stopped out simultaneously (gap risk, correlated breakout
failure) and the realized loss exceeds the daily halt before the halt can
even trigger.

### EXCLUDED SECTOR: REAL ESTATE
No real estate ETFs or equities may ever be screened, signaled on, or traded.
This is a hard exclusion enforced at the screening stage (so real estate
names never even reach the decision/risk-check stages) — not just a filter
applied later. Maintain an exclusion list covering:
- Real estate ETFs (e.g. VNQ, IYR, XLRE, SCHH, and similar REIT-focused funds)
- Individual REITs and real estate operating companies
- The list should be configurable so I can add/remove tickers, and should
  be checked against a ticker's sector/industry classification (not just a
  hardcoded symbol list) so new or less obvious real estate names aren't
  missed

Log any candidate that gets excluded for this reason in the journal, same
as a risk-check block.

### EXECUTION LOOP
Implement a recurring cycle with these stages, each clearly separated:
1. **Research & Screen** — scan for pre-market gappers / momentum / volume
   breakout candidates against defined criteria, excluding real estate
   ETFs/equities per the exclusion list above
2. **Decision** — generate buy/sell signals from the strategy module
3. **Risk Check** — validate the proposed trade against the active risk
   profile's guardrails (including max aggregate open risk) BEFORE it's
   allowed to proceed to execution
4. **Execution** — place the order via the broker interface
5. **Journaling** — log every action (signal, size, risk profile active, risk
   check result, order response, fill, running P&L) to a persistent file,
   including trades that were blocked by a risk check and why

### RISK MANAGEMENT (mandatory, enforced at the order layer, not the strategy layer)
- Hard stop-loss on every position, required at order placement (no
  stop = no trade)
- Per-trade risk, daily drawdown halt, step-down sizing, concurrent
  position cap, max aggregate open risk, correlation cap, and daily trade
  cap all pulled from the active risk profile above
- No new entries in the first/last N minutes of the trading session
- Volatility filter — skip new entries if broad-market or ticker-level
  volatility is outside a defined range

### EXECUTION SAFETY
- Idempotent order placement (safe to retry without double-filling)
- Explicit handling for partial fills, rejected orders, and broker API
  errors/rate limits
- Abstract the broker behind an interface; paper trading is the default,
  live trading requires an explicit flag

### VALIDATION GATE
- Backtesting harness required before any strategy can run live
- Walk-forward test on out-of-sample data — a strategy that only performs
  on the period it was tuned on should fail this gate
- New strategies start in paper mode; going live requires me to manually
  flip a flag after reviewing backtest + walk-forward results

### MONITORING & KILL SWITCH
- Real-time dashboard panel: active risk profile, open positions, max
  aggregate open risk used vs limit, day P&L, drawdown vs halt, trade
  count vs max, consecutive loss streak
- Single kill switch (button/endpoint) that flattens all positions and
  disables auto-trading immediately

Confirm the exact broker API I'll be integrating with (Alpaca, IBKR, etc.)
before wiring anything to a live connection.
