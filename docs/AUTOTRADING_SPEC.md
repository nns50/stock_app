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
- **Backtest data source**: [FirstRate Data](https://firstratedata.com)'s free tier —
  a one-time bulk CSV download of ~1 year of 1-minute bars for popular/liquid symbols,
  not a rate-limited API — as the historical corpus for the backtest + walk-forward
  harness. Alternatives ruled out: Alpha Vantage's free tier has real depth (~2 years)
  but only 25 requests/day, which can't realistically pull multi-ticker 1-minute
  history; Polygon.io's free tier is oriented around daily bars; Yahoo (already
  integrated) is hard-capped at 7 days of 1-min / 59 days of 5-15min history, fine for
  live scanning but not a walk-forward split. Backtest data and live-scan data are
  intentionally decoupled — Yahoo's shallow depth is a non-issue for live screening,
  which only needs a recent window, not years of history. Caveat: FirstRate's exact
  current ticker coverage and file format under the free tier should be manually
  verified (in a browser) before the backtesting phase starts — an automated fetch of
  their download page was blocked by bot protection during research.

  **Tiingo — considered and ruled out for this role.** Its IEX intraday endpoint
  returns only the most recent ~2000 bars at whatever frequency is requested — at
  1-minute bars that's roughly 5 trading days, at 5-minute bars roughly 26 days. That's
  *shallower* than Yahoo's already-free, already-integrated 7-day (1-min) / 59-day
  (5-15min) caps, so it would be a downgrade, not an upgrade, for the walk-forward
  corpus. Tiingo's daily (EOD) history is genuinely deep (30+ years) but too coarse for
  an intraday breakout strategy. Its fundamentals endpoint does return `sector`/
  `industry` fields (relevant to the RE-exclusion classification need), but that
  endpoint is a paid add-on — free access is limited to the Dow 30 with 3 years of
  history, too narrow to cover the small/mid-cap gappers the exclusion check most needs
  to catch. Worth revisiting if a small paid add-on is ever on the table, but not a fit
  for the free-tier backtest corpus.

## Phased roadmap

Sequenced so that execution-capable (order-placing) code is built **last**, after the
strategy and risk logic have been validated by backtesting — matching the spec's own
gate below. Each phase should be independently mergeable and testable before the next
starts.

1. **Foundations** — DB schema for risk-profile config, the RE exclusion list, and a
   shared journal-writing table/service that every later phase logs into (candidate
   found, excluded, signal generated, risk-check pass/block, order placed, fill). No
   screening or trading logic yet — just the scaffolding everything else writes to.
2. **Screening & real-estate exclusion** (Research & Screen stage) — scan for
   pre-market gappers / momentum / unusual-volume candidates; apply the RE exclusion
   list + sector/industry check before anything else sees a candidate. Read-only:
   surface results somewhere visible (e.g. a candidates list in the UI), place no
   orders. Excluded candidates get logged same as a risk-check block.
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
