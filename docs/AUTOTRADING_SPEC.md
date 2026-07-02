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
- **Backtest data source: Polygon.io Stocks "Starter" plan, $29/mo — confirmed and
  final.** Polygon rebranded to [Massive](https://massive.com) on 2025-10-30 — same
  account/API, old `polygon.io` endpoints still work, no forced migration. Confirmed
  directly from Massive's current pricing page (not secondary sources): all US stock
  tickers, **unlimited API calls**, **5 years of historical data**, **100% market
  coverage**, minute aggregates, Flat Files (bulk download — no pagination needed to
  ingest years of history), reference data, and corporate actions. The 15-minute-delay
  restriction is irrelevant for backtesting (a walk-forward harness only ever queries
  *past* bars). The $79/mo Developer tier (10yr + trade-level tick data) isn't worth it
  for this app — the strategy only needs aggregated bars, and 5 years is comfortably
  enough depth for a real walk-forward split (e.g. train on 3 years, test out-of-sample
  on the remaining 2).

  **Alpaca's free tier was seriously considered as an alternative** (free; 200
  req/min; SIP — full market — historical data once a query is >15min old; supports
  split/dividend-adjusted bars; no KYC for a paper/data-only account) and stays worth
  knowing about, but Polygon/Massive was kept: Alpaca's ~7-year depth claim is
  community-sourced, not vendor-confirmed like Polygon's numbers above, there have been
  community reports of its split-adjustment parameter misbehaving on some tickers, and
  it has no bulk-download equivalent to Flat Files — ingesting years of 1-minute bars
  would mean writing pagination/backoff logic instead of just downloading files. Given
  the user was already willing to pay for reliability/support, and Polygon's numbers
  are now confirmed rather than partially-verified, sticking with the paid plan won
  out.

  **Action items — done by the user, not from here:** Massive/Polygon account created
  and paid for directly; the resulting `POLYGON_API_KEY` goes server-side only
  (`server/.env` locally, `fly secrets set POLYGON_API_KEY=...` in production — see
  `docs/DEPLOY.md`). Deliberately a separate config namespace from
  `MARKET_DATA_PROVIDER` (`config.polygon.apiKey`, not one of the `mock`/`tradier`/
  `yahoo`/`webull` live-provider choices) — this key only ever feeds the backtest
  corpus, never live screening or quotes.

  Superseded candidates, kept for the record: **FirstRate Data**'s free tier (~1yr of
  1-min bars via bulk CSV download, no account needed) was the original free-tier
  recommendation before the user opted to pay for Polygon/Massive instead. **Tiingo**
  was ruled out regardless of price sensitivity: its IEX intraday endpoint caps at the
  most recent ~2000 bars at any frequency (~5 trading days at 1-min), *shallower* than
  Yahoo's already-free 7-day cap already in this repo. **Alpha Vantage** (25 req/day
  free) and **Polygon's own free tier** (daily-bar-oriented) were ruled out for the
  reasons already noted when they were free-tier candidates.

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
   in the request, enforced by a `useConfirm()` modal in the UI (below) — not just a
   config edit. No screening or trading logic yet — just the scaffolding everything
   else writes to.
2. **Screening & real-estate exclusion — shipped.** Discovers candidates from
   `universe` plus (when Webull is configured) its pre-market "unusual volume" and
   gainers movers — the only source in this app that finds gappers outside the
   ~124-symbol seeded universe; falls back to universe-only otherwise. Each candidate
   is checked against the exclusion list, then (`services/autotrading/realEstateClassifier.ts`)
   `universe.sector`, then — for the common case of a symbol outside that seed — a
   live Yahoo fundamentals fetch (independent of `MARKET_DATA_PROVIDER`, since Tradier
   returns no sector/industry at all), matching sector/industry against
   `/real estate|reit/i`. Verified live against the seeded universe: AMT, PLD, and EQIX
   (REITs not on the static ETF list) are correctly caught by the sector check alone. A
   fetch failure classifies as **unknown**, not clear — that candidate is skipped for
   this cycle and re-tried next cycle, never silently waved through. Only symbols that
   clear both checks are scored, reusing the existing `indicators/screener.ts` engine
   unmodified (`services/autotrading/screen.ts`) — this stage adds discovery + the
   exclusion gate on top of it, not a parallel scoring engine. Real-estate exclusions
   and confirmed candidates are journaled (`autotrade_events`, stage `screen`); routine
   non-matches aren't, to avoid flooding the journal every cycle. Routed at
   `POST /api/autotrade/screen`. Read-only — no orders. UI: `web/src/pages/AutoTradePage.tsx`
   (`/auto-trade`) covers config, the exclusion list, a "Run screen" button with
   candidates/excluded/skipped/errors, and the recent-activity journal — the AGGRESSIVE
   switch is gated by a `useConfirm()` modal, not just a raw `<select>`.
3. **Strategy / Decision module — shipped.** Turns each screened candidate into a
   concrete trade plan (`services/autotrading/decide.ts`): entry = current price, a
   **hard stop** at `stopAtrMultiple`× the symbol's own ATR (default 1.5×, so the stop
   adapts to each symbol's actual volatility rather than a fixed dollar/percent), and a
   target at a fixed reward:risk multiple of that stop distance (default 2R). The
   reward:risk multiple is a fixed, generic ratio, not tuned to any target return — per
   the spec, what the strategy actually returns is for backtesting (a later phase) to
   measure, not an input to this logic. A candidate with no usable ATR (insufficient
   history) gets no signal, logged and skipped rather than guessed at. Pure function,
   no I/O — `generateSignal()`/`runAutotradeDecision()` take already-screened
   candidates and only journal (stage `decision`, `signal_generated` / `no_signal`).
   Still fully read-only — no risk engine, no orders yet; this isolates "does the
   signal logic make sense" from "is it sized and risk-checked correctly." Routed at
   `POST /api/autotrade/decide` (runs screen + decision together); the Auto-Trade page's
   candidates table now shows Entry/Stop/Target/R per candidate.
4. **Risk engine — shipped.** `services/autotrading/riskCheck.ts` sizes each signal by
   the active profile's `riskPerTradePct` (reusing `services/riskSizing.ts`'s
   `computeRiskSizing()` unchanged — same math the manual "Size by risk" tool uses),
   applying step-down (50% cut) once the losing streak reaches `stepDownAfterLosses`,
   then gates it through every profile cap: `equity_configured` (fails closed — blocks
   everything — until equity is set), `quantity`, `daily_drawdown_halt`,
   `max_trades_per_day`, `max_concurrent_positions`, the CRITICAL
   `max_aggregate_open_risk`, and `max_correlated_exposure`. Correlation window/
   threshold (the spec's deferred decision): **30 trading days, |r| ≥ 0.7** — a
   standard "strong correlation" convention, applied to daily-return Pearson
   correlation (`indicators.ts`'s new `pearsonCorrelation`/`dailyReturns`) between each
   open position and the candidate. The correlated-exposure check does **not** count
   the candidate's own notional — a symbol is trivially "correlated" with itself, so
   including it would block even a lone, uncorrelated first trade purely against
   itself (caught by hand-checking the numbers before writing tests, not by a test
   failure — worth having caught before it shipped).
   Signals are risk-checked **sequentially as a batch**, not independently against a
   static snapshot — an approved signal's risk/notional/position-count is added to a
   running total before the next signal in the batch is checked, so a batch of
   individually-fine signals can't jointly bust a cap none of them would trip alone
   (verified live: with 5 candidates and MODERATE's 2-position cap, the top-2-scored
   candidates were approved and every candidate after that was correctly blocked on
   `max_concurrent_positions` once the running count hit the cap).
   **Known interim scope, to revisit in Phase 6:** concurrent-position count and
   aggregate open risk are account-wide regardless of source (mirrors how the
   live-trading guardrails already treat "the account" as one unified thing — the
   safer reading, since it can't understate real exposure). Daily P&L, the
   consecutive-loss streak, and account equity are **not** yet auto-trading-specific —
   there's no "Phase 6 executed this" position marker to filter on yet, since nothing
   has executed an auto-trade. Equity is a manually-set number
   (`autotrade_config.accountEquityUsd`), not live broker data — Webull's account-state
   call needs an `accountId` with no natural source for an unattended loop yet; revisit
   once Phase 6 has one. Pure evaluator (`evaluateRiskCheck`) is heavily unit-tested,
   per the spec's call for the heaviest coverage on this phase; the orchestration
   wrapper (`runAutotradeRiskCheck`) assembles real portfolio state and is exercised
   against the real `positions` journal in tests, plus verified live in a browser.
   Routed at `POST /api/autotrade/risk-check`; the Auto-Trade page's candidates table
   shows a Qty + pass/fail Risk-check column per candidate.
5. **Backtesting & walk-forward harness — the validation gate — shipped.** Ingests
   Polygon/Massive daily bars into a local cache (`backtest_bars`, keyed by
   symbol/timeframe/time) and tracks which `[from, to]` ranges have already been
   fetched in a separate `backtest_fetch_log` ledger — the cached data's own min/max
   bar time can't answer "is this range covered," since weekend/holiday gaps mean a
   requested calendar boundary is rarely an actual trading day (`db/backtestBars.ts`,
   `services/autotrading/polygonClient.ts`, `services/autotrading/historicalData.ts`).
   Decoupled from live scanning, per the resolved decision above —
   `config.polygon.apiKey` only ever feeds this corpus.

   The simulation core (`services/autotrading/backtest.ts`'s `simulateBacktest()`) is a
   pure, I/O-free function that replays Screen → Decision → Risk Check day by day over
   pre-loaded candle arrays, reusing the exact same functions phases 2-4 already
   shipped (`scoreSymbol`, `generateSignal`, `evaluateRiskCheck`) so the backtest can't
   silently drift from what the live loop actually does. A daily-bar backtest can only
   approximate an intraday loop, so the approximations are explicit and documented in
   code: a signal is generated from data through day N's close; if approved, it fills at
   day (N+1)'s open — never the signal day's own price; each day after entry, a stop/
   target hit is checked against that day's high/low, and if a single day's range could
   have hit both, the **stop** is assumed to win the tie (the conservative read, since a
   daily bar can't reveal the actual intraday order of events); anything still open at
   the end of the window force-closes at the last available close
   (`exitReason: 'end_of_period'`). Correlated-exposure sizing reuses the same
   Pearson-correlation math as the live risk engine, computed entirely from
   already-loaded history (no network calls inside the simulation loop). The real-estate
   exclusion runs once upfront, before any history is fetched, exactly as it does at
   live Screen time.

   `runWalkForwardBacktest()` is the validation gate itself: it fetches each symbol's
   history **once**, then replays it independently over an in-sample `[from, splitDate]`
   window and an out-of-sample `(splitDate, to]` window — both starting from the same
   configured equity (not the out-of-sample window compounding on the in-sample
   result), so their stats are directly comparable rather than confounded by a
   different effective account size. `computeBacktestStats()` summarizes either window
   (win rate, avg win/loss, expectancy, profit factor, R-multiple edge, max drawdown,
   win/loss streaks), reusing `computeStreaksAndDrawdown()` from `services/pnl.ts` — the
   same function the live Journal's own stats use — rather than a second drawdown
   implementation. The harness itself renders no pass/fail verdict: per the spec below
   ("going live requires me to manually flip a flag after reviewing backtest +
   walk-forward results"), it's the person reviewing in-sample vs. out-of-sample who
   judges whether a strategy configuration held up, not an automated gate.

   Routed at `POST /api/autotrade/backtest` (a single window) and
   `POST /api/autotrade/backtest/walk-forward` (the in-sample/out-of-sample split,
   `splitDate` required and validated to fall strictly between `from` and `to`). The
   Auto-Trade page's "Backtest & walk-forward" card takes a symbol list, date range, an
   optional split date, a risk profile independent of the live Configuration card's
   profile, and starting equity; it renders a stat grid, an equity-curve chart, and a
   trade-by-trade table per window. Nothing downstream of this phase — paper or live
   execution — is wired up yet; this phase only produces the report a human reviews
   before either of those is allowed to run.
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
