# Automated Trading — Specification

**Status: all phases (1-13) shipped and running.** Equities screening, decision, risk
engine, backtesting, paper execution, monitoring/kill-switch, and the live-trading gate
(phases 1-8) are built and have each cleared adversarial review. An options-trading
addition (phases 9-13 — screening & decision, risk engine & combined budget, backtesting,
paper execution & expiration management, and monitoring) has since been scoped, approved,
and shipped on top of the same codebase. This is the reference spec for adding a fully
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

### Fit with the current codebase: options trading addition

The options scope below (see "Original spec" — appended) arrived after phases 1-7 were
already shipped and running in paper mode for equities. A lot of what it asks for
already exists, built for the human-facing Options page, and is currently disconnected
from the autonomous loop:

- **Liquidity/DTE/IV-rank filtering already exists.** `server/src/options/entryRules.ts`'s
  `EntryStrategyConfig`/`scanEntries()` already has `minOpenInterest`, `minVolume`,
  `maxSpreadPct`, `minDaysToExpiration`/`maxDaysToExpiration`, and `ivRankMin`/`ivRankMax`
  — with defaults (`minOpenInterest: 100, minVolume: 10, maxSpreadPct: 10,
  minDaysToExpiration: 7, maxDaysToExpiration: 60`) that already satisfy "exclude 0DTE
  and same-week expirations" (7 days reliably excludes both regardless of which weekday
  "today" is). The autonomous decision stage should call this directly, not reimplement it.
- **Expiration/time-based exit logic already exists.** `server/src/options/exitRules.ts`'s
  `evaluateExit()`/`defaultExitConfig()` already has `timeExitDaysBeforeExpiry` (default
  7). Today it only *recommends* a close for a human (`services/positionExits.ts` turns it
  into an alert) — it never places an order. The autonomous loop needs to *act* on this
  trigger automatically (close the paper position outright), not just surface it.
- **Defined-risk sizing already exists, split across two functions.**
  `services/riskSizing.ts`'s `computeSpreadSizing()` already sizes a debit spread by max
  loss (net premium × contracts) — exactly "risk per trade = premium paid." It has zero
  references anywhere under `services/autotrading/` today. A single long call/put doesn't
  need a new function at all: `computeRiskSizing()` (already used for equities) sizes by
  `|entryPrice − stopPrice| × multiplier`; passing `stopPrice: 0` (the option expires
  worthless — its actual worst case) makes that identical to "size by full premium paid."
- **A structural, code-level defined-risk check already exists.**
  `server/src/options/optionStrategy.ts`'s `analyzeStrategy()` computes `maxLoss` and
  `unboundedLoss` for any leg combination. Before ever approving an options candidate, the
  risk-check stage should run it and hard-block anything where `unboundedLoss` is true or
  `maxLoss` isn't finite — a backstop against the decision logic ever constructing an
  undefined-risk structure, not just a promise that it won't.
- **IV rank has a bootstrapping gap for symbols the autonomous loop screens.**
  `services/ivRank.ts`'s `computeIvContext()` needs ≥15 days of accumulated ATM-IV history
  (`db/ivHistory.ts`) to return a real `'history'`-method rank; that history is currently
  only recorded when a *human* views a chain (`routes/options.ts`). A symbol the loop
  screens but no human has ever looked at starts with `method: 'insufficient'` (or a
  cruder `'hv-estimate'` proxy). The loop needs to record its own IV samples going forward
  (same `recordAtmIv()` call the human page already makes) and — matching this codebase's
  established convention for "the check couldn't run" (real-estate `'unknown'`, a failed
  quote fetch) — **fail closed**: skip a candidate rather than guess, when IV context
  isn't a real historical rank yet.
- **No existing "combined risk budget" plumbing.** `TradeSignal` (`decide.ts`),
  `OpenRiskItem`, and `PaperPosition` are all 100%-stock-shaped — none can represent an
  option's max-loss today. Combining the aggregate-open-risk budget isn't just an
  accumulator change (the running-total `+=` pattern in `riskCheck.ts` and `execute.ts`
  is already asset-type-blind and would sum anything handed to it) — it requires an
  options-position shape that produces a comparable "$ at risk" figure in the first place.
- **No options-chain support in the Polygon backtest client at all.**
  `services/autotrading/polygonClient.ts` only fetches stock daily-bar aggregates; there is
  no strike/expiration/IV/Greeks data path anywhere in `services/autotrading/`. See the
  new "Resolved decisions" entry below — this blocks Phase 11 until a data source is
  chosen.

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

  **Considered and deferred (Phase 7, after live rate-limiting from Yahoo — see below):**
  whether to move the live Screen/scoring stage off Yahoo onto Polygon/Massive too.
  Confirmed Polygon's Starter tier (already paid for) keeps its 15-minute delay for live
  data — a dealbreaker for a strategy built around real-time pre-market gaps and volume
  breakouts — so this would require an upgrade: **Developer (~$79/mo)** for a real-time
  IEX-only feed (not the full consolidated tape) plus ticker fundamentals (sector via SIC
  code, which could also retire the Yahoo dependency in
  `services/autotrading/realEstateClassifier.ts`), or **Advanced (~$199/mo)** for the
  full real-time SIP feed across all exchanges. **Decision: stay on Yahoo for now** — the
  sector-classification caching fix (below) already removes the dominant source of
  observed rate-limiting; revisit only if scoring-stage rate-limiting keeps recurring in
  practice. If revisited, scope it narrowly to the auto-trading loop's own live
  quotes/candles (mirroring how the backtest corpus is already its own separate
  `config.polygon` namespace, decoupled from `MARKET_DATA_PROVIDER`) rather than
  replacing the app's global provider — `MARKET_DATA_PROVIDER` is read by every other
  page (Options, Screener, Positions), and the existing Polygon client
  (`polygonClient.ts`) has no options-chain support at all, so a global swap would be a
  much bigger build than this specific problem calls for.

- **What "paper" execution actually means (Phase 6)**: confirmed via
  `docs/LIVE_TRADING_DESIGN.md` §13 — the Webull OpenAPI plan this app is integrated
  against has **no paper/sandbox account** ("None — go straight to the real account").
  So Phase 6's paper mode is a **fully local simulation**: it never calls
  `webullPlaceOrder()` or anything in the live order pipeline
  (`services/trading/placeOrder.ts`) — it records a synthetic fill (from a live quote)
  into a new, separate `autotrade_paper_positions` table and journals it, exactly
  mirroring the real `positions`/`position_exits` shape but kept fully apart from it.
  This is deliberate, not a shortcut: it means Phase 6 is **structurally incapable** of
  placing a real order, regardless of any bug in its risk/decision logic, since the
  code path that could do that is never invoked. It also sidesteps the live pipeline's
  `placeOrder()` requiring an exact human-typed confirmation phrase
  (`placeConfirmation(intent)`, `services/trading/placeOrder.ts`) and a manually-chosen
  `accountId` sourced from browser `localStorage` today — neither has any meaning for
  an unattended loop, and forging a bypass for either would be exactly the kind of
  "quietly weaken a safety check" move this repo's operating principles rule out.
  Paper positions never touch `positions`/`orders` (the human's real trading journal)
  — mixing autonomous synthetic trades into the user's real P&L/win-rate stats would
  corrupt the one thing that journal exists to be honest about. A real Webull
  `accountId`/confirm-phrase path is Phase 8's problem, once a human is reviewing
  Phase 5/6 results before flipping the live flag — not before.
- **Phase 8's confirmation model: one-time only, no per-order gate — and NOT a reuse of
  `placeOrder()`'s existing type-to-confirm phrase.** `docs/LIVE_TRADING_DESIGN.md`
  states as a non-negotiable principle that a human confirms *every* order, and lists
  "no algorithmic/automated/scheduled trading" as an explicit non-goal — this doc's
  Phase 8 is a deliberate, scoped exception to that, not an oversight (already flagged at
  the top of this file). Checked `placeOrder.ts` directly: `placeConfirmation(intent)` is
  `` `${side} ${quantity} ${symbol}` `` — a pure function of the order, echoed back by
  the caller. It's a UX rail against a human misclicking on the Trade page, not a secret
  only a human can produce — so the autonomous loop *could* trivially compute and pass
  it itself, but doing so would be hollow (confirming its own order proves nothing) and
  is exactly the kind of "technically passes, quietly defeats the purpose" move this
  repo's operating principles rule out. **Decision, confirmed with the user: no per-order
  confirmation of any kind, and no daily re-arm either** — "the application [should] be
  able to trade for itself without my confirmation," with review effort spent on
  guardrail configuration instead. Phase 8 therefore does **not** call `placeOrder()` —
  it gets its own entry point that shares the safe, non-human-specific lower layers
  (guardrail evaluation, the Webull order call, the order lifecycle/audit trail) but has
  no `confirmation` parameter to fake.
- **Phase 8 track record gate: no code-enforced minimum, confirmed with the user.** The
  UI will still surface the paper track record (trade count, date range, win rate) next
  to the live-enable control so it's visible at decision time, but the server will not
  block flipping `liveTradingEnabled` on any specific day/trade-count threshold — purely
  the user's judgment call, matching how AGGRESSIVE-vs-MODERATE is already just a
  confirmed choice with no enforced graduation criteria either.
- **Phase 8 live-order caps: separate from the human Trade page's, confirmed with the
  user.** `trading_config`'s caps (`maxOrderUsd`, `maxExposureUsd`, `maxDailyLossUsd`,
  etc.) were tuned for a human confirming a specific $ ticket; autotrade sizes
  risk-based (% of equity × stop distance via `computeRiskSizing()`), which can imply a
  different notional than those flat numbers were tuned around. A new, autotrade-only
  cap set (proposed field names: `liveMaxOrderUsd`, `liveMaxDailyLossUsd`,
  `liveMaxOrdersPerDay`, `liveFatFingerPct`, `liveAllowNakedShort`) reuses the exact same
  pure `evaluateGuardrails()` function with these numbers instead — same well-tested
  logic, independently tunable ceiling. `liveAllowNakedShort` defaults `false`, matching
  `guardrails.ts`'s own default and this project's established defined-risk-by-default
  posture (mirrors the options addition's undefined-risk exclusion). Defaults will be
  derived from the configured `accountEquityUsd` and active risk profile rather than
  fixed dollar figures copied from the human page, so they scale sensibly with account
  size instead of being an arbitrary number disconnected from it — exact formula to be
  finalized in Phase 8 Step A, editable afterward in the UI either way (the user's own
  framing: "I just need to be able to configure and setup the guardrails").
- **Phase 8 probation period: yes, confirmed with the user.** For the first
  `liveProbationTrades` live trades after `liveTradingEnabled` first turns true (default
  proposed: 20), position sizing gets an additional cut (`liveProbationSizeMultiplier`,
  default proposed: 0.5×) on top of whatever the risk profile and any loss-streak
  step-down already produce — mirrors `riskCheck.ts`'s existing step-down mechanism
  exactly (an additional multiplier on `effectiveRiskPct`, composing with step-down
  rather than replacing it) rather than inventing a parallel sizing path. The probation
  counter resets if `liveTradingEnabled` is turned off and back on — re-enabling live
  trading after a pause is itself the risky transition being guarded against, not just
  the very first time.
- **Phase 8 additional safety layer, not explicitly asked for but added by inference —
  flagged here for visibility, not buried silently:** autotrade's live orders are also
  blocked if the human's own `trading_config.killSwitch` is engaged or
  `trading_config.enabled` is off, in addition to autotrade's own `killSwitch`/
  `liveTradingEnabled`. Same broker, same account — if the human ever hits "Halt
  trading" on the manual Trade page, that should stop the autonomous loop's live orders
  too, not just new manual ones. Zero added friction for normal operation (it only
  matters if the human has manually halted trading), so this was added as a sensible
  default rather than posed as an open question — reversible if the user disagrees.
  **Exits are the one exception, on both sides**: closing an already-open live position
  to honor its own already-approved stop/target is risk-*reducing*, so it proceeds even
  if either kill switch is engaged — exactly mirroring Phase 7's resolved decision for
  paper positions ("does not force-close existing positions — their existing hard
  stop-losses remain in place as the exit mechanism") and the human pipeline's own
  cancel-order exemption from `TRADING_ENABLED`.
- **Options IV-extreme filter: `ivRankMax: 70`, confirmed with the user.** The
  existing `EntryStrategyConfig` (`entryRules.ts`) already has an `ivRankMin`/`ivRankMax`
  field — `defaultEntryConfig()` just doesn't set one, since the human-facing Options page
  uses the same config for both buying and selling strategies, where "high IV" cuts the
  opposite way. This system only buys premium (long calls/puts, debit spreads), so
  "extreme" only needs to guard one direction: overpaying for premium that's likely to get
  crushed. Proposing **70** as the autotrade-specific default — a deliberate step above the
  existing frontend convention's own "richly priced" line (`ivRank >= 50`, `OptionsPage.tsx`)
  so a candidate in the 50-70 range (rich but not extreme) can still trade, and only the
  genuine tail gets blocked. Fails closed, matching this codebase's established convention
  (real-estate `'unknown'`, the IV-rank bootstrap gap noted above): a candidate whose IV
  rank can't be computed yet (`method: 'insufficient'`) is skipped, not assumed fine — same
  as a candidate whose IV rank computes above the threshold. The earnings example in the
  original ask doesn't need a separate earnings-calendar lookup — an approaching earnings
  date is exactly the kind of thing that already shows up as an elevated IV rank, which is
  what this filter is actually checking. **Confirmed with the user** (2026-07-03) — the
  recommended 70 was accepted as-is.
- **Options assignment/expiration handling: close-only, no roll — confirmed with the
  user (2026-07-03).** The original ask offered close-or-roll. Rolling means the loop has to
  pick a *new* contract (strike + expiration), which is a second entry decision — it would
  need to pass through the same liquidity/DTE/IV-rank filters as a fresh entry, roughly
  doubling this feature's decision surface for what's fundamentally a risk-avoidance step,
  not a strategy one. Close-only for the first version, consistent with how
  this project already treats scope expansions elsewhere — AGGRESSIVE vs. MODERATE, and
  undefined-risk strategies, both require an explicit, separate opt-in rather than shipping
  bundled by default. Rolling could be added later the same way, if wanted.
- **Options backtest data source: Options Starter, $29/mo — confirmed and final,**
  **including the exact endpoint-level shape of the data (not just the marketing pricing
  page).** The earlier attempt to verify this from Polygon's/Massive's own pricing pages
  was blocked by HTTP 403s on both `polygon.io/options` and `massive.com/pricing`; the
  user then checked the Massive options pricing page directly (screenshot reviewed
  2026-07-02) for tier/pricing, and separately pulled the actual Options API endpoint
  reference (reviewed 2026-07-02) — which corrects an assumption the pricing page alone
  couldn't settle (see below). Options data is a separate product line from the stocks
  plans already confirmed above, four tiers: **Options Basic** ($0/mo — 5 calls/min, 2yr
  history, end-of-day only, no Greeks/IV/open interest, no Flat Files), **Options
  Starter** ($29/mo — unlimited calls, 2yr history, 15-min delayed, Greeks/IV/open
  interest included, minute aggregates, Flat Files, no historical quotes or trades),
  **Options Developer** ($79/mo — same as Starter plus 4yr history and historical trade
  prints, still no historical quotes), **Options Advanced** ($199/mo — 5+ years history,
  real-time data, and the only tier with historical bid-ask quotes).

  **Correction to the earlier reading of the pricing page: Greeks/IV/open interest are
  snapshot-only at every tier, including Advanced — there is no historical Greeks/IV/OI
  time-series endpoint at any price.** The endpoint reference lists exactly two places
  Greeks/IV/OI appear — "Option Contract Snapshot" (`/v3/snapshot/options/{underlying}/
  {contract}`) and "Option Chain Snapshot" (`/v3/snapshot/options/{underlying}`) — both
  explicitly described as a snapshot of *current* state ("the latest quote and trade
  information," "the underlying asset's current price"), with no date/range parameter,
  unlike every genuinely historical endpoint (Aggregate Bars, Quotes, Trades all take a
  `{from}/{to}` range). The "Greeks, IV, & Open Interest ✓" checkmark on the pricing page
  means the current-state snapshot includes those fields — not that they're stored
  historically at that tier's depth, as the earlier reading of that page assumed. This
  also resolves the original conflicting-secondary-source tension for good: the source
  claiming "historical IV back to 2021" was describing the historical *price* aggregates
  (genuinely deep), and the source claiming the Snapshot API doesn't support historical
  IV was correct and describing the *same* snapshot-only limitation confirmed here.

  **Consequence for Phase 11: IV/Greeks must be computed, not ingested.** The backtest
  will derive historical IV and Greeks itself from historical option price bars
  (`options_ticker`'s Aggregate Bars, genuinely historical at every tier) plus the
  underlying's own historical price (already available via the existing stocks plan) —
  reusing this app's existing `options/blackScholes.ts` (`bsGreeks`/`impliedVol`, already
  the live-Greeks fallback for Yahoo on the human Options page) rather than a packaged
  feed that doesn't exist at any tier. This isn't a compromise specific to the cheap
  tier — Advanced's $199/mo doesn't buy a historical Greeks/IV feed either, so this is
  simply how the backtest has to work regardless of tier chosen.

  **A second, separate gap this same finding surfaces: open interest can't be
  backtested at all, at any tier.** Same root cause — OI only ever appears in the two
  snapshot endpoints above, both current-state-only, and unlike price there's no
  Black-Scholes-style way to derive a historical OI number from other historical data
  (it isn't computable from price/volume). Proposed handling, mirroring how this
  codebase already treats a check that can't run (real-estate `'unknown'`, the IV-rank
  bootstrap gap): **the open-interest filter is skipped during backtesting specifically**
  (documented as an explicit, permanent simplification, not a bug) **and remains fully
  enforced at live/paper execution**, where OI comes from the live chain via whichever
  `MARKET_DATA_PROVIDER` is configured, never Polygon — the same live-vs-backtest split
  every other decision in this doc already makes. **Confirmed with the user** (2026-07-03)
  — a real, permanent backtest limitation, not a bug to later fix; options backtesting
  proceeds on this basis rather than being blocked indefinitely on data that doesn't exist
  at any tier.

  **The pre-existing bid-ask-spread gap stands, and is now better understood as part of
  the same pattern**: the spread filter can't be backtested against a real historical
  quote below the $199/mo Advanced tier (Starter/Developer add historical *trade*
  prices, never quoted bid/ask) — zero effect on live/paper trading, which reads the
  live chain directly, never Polygon.

  **Confirmed with the user: Options Starter ($29/mo) — and this finding makes it an
  even clearer choice than originally scoped, not a closer call.** Paying for Advanced
  no longer looks like "backtest everything vs. backtest almost everything" — it's
  "close the spread gap, while the Greeks/IV/OI gap remains no matter what's paid for."
  Since two of the three things a pricier tier might have bought (historical Greeks/IV,
  historical OI) turn out to be unavailable at *any* tier, Advanced's real incremental
  value over Starter is narrower than it first appeared — only the spread filter and
  deeper/real-time history, the latter unneeded for backtesting. Starter remains the
  right pick for the same reasons already recorded (unlimited calls, Flat Files, no
  paid-for real-time data a backtest can't use), now with the added confidence that its
  main limitations (spread, OI) aren't things a bigger spend would have solved anyway.

  **Action item — the user's, not from here:** actually subscribing to the Options
  Starter add-on (billing, same as the stocks plan) still needs to happen before any
  options history can be ingested. Confirmed by the user: it uses the same
  Massive/Polygon account and existing `POLYGON_API_KEY` already configured for
  stocks — options is an add-on tier on the same account, not a separate vendor or a
  second server-side secret to provision. **Subscription confirmed active by the user
  (2026-07-02).**
  **This resolves the data-source question, but does not by itself green-light writing
  phases 9-13** — per the user's own explicit sequencing choice earlier (data before
  implementation), the next step is an explicit go-ahead on the phase 9-13 roadmap the
  same way phases 1-8 got one (task-tracked separately), before any options code is
  written.

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
   **Known interim scope at the time this phase shipped, resolved in Phase 6:**
   concurrent-position count and aggregate open risk were account-wide regardless of
   source, since nothing had executed an auto-trade yet and `positions` (the human's
   real journal) was the only position data that existed anywhere. Once Phase 6 gave
   auto-trading its own position marker (`autotrade_paper_positions`), this was
   revisited — see Phase 6's writeup below for the resolved answer (autotrade's own
   caps are scoped to its own paper positions, not combined with the human's real
   ones; the original "combine for safety" framing turned out not to apply once the
   positions in question carry zero real financial exposure). Equity is a manually-set
   number (`autotrade_config.accountEquityUsd`), not live broker data — Webull's
   account-state call needs an `accountId` with no natural source for an unattended
   loop, and paper mode never calls it at all (see Phase 6). Pure evaluator (`evaluateRiskCheck`) is heavily unit-tested,
   per the spec's call for the heaviest coverage on this phase; the orchestration
   wrapper (`runAutotradeRiskCheck`) assembles real portfolio state and is exercised
   against the real `positions` journal in tests, plus verified live in a browser.
   Routed at `POST /api/autotrade/risk-check`; the Auto-Trade page's candidates table
   shows a Qty + pass/fail Risk-check column per candidate.
   **Fixed (2026-07-04):** the "no natural source for an unattended loop" framing above
   was accurate when written, but Phase 8 subsequently added `liveAccountId` —
   server-side, set once, with no browser dependency — for exactly the live-order path
   (`liveExecute.ts`'s `attemptLiveEntry`). `syncAccountEquityFromBroker()` reuses that
   same account id to pull the live account's net liquidation value (not buying power,
   which reflects available leverage rather than the account's actual value) and set
   `accountEquityUsd` from it. A "Sync from Webull" button next to the manual equity
   field does this on demand; there is still no automatic/periodic sync, and paper mode
   still never calls the broker — this only replaces how the manual number gets typed
   in, not what consumes it. Read-only against the broker and gated only on
   `liveAccountId` being set, independent of `liveTradingEnabled` and both kill
   switches, since nothing here places an order — equity can be synced and reviewed
   long before ever going live.
   **Fixed (2026-07-04), originally flagged during Phase 6's review, deferred through
   Phase 8:** `getPortfolioSnapshot()`'s "today" bucketing was UTC-based
   (`new Date().toISOString().slice(0, 10)`) for `dailyPnl`, plus a SEPARATE
   server-local-time midnight (`setHours(0,0,0,0)`) for `tradesToday` — two different,
   both-wrong bucketings in the same snapshot, the same bug class `execute.ts` was
   already fixed for in Phase 6. Both now reuse the identical `etDateStr()`
   (US/Eastern date-string) convention `execute.ts`/`optionsExecute.ts` already use —
   duplicated locally (not imported) to avoid a circular import, since `execute.ts`
   already imports from `riskCheck.ts`. Regression-tested by faking the system clock to
   11:30pm ET (3:30am UTC the next day) and confirming an exit/order dated that instant
   still buckets as "today," not "yesterday."
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

   **Hardened after an independent adversarial review of the whole harness (routes,
   simulation core, and orchestration), before treating any of it as trustworthy:** the
   correlated-exposure check now threads the *running* same-day-batch position list
   through, not a stale pre-batch snapshot — the bug let several mutually-correlated
   candidates all clear the cap on the same day, since none of them saw each other as
   already-approved (mirrors `riskCheck.ts`'s own `runningPositions` pattern, which was
   already correct). Candidate ties on score now break deterministically by symbol name
   instead of falling back to `historyBySymbol`'s Map insertion order, which depended on
   real concurrent-fetch completion timing — a rerun of an identical config against
   identical cached data could otherwise approve a different candidate. `tradesToday`
   is wired to positions actually filled that simulated day (was hardcoded to `0`,
   masked today only because both shipped profiles' `maxConcurrentPositions` binds
   before `maxTradesPerDay` would). At the route layer, `from`/`to`/`splitDate` are now
   validated as real calendar dates (not just `YYYY-MM-DD`-shaped — a value like
   `2024-02-30` used to either 500 or silently roll to March 1st), `symbols` is capped
   at 50 per run, and one symbol's historical-bar fetch failing (bad ticker, rate limit)
   no longer 500s the whole request — it's now reported per-symbol in a new
   `errors: {symbol, message}[]` on `BacktestReport`/`WalkForwardReport`, surfaced in the
   UI, while every other symbol's result still comes back normally.

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
6. **Paper execution loop — shipped.** `services/autotrading/loop.ts` mirrors the
   alerts-poller's self-rescheduling `setTimeout` pattern exactly (`services/alertScheduler.ts`):
   `autotrade_config.enabled` is read fresh every cycle (no restart to toggle), one
   `try`/`catch` wraps each tick so a single bad cycle can't kill the loop, and the timer
   is `unref`'d so it never keeps the process alive alone. Wired into `index.ts`'s startup
   next to the alert scheduler.

   One cycle (`runAutotradeLoopTick()`): check every open paper position for a stop/target
   hit first (`checkPaperExits()` — this runs regardless of the session window, since a
   closed or near-the-bell market doesn't invalidate an already-known stop/target level);
   then, only inside the allowed session window, Screen (Phase 2, unmodified) → a
   ticker-ATR + broad-market-proxy volatility filter (new — see below) → Decision (Phase
   3, unmodified) → `runPaperExecution()` (Execution). Every stage journals to
   `autotrade_events` exactly as the manual preview flow already does, so the activity
   feed reads the same whether a human clicked "Run screen" or the loop ran itself.

   **Paper is a fully local simulation** (the resolved decision above): `execute.ts` never
   calls the live Webull order pipeline. `attemptPaperEntry()` fills at a *freshly-fetched*
   quote (not the signal's own screening-time price — this loop runs in real time, unlike
   the backtest's next-day-open convention, so "now" genuinely is the fill moment),
   recording a row in the new `autotrade_paper_positions` table (kept fully separate from
   `positions`, the human's real journal). A quote-fetch failure is reported per-symbol,
   not silently guessed at. `checkPaperExits()` closes at the declared stop/target *level*,
   not the observed quote — the same convention `backtest.ts` uses, so paper and backtest
   results stay comparable.

   `runPaperExecution()` risk-checks a batch sequentially against a **running** total
   (mirrors `simulateBacktest()`'s batch pattern and `runAutotradeRiskCheck()` — the same
   same-batch-correlation-threading fix Phase 5's review found and fixed in the backtest
   engine, built correctly here from the start), reusing `evaluateRiskCheck()` and the
   now-exported `correlatedNotional()` directly rather than a third parallel
   implementation. **This resolves the Phase 4 "known interim scope" note**: autotrade's
   own concurrent-position-count and aggregate-open-risk caps are scoped to its *own* open
   paper positions, not combined with the human's real ones. Paper trades carry zero real
   financial exposure, so combining them wouldn't add real safety — and would make this
   phase impossible to observe for anyone who has real positions open (a very ordinary case
   for this app's primary manual-trading UI).

   `executionGuards.ts` adds two hard blocks specific to the unattended loop (distinct from
   `services/trading/marketHours.ts`, which is deliberately warn-only for the
   human-confirmed live pipeline — a person can see a warning and decide anyway; a loop with
   no one watching can't): `checkSessionWindow()` blocks outside market hours and within 15
   minutes of the open or close (the spec's "no entries in the first/last N minutes"), and
   `checkVolatility()` blocks a candidate whose own ATR% is too high, or *every* candidate
   this cycle if a broad-market proxy (SPY by default, its own ATR% — no VIX feed exists in
   this app, so this reuses whatever `MARKET_DATA_PROVIDER` is already configured instead of
   adding a new data source) is itself too volatile.

   Routed at `POST /api/autotrade/loop/run-once` (run one cycle immediately — the same
   function the background scheduler calls, so a human can watch it work without waiting
   for the real-time interval) and `GET /api/autotrade/paper-positions`. The Auto-Trade
   page's new "Paper trading" card shows the last run's summary, per-window stat tiles
   (open/closed count, realized P&L), and the full paper trade history. The page's
   "Auto-trading enabled" warning and footer copy were updated — they used to say the
   execution loop hadn't been built yet, which would now be actively wrong.

   **Hardened after an independent adversarial review**, before treating an unattended
   loop as trustworthy even in paper mode: `runAutotradeLoopTick()` now guards against a
   second concurrent call while one is already in flight (returns immediately with
   `skippedReason: 'A cycle is already running'`) — the self-rescheduling timer can never
   overlap *its own* ticks, but the manual "run one cycle now" route calls the same
   function completely independently, and without this guard a manual trigger landing
   mid-cycle let two `runPaperExecution()` batches each snapshot the paper portfolio
   blind to the other's approvals (the same same-batch cap-busting bug class Phase 5's
   review found in the backtest engine, reintroduced via inter-call concurrency).
   `closePaperPosition()` now checks the SQL `UPDATE`'s actual row count instead of just
   re-`SELECT`ing — it used to return the stale row (not `null`) on a no-op second close,
   which let `checkPaperExits()` journal a duplicate `paper_position_closed` event for a
   close that only happened once. Daily P&L / consecutive-loss / trades-today figures are
   now bucketed by the ET calendar date, not UTC — `checkPaperExits()` runs around the
   clock, not just during the session, and UTC midnight falls at 7-8pm ET (squarely
   inside ordinary after-hours activity), so a position closed late one evening could
   land in a different UTC "day" than its own ET trading day, corrupting the next
   morning's risk-check inputs. `attemptPaperEntry()` now validates a fetched quote is
   finite and positive before use, and never lets one candidate's persistence failure
   abort the rest of the batch. The "Paper trading" card no longer leaves a stale
   successful summary on screen next to a newer failed run's error.

   A follow-up focused review of that fix commit found the same "stale success next to
   a fresh error" pattern still unfixed in the sibling "Research, Screen & Decide" card
   (now fixed identically) and a regression test that didn't actually exercise the new
   `openPaperPosition()` try/catch it was named for (it hit an earlier validation check
   instead — replaced with one that spies on `openPaperPosition` directly to force a
   genuine persistence-layer throw). `stopAutotradeLoop()` now also resets the
   reentrancy flag, defensively, so a failed test assertion elsewhere can never wedge it
   `true` across unrelated tests. Verified live in a browser end to end (Screen →
   Backtest → Paper trading, including a rapid-double-click reentrancy test against the
   real server) with a full recorded activity trail and no console errors.
7. **Monitoring dashboard & kill switch — shipped.** `autotrade_config` gained a
   `killSwitch: boolean` field, independent of `enabled` — mirrors `trading_config`'s
   existing live-trading kill switch (`db/trading.ts`) exactly, down to the convenience
   wrapper (`setAutotradeKillSwitch(on)`) and the route shape
   (`POST /api/autotrade/kill-switch { on }`, no confirmation required either direction —
   a panic button has to fire in one click, and releasing it is the safe direction
   anyway). Kept deliberately separate from `enabled` rather than reusing it: `enabled`
   is the routine on/off a user might flip many times a session, while the kill switch is
   a sticky, explicit emergency halt — collapsing them into one flag would lose that
   distinction. Engaging it doesn't touch `enabled`, and releasing it doesn't either, so
   an already-armed loop resumes on its own the moment the kill switch is released,
   with no need to re-check "enabled" separately (same recovery behavior as the live
   system).

   **Implements the resolved kill-switch decision above** ("cancels all new... orders and
   disables the loop immediately... does not force-close existing positions — their
   existing hard stop-losses remain in place as the exit mechanism"): `checkPaperExits()`
   now runs on *every* tick unconditionally, before either the kill switch or `enabled` is
   even read. This is a correctness fix, not just new-feature wiring — for paper trading
   specifically there is no broker enforcing a stop/target independently, so this loop
   *is* the only thing that can honor "stops remain in place" once new-entry generation
   halts. Previously the outer scheduler (`loop()`) only called `runAutotradeLoopTick()`
   at all when `enabled` was true, meaning turning the master switch off silently stopped
   exit-checking too, leaving any already-open paper position unable to ever close on its
   own stop/target — and the manual "run one cycle now" route didn't check `enabled` (or,
   before this phase, have a kill switch to check) at all, so it could open *new* entries
   even while the master switch was off. Both gaps are fixed the same way: the
   enabled/kill-switch gate now lives *inside* `runAutotradeLoopTick()` itself, checked
   only after exits run and only before the entries stages (screen/decide/execute) —
   so the background scheduler and the manual trigger get byte-for-byte identical
   gating, and `loop()` now calls `runAutotradeLoopTick()` unconditionally every cycle
   (cheap when nothing is open — `checkPaperExits()` short-circuits on an empty
   position list with no network calls).

   The dashboard itself (`services/autotrading/dashboard.ts`) is a read-only snapshot:
   active risk profile, open paper positions vs. the profile's concurrent-position cap,
   aggregate open risk vs. its $ cap, today's realized paper P&L vs. the $ level that
   trips the daily-drawdown halt, trades today vs. the daily cap, and the
   consecutive-loss streak vs. the step-down trigger. Every "used vs. limit" figure is
   computed the exact same way `evaluateRiskCheck()` (`riskCheck.ts`) computes it for a
   live pre-trade decision — read from `RISK_PROFILES`, not re-derived — so the panel can
   never show a number the risk engine itself would disagree with. The open-positions/
   P&L/streak/trade-count figures come from a new `getPaperPortfolioSnapshot()`,
   extracted from what used to be inlined at the top of `runPaperExecution()`
   (`execute.ts`) — both the execution loop's own running-total risk check and the
   dashboard now share one computation instead of two that could quietly drift apart.
   Routed at `GET /api/autotrade/dashboard`.

   UI: a kill switch button in the Configuration card — same one-click, no-modal,
   red-when-engaged styling as the **Trade** page's kill switch — plus an inline warning
   explaining that existing paper positions keep working while it's engaged. A new
   "Monitoring" card (placed right after Configuration, so it's visible without
   scrolling) renders the six stat tiles, going red per-tile once its own cap is
   reached; a manual **Refresh** button plus an opt-in polling interval
   (`components/RefreshBar.tsx`, default off) keeps it current, matching this app's
   existing "polling is opt-in" convention rather than an always-on interval. Verified
   live in a browser end to end: engaging the kill switch turns the button and an inline
   warning red immediately; a "Run one cycle now" click while engaged correctly reports
   "New entries skipped — Kill switch is engaged" while still checking exits; releasing
   it restores normal operation; zero console errors throughout.

   **Hardened after an independent adversarial review** (two reviewers, one on the
   kill-switch/loop-gating logic, one on the UI/routes/tests), before treating a
   safety-critical kill switch as trustworthy: the initial gate check in
   `runAutotradeLoopTick()` only protected against the kill switch being engaged
   *before* a cycle starts — Screen and Decision are network-bound (sector
   classification, the market-ATR proxy) and can take real wall-clock time, so a kill
   switch engaged mid-cycle didn't stop that cycle's entries. A second check now runs
   immediately before `runPaperExecution()` (the write stage), so engaging the kill
   switch mid-cycle now aborts that same cycle's entries instead of only the next one.
   Separately — and more seriously — `YahooProvider` (used for the real-estate
   sector-classification fallback every Screen cycle calls for symbols outside the
   seeded universe) had no request timeout: `yahoo-finance2` ships with its own queue
   timeout unset, so a stalled connection could hang the awaiting call forever. Since
   nothing downstream of that hang would ever resolve, `runAutotradeLoopTick()` would
   never return, `tickInFlight` would never reset, and the self-rescheduling timer would
   never re-arm — permanently stopping the *entire* loop, including `checkPaperExits()`,
   the one thing this phase depends on to keep enforcing stops while halted. Every
   Yahoo call now races a 15s timeout (matching `util/http.ts`'s existing convention),
   converting a hang into a bounded, retried transient failure instead. The Monitoring
   card's Day P&L tile also colored red for any ordinary down day, giving no distinct
   signal when the daily-drawdown halt was actually breached — contradicting this
   section's own "a tile goes red once its cap is reached" claim; it now shows a
   distinct "HALT TRIGGERED" label (guarded against the equity-unset $0/-0 edge case,
   same guard style as the aggregate-open-risk tile) instead of just reusing the
   ordinary win/loss color. And a kill-switch toggle's own background config reload
   (fire-and-forget, to keep the button responsive) failing could swap the *entire*
   Configuration card — including the button that releases the kill switch — for a
   generic error box; the button is now rendered from local state outside that
   error branch, so it can never be hidden by an unrelated reload failure. Each fix
   has a regression test verified by reverting the fix and confirming the test fails
   against the old code. **Fixed (2026-07-04), originally left deferred/inert**:
   `stopAutotradeLoop()` used to unconditionally reset the reentrancy flag without
   stopping a genuinely in-flight tick, which could still open a position after the
   call returned. Now aborts an `AbortController` scoped to the in-flight tick;
   `runAutotradeLoopTick()` checks it at the same "re-check right before executing"
   point that already re-reads the enabled/kill-switch gates mid-cycle (screening +
   deciding is network-bound and can take real wall-clock time), skipping execution
   entirely if it fires. Not a hard interrupt — nothing here supports mid-await
   cancellation — but this closes the specific, documented gap (a tick already past
   that checkpoint when stopped completes normally, same as before).

   **Four bugs found live, immediately after the first production deploy, all fixed the
   same day**: `PUT /api/autotrade/config` rebuilt its patch as
   `{ enabled: body.enabled, riskProfile: body.riskProfile, accountEquityUsd:
   body.accountEquityUsd }` unconditionally — when a request omits a field, zod leaves
   it genuinely absent on the parsed body, but constructing the object this way put an
   `enabled: undefined` *own property* on the patch regardless, and
   `setAutotradeConfig`'s `{ ...current, ...patch }` spread treats an explicit
   `undefined` the same as "reset to default," not "leave alone." Net effect: checking
   "Auto-trading enabled," then separately setting account equity and saving (two
   independent actions, matching how the Configuration card actually works) silently
   flipped `enabled` back to `false` — the loop looked like it was doing nothing because
   it genuinely wasn't enabled anymore. `trade.ts`'s equivalent live-trading route never
   had this bug (it passes the parsed body straight through instead of reconstructing
   it) — checked for and confirmed clean. Second: Monitoring, Paper trading, and Recent
   activity all reflect state the background loop changes on its own, but only
   Monitoring (added in this phase) had any refresh mechanism — Paper trading and Recent
   activity had none at all, so a user watching the page with nothing to click had no
   way to see the loop's own activity without reloading the browser tab. Replaced the
   Monitoring-only `RefreshBar` with one shared control in the page header (manual
   refresh + the same opt-in polling) that refreshes all three together. Third: an open
   paper position showed no P&L or price movement at all — `paperPnl()` only ever
   computed *realized* P&L from `exitPrice`, which is null by definition until a
   position closes, so every open row rendered "—". Fixed by mirroring the human
   Positions page's own live-pricing pattern (`services/quotes.ts`'s
   `resolveStockPrices()` — batched, gracefully degrading to a last-known cached price
   per symbol, never failing the whole request): `GET /api/autotrade/paper-positions`
   now enriches each open position with a live quote and an unrealized P&L
   (`services/pnl.ts`'s new `computePaperUnrealizedPnl()`, the same core formula as
   `computePositionPnl()` without the human journal's multiplier/fees/partial-exit
   complexity paper positions don't have). The table gained a **Current $** column
   (with the same amber "stale" chip the human Positions page uses for a cached
   fallback price) and an **Unrealized P&L** stat tile alongside Realized P&L. Fourth: a
   live screen showed dozens of "Too many requests" errors from Yahoo. Cause: the
   real-estate sector/industry classifier (`realEstateClassifier.ts`, Phase 2) re-fetched
   every non-seeded symbol's classification from Yahoo's fundamentals endpoint on *every*
   screen — and the autonomous loop screens every 60 seconds, forever, unlike the manual
   Screener page's occasional, human-triggered use of the identical fetch pattern. A
   symbol's sector is effectively static, so this was almost entirely wasted, repeated
   traffic against an unofficial, unauthenticated API with no documented rate limit.
   Added a durable cache (`autotrade_sector_cache`): a `real_estate`/`clear` result is
   reused for 30 days; an `unknown` result (the fetch itself failed) gets a much shorter
   30-minute TTL so it's retried soon without immediately re-hammering an
   already-rate-limited endpoint on the very next cycle. **This does not fully resolve
   Yahoo rate-limiting** — most of the errors observed live were for symbols already in
   the seeded universe (their sector never needed a Yahoo call at all), meaning they came
   from the *scoring* stage's live `getCandles`/`getQuote` calls instead, which can't be
   cached the same way without sacrificing the freshness the strategy needs, and for
   which no batched-candles API exists in this codebase yet to reduce per-symbol call
   count. If rate-limiting persists after this fix, the durable answer is a
   `MARKET_DATA_PROVIDER` better suited to sustained automated polling (e.g. Tradier,
   already supported) rather than Yahoo's free/unofficial API — a separate decision, not
   made here. All four fixes have regression tests verified by reverting and confirming
   they fail against the old code.
8. **Live-trading gate — shipped.** The manual flag flip that lets the loop place
   real orders, prioritized ahead of the options addition (phases 9-13) per the user's
   explicit sequencing call. See the four Phase-8-specific "Resolved decisions" entries
   above for the confirmed design (one-time confirmation only, no code-enforced track
   record minimum, autotrade-specific live caps, a probation period). Broken into
   independently-mergeable steps, mirroring how phases 5-7 were each built in reviewed
   sub-steps rather than one large change:
   - **Step A — config & schema.** New fields (on `autotrade_config` or a sibling
     table): `liveTradingEnabled`, `liveAccountId` (server-side, replacing the human
     Trade page's browser-`localStorage` source — meaningless for an unattended loop),
     the autotrade-specific cap set (`liveMaxOrderUsd`, `liveMaxDailyLossUsd`,
     `liveMaxOrdersPerDay`, `liveFatFingerPct`, `liveAllowNakedShort`), and the
     probation fields (`liveProbationTrades`, `liveProbationSizeMultiplier`). Setting
     `liveTradingEnabled: true` requires an explicit typed-phrase confirmation at the
     route (a new, stronger analog of `confirmAggressive`'s boolean, given the stakes
     categorically exceed a risk-profile change) — a one-time gesture, not per-order
     friction, consistent with the confirmed confirmation model. No execution capability
     yet — pure plumbing, reviewable on its own like Phase 1 was.
   - **Step B — live execution service.** A new `services/autotrading/liveExecute.ts`,
     parallel to (not a modification of) `execute.ts` — paper execution and
     `autotrade_paper_positions` stay completely unchanged and keep running by default
     even after live trading is on, as an ongoing live-vs-paper sanity check. Reuses the
     lower, non-human-specific layers of the existing live pipeline (guardrail
     evaluation via `evaluateGuardrails()` against the new live-cap config,
     `webullPlaceOrder()`, the order lifecycle/audit trail with `created_by: 'autotrade'`)
     without going through `placeOrder()`'s confirmation parameter. `checkLiveExits()`
     mirrors `checkPaperExits()` and always runs regardless of either kill switch, per
     the exits-are-risk-reducing decision above. Probation and step-down multipliers
     compose on top of the risk profile's normal sizing.
   - **Step C — wire into the loop.** `runAutotradeLoopTick()` gates live entries behind
     `liveTradingEnabled` **and** `TRADING_ENABLED` (env) **and** both kill switches
     (autotrade's own, and the human pipeline's `trading_config.killSwitch`/`enabled`)
     **and** guardrails passing — every layer, not a subset. Live and paper execution
     both run each cycle when both are enabled.
   - **Step D — UI.** A new "Live trading" section on the Auto-Trade page: the one-time
     enable flow with its typed confirmation, `liveAccountId` input, an editor for the
     autotrade-specific caps, probation status (trades remaining, current multiplier),
     and the paper track record surfaced alongside the control (visible, not enforced).
     The Monitoring dashboard (Phase 7) extends to show live positions/risk alongside
     paper's.
   - **Adversarial review — done, two independent reviewers, matching Phase 7's
     precedent** (given this phase's blast radius is real money rather than paper).
     Reviewer 1 (gating/safety invariants) found three real gaps, all fixed: the
     deploy-level `TRADING_ENABLED` env var was never checked anywhere in the live
     path; `runLiveExecution()` reused a stale per-batch config snapshot instead of
     re-checking the kill switch before each candidate; `liveAccountId` could be
     silently redirected post-enable with no re-confirmation. Reviewer 2 (reconcile/
     probation/data-integrity) found four real gaps, all fixed: `webullOrderStatus()`
     trusted broker response ordering instead of the `combo_type` tag to find a
     bracket's MASTER leg; fill materialization had no error isolation (an exception
     after the intent already committed to `'filled'` would silently lose the fill
     forever); two bracket exit legs both reporting FILLED would have been resolved
     arbitrarily instead of flagged ambiguous; the probation trade count didn't
     exclude expired orders. One finding (a partial-fill-then-cancelled bracket) was
     left as-is — it mirrors an identical pre-existing gap in the human-confirmed
     path, not something specific to autotrade. Every fix has a regression test
     verified by reverting the fix and confirming it fails against the old code.

     **Follow-up, added after live trading was actually enabled (2026-07-03):** live
     fills had no dedicated view on the Auto-Trade page itself — only the Monitoring
     dashboard's aggregate `liveOpenPositions*` figures, with individual positions
     visible only by cross-referencing the Positions/Journal pages (where they render
     identically to a manual trade, distinguished only by a `tags`/`notes` value you'd
     have to open the position to see). A new `GET /api/autotrade/live-positions`
     route and a **Live positions** table close that gap — read-only, purely additive,
     no execution-path change. Reuses `services/pnl.ts`'s `computePositionPnl()`
     (handles partial exits and the stock/option multiplier correctly, unlike paper
     trading's simpler shape) and a `priceMap()` helper relocated from
     `routes/positions.ts` into `services/quotes.ts` so both routes share one
     stock/option price-resolution implementation instead of two.

     **Follow-up, added 2026-07-04 — autotrade-specific alerting.** Before this, the
     only way to learn a live order had fired, or that the kill switch had engaged,
     was to have the Auto-Trade page open. Both events now push a best-effort
     notification through `services/notifier.ts` — the same Slack/Discord/generic
     webhook dispatcher the price-alert system already uses (`dispatchNotifications()`
     is a no-op with zero channels configured, and never throws, so this adds no new
     failure mode to either path). `attemptLiveEntry()` fires one on every successful
     live order placement (symbol, side, quantity, limit, stop, target), right after
     the existing `live_order_placed` journal entry. `POST /api/autotrade/kill-switch`
     fires one only on the *engage* direction — a deliberate emergency halt worth
     knowing about away from the app — not on release, which is the safe direction and
     needs no push. Deliberately scoped narrow for this first cut: no notification yet
     for a daily-drawdown halt triggering (that would need day-over-day state-transition
     tracking to fire once rather than once per blocked candidate) or for paper-trading
     events (paper carries no real financial exposure, so there's nothing time-sensitive
     to page a human about).

### Options trading addition — phases 9-13, approved (2026-07-03)

The data-source question and the three design defaults flagged below (IV-rank ceiling,
expiration handling, the backtest open-interest gap) are now confirmed — see "Resolved
decisions" above — and implementation is approved, starting with phase 9. This still
mirrors the spec's own validation-gate principle ("backtesting harness required before
any strategy can run live") but applies it more strictly than equities got: rather than
letting screening/decision/sizing ship first and backtest later (the order phases 2-4 vs.
5 actually happened in), options holds phase 12 (paper execution) on clearing phase 11's
walk-forward gate first, exactly like equities' own phase 5 gate. Numbered to continue on
from equities' phase 8; independent of it — phase 8 (equities live-trading gate) shipped
on its own timeline regardless of this options work.

9. **Options screening & decision — shipped.** Extends Research & Screen so that a
   candidate clearing the existing equity screen (same real-estate exclusion — applies
   identically to the underlying) also pulls an option chain and runs it through
   `scanEntries()` (`entryRules.ts`, already built for the human Options page) with an
   autotrade-specific `EntryStrategyConfig` (`defaultAutotradeEntryConfig()`,
   `services/autotrading/optionsDecide.ts`) — the existing defaults already satisfy
   "exclude 0DTE and same-week expirations" (`minDaysToExpiration: 7`), plus the confirmed
   `ivRankMax: 70`. Of the expirations the provider returns, only the **nearest one inside
   the configured DTE window** is fetched and scanned — not every qualifying expiration —
   both to bound provider calls per candidate per cycle and because `db/ivHistory.ts`'s
   schema records one ATM-IV sample per symbol per day with no expiration dimension, so a
   single, consistently-chosen expiration keeps that history meaningful day over day.
   The loop records its own daily ATM-IV sample (`recordAtmIv()`) for anything it
   screens — the same call the human Options page already makes when a chain is
   viewed — so real `'history'`-method IV-rank coverage grows over time instead of
   staying permanently bootstrapped; this happens even on a cycle that ends up skipping
   the candidate for insufficient history, since accruing the sample is what eventually
   fixes that. Until a symbol has **15** real daily samples, it's skipped (fails
   closed) rather than scored on the `computeIvContext()` fallback proxy (realized
   volatility) that the human page's own IV panel is willing to use — a deliberately
   stricter policy than that page, since this system acts on the number rather than just
   displaying it.
   A new options-shaped signal (`OptionsTradeSignal`) replaces the stock-only
   `TradeSignal` for this path, structurally defined-risk by construction and confirmed
   via `analyzeStrategy()` as a code-level backstop (never approves anything reporting
   `unboundedLoss` or a non-finite `maxLoss`), with `maxLossPerContract` read directly
   from that same analysis rather than computed independently, so it can't silently
   drift from the check that approved it. **First-cut scope, narrower than the original
   "long call, long put, or debit spread"**: only single-leg long calls/puts ship here.
   A debit spread's short leg has no strike-selection logic anywhere in this codebase to
   reuse — `computeSpreadSizing()` (phase 10) only sizes an already-defined spread, it
   doesn't construct one — so building that from scratch would be a real, additional
   strategy surface with its own risk/reward trade-offs, unlike everything else here
   which reuses existing, already-shipped logic. Single-leg longs are the strictly more
   conservative subset (uncapped upside, one fewer decision), so shipping this first
   mirrors this codebase's own established convention of gating anything with more scope
   behind an explicit, separate opt-in (AGGRESSIVE vs. MODERATE, undefined-risk
   strategies) — debit-spread construction was added later the same way; see the
   follow-up note after phase 10.
   Read-only, like equities' phase 3 — no risk-check, no orders — but wired into the
   real, unconditional loop tick (`runAutotradeLoopTick()`) right alongside the equity
   decision, on the exact same already-screened/volatility-filtered candidates, since
   IV-history accrual only happens by actually running this every cycle. Exposed in the
   UI as a new **Options** column on the existing candidates table (Auto-Trade page) plus
   a **No options signal** list mirroring the equity "no signal" section, and in the API
   as a third `optionsDecision` field alongside `screen`/`decision` on the existing
   `POST /api/autotrade/decide` response — not a separate endpoint, since it consumes the
   exact same screened candidates in the same preview round-trip.
10. **Options risk engine, sizing & combined budget — shipped.** A new
    `services/autotrading/optionsRiskCheck.ts` — a deliberate PARALLEL implementation of
    `riskCheck.ts`, not a shared/refactored core, mirroring this codebase's established
    convention for every other equity/options split (`decide.ts` vs. `optionsDecide.ts`,
    `execute.ts` vs. `liveExecute.ts`): keeps each path's tests fully isolated and avoids
    awkwardly parameterizing away what's genuinely asset-specific about sizing. Sizes a
    single long call/put via the exact same `computeRiskSizing()` equities use, with
    `stopPrice: 0` (the option's real worst case — expires worthless — already produces
    "size by full premium paid," not a new formula) and `assetType: 'option'` (100×
    multiplier). Every options trade's risk-per-trade is contracts × premium × 100, sized
    to the active profile's `riskPerTradePct` exactly like equities are sized to it via
    stop distance — matching the original ask's "1% risk on MODERATE means max 1% of
    account equity spent on premium for that trade." Gates through the identical set of
    checks `evaluateRiskCheck()` does — `equity_configured`, `step_down_sizing`,
    `quantity`, `daily_drawdown_halt`, `max_trades_per_day`, `max_concurrent_positions`,
    `max_aggregate_open_risk`, `max_correlated_exposure` — since this codebase's own
    `riskCheck.ts` already treats every one of those as account-wide regardless of source
    ("the safer reading, since it can't understate real exposure"), not something specific
    to combine just for this phase.
    **The combined budget is real, not just a shared risk-profile config**:
    `runOptionsRiskCheck()` seeds its running totals from the same real open-position
    snapshot (`getPortfolioSnapshot()`) equity's own risk-check uses, PLUS whatever an
    equity batch already approved earlier in the exact same cycle (threaded in via an
    `equityResults` parameter — only the four fields actually needed: `symbol`, `ok`,
    `approvedRiskAmount`, `approvedNotional`, not the full nested shape) — an approved
    options signal's risk correctly counts against the next equity OR options candidate's
    cap, and vice versa, verified with tests that reproduce the exact multi-position
    gap-risk scenario `max_aggregate_open_risk` exists to prevent (docs/AUTOTRADING_SPEC.md,
    phase 4), now across both instrument types at once. A correlated-ticker position's
    "notional" for a long option is its premium paid (= its own risk amount) — a
    deliberate simplification, not a delta-adjusted/leveraged exposure figure, flagged in
    code as such since nothing in this codebase computes one today.
    **First-cut scope, mirroring phase 9's own scope reduction**: only single-leg long
    calls/puts were sized here initially; `computeSpreadSizing()` stayed unused under
    `services/autotrading/` until a debit-spread SIGNAL shape existed to size — see the
    follow-up note below. Preview-only for now (a new `POST /api/autotrade/
    risk-check-options` route plus an approved/blocked badge on the Auto-Trade page's
    existing Options column) — not wired into the unconditional 24/7 loop tick, since
    there is no options EXECUTION path yet (phase 12) for it to gate; mirrors how equity's
    OWN risk-check started (phase 4, preview-only) before phase 6 gave it a real
    paper-execution consumer.

    **Follow-up — debit-spread signal shape (2026-07-03):** `OptionsTradeSignal`
    (`optionsDecide.ts`) is now a discriminated union on a new `kind` field —
    `'single_leg'` (unchanged) or `'debit_spread'` — picked by a new persisted
    `optionsStrategyType` config field (`db/autotradeConfig.ts`, default `'single_leg'`,
    zero behavior change unless explicitly switched, same posture as `riskProfile`). The
    short leg is found by reusing `scanEntries()` a second time with a shifted,
    further-out-of-the-money delta band (`SHORT_LEG_DELTA_BAND`: 0.15-0.25, vs. the long
    leg's own 0.30-0.60), constrained to a strike strictly further OTM than the long leg
    (higher for a call spread, lower for a put spread) and rejected if the short leg's
    premium would leave a net credit rather than a net debit. The structural backstop is
    extended to both bounds — a debit vertical caps max loss AND max gain by construction,
    so `analyzeStrategy()` is checked for `unboundedProfit` as well as `unboundedLoss` now,
    not just the single-leg check. Sizing finally puts `computeSpreadSizing()` to use
    under `services/autotrading/`: `evaluateOptionsRiskCheck()` branches on `signal.kind`
    — `computeSpreadSizing()` for a spread (sized by max loss per spread, not a stop
    distance), the existing `computeRiskSizing()` call for a single leg — sharing every
    other check (drawdown halt, trade/position caps, the combined aggregate-risk budget,
    correlated exposure) unchanged. `OptionsRiskCheckResult` is a new type (not a change to
    the shared `RiskCheckResult` equity's own risk-check returns) since a spread's sizing
    result is a `SpreadSizingResult`, not a `RiskSizingResult` — kept separate so equity's
    risk-check path never needs to narrow a union it can't produce.
    **Was decision + risk-check only, mirroring exactly where phases 9→10 originally
    stopped**: a `'debit_spread'` signal that passes risk-check is risk-checked against the
    same combined budget as a single leg, but `attemptOptionsPaperEntry()` used to skip it
    with a clear logged reason at the final "open a position" step rather than opening
    one, since `autotrade_options_paper_positions` was single-contract, with no shape for a
    two-leg paper position. Exposed as a new **Options strategy** selector on the
    Auto-Trade page's config panel (single leg / debit spread), and the existing Options
    preview column on the candidates table now renders whichever shape the signal is.
    **Fixed (2026-07-04) — Task #69, paper execution.** `autotrade_options_paper_positions`
    gained a `kind` column plus `short_contract_symbol`/`short_strike`/`short_entry_price`/
    `short_exit_price` (additive `ALTER TABLE`s in `migrate()`, existing rows default to
    `kind = 'single_leg'` with the short columns null — no migration of existing data
    needed). A `'debit_spread'` signal now opens BOTH legs at freshly-fetched marks in
    `attemptOptionsPaperEntry()` — atomically: either leg's quote failing, or the net debit
    having vanished/inverted between screening and fill (stale quotes), rejects the whole
    entry, never a partial spread. `checkOptionsPaperExits()`'s time-exit trigger closes
    both legs together the same way. Realized/unrealized P&L for a spread nets the two
    legs' values first — `(netValueAtExit − netDebitAtEntry) × spreads × 100` — rather than
    reusing the single-leg `(exit − entry) × contracts × 100` formula; the Options paper
    positions table shows a spread's strikes as `long/short` and its Entry/Current/Exit $
    columns as that net value. **Options backtesting (phase 11) is unaffected and remains
    single-leg only** — see the follow-up note after phase 11's writeup below.
11. **Options backtesting — shipped.** Given the scope (a new contract-discovery data
    layer, deriving IV/Greeks from historical prices, and a day-by-day simulator reusing
    phases 9-10's real functions), this was built in four independently-mergeable steps,
    mirroring how equities' own phase 5 was constructed:
    - **Step A — data layer.** `services/autotrading/polygonOptionsClient.ts`
      (`fetchPolygonOptionContracts()`, a sibling to `polygonClient.ts` — Polygon's
      `/v3/reference/options/contracts` endpoint, which contracts existed for an
      underlying by expiration range) plus `db/backtestOptionContracts.ts` (a
      `backtest_bars`-style cache-and-fetch-log, keyed by expiration range instead of a
      trading-day range). A contract's own PRICE history needed **no new code at
      all** — `historicalData.ts`'s existing `getHistoricalBars()` is reused completely
      unchanged, since Polygon's Aggregates endpoint is ticker-format-agnostic (an
      OCC-style options ticker works there exactly like a stock symbol).
    - **Step B — the simulation engine.** `services/autotrading/optionsBacktest.ts`'s
      `simulateOptionsBacktest()` replays phases 9-10's entry/sizing logic day-by-day —
      the same `evaluateOptionsRiskCheck()` (phase 10) gates every candidate, and the
      same `entryRules.ts` threshold values (`defaultAutotradeEntryConfig()`, phase 9)
      define a qualifying contract, not new numbers guessed for this phase. Unlike
      equities' pure/sync `simulateBacktest()`, this is **async**: which contract's price
      bars are needed depends on the underlying's own price path as the simulation
      unfolds, so bars are fetched on demand (already cache-or-fetch) and memoized per
      contract for the run. `backtest.ts` itself needed only purely-additive changes
      (`export` on already-existing internals it needed to reuse, plus widening
      `computeBacktestStats()`'s parameter type to a structural subset it already
      satisfied) — zero behavior change to the existing, heavily-tested equity backtest.
    - **Step C — routes.** `POST /api/autotrade/backtest-options` and
      `.../backtest-options/walk-forward`, mirroring the equity routes' exact validation
      and response shape.
    - **Step D — UI.** A second button ("Run options backtest" / "Run options
      walk-forward") on the existing Backtest & walk-forward card, reusing the same
      symbols/dates/profile/equity form — a human comparing the two overlays wants to run
      both against the identical window, not fill out a second form. Renders as an
      independent result section (own stats grid, equity curve, and a
      contract/strike/expiration-shaped trades table) below the equity results, reusing
      `BacktestStatsGrid`/`BacktestEquityChart` unchanged (already 100% asset-type-blind).

    **Six deliberate, documented scope reductions** (in the file's own header comment,
    mirroring phase 9's own "first cut" framing, not silent shortcuts): (1) an
    independent backtest, not combined with a concurrent equity backtest's risk in the
    same run — `evaluateOptionsRiskCheck()` is reused verbatim, just with no equity
    approvals to combine with this run, the same posture phase 4's risk-check had before
    phase 6 gave it a concurrent execution consumer; (2) exactly one reference contract
    (nearest-to-spot strike, in the confirmed DTE window) is considered per underlying
    per day, not a full multi-strike scan via `scanEntries()` — that function's bid/ask
    spread check is unconditional (no config can disable it) and would reject 100% of
    backtested candidates outright, since no tier has historical bid/ask data; (3) open
    interest and bid-ask spread are skipped (the already-confirmed backtest gap); volume,
    delta band, DTE window, and IV-rank ceiling are still enforced; (4) IV rank always
    uses `computeIvContext()`'s hv-estimate (realized-vol) fallback — the same proxy the
    human Options page already uses live — rather than a genuinely-derived historical
    options-IV series (the day's own implied vol is still real and Black-Scholes-derived
    from that day's actual historical option price; only the ranking methodology falls
    back to the cruder proxy; live/paper is unchanged, still failing closed without 15
    real samples exactly as phase 9 shipped it); (5) exit is time-based only
    (`timeExitDaysBeforeExpiry`), matching phase 12's own already-scoped close-only
    automated-exit design, not the human page's fuller stop-loss/take-profit/delta-drift
    default (which is for manual review, not automation); (6) delta is recomputed via
    Black-Scholes directly, not `entryRules.ts`'s `evaluateContract()`, for the same
    reason as (2).

    **Follow-up — genuinely combined equity+options backtest (2026-07-04), resolving
    scope reduction (1) above:** `services/autotrading/combinedBacktest.ts` is a new,
    THIRD simulation engine — not a modification of `simulateBacktest()` or
    `simulateOptionsBacktest()`, both of which are each a single, self-contained loop
    over the whole date range with no seam to pause one mid-run and let the other catch
    up without restructuring either (13+ and 20+ existing tests apiece). Its day-by-day
    loop reuses every pure building block both existing engines already reuse
    (`scoreSymbol`, `generateSignal`, `evaluateRiskCheck`, `evaluateOptionsRiskCheck`,
    `pickReferenceContract`, the Black-Scholes helpers, `backtestCorrelatedNotional` —
    the last two newly `export`ed from `optionsBacktest.ts`/`backtest.ts` for this reuse,
    zero behavior change to either), but shares ONE running risk/count/position ledger
    across both instrument types within each simulated day — exactly the property
    `evaluateOptionsRiskCheck()` (phase 10) was already built to support (it takes the
    running totals as a plain, source-agnostic `RiskCheckContext`) and exactly what the
    live loop (phase 12) already does for real, unattended paper-execution risk-checks.
    Ordering mirrors the live loop's own: each day, ALL equity candidates are
    decided/risk-checked FIRST — seeded with options' own pre-existing open risk,
    mirroring `optionsSeedForEquity()` — then ALL options candidates are
    decided/risk-checked SECOND, continuing the same running ledger equity's own batch
    just left off at. "Already open" exclusion stays PER INSTRUMENT TYPE (a symbol can
    carry an open equity position AND an open options position at once, matching the
    live system's own separate tables); only the risk BUDGET combines.
    `consecutiveLosses` combines by MAX across the two books' own closed-trade streaks,
    the same "erring toward the more conservative streak" reasoning phase 12's
    combined-budget-for-real work and phase 13's dashboard already use verbatim, kept
    consistent here rather than a fourth definition. Reports `equityTrades` and
    `optionsTrades` as two separate lists (too structurally different to merge) against
    ONE shared equity curve; `computeBacktestStats()` needed no changes — it's computed
    server-side over both lists concatenated, one risk-adjusted read spanning the whole
    account. Exposed as a third, additive "Run combined backtest" / "Run combined
    walk-forward" button on the existing Backtest & walk-forward card (same
    symbols/dates/profile/equity form) and `POST /api/autotrade/backtest-combined`
    (+`/walk-forward`) — the two existing independent backtests are unchanged and still
    available side by side. Single-leg options only, matching
    `simulateOptionsBacktest()`'s own current scope — the debit-spread signal shape
    (phase 9/10's other follow-up) hasn't been extended to either backtest engine.
12. **Options paper execution & expiration management — shipped.** Cleared for
    implementation after the user confirmed (2026-07-03) they had reviewed phase 11's
    options backtest/walk-forward against real data and judged the results sound enough
    to build on — the same bar equities' own phase 5 → 6 transition required, not just
    "the code exists." Built in four independently-mergeable steps, mirroring phases 6 and
    11's own structure:
    - **Step A — data layer.** `db/autotradeOptionsPaperPositions.ts` and a new
      `autotrade_options_paper_positions` table — a deliberate PARALLEL table/module to
      `autotradePaperPositions.ts`, not a shared/unioned one, since a long option position
      is identified by contract (strike/expiration/side), not a buy/sell direction +
      stop/target price.
    - **Step B — execution service.** `services/autotrading/optionsExecute.ts`:
      `attemptOptionsPaperEntry()` fills at a freshly-fetched contract mark (never the
      signal's own screening-time premium), `checkOptionsPaperExits()` wires ONLY
      `exitRules.ts`'s `timeExitDaysBeforeExpiry` trigger — implementing "I do not want
      the automated system holding options through expiration," close-only per the
      confirmed default, no roll logic — and `runOptionsPaperExecution()` risk-checks a
      batch via `evaluateOptionsRiskCheck()` (phase 10). The phase 10 combined budget is
      made REAL here, not just preview: `execute.ts`'s `runPaperExecution()` gained an
      optional, default-safe `PaperPortfolioSeed` parameter so options' pre-existing risk
      folds into equity's own batch, and `runOptionsPaperExecution()` reads `execute.ts`'s
      `getPaperPortfolioSnapshot()` directly (a one-way import, no cycle) to fold equity's
      book into every options risk-check — an approved signal of either type now correctly
      counts against the other's cap in the actual unattended loop, not only the phase 10
      preview route.
    - **Step C — loop wiring.** `checkOptionsPaperExits()` runs unconditionally in
      `runAutotradeLoopTick()`, alongside `checkPaperExits()` — an approaching expiration
      doesn't wait for market hours or the kill switch. `runOptionsPaperExecution()` runs
      after equity's own paper execution, gated solely on paper being active (options has
      no live-trading path of its own).
    - **Step D — routes + UI.** `GET /api/autotrade/options-paper-positions` (mirrors
      `/paper-positions`, enriching with a live contract mark fetched by re-querying the
      chain and matching strike + side) and an **Options paper positions** table on the
      Auto-Trade page, right below equity's own paper trading, with the same open/closed
      counts and realized/unrealized P&L stat tiles.

    Underlying real-estate exclusion applies identically throughout, inherited from
    whatever the underlying already cleared at Screen. No P&L-based automated exit
    (take-profit/stop-loss/delta-drift) exists for options paper positions — a long
    option has no numeric stop/target price the way a stock paper position does (phase 10:
    sized by full premium paid, worst case = expires worthless), so there's nothing for
    those rules to mirror; they stay human-review-only on the Options page.
13. **Options monitoring — shipped.** Extends the phase 7 dashboard
    (`getAutotradeDashboard()`) with options-specific rows. Unlike live trading (phase 8),
    which genuinely is a second, independent pool — `runLiveExecution()` risk-checks only
    against its own snapshot, never equity paper's — options paper is the OPPOSITE case:
    phase 12 made the equity/options combined budget real (`runPaperExecution()` and
    `runOptionsPaperExecution()` each fold the other's running totals into every
    risk-check), so `openPositionsCount`, `openRisk`, `dailyPnl`, and `tradesToday` are now
    genuinely COMBINED across both books — one pool, not a second one — matching what the
    risk engine actually enforces; showing them separately would misrepresent that.
    `dailyPnl`/`tradesToday` combine by sum, `consecutiveLosses` by max (not sum — a
    losing streak isn't additive across two books without merging their closed-trade
    timestamps chronologically, which step-down sizing doesn't need to be precise about;
    erring toward a MORE conservative streak after recent losses in either book is the
    safe direction). A new `openOptionsPositions` array carries each open options paper
    position plus a computed `dte` (days-to-expiration, via `blackScholes.ts`'s
    `daysToExpiration()`) for per-position display — the equity `openPositions` array
    itself stays equity-only, since an option position's contract/strike/expiration shape
    doesn't overlay onto a stock position's shape.

    UI: the existing "Open positions"/"Aggregate open risk" tiles now show the combined
    figure with an equity/options breakdown as a sub-label, and a new "Options
    expirations" list appears (only when something is open) sorted soonest-first, flagging
    anything within the automated system's own time-exit window (7 days) in red — so a
    human sees an upcoming expiration, and the automated close that's coming for it,
    before it happens.

    No separate options live-trading-gate phase — options rides the same phase 8 flag
    equities uses once its own paper track record exists, since paper-vs-live is one
    system-wide switch already, not one per asset class.

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

---

### Addendum: options trading scope (added after phases 1-7 shipped)

The following was given after phases 1-7 above were already built, merged, and running
live in paper mode. Appended verbatim, as received, rather than merged into the sections
above — see "Fit with the current codebase: options trading addition" and the
options-specific "Resolved decisions" entries earlier in this doc for how it maps onto
what already exists and what's still open.

> I also want to add automatic options trading to the application:
>
> OPTIONS TRADING SCOPE
> In addition to equities, the strategy may trade options — but with the
> following constraints, since options risk doesn't map to the equity risk
> model above (position size × stop distance):
>
> DEFINED-RISK STRATEGIES ONLY at first: long calls, long puts, and debit
> spreads (where max loss = premium paid, known at entry). Do NOT implement
> undefined-risk strategies (naked short calls/puts, uncovered strategies)
> as part of this automated system — that's a materially different risk
> profile and I want to opt into it separately and explicitly later, not
> have it bundled in by default.
>
> For options, "risk per trade" from the active risk profile = premium
> paid per position (not notional/underlying exposure). This keeps it
> consistent with the equity risk model — 1% risk on MODERATE means max
> 1% of account equity spent on premium for that trade.
>
> Minimum days-to-expiration filter: exclude 0DTE and same-week expirations
> by default (configurable) — theta decay and gap risk on very short-dated
> options make them a different risk category than what the daily
> drawdown/step-down logic above was designed to contain. If I want to
> enable shorter-dated expirations later, that should require the same
> kind of explicit opt-in as switching to AGGRESSIVE.
>
> Liquidity filters before any options trade: minimum open interest,
> minimum daily volume, and a maximum acceptable bid-ask spread (as % of
> midpoint) — skip the trade if the option doesn't meet these, even if the
> underlying signal is good.
>
> IV filter: flag or avoid entries where implied volatility is at an
> extreme relative to its recent range (e.g. very high IV rank into
> earnings), since premium becomes overpriced/whipsaw-prone in those
> conditions.
>
> Assignment/expiration handling: automatically close or roll positions
> before expiration rather than letting them expire in-the-money and risk
> assignment — I do not want the automated system holding options through
> expiration.
>
> Underlying real estate exclusion applies to options as well — no options
> on real estate ETFs/equities from the exclusion list.
>
> Max aggregate open risk (from the active risk profile) must include
> options premium at risk alongside equity risk — one combined budget, not
> separate pools for stocks vs. options.

**Sequencing decision, given separately when asked how to proceed:** get proper options
historical data (backtest-grade) before writing any options implementation code, rather
than implementing against the existing live/manual data paths and backtesting later. That
data-source question is now resolved — see "Options backtest data source: Options
Starter, $29/mo — confirmed and final" under "Resolved decisions" above
for the current state of that data-source search.
