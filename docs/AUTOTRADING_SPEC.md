# Automated Trading — Specification

**Status: all phases (1-19) shipped and running.** Equities screening, decision, risk
engine, backtesting, paper execution, monitoring/kill-switch, and the live-trading gate
(phases 1-8) are built and have each cleared adversarial review. An options-trading
addition (phases 9-13 — screening & decision, risk engine & combined budget, backtesting,
paper execution & expiration management, and monitoring) has since been scoped, approved,
and shipped on top of the same codebase, followed by live options trading, bidirectional
(long/short) equity and options trading, options price-based exits, regime-aware
position sizing, and multi-timeframe (daily + weekly) trend confirmation (phases 14-19 —
see "Phased roadmap" below). This is the reference spec for adding a fully
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
  - **Follow-up (2026-07-11) — equity gained an explicit earnings-date check; the
    decision above for OPTIONS is unchanged.** Revisits the earnings example from the
    original ask, this time for equity specifically — which has no IV-rank concept at
    all, so the reasoning above (an approaching print already shows up as elevated IV
    rank) has nothing to attach to there. New `AutotradeConfig.earningsBlackoutDays`
    (0 default, disabled): `screen.ts`'s own per-candidate loop (`runAutotradeScreen()`)
    skips an equity candidate whose next known earnings date —
    `services/events.ts`'s existing `getSymbolEvents()`, already used by the manual
    pages' `EarningsBadge` — falls within this many calendar days, mirroring the
    real-estate exclusion's screening-stage gate structure. Unlike that check, an
    UNKNOWN earnings date does NOT block: `events.ts`'s lookup hits Yahoo directly and
    is cached for only an hour (vs. the sector classifier's 30 days), so failing
    closed here would risk starving the loop of candidates during ordinary Yahoo
    flakiness, not just correctly excluding a genuine match. Options entries are
    deliberately left untouched — the confirmed reasoning above still holds for them.
    Scoped to blocking NEW entries only, not closing positions already open as their
    earnings approaches — a materially larger change (there's no existing hook that
    loops over open positions for any reason other than a stop/target/time-exit check)
    that wasn't confirmed as in scope for this pass.
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
   seeded universe (507 symbols — see the follow-up below; originally 124); falls
   back to universe-only otherwise. Each candidate
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

   **Fixed (2026-07-10) — the 124-symbol default universe was too narrow for the
   screener's own volume bar, so the loop kept repeating the same handful of symbols
   and making no progress.** Reported directly: the app "pigeon holes itself into only
   a few equities" that "keep repeating to screen them and they keep failing the
   checks." Root cause: `defaultAutotradeScreenerConfig()` layers `minRelVol: 1.5` on
   top of the base screener filters, and the 124-symbol starter list is exclusively
   S&P 500 mega-caps — names that rarely trade 1.5× their average volume without a
   real catalyst that day. With Webull unconfigured (or its movers feed thin), every
   cycle re-screened the same static set, most of which predictably failed the same
   filter again. Two changes, presented as options and both approved (the user chose
   "expand now, add auto-promotion as a follow-up" over either alone):
   1. **The seeded universe grew from 124 to 507 symbols** — the full current S&P 500,
      not just its largest names — so relative-volume breakouts have a much larger
      pool to be found in. `server/data/sp500.json` was rebuilt as a **union**, not a
      replacement: all 124 original entries kept verbatim in their original order,
      plus 383 newly-sourced entries appended, added only where the symbol wasn't
      already present. Deliberately additive rather than a wholesale replace because
      the new data came from a web fetch processed through a summarizing model (not a
      guaranteed byte-exact source) — a small mismatch already surfaced (`MMC` vs.
      `MRSH` for Marsh McLennan) that a destructive replace would have silently
      applied to a live production universe.
   2. **A new one-time top-up migration** (`topUpUniverseOnce()`, `db/index.ts`)
      applies the expansion to the `universe` table on next startup even though
      `seedUniverseIfEmpty()` — which only ever acts on a genuinely empty table — has
      long since no-opped against this app's already-seeded production DB. Reads a
      **frozen delta file** (`server/data/sp500_topup_2026_07.json`, just the 383
      newly-added symbols) rather than diffing the full `sp500.json` against what's
      currently in the table: `sp500.json` still lists the original 124 too (it's a
      union), so a full-file diff can't tell "never seeded" apart from "user removed
      it on purpose" and would silently resurrect any original-124 symbol a user had
      already deleted — caught by a smoke test that simulated exactly that (an
      already-seeded DB with a manually-removed original symbol) before this shipped.
      Uses the same `INSERT OR IGNORE` upsert `addSymbols()` already relies on, so
      it's naturally safe to run redundantly, and is additionally gated by a
      `settings` key (`universeTopUp`) so it truly applies once: once set, it never
      re-adds a symbol a user later removes from the delta either. Runs from
      `initDb()` right after `seedUniverseIfEmpty()`.

   **Follow-up (2026-07-10), shipped separately — movers auto-promotion, the
   explicitly separate second half of the same request.** A movers-sourced symbol
   is discovered fresh every cycle but never persisted: scored, maybe traded, then
   forgotten, so a genuinely active name gets re-found (and re-scored from zero
   IV/history) every single day instead of earning a permanent spot in `universe`.
   `services/autotrading/moversPromotion.ts`'s `processMoversForPromotion()` closes
   that gap. Two new tables (`movers_occurrences`, `auto_promoted_symbols`):
   - `movers_occurrences` records one row per (symbol, UTC calendar day) a symbol
     showed up as a movers-sourced, **filters-passing** screen candidate — the same
     quality bar the screener already applies, not raw movers-feed membership, so a
     spike with no real volume/price/RSI/trend backing it can't earn a spot just by
     appearing. Once-per-day dedup (mirrors `iv_history`'s shape) so many loop ticks
     the same day still only count once.
   - Once a symbol clears `autoPromoteThreshold` distinct days within a rolling
     `autoPromoteWindowDays`-day window (defaults 3 within 10), it's added to
     `universe` via the same `INSERT OR IGNORE` `addSymbols()` upsert, subject to
     the real-estate exclusion list and a lifetime `autoPromoteMaxSymbols` cap
     (default 50) on symbols promoted by this mechanism specifically.
   - `auto_promoted_symbols` is an append-only ledger — the exact same "don't
     re-fight a deliberate removal" posture as the sp500.json top-up above, but
     scoped per-symbol and permanent: once a symbol is EVER promoted, it's gated on
     the ledger (not live `universe` membership) forever after, so it's never
     reconsidered again even if a user later removes it from their universe on
     purpose. A symbol already in `universe` for an unrelated reason (seeded,
     manually added) is left alone and never enters the ledger at all.
   - Runs from `runAutotradeLoopTick()` right after `runAutotradeScreen()`, against
     the full screened set — deliberately **before** the volatility pre-filter, since
     a symbol's own recurrence is independent of whether today's overall market
     conditions happen to be too choppy for the loop to actually enter anything.
     Deliberately **only** from the automatic loop tick, never the manual "Run
     screen" route — this specifically addresses the automated loop's own
     pigeon-holing. Wrapped in its own try/catch, same backstop posture as the
     equity/position-truth syncs above.
   - Each promotion is journaled (`universe_auto_promoted`, stage `screen`, detail
     `{occurrences, windowDays, threshold}`) — visible in Recent Activity, unlike
     equity's own silent sync, since a symbol permanently joining the trading
     universe is a bigger deal than a routine balance refresh. `autoPromoteMoversEnabled`
     defaults **true**: a fresh deploy carries no risk of an immediate mass-promotion,
     since no symbol can have accumulated `autoPromoteThreshold` days of history before
     this shipped. All four fields (`autoPromoteMoversEnabled`, `autoPromoteThreshold`,
     `autoPromoteWindowDays`, `autoPromoteMaxSymbols`) are user-editable in the
     Auto-Trade page's Configuration card, same pattern as every other numeric risk
     parameter (sensible default, freely overridable afterward — not blocked on
     getting the exact numbers right up front).
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
   **Follow-up (2026-07-10) — equity now also syncs automatically, every cycle, not
   just on demand.** `runAutotradeLoopTick()` (`loop.ts`) calls
   `syncAccountEquityFromBroker()` itself, right after the exits/reconcile section and
   before `accountEquityUsd` is (re-)read for this cycle's own sizing — so a live entry
   this cycle already prices against the freshest equity, not whatever was last
   manually synced. Placed alongside the other "always runs regardless of any gate"
   steps (same reasoning as the live-order reconcile: read-only toward the broker, and
   equity accuracy doesn't depend on whether new entries happen to be gated off right
   now); wrapped in its own try/catch so a broker hiccup here can't take down exits,
   reconcile, or entries. No-ops via `syncAccountEquityFromBroker()`'s own
   `liveAccountId` check when live trading isn't configured, so this is a pure no-op
   for anyone not using it — the loop's existing 60-second cadence
   (`TICK_INTERVAL_SECONDS`) is what makes this "every ~1 minute" without a second
   timer. The Configuration tile's own display (`AutoTradePage.tsx`) separately polls
   the same sync every 60 seconds client-side (via `usePolling`) purely to keep what's
   ON SCREEN caught up without waiting for an unrelated reload — it skips whenever the
   equity field has an unsaved manual edit (`equityDraft` no longer matches the last
   config value), and suppresses the manual button's success/error toast so it fails
   quietly in the background rather than popping a toast every minute. The Trade page's
   "Account state" tile got the analogous treatment (`TradePage.tsx`) but as
   client-side-only polling of `GET /trade/account-state` — that endpoint is entirely
   stateless server-side (no DB table backs it), so there's nothing for a server loop to
   keep fresh; it also skips its refresh whenever the tile's fields no longer match the
   last pull, preserving the "Dry-run (manual state)" hand-editing workflow.
   **Fixed (2026-07-10), same day, caught in real use once deployed:** the automatic
   per-tick sync above initially reused `syncAccountEquityFromBroker()`'s existing
   "journal an `equity_synced` event whenever the value changes" behavior unchanged —
   fine for the old on-demand button (an occasional, deliberate action worth a record),
   but net liquidation value drifts with mark-to-market on nearly every once-a-minute
   check, so it flooded the Recent Activity tile's fixed-size window (`GET
   /autotrade/events?limit=50`) with equity noise, crowding out the screen/decide/
   execute events that tile exists to surface. `syncAccountEquityFromBroker()` now takes
   an optional `{ log?: boolean }` (default `true`); `loop.ts`'s per-tick call passes
   `{ log: false }` so the automatic sync still updates `accountEquityUsd` but never
   journals, while the manual "Sync from Webull" button (unchanged, no args) keeps
   journaling every change exactly as before.
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
   at 50 per run, the `from`-to-`to` span is capped at 3 years (2026-07-11 follow-up,
   below — an unbounded span had no yield point in the day loop and could tie up the
   whole server), and one symbol's historical-bar fetch failing (bad ticker, rate limit)
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

   **Statistical-significance check on a walk-forward window (2026-07-18) — shipped.**
   `services/autotrading/significance.ts`'s `computeSignificanceStats()` adds a bootstrap
   confidence interval and a sign-flip permutation p-value on top of `computeBacktestStats()`'s
   plain expectancy figure — the stat grid answers "what happened"; this answers "how much
   to trust it." Both windows' significance is computed the same way regardless of engine
   (equity, options, or combined's `[...equityTrades, ...optionsTrades]` concatenation,
   mirroring `combinedStats()`'s own reuse of `computeBacktestStats()`), via the same
   structural-subset parameter idiom (`{ pnl: number }[]`) so one function serves all
   three without duplication. Mirrors `services/riskOfRuin.ts`'s own Monte Carlo
   conventions: an injectable `rng` (default `Math.random`, swapped for a seeded PRNG in
   tests) and a private sort-then-percentile helper, rather than a shared stats module —
   this codebase's established small-helper-duplication convention. A sample below 20
   trades is flagged `reliable: false` rather than hidden, the same floor
   `pnl.ts`'s `kellySuggestion()` already uses for its own reliability flag. Exactly like
   the walk-forward harness itself, this renders no pass/fail verdict — the CI and
   p-value are additional evidence surfaced alongside the existing stat grid (Auto-Trade
   page's new "significance" panel per window), for the same human review the rest of
   this phase already defers to, not a new automated gate.
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
     probation fields (`liveProbationTrades`, `liveProbationSizeMultiplier`).
     **`liveMaxOrdersPerDay` is not `maxTradesPerDay`** (corrected 2026-08-25):
     `maxTradesPerDay` counts ENTRIES and is enforced by riskCheck, while this
     cap counts every submitted intent — entries, loop-placed exits and
     scale-in add-ons alike — via `countTodaysOrders` and guardrails.ts's
     `max_orders_per_day`. Both `shapeToPatch` and `suggestLiveCaps` set it to
     `maxTradesPerDay` exactly, which made every exit cost an entry: on
     2026-08-24, with both at 4, three entries plus one stagnation scratch
     spent the budget and GRMN's own stagnation exit was blocked 44 times
     ("4 placed vs 4/day") and carried overnight. Both now derive it through
     the shared `liveOrderCapForTrades()` (entries + one close each), so the
     entry budget is untouched and exits can no longer eat it.
     **Hand-edited dollar caps survive a tune** (2026-08-25): `computeTargetTune`
     now applies the same "only move what you own" rule `liveCapsReanchor` has
     always enforced — a cap that no longer equals its anchor-derived value was
     set by a human and is carried through unchanged, with a warning naming it.
     The re-anchor's header had described that rule as already covering the
     tune; it did not, so a tune silently reverted a hand-raised cap while the
     re-anchor carefully preserved it. `DOLLAR_CAP_KEYS`, `deriveDollarCaps` and
     `handEditedDollarCaps` moved to `targetTune.ts` (re-exported from
     `liveCapsReanchor`) so both paths share one definition.
     While wiring that up, a latent disagreement surfaced: `shapeToPatch` sized
     the per-order cap from `shape.maxOrderEquityFraction` (conservative = 0.2)
     while everything that reads it back used
     `maxOrderEquityFractionFor(riskProfile)` (MODERATE = 0.25) — and a
     conservative tune journals as MODERATE. So a freshly-applied CONSERVATIVE
     tune already read as hand-edited, permanently excluding its per-order cap
     from re-anchoring. `shapeToPatch` now derives through the same function,
     and the agreement test runs over every band instead of one.

     **MAE/MFE excursions measured the wrong window** (fixed 2026-08-25).
     `computeExcursion` scanned every bar handed to it, trusting its callers'
     `getCandles(symbol, 'daily', {start: entryDate, end: exitDate})` to have
     bounded the fetch. The live provider (Webull) has no date-range parameter
     at all — its bars endpoint takes a `count` — so `start`/`end` were dropped
     silently and the most recent 120 daily bars came back instead. MAE/MFE was
     therefore the symbol's ~6-month high/low: +20.95R average MFE and −4.28R
     average MAE across the book, an average adverse excursion four times the
     stop on trades that would have been stopped out at 1R. `autoTuneExitsEnabled`
     consumes the same report through `buildAutotradeExcursionReport`, so turning
     it on would have tuned `stopAtrMultiple`/`targetRMultiple` from those ranges;
     it was off, which is the only reason this cost nothing. Fixed on both sides:
     `computeExcursion` now filters to `[entryDate, exitDate]` itself (the
     requirement lives there, not in a provider that may not support ranges) and
     reports an empty window as unmeasurable rather than silently widening, and
     `WebullProvider.getCandles` honors a range the only way that API allows —
     request enough bars to reach `start`, filter to the window, and defer to the
     aux provider when the window predates the oldest bar available rather than
     return a truncated window a caller would read as complete.
     **Intraday resolution for same-session trades** (2026-08-25, same day).
     Fixing the window stopped excursions spanning six months, but a DAILY bar
     still hands a same-session trade that whole day's high/low — including the
     hours it did not exist, which for this loop (90-minute stagnation exit,
     maxHoldDays 1) is most of them. A trade whose entry and exit dates match is
     now measured on `INTRADAY_TIMEFRAME` (5-minute) bars, narrowed again to the
     minutes actually held via `positions.entry_time` and the last exit's
     `created_at` (`etDateTimeToMs` in util/marketDate.ts resolves the ET
     wall-clock entry to an instant). Intraday history is short, so when it
     cannot be had this falls back to daily and records it: every row carries a
     `resolution` ('intraday' | 'daily') and the report carries a
     `resolutionMix`, surfaced in the Journal's Analytics panel — an upper bound
     labelled as one, never a precise-looking number that quietly isn't.
     Both callers now go through ONE shared `excursionForTrade()`; they had
     carried near-identical copies of this logic, which is exactly why they
     carried identical bugs. Setting
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
     without going through `placeOrder()`'s confirmation parameter.
     > **Corrected 2026-08-21 — what actually shipped:** live exit **placement** does
     > NOT bypass the kill switch, and that is the behavior we keep. The exit sweeps
     > (`checkLiveOptionsExits()`, `checkLiveEquityTimeExits()`) run every tick, but
     > each close they place routes through `evaluateGuardrails()` with the combined
     > kill switch, so an engaged switch blocks automated exits exactly like entries.
     > A held OPTIONS exit short-circuits before any broker call and journals
     > `live_options_exit_blocked` once per position per halt (it used to journal
     > per tick and spend ~4 rate-limited broker calls per attempt first); equity
     > time-exit blocks journal per attempt, deliberately, since
     > `live_time_exit_blocked` feeds the failure-streak alert. Confirmed as the intended
     > semantic in real use: the kill switch's job includes "hands off — I'm trading
     > this account manually in Webull," and an app that keeps firing its own closes
     > into a session the human is actively managing is interference, not safety.
     > The risk-reduction concern is covered elsewhere: broker-side bracket legs
     > rest at Webull and fire regardless of anything this app does, and the
     > read-only reconcile/sync paths (which genuinely do run regardless of the
     > kill switch) book whatever the broker or the human executes. Only PAPER
     > exits close positions during a halt — they touch no broker.
     Probation and step-down multipliers
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

     **Resolved 2026-07-24.** The deferred partial-fill finding is fixed on all
     three live paths at once (human reconcile, live equity, live options), since
     it was the same defect in three places. Fills are now materialized whenever
     the broker REPORTS filled quantity — not only at a terminal `filled` — so a
     partial that is cancelled between two ticks is still recorded; on autotrade's
     paths that was the sharp edge, because a cancelled intent leaves the pending
     set permanently and nothing would ever have booked it. Each intent carries a
     `materialized_qty` / `materialized_notional` high-water mark, so repeated
     observation books only the unbooked delta and the three independent reconcile
     callers can't double-book. Later instalments blend into the single position
     each autotrade order maps to (`position_id` is one column), while the human
     ledger books independent lots. The shared guards live in
     `services/trading/fillDelta.ts` so they can't drift between paths: a decrease
     in reported quantity refuses the book outright, a total exceeding the order's
     own size is clamped (and priced at the reported average rather than a
     differenced one, which would inflate it), and every refusal is journaled.
     The bias is deliberate and one-directional — under-record and flag rather
     than inflate size or cost basis, because the latter silently corrupts every
     risk figure derived from it. The underlying broker semantics
     (`filled_quantity` as a running total) remain UNCONFIRMED against a real
     partial fill; `npm run capture:broker --watch` exists to settle it, and the
     guards above are what make correctness not depend on the answer.

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

     **Fixed (2026-07-10) — the Live positions table could go permanently stale,
     independent of `webullPositionsScheduler.ts`.** Reported after live use: entries
     and closes that both showed correctly on the Positions page were missing/stuck on
     the Auto-Trade page's own Live positions table, and a manual refresh didn't help —
     confirming it wasn't a display/polling issue but the underlying `positions` rows
     themselves. Root cause: `reconcileLiveOrders()` only detects an exit via the
     *specific* bracket order it placed and is tracking — by design, per the reviewer-2
     finding above, two exit legs both reporting FILLED is left open rather than
     guessed, and any close that happens some other way (Webull-side auto-liquidation,
     an unattributable broker response) is never detected at all. The Positions page
     stayed accurate only because `webullPositionsScheduler.ts`'s background sync
     independently diffs the journal against Webull's actual holdings and closes the
     gap — but that scheduler's account id is a *separate* Settings-page field from
     `AutotradeConfig.liveAccountId`, entered independently, with nothing keeping them
     in sync; autotrade's own live positions silently had no such backstop unless a
     user happened to also configure that unrelated feature for the same account.
     `runAutotradeLoopTick()` now calls `runWebullPositionsSync(liveAccountId)` itself,
     right after `reconcileLiveOrders()` each cycle — the exact same, already-tested
     diff-and-close/import logic the scheduler uses, reused wholesale rather than
     duplicated, but driven by autotrade's own correctly-configured account instead of
     depending on a separate feature also being set up. Order-based reconcile still runs
     first and stays authoritative when it *can* attribute a fill (a real broker price,
     not an estimate); this is purely a backstop for what it can't. No-ops when
     `liveAccountId` isn't set; wrapped in its own try/catch so a broker hiccup here
     can't take down exits, reconcile, or entries. Options live positions
     (`autotrade_live_options_positions`) are a separate table this doesn't cover — see
     the follow-up immediately below for that side.

     **Follow-up (2026-07-10), same day — the equivalent backstop for LIVE OPTIONS
     positions.** `reconcileLiveOptionsOrders()` shares the equity gap above, and is
     arguably worse: unlike equity's bracket (whose exit legs exist for the position's
     *entire* open life), an options position often has **no order watching it at all**
     for most of its life — `checkLiveOptionsExits()` only places a closing order inside
     the final `AUTOTRADE_TIME_EXIT_DAYS` (7), and only when it can get a valid quote; an
     illiquid near-expiry contract can keep failing that and leave the position invisible
     to reconcile even in principle, since `listPendingLiveOptionsOrders()` only ever
     returns rows joined against an order that actually exists. Unlike equity, there was
     no existing, already-tested Webull-holdings diff to reuse — `providers/webull/
     positions.ts` has never parsed anything beyond a single option contract, has no
     concept of a multi-leg spread, and had zero test coverage of any option position
     flowing through it. Given the stakes (a false-positive close would understate real
     exposure to the risk engine and write a guessed, not confirmed, exit price into
     realized P&L — worse than staying stale), this was a genuine design fork: build a
     full auto-closing backstop matching equity's, add a narrower one that only alerts
     without auto-closing, or just harden `checkLiveOptionsExits()`'s own persistence.
     Put to the user explicitly; the answer was the full auto-closing backstop, same
     posture as equity, accepting the added risk.
     `syncLiveOptionsPositionsFromBroker(accountId)` (`liveOptionsExecute.ts`) diffs each
     open live options position's leg(s) against `previewWebullPositions()`'s current
     holdings, reusing `contractKey()` (now exported from `providers/webull/positions.ts`)
     — the SAME already-tested per-contract matching equity's backstop uses — applied
     once per LEG rather than trying to reconstruct a whole spread from one raw payload
     row (Webull's positions endpoint has no known concept of a multi-leg strategy, and
     nothing in this codebase has ever confirmed one exists). A debit spread only closes
     once **both** legs are confirmed gone; if just one leg is missing (e.g. early
     assignment on the short leg), that's a materially different, ambiguous situation
     left open rather than guessed — same "don't guess" posture as equity's own ambiguous
     exit-leg handling. `runAutotradeLoopTick()` calls it right after
     `reconcileLiveOptionsOrders()` and before `checkLiveOptionsExits()`, same ordering
     logic as the existing comment there (a position this just closed shouldn't also get
     a wasted new closing order placed for it the same tick). Exit price is a current
     quote via `fetchContractMark()` (already used elsewhere in this file), never
     guessed — if it can't be fetched, the position is left open to retry on a later
     sync, same as equity's own `closePositionsFromPreview`. Unlike equity's *silent*
     broker-truth close, this DOES journal a `live_options_position_closed` event
     (`detail.via: 'broker_sync'`) on every close it makes — deliberately more visible
     than equity's precedent, since this per-leg matching is new and unvalidated against
     a real account's multi-leg holdings; `exitReason` is stored as `'manual'` (the
     closer of the two values the `exit_reason` CHECK constraint allows, to avoid a
     schema migration against the already-deployed table — `'time_exit'` would
     misleadingly imply `checkLiveOptionsExits()` placed a real closing order); the
     journaled event's own `detail.via` is what actually distinguishes it. No-ops without
     a `liveAccountId`; wrapped in its own try/catch so a broker hiccup here can't take
     down exits, reconcile, or entries either.

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

     **Follow-up, added 2026-07-09 — repeated live-order-rejection alerting.** The
     sub-penny bracket bug (below) rejected 2000+ live entries before anyone noticed,
     precisely because the alerting above only fires on SUCCESS (a placement) and on the
     kill-switch engage — a systemic run of REJECTIONS pushed nothing. Closed by
     `services/autotrading/liveFailureAlert.ts`'s `maybeAlertLiveOrderFailures()`, called
     once per tick from `runAutotradeLoopTick`'s `finally` (so it runs regardless of
     which return path the tick took — failures are journaled by both the exit/reconcile
     and the entry stages). It derives entirely from the append-only journal
     (restart-safe, no separate counter to drift): it counts consecutive broker/quote
     rejections (`live_entry_failed` / `live_options_entry_failed` /
     `live_options_exit_failed`) since the last successful placement
     (`live_order_placed` / `live_options_order_placed`), and when that count reaches the
     threshold (3) fires ONE alert naming the count and the latest symbol/reason, then
     re-reminds at most hourly while the streak persists, resetting the moment an order
     gets through. Re-reminders are additionally suppressed while the market is closed:
     entries are session-gated, so out of session the streak can neither grow nor
     resolve, and a Friday streak once re-paged hourly all weekend saying nothing new.
     The FIRST alert of a streak is deliberately not gated — an out-of-session failure
     (a time-exit's close attempt, say) is new information and pages regardless of the
     clock; at the next open one reminder may fire, then the first success clears it. Scoped to the broker-REJECTION class only, NOT guardrail `*_blocked`
     events (a kill switch or a cap is the system correctly refusing — expected, and the
     kill-switch engage already alerts). A `live_failure_alerted` marker event is
     journaled so the throttle survives a restart. Best-effort like the rest, through the
     same `dispatchNotifications()` path.

     **Follow-up, added 2026-07-11 — daily-drawdown-halt alerting.** Closes the other gap
     the paragraph above deliberately left open. `services/autotrading/dailyHaltAlert.ts`'s
     `maybeAlertDailyDrawdownHalt()`, called the same way as
     `maybeAlertLiveOrderFailures()` (once per tick, from the `finally`) — since the halt
     is recomputed fresh on every risk-check rather than a persisted state, "already
     alerted for today" is what's tracked instead of "just tripped": a `daily_halt_alerted`
     marker event (journaled the same restart-safe way) records the (ET) trading day and
     which of the three independent pools — paper, live, live options — it covers, since
     `dashboard.ts`'s own header comment already establishes those as three separate daily
     P&Ls against the one shared % cap. Reads `getAutotradeDashboard()` directly rather
     than re-deriving the numbers — the exact figures already computed there, not a second
     implementation. Alerts once per pool per day the first time that pool's `dailyPnl` is
     found at or past its halt level; the next day's fresh P&L naturally clears the
     throttle (no explicit "un-halt" notification, mirroring the kill-switch's
     release-doesn't-alert convention). Paper is included despite the "no real financial
     exposure" reasoning above — the loop runs unattended, and a config/strategy having a
     bad-enough paper day to trip its own configured cap is worth knowing without having
     the page open, the same way the live case is.

     **Follow-up, added 2026-07-09 — sub-penny bracket price rejected every live
     order.** Confirmed in production: every live entry attempt failed with Webull's
     `Price increment should be 0.01 when price is equal to or greater than 0.9999`
     (2,000+ blocked attempts). Root cause: `generateSignal()` computed `stop`/`target`
     as pure ATR-multiple arithmetic (`entry ± stopAtrMultiple × atr`, then a further
     R-multiple for the target) with no rounding, and `attemptLiveEntry()` passes them
     straight through as a live bracket order's `bracket.stopLossPrice`/`takeProfitPrice`
     — an ATR-derived distance is essentially never an exact cent, so **every** live
     bracket order carried a sub-penny stop/target leg, and Webull rejects the whole
     bracket (all three legs) if any one leg isn't a clean $0.01 increment. Fixed at the
     source (`decide.ts` now rounds `entry`/`stop`/`target` to the cent) and defensively
     at the broker boundary (`providers/webull/orders.ts`'s `priceStr()` now rounds
     every price it stringifies — limit/stop fields, bracket exit legs, spread net
     debit/credit, and replace patches — so no other caller, present or future, can
     reintroduce the same failure mode). Regression tests for both layers, each
     verified by reverting the fix and confirming it fails against the old code.

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
   displaying it. *(Revised 2026-07-09 — see the follow-up after this item: the
   fallback is now used here too, by explicit request.)*
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
   decision, on the same already-screened/volatility-filtered candidates *(narrowed
   2026-07-09 — see the follow-up below)*, since IV-history accrual only happens by
   actually running this every cycle. Exposed in the UI as a new **Options** column on
   the existing candidates table (Auto-Trade page) plus a **No options signal** list
   mirroring the equity "no signal" section, and in the API as a third `optionsDecision`
   field alongside `screen`/`decision` on the existing `POST /api/autotrade/decide`
   response — not a separate endpoint, since it consumes the exact same screened
   candidates in the same preview round-trip.

   **Follow-up (2026-07-09) — mover-sourced candidates could never clear the IV-rank
   gate; loosened the gate itself, by explicit request.** Reported as "every options
   candidate blocked, every cycle" — confirmed against a real run where all seven
   rejections were either the DTE-window check (a genuine "no listed expiration in
   [7,60]d today" fact for thin/small-cap chains, not a bug) or exactly this IV-rank gate,
   every one showing 1 real sample. Root cause: `db/ivHistory.ts` records one ATM-IV
   sample per **calendar day** a symbol is screened, and `discoverSymbols()`
   (`screen.ts`) draws candidates from the persistent universe list **plus** Webull's
   premarket gainers/unusual-volume movers — an essentially different set of speculative
   small-caps every day. A mover-sourced symbol almost never gets screened again, so it
   can never accumulate the 15 days of history phase 9 requires — not a temporary
   bootstrapping gap for it, a permanent dead end. Two changes, both to
   `services/autotrading/loop.ts`/`optionsDecide.ts`:
   1. **Options decision now only sees `discoverySource: 'universe'` candidates** —
      `runAutotradeLoopTick()` filters `passedVolatility` before calling
      `runOptionsDecision()` (new `optionsCandidatesConsidered` on `LoopTickSummary` for
      visibility). Equity autotrading is unaffected — it still gets movers for momentum/
      breakout. The universe list is screened every cycle, so it's where 15-day history
      can actually compound.
   2. **The `computeIvContext()` hv-estimate fallback is now used here too** — the exact
      mechanism `routes/options.ts`'s `ivContextFor` already uses for the human page
      (candles fetched only when real history is short, same lazy condition), reversing
      phase 9's original "deliberately stricter" choice above. Realized volatility is
      computed from historical price candles that already exist in bulk, so unlike
      forward-accumulating IV history it has no ramp-up at all. Still fails closed if
      *neither* real history *nor* enough price history exists; a signal built from the
      fallback says so in its `rationale` (`ivContext.method` is never silently presented
      as real history). This was a deliberate, requested loosening of a documented
      quality bar, not a bug fix — the user explicitly asked for it after weighing the
      trade-off (start testing sooner vs. slightly lower-confidence IV data on some
      signals).
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
    available side by side. Was single-leg options only, matching
    `simulateOptionsBacktest()`'s own scope at the time — the debit-spread signal shape
    (phase 9/10's other follow-up) hadn't been extended to either backtest engine.
    **Fixed (2026-07-04) — Task #69, backtesting.** Both `simulateOptionsBacktest()` and
    `simulateCombinedBacktest()` now simulate a `'debit_spread'` run when
    `optionsDecisionConfig.strategyType` says so (same field the live loop already reads;
    the Auto-Trade page's backtest buttons now thread the SAME **Options strategy**
    setting shown in Configuration, rather than silently always backtesting single-leg).
    A new `pickShortLegReferenceContract()` (exported from `optionsBacktest.ts`, reused
    unchanged by `combinedBacktest.ts`) finds the short leg the same way the live decision
    engine does: nearest contract strictly further OTM than the long leg, in the SAME
    expiration, whose delta (recomputed via Black-Scholes from that day's historical
    price, matching the long leg's own existing simplification) falls within the exact
    same exported `SHORT_LEG_DELTA_BAND` `optionsDecide.ts` uses live — reused, not
    re-guessed, so backtest and live can never drift on this threshold. A spread fills
    and closes BOTH legs together or not at all (mirrors `optionsExecute.ts`'s paper-
    execution atomicity), and its P&L nets both legs' premiums first —
    `(netValueAtExit − netDebitAtEntry) × contracts × 100`, via a shared
    `simulatedOptionsPnl()` helper — rather than the single-leg `(exit − entry) ×
    contracts × 100` formula. `SimulatedOptionsTrade` gained a `kind` discriminator plus
    `short*` fields (mirroring the paper-position schema's own long/short split); the
    options and combined backtest trade tables render a spread's strikes as `long/short`
    and net its Entry/Exit $ columns the same way the Options paper positions table does.
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

    (Superseded below — see item 14: options ended up with its own dedicated live gate,
    caps, and probation window after all, not the same phase 8 flag as originally
    expected here.)

14. **Live options trading gate — shipped, adversarial review done.** The phase 8
    equivalent for options: a manual flag flip that lets the loop place REAL options
    orders (single-leg AND debit-spread) through Webull, once the user's explicit
    go-ahead confirmed three open questions: the enable gate is a checkbox
    (`liveOptionsEnabled`) nested UNDER `liveTradingEnabled` with NO second typed
    confirmation (the master phrase already covers "real money is now live"); the
    guardrail caps are DEDICATED (`liveOptions*`, separate from equity's own live caps,
    since options size risk-based on premium rather than share count); and BOTH
    single-leg and debit-spread signals are live-eligible from day one, not
    single-leg-first as originally recommended. Broken into independently-mergeable
    steps, mirroring phase 8's own:
    - **Step A — config & schema.** `liveOptionsEnabled`, `liveOptionsEnabledAt`
      (anchors its OWN probation window, separate from equity's `liveEnabledAt` —
      options can go live weeks after equity), the dedicated cap set
      (`liveOptionsMaxOrderUsd`, `liveOptionsMaxDailyLossUsd`,
      `liveOptionsMaxOrdersPerDay`, `liveOptionsFatFingerPct`), and its own probation
      fields (`liveOptionsProbationTrades`, `liveOptionsProbationSizeMultiplier`).
      Setting `liveOptionsEnabled: true` fails closed unless `liveTradingEnabled` is
      already (or concurrently, in the same request) true. Two new tables, parallel
      to the paper options shape rather than reusing `positions` (which has no
      column for a debit spread's second leg): `autotrade_live_options_positions`
      and `autotrade_live_options_orders` — the latter tracks entry/exit intents via
      a `role` column instead of a bracket child leg, since autotrade's options
      signals never carried a price-based stop/target to begin with (phase 12's
      close-only, time-based exit design), so there's no broker bracket to poll for
      here.
    - **Step B — live execution service (entry).**
      `services/autotrading/liveOptionsExecute.ts`'s `attemptLiveOptionsEntry()` for
      both single-leg (a marketable LIMIT above the fresh mark) and debit-spread (one
      VERTICAL combo order, both legs priced and submitted atomically) signals.
      Guardrails run against the dedicated caps; probation is tracked independently
      via `liveOptionsEnabledAt`. `runLiveOptionsExecution()` batches candidates
      against a running total that folds in live EQUITY's current book
      (`getLivePortfolioSnapshot()`) — the same one-real-account combined-budget
      reasoning already applied to the paper books, one-way for now (the reverse —
      equity's own batch seeing live options' book — is Step D's job, mirroring how
      paper's own bidirectional seeding was completed at the loop level).
    - **Step C — exit + reconciliation.** `checkLiveOptionsExits()` mirrors the paper
      options time-exit trigger but PLACES a real closing order instead of recording
      a paper close — a single-leg sells to close; a debit spread closes both legs
      together as one VERTICAL combo (long leg flipped to sell, short leg flipped to
      buy back), mirroring `providers/webull/orders.ts`'s `optionBracketExit()`
      side-flip rule — the closest existing "flip an entry to close it" precedent,
      since no code anywhere in this app had closed a spread via a real order
      before, human or automated. `reconcileLiveOptionsOrders()` polls every pending
      entry/exit intent and materializes the result (opens or closes a live options
      position). A live combo fill reports one NET price, not a per-leg breakdown,
      so a spread's stored entry/exit price carries the whole net debit/credit
      rather than paper's true per-leg fidelity — mathematically equivalent for P&L
      (the formula already treats a missing short-leg price as a zero contribution).
      Surfaced, not fixed, here: a single-leg sell-to-close depends on
      `evaluateGuardrails()`'s naked-short check seeing the already-held long via
      the broker's own reported position — unconfirmed against a real account
      whether that reporting correctly covers OPTION holdings the same way it does
      stock. Fails closed if not (the exit gets blocked, not mis-placed).
    - **Step D — wire into the loop + UI.** `runAutotradeLoopTick()` gates live
      options entries behind everything phase 8's own live gate requires PLUS
      `liveOptionsEnabled` specifically. A "Live options trading" checkbox and its
      own caps editor nested inside the existing "Live trading" section (shown only
      once live trading itself is enabled, matching the gate's own nesting), its own
      probation status, a **Live options positions** table, and a **Live options**
      block in the Monitoring dashboard — mirroring phase 8 Step D's own additions.
    - **Adversarial review — done, two reviewers, matching phase 8's own
      precedent** (real money rather than paper). Reviewer 1 (gating/safety
      invariants) found two real gaps, both fixed: `checkLiveOptionsExits()` —
      unlike equity, whose exits are 100% broker-bracket-driven and never
      place a new order — never checked the deploy-level `TRADING_ENABLED`
      env gate before placing a real closing order; and that same function
      reused ONE stale config snapshot across its whole per-tick loop over
      multiple triggered positions, so a kill switch engaged mid-loop
      wouldn't stop the next position's close until the next cycle (the same
      bug class already fixed for entries). Reviewer 1 also found that the
      naked_short guardrail on a single-leg close trusted
      `webullAccountState()`'s account-wide position aggregate, which sums
      ALL same-symbol positions (stock and every option contract alike) with
      no asset-type/strike/expiration filter — confirmed this can fail OPEN
      (wrongly allow a sell), not just closed as an earlier version of this
      code assumed; fixed by feeding the guardrail this system's own ledger
      quantity for the position being closed instead of the broker's
      aggregate. Reviewer 2 (reconcile/probation/data-integrity) was cut off
      by a session limit mid-review; the remaining checklist (double-
      materialization safety, the pending-orders query, error isolation
      during materialization, probation counting, the combined-budget batch
      math, and order-submission idempotency) was independently completed by
      re-reading the code directly — all confirmed correct or consistent with
      an already-accepted phase-8 precedent (a materialization failure is
      journaled loudly and the row stays visibly stuck for a human to notice,
      not silently retried — the same known tradeoff phase 8 itself accepted).
      Verification also caught and fixed a pre-existing, unrelated test-
      isolation flake in `autotradeLoop.test.ts` (a shared-config field left
      set by a different, older test file could leak into a later test
      depending on vitest's non-alphabetical file execution order) —
      reproduced directly, fixed, and confirmed clean across ten consecutive
      full-suite runs.
    - **Follow-up, hardening deep-dive (2026-07-09).** After the live equity
      sub-penny bracket bug (item 8's own 2026-07-09 follow-up), a broader
      broker-boundary audit of the live options path found the EXIT side built
      its closing limit from a raw mark with no validity guard, unlike the
      entry side (`attemptLiveOptionsEntry`'s `validPremium`/`netDebit > 0`
      checks). A near-worthless or unquoted contract marks at 0 — or a
      crossed/stale spread quote gives `netValue <= 0`, or a value tiny enough
      that the sell-side marketable buffer rounds it to 0 — so the close's
      `limitPrice` would be `<= 0`, the `limit_price > 0` guardrail would reject
      it EVERY cycle, and the position would never auto-close (drifting to
      expiration, the exact outcome the time-exit exists to prevent).
      `placeLiveOptionsExit()` now guards the computed `limitPrice` with
      `validPremium()` on both the single-leg and spread branches, skipping that
      cycle with a precise, journaled reason instead of spinning on an
      unplaceable order; regression-tested (single-leg mark 0, crossed spread)
      and revert-verified. Two related broker-boundary items were characterized
      but deliberately NOT changed, as a blind fix would do more harm than good:
      (1) option prices are rounded to the cent but not to a $0.05 tick, which
      non-penny-pilot classes require at premium >= $3 — but blindly rounding to
      nickels would corrupt the many liquid penny-pilot names that legitimately
      trade in cents, so the correct fix must key off real per-symbol tick data
      or a live preview, driven by an actual observed options rejection rather
      than speculation; (2) strikes serialize via bare `String(strike)` (`"100"`
      not `"100.0"`) — but that matches the format `orders.ts` was originally
      built against and that real orders have used, so changing it speculatively
      risks breaking working orders. Both are flagged for confirmation against a
      live option preview.
    - **Follow-up, hardening deep-dive — CRITICAL cross-tick double-open
      (2026-07-09).** Two independent audits (idempotency and error-isolation)
      both confirmed the same critical bug: the live entry paths deduped only
      against an OPEN POSITION, but a live position materializes only when a
      FULL fill reconciles, so an entry order still working / partially filled /
      not-yet-materialized across a loop-tick boundary was invisible — the next
      tick re-emitted the same signal (the decision stage is a stateless pure
      transform) and placed a SECOND real order for that symbol (double size,
      two OCO bracket pairs for equity). The exit path already deduped against
      pending orders (`listPendingLive(Options)Orders`); the entry path never
      did. Fixed on BOTH asset classes: `attemptLiveEntry` /
      `attemptLiveOptionsEntry` now refuse when any pending (working /
      filled-unmaterialized / open) autotrade order exists for the symbol — the
      authoritative choke-point guard — and `runLiveExecution` /
      `runLiveOptionsExecution` fold those symbols into `skipSymbols` so a known
      dup isn't even risk-checked. Regression-tested on both paths and
      revert-verified. The loop tick itself was confirmed non-reentrant
      (`tickInFlight` is set with no `await` between check and set), so this was
      a sequential-tick, not an overlap, bug.
    - **Follow-up, hardening deep-dive — options-exit materialization now
      retries (2026-07-09).** The error-isolation audit found `reconcileLive-
      OptionsOrders` transitioned an exit intent to the terminal `filled` state
      and materialized the close in the SAME pass; if `closeLiveOptionsPosition`
      threw after that transition committed, the `isTerminal` short-circuit
      skipped the row on every later pass — the position stayed `open` in our
      ledger forever while flat at the broker (polluting open-risk / the
      combined budget and blocking any new position on that symbol). Unlike
      equity, whose exit detection is a separate `state === 'filled'` block that
      re-runs every tick and so self-heals. Fixed by adding a retry branch: an
      already-`filled` EXIT that's still pending (its position still open)
      re-attempts the (idempotent) close each tick until it succeeds; the shared
      materialize+isolate logic was extracted into `materializeLiveOptionsFill`.
      ENTRY rows are deliberately left one-shot (re-creating a position isn't
      idempotent — a create-then-link that threw after the create would
      double-open), matching equity's own accepted entry precedent; a failed
      entry-materialize stays loudly journaled. Regression-tested (close throws
      on pass 1, succeeds on the retry) and revert-verified. The two remaining
      lower-severity error-isolation gaps — a broker-accepted order whose
      tracking row fails to write becomes reconcile-invisible, and a
      place-timeout can throw despite the "never throws" contract — remain
      tracked for follow-up (both require a rare better-sqlite3 write or network
      throw; the broker layer itself never throws).
    - **Follow-up, hardening deep-dive — combined-budget same-tick double-spend
      (2026-07-09).** The sizing audit confirmed a HIGH-severity over-risk bug:
      the live equity and options batches run sequentially within one tick
      (equity first), but a live fill only becomes a `positions` row on a LATER
      reconcile tick — so the options batch's risk seed (built from open
      POSITION rows) couldn't see the equity orders just placed this tick, and
      re-spent the same headroom. At $100k / 2% aggregate cap, equity could
      place $2,000 of risk and options another $2,000 the same tick = $4,000 =
      2× the cap (and 2× maxConcurrentPositions). Paper never hit this (paper
      positions write synchronously). Fixed by seeding BOTH batches from a new
      `combinedLiveOpenRisk()` (liveExecute.ts) = open positions of both books
      PLUS every placed-but-not-yet-materialized order (`pendingLiveOrdersRisk`
      / `pendingLiveOptionsOrdersRisk`, position_id IS NULL, so no double-count
      with materialized positions). This also closes the pre-existing one-way
      gap (equity's batch never saw options risk at all) and cross-tick still-
      working orders. Regression-tested (a pending equity order blocks an
      options entry a position-only seed would have allowed) and revert-verified;
      full suite green across repeated runs. The audit CLEARED probation
      counting, cap 0/negative handling (all fail closed), the options ×100
      multiplier, and sizing-vs-cap consistency.
    - **Follow-up, hardening deep-dive — error-isolation backstops (2026-07-09).**
      Two low-probability gaps from the error-isolation audit (both need a rare
      network/DB throw; the trigger was never observed): (1) `webull/client.ts`'s
      `call()` promised "never throws" but a `fetch` rejection (network error or
      the timeout abort) propagated out — and `webullPlaceOrder` relies on the
      contract, since a throw would unwind BEFORE the intent is recorded,
      orphaning an order that may have reached the broker. `call()` now catches
      the rejection and retries (idempotent — the `client_order_id` is built once
      outside the retry loop, same as the 429 path) or returns a clean
      `{ok:false,status:0}`. (2) `runLiveExecution` / `runLiveOptionsExecution`
      awaited each candidate's `attemptLive*Entry` with no `try/catch`, so a rare
      throw aborted the rest of the batch; each candidate is now isolated (a
      throw becomes that candidate's failure outcome, the batch continues).
      Regression-tested and revert-verified. Two residuals remain DOCUMENTED, not
      fixed (both need a rare better-sqlite3 write to throw in a narrow window,
      and both are self-limiting): a broker-accepted order whose tracking-row
      INSERT then throws is reconcile-invisible until a human notices (a full fix
      needs a write-ahead of the tracking row before the broker ack — a larger
      change than the risk warrants); and a `transitionIntent` throw inside a
      reconcile loop aborts that tick's remaining reconciles but self-heals on
      the next tick (the rows stay pending). This completes the live-trading
      hardening deep-dive — every CONFIRMED audit finding is fixed, and the
      remaining items are documented tail-risk.
15. **Equity bidirectional (long/short) trading — shipped (2026-07-15).**
    Reported directly: the loop only ever traded one direction at a time —
    every candidate in a given screen/decide/loop cycle was scored and signed
    as either all-long or all-short, never a mix, even though the underlying
    scoring engine has always been able to mirror its own math for either
    side. Requested: score and trade **both** directions in the same cycle,
    picking whichever side actually fits each candidate — plus a follow-up
    phase (16, below) extending the same idea to options calls/puts.
    - **Per-candidate scoring.** `indicators/screener.ts`'s new
      `scoreSymbolBothDirections()` computes a symbol's indicators once (the
      expensive part) and scores it as long AND short from that same
      snapshot, reusing the existing direction-aware momentum/RSI math
      unmodified (the mirroring the About page and User Guide already
      documented). `services/autotrading/screen.ts`'s new `pickDirection()`
      picks whichever side actually qualifies and scores higher (ties favor
      long); `runAutotradeScreen` takes a `directionMode: 'long' | 'short' |
      'both'` option — in `'both'` mode each candidate carries its own
      resolved `direction`, so a single screen can return some symbols long
      and others short. `services/autotrading/decide.ts`'s `generateSignal`
      now reads the side straight off the candidate (`candidate.direction`)
      instead of a single batch-wide `DecisionConfig.direction`, which is
      removed — a signal's side was never meaningfully "configured" once
      candidates can differ, only "read."
    - **Config & routing.** `AutotradeConfig` gains `tradeDirection: 'long' |
      'short' | 'both'` (default `'long'`, matching every cycle before this
      phase exactly, so leaving it untouched changes nothing), routed
      through `PUT /api/autotrade/config`. `POST /api/autotrade/screen` and
      `/decide` accept an optional `directionMode` that defaults to the
      saved `tradeDirection` when omitted (so the manual preview shows what
      the loop would actually do), and the live loop
      (`services/autotrading/loop.ts`) always passes its own
      `config.tradeDirection` through. Backtesting keeps its established
      self-contained-hypothesis convention instead: `BacktestConfig`'s own
      `directionMode` does **not** fall back to the live config when
      omitted — it defaults to `'long'` via the screener config's own
      default — so a backtest run is reproducible from its own saved
      parameters regardless of what the live loop is configured to trade
      right now.
    - **The risk asymmetry that shaped the scope.** An equity short carries
      theoretically unlimited downside, unlike every position this app has
      ever taken live before (long stock, long calls, long puts — always
      capped at what was paid). A live equity short now runs into the same
      `naked_short` guardrail (`services/trading/guardrails.ts`) the manual
      Trade page has always enforced for human-placed short orders —
      previously unreachable from autotrade, since autotrade never
      generated a sell-to-open signal. `AutotradeConfig.liveAllowNakedShort`
      (pre-existing, defaulted `false`) is now autotrade's own gate on it:
      with `tradeDirection` set to `short` or `both` but
      `liveAllowNakedShort` left off, the loop still screens, decides, and
      risk-checks short candidates normally and opens them in **paper**
      (a local simulation carries no real exposure, so it has no such
      gate), but a live entry attempt is blocked at the guardrail with no
      order sent to the broker — verified in
      `test/autotradeLiveExecute.test.ts`. Options puts needed no equivalent
      new gate: an autotrade options position is always long-the-contract
      (buying a put to express a bearish thesis, same as buying a call for
      a bullish one — see phase 9's existing "long put" flow in Research &
      Screen), which is already defined-risk, so nothing changed for
      options in this phase.
    - **Bug found and fixed along the way: correlated-exposure netting.**
      `riskCheck.ts`'s `correlatedNotional()` (and backtest's parallel
      `backtestCorrelatedNotional()`) summed every correlated position's
      full notional as risk added, regardless of which side it was on — so
      a correlated position that was actually a **hedge** (opposite side
      from the candidate) was double-counted as compounding risk instead of
      recognized as a partial offset. Both now net by side: a correlated
      position on the **same** side as the candidate still adds (byte-
      identical to the pre-existing long-only behavior), one on the
      **opposite** side subtracts, and the running total is floored at $0
      (a hedge can reduce the counted exposure toward zero, never below
      it, and never "banks" a credit against other, unrelated risk). Every
      options-only call site (`optionsRiskCheck.ts`, `optionsExecute.ts`,
      `liveOptionsExecute.ts`, `combinedBacktest.ts`'s options leg) passes a
      constant `'long'` for both the candidate and every options position,
      since options are always long-the-contract — this fix is a pure no-op
      for every options-only path and only changes behavior where a real
      opposite-side equity position exists. Covered by a dedicated
      `test/correlatedNotional.test.ts`.
    - **UI.** The Auto page's Configuration card gained a **Trade direction**
      select (Long / Short / Both, saves immediately like the existing
      options-strategy select) with an inline hint about the
      `liveAllowNakedShort` interaction whenever it's not Long. The
      Research & Screen candidates table gained a **Dir** column (a
      long/short badge per row) — informative in every mode, but only
      capable of differing row-to-row once Trade direction is Both.
    - **Known gap, documented rather than built:** the Auto page's backtest
      form has no control for `directionMode` yet — a UI-initiated backtest
      always runs the engine's own `'long'` default regardless of the live
      loop's saved `tradeDirection`, even though the backtest **engine**
      (`simulateBacktest`) fully supports all three modes and is reachable
      today via a direct `directionMode` field in the API request body. Left
      out of this phase to keep it scoped; a form control is a natural
      follow-up, not a blocker for anything above.
    - **Scope boundary:** this phase is equity-only. Options calls/puts
      per-candidate assignment, reusing this same directional read, is
      phase 16 below.
16. **Options call/put per-candidate assignment — shipped (2026-07-16).**
    Closes phase 15's own scope boundary: options call/put now follows each
    candidate's own resolved direction (long → call, short → put) instead
    of a single setting applied to every candidate in a run.
    - **Live loop & manual preview: a one-line read, not new routing.**
      `optionsDecide.ts`'s `generateOptionsSignal()` now derives
      `side` from `candidate.direction` instead of a `cfg.direction` field,
      which is removed from `OptionsDecisionConfig` entirely (the same
      treatment `DecisionConfig.direction` got in phase 15, for the same
      reason: a per-candidate value can't meaningfully be "configured" at
      the batch level, only read). No routing changes were needed in
      `loop.ts` or `routes/autotrade.ts`'s `/decide` — both already pass
      options decisioning the SAME `ScreenCandidate[]` equity's own
      decision just consumed, and that array already carries the correct
      per-candidate `.direction` (phase 15). A batch scored with
      `tradeDirection:'both'` therefore produces a genuine mix of calls and
      puts with zero additional wiring — verified live against the mock
      provider: every row's equity Dir badge and Options call/put badge
      matched, symbol for symbol, in a real browser render.
    - **`optionsBacktest.ts`: its own `directionMode`, full `'both'`
      support.** Replaced the single `optionsDecisionConfig?.direction`
      read (resolved once, outside the day loop) with `directionMode:
      'long' | 'short' | 'both'` on `OptionsBacktestConfig` — own value,
      not inherited from live config, same self-contained-hypothesis
      convention `BacktestConfig.directionMode` already established. In
      `'both'` mode its internal equity-scoring loop now calls
      `scoreSymbolBothDirections()`/`pickDirection()` per symbol (mirroring
      `backtest.ts`'s own upgrade) instead of single-direction `scoreSymbol()`,
      and `side`/`entryCfg` — previously computed ONCE for the whole
      run — are now resolved per candidate inside the day loop
      (`sideFor()`/`entryConfigFor()` helpers), since a candidate's call/put
      contract, delta band, and IV-rank ceiling all key off its own side.
      The already-open-position time-exit check needed its own
      `exitMinDaysToExpiration` constant, since the DTE window doesn't vary
      by side but is checked before that day's candidates (and so before
      any side) are known.
    - **`combinedBacktest.ts`: the equity leg gets bidirectional too,
      closing the gap this file's own code comment flagged in phase 15.**
      Its equity-scoring loop (`scoresToday`) previously used
      single-direction `scoreSymbol()` unconditionally, because — per that
      comment — both legs read the same scoring pass and options
      direction-awareness didn't exist yet to make upgrading it worthwhile
      on its own. Now: `scoresToday` resolves each symbol's direction the
      same way (`scoreSymbolBothDirections()`/`pickDirection()` in `'both'`
      mode) and carries it alongside each score; the equity leg's
      `generateSignal()` call reads it directly (replacing a constant
      `screenerCfg.direction`), and the options leg derives its own
      `side`/`entryCfg` from that SAME per-symbol resolved direction
      (replacing the static `optDirection`/`optSide` computed once outside
      the day loop) — so a long equity signal and its matching call, or a
      short equity signal and its matching put, always agree, sharing the
      one combined risk ledger phase 11 already built. New
      `CombinedBacktestConfig.directionMode` field, same self-contained
      convention as the other two engines.
    - **Routing:** `routes/autotrade.ts`'s `optionsBacktestBodyBase` and
      `combinedBacktestBodyBase` gained a `directionMode` field (previously
      absent from both schemas entirely — only the equity `/backtest` route
      had one), threaded straight into `runOptionsBacktest`/
      `runOptionsWalkForwardBacktest`/`runCombinedBacktest`/
      `runCombinedWalkForwardBacktest`, same non-inherited convention.
    - **No new risk gate.** Confirms phase 15's own reasoning: an autotrade
      options position is always long-the-contract regardless of call or
      put (buying a put to express a bearish thesis is still bounded risk,
      same shape as buying a call), so nothing analogous to equity's
      `liveAllowNakedShort` gate was needed for this phase.
    - **UI: no new UI needed.** The Research & Screen candidates table's
      Options column already rendered whatever `side` the API returned —
      it never assumed a fixed direction. The existing **Trade direction**
      select (phase 15) now transparently governs options call/put too,
      exactly as scoped: reusing the equity directional read, not a second,
      options-specific direction setting.
    - **Verified:** every new/changed test (`optionsDecide.ts`'s existing
      direction-locking tests updated for the removed `cfg.direction`, a
      new mixed-batch call+put test, `optionsBacktest.ts`'s and
      `combinedBacktest.ts`'s own `'both'`-mode tests, four new route
      integration tests) confirmed genuinely failing on a reverted source
      change before being restored, matching phase 15's own discipline.
    - **Known gap, carried forward:** the backtest FORM UI still has no
      control for `directionMode` (phase 15's own noted gap, now true of
      all three backtest routes — equity, options, and combined — not just
      the equity one), even though all three engines fully support it via
      a direct API request.

**Follow-up (2026-07-16) — closes the backtest-form gap noted in phases 15 and 16.**
The Auto page's Backtest & walk-forward card gained its own **Backtest trade
direction** select (`Long`/`Short`/`Both`), a single shared field threaded into
all three run buttons (equity, options, combined) and both walk-forward
variants — own value, not synced from Configuration's `tradeDirection`, same
self-contained-hypothesis convention as the card's existing (also independent)
risk-profile field. `web/src/api/types.ts`'s `BacktestRequest`,
`OptionsBacktestRequest`, and `CombinedBacktestRequest` each gained an optional
`directionMode` field to carry it. No server-side changes were needed — the
routes and engines already supported `directionMode`, they just had no UI
reaching them.

17. **Options price-based exits: stop-loss / take-profit — shipped
    (2026-07-16).** Phase 12 shipped options exits as **close-only and
    time-based** — a position only ever left automatically via
    `timeExitDaysBeforeExpiry`, with take-profit/stop-loss/delta-drift
    explicitly deferred to human review. This phase adds a %-of-premium
    stop-loss and take-profit on top, reusing `exitRules.ts`'s pre-existing
    `evaluateExit()` engine unchanged (it already supported `stopLossPct`/
    `takeProfitPct`/delta-drift; only `timeExitDaysBeforeExpiry` was wired
    up before now).
    - **Scope boundary: PAPER + BOTH BACKTEST ENGINES only, not LIVE.**
      Mirrors phase 9-13's own equity precedent — the trailing-stop/
      breakeven/partial-exit feature is also paper+backtest only, LIVE
      equity positions untouched, on the stated reasoning that modifying or
      partially closing a resting live bracket has no existing precedent
      and a meaningfully worse failure mode than a force-close does. The
      same reasoning applies here: LIVE options positions stay time-exit-
      only (unchanged) rather than threading a dynamic exit reason through
      the live order-placement/reconcile/materialization pipeline.
    - **Config.** `AutotradeConfig.optionsStopLossPct`/`optionsTakeProfitPct`
      (0-100, both default `0` = disabled — an untouched config changes
      nothing), routed through `PUT /api/autotrade/config` and all four
      backtest routes (`/backtest-options`, `/backtest-options/walk-forward`,
      `/backtest-combined`, `/backtest-combined/walk-forward`). The two
      backtest engines' own config fields are optional and NOT inherited
      from the live config when omitted, same self-contained-hypothesis
      convention as every other backtest field — a saved backtest run stays
      reproducible from its own parameters.
    - **Net-debit basis for spreads.** The %-of-premium calculation for a
      debit spread uses `entryPremium - shortEntryPremium` (net debit) as
      the basis, not the long leg's raw premium alone — matching the
      existing `optionsPnl()`/`simulatedOptionsPnl()` functions' own
      established basis, so a stop/target percentage means the same thing
      it already means everywhere else P&L is reported.
    - **`optionsExecute.ts`: an efficiency-preserving gate, not an always-on
      poll.** `checkOptionsPaperExits()` only fetches a quote unconditionally
      every cycle when a price rule is actually configured
      (`optionsStopLossPct > 0 || optionsTakeProfitPct > 0`); with both left
      at their 0 default, behavior — and provider-call cost — is
      byte-identical to before this phase (no fetch until the quote-free
      time-exit trigger fires, then one fetch to price the close).
    - **`optionsBacktest.ts` / `combinedBacktest.ts`: no new cost.** Both
      engines already fetch each day's bar close to check the time-exit
      rule; the stop-loss/take-profit check reuses that same close via one
      `evaluateExit()` call (passing the simulated day as `now`, never the
      real wall clock) instead of a second pass.
    - **Schema.** `autotrade_options_paper_positions.exit_reason` gains
      `'stop_loss'`/`'take_profit'` alongside the existing `'time_exit'`/
      `'manual'` (SQLite can't widen a CHECK in place, so
      `rebuildAutotradeOptionsPaperPositionsTable()` copies rows through a
      fresh table on startup, same rename/create/copy/drop dance as the
      equity paper-positions table's own migration, guarded so it runs
      once). LIVE options positions' own schema is untouched — still
      `'time_exit'`/`'manual'` only, matching the scope boundary above.
    - **UI.** The Auto page's Configuration card gained **Options stop-loss
      (%)** and **Options take-profit (%)** fields (Save button per field,
      matching the existing partial-exit-size field's pattern); both hints
      call out that they're paper/backtest-only and that LIVE stays
      time-exit-only. The options backtest trades table and options paper
      positions table both color-code the exit-reason badge (green
      take-profit, red stop-loss) alongside the existing slate/blue
      end-of-period/time-exit cases; the LIVE options positions table is
      unchanged, matching the scope boundary.
    - **Verified:** every new/changed test (across `optionsExecute.ts`,
      both backtest engines, the config sanitizer, the DB schema/migration,
      and the UI) confirmed genuinely failing on a reverted source change
      before being restored. The coverage sweep also caught a latent bug
      class worth calling out: passing an **explicit** `0` (as opposed to
      omitting the field) for either pct through to `evaluateExit()`
      without the `|| undefined` guard makes `pct <= -0`/`pct >= 0` true for
      any loss/gain at all — an immediate-exit-on-any-move bug, not merely
      "feature disabled." Both backtest engines already had the guard in
      place; a dedicated test in each now proves an explicit `0` behaves
      identically to an omitted field, since a client can reach that exact
      input through the backtest routes' own pass-through.

18. **Regime-aware position sizing — shipped (2026-07-16).** A softer,
    graduated companion to the existing `maxMarketAtrPct` hard cutoff: once
    the broad-market proxy's (SPY) own ATR% crosses a lower
    `regimeAtrThresholdPct`, new positions size down by `regimeSizeCutPct`
    instead of being blocked outright — `maxMarketAtrPct` still blocks
    everything once volatility gets more extreme. Mirrors the existing
    `stepDownAfterLosses`/`stepDownSizeCutPct` mechanism (a consecutive-loss
    streak cuts size the same way), just keyed to market volatility instead
    of a losing streak.
    - **No new fetch.** `loop.ts` already computes `marketAtrPct` once per
      cycle (`getMarketAtrPct('SPY')`) for the existing volatility filter;
      this reuses that SAME reading, threaded into `RiskCheckContext` and
      on into `runPaperExecution`/`runOptionsPaperExecution`/
      `runLiveExecution`/`runLiveOptionsExecution` as a new parameter
      (default `null` — regime cut inactive — for any caller that doesn't
      have one, e.g. a direct test call). The manual `/risk-check` preview
      route self-fetches its own fresh reading instead, matching that
      route's existing "re-fetch everything fresh" design rather than
      requiring a caller to thread one in.
    - **Same insertion point as step-down, stacks multiplicatively.**
      `evaluateRiskCheck()`/`evaluateOptionsRiskCheck()` extend the existing
      `effectiveRiskPct` formula with a second multiplicative factor:
      `riskPerTradePct × (step-down factor) × (regime factor)` — both cuts
      apply together when both are active, exactly like step-down sizing
      and live probation already stack (sequential multiply-then-floor, no
      "smallest wins" logic anywhere in this codebase). `RiskCheckContext`
      is a single shared type (`riskCheck.ts`, reused by
      `optionsRiskCheck.ts`, not duplicated) — extending it once updated
      both the equity and options sizing paths.
    - **Config.** `AutotradeConfig.regimeAtrThresholdPct` (default `3`, a
      real threshold — unlike most brand-new fields this session, this one
      isn't inert at its default) / `regimeSizeCutPct` (default `0` =
      disabled — so an untouched config changes nothing regardless of the
      threshold's own value), routed through `PUT /api/autotrade/config`
      only. The backtest routes' own risk-param override schema
      (`backtestRiskParamsSchema`) deliberately does NOT gain these two
      fields — see the scope boundary below.
    - **Scope: LIVE + PAPER only, same boundary as `maxMarketAtrPct`
      itself.** All three backtest engines explicitly pass `marketAtrPct:
      null` (regime cut unconditionally inactive) into every
      `RiskCheckContext` they build, with a comment pointing back to
      `maxMarketAtrPct`/`maxTickerAtrPct`/`sessionBufferMinutes`'s own
      pre-existing "no backtest equivalent" note — no live SPY-proxy ATR
      series is wired into any backtest engine today, and none of the six
      other session-volatility fields are simulated in a historical daily-bar
      replay either.
    - **UI.** Two new Configuration fields (**Regime ATR threshold (%)**,
      **Regime size cut (%)**) placed right after **Max trades per day** —
      the same relative position as `regimeAtrThresholdPct`/
      `regimeSizeCutPct` in `AutotradeConfig` itself. No new dashboard
      surface for the live market-ATR% reading itself (unlike consecutive
      losses, which the dashboard already tracks) — a per-poll live provider
      fetch on the frequently-polled dashboard endpoint would reintroduce
      exactly the kind of wasteful repeated-fetch cost the earlier
      performance phases (see the Perf sub-phases above) fixed. The
      `regime_sizing` check this feature adds already flows into every
      risk-check's own journaled `checks` array (**Recent activity**),
      exactly like `step_down_sizing` always has — sufficient visibility
      without a new always-on fetch.
    - **Verified:** every new/changed test (the formula's active/inactive/
      stacking behavior for both equity and options, the config
      sanitizer, and a dedicated loop-level test proving `getMarketAtrPct`
      is called exactly once per tick and reused, not re-fetched) confirmed
      genuinely failing on a reverted source change before being restored.
      Also fixed along the way: the formula's own `marketAtrPct === null`
      checks used strict equality, which crashed (`.toFixed` on `undefined`)
      against several pre-existing test fixtures that build a
      `RiskCheckContext`-shaped mock without every current field — switched
      to `== null` so the code is robust to a caller (test or otherwise)
      that omits the field entirely, not just one that passes `null`
      explicitly.

19. **Multi-timeframe (daily + weekly) trend confirmation — shipped
    (2026-07-16).** A second, longer-horizon check on top of the existing
    `requireTrendAlignment` (daily-only) filter: price must ALSO be on the
    right side of its own **weekly** moving average, using the same
    `maShort` period against weekly instead of daily candles. A **filter**,
    not a scored component — like `requireTrendAlignment`, it either blocks
    a candidate or it doesn't, rather than nudging the 0-100 score, so it
    needed no new scoring weight and no About-page component-table entry.
    - **Reuses the existing scoring engine, not a parallel one.**
      `computeCandleIndicators`/`computeCandleIndicatorSeries`/
      `candleIndicatorsAt` (`indicators/screener.ts`) are already fully
      timeframe-agnostic — they take whatever `Candle[]` they're handed, so
      the SAME functions run unmodified against a weekly series. Only one
      new derived value threads through `computeIndicators()`/`scoreSymbol()`/
      `scoreSymbolBothDirections()`: an optional `weeklyIndicators` param,
      whose `.maShort` lands on `IndicatorSnapshot.weeklyMaShort` — not a
      second full candle array threaded through the whole pipeline.
    - **Fails CLOSED, matching `requireTrendAlignment`'s own precedent.**
      `weeklyMaShort === null` (no weekly data computed/available) blocks
      the candidate rather than silently passing it — the same
      candidate-specific-data-missing convention `scoreFromIndicators`
      already uses elsewhere, and a deliberately different posture from the
      market-wide `maxMarketAtrPct`/regime-sizing checks (phase 18), which
      fail OPEN on missing data because those describe an unknown *market*
      condition rather than a missing *candidate* signal.
    - **Live/paper: `screen.ts` fetches weekly candles only when the filter
      is enabled** (`cfg.filters.requireWeeklyTrendAlignment`) — same
      don't-do-unrequested-work gate as the earnings-blackout lookup and
      `optionsExecute.ts`'s own `priceRulesActive` gate. A dedicated weekly
      indicator cache (`weeklyIndicatorCache`, keyed `symbol:maShort`)
      mirrors the existing daily `candleIndicatorCache` but stays a
      separate `Map` so the two can never collide. The fetch pulls 40 weekly
      bars and drops the most recent one before computing anything (`
      cachedWeeklyIndicatorsFor`'s own `.slice(0, -1)`) — a live fetch always
      ends at "now," so the tail bar may still be mid-week and unclosed.
    - **Backtest: a new lookahead-bias guard, `closedWeeklyIndexAsOf`.**
      `Candle.time` is a bar's own START, and the existing `indexAsOf()`
      returns the week *containing* the simulated day — which, for a weekly
      bar, is still in progress and hasn't closed yet. Using it directly
      would leak the rest of that week's price action into "as of today."
      `closedWeeklyIndexAsOf` backs up exactly one index from whatever
      `indexAsOf` resolves to, needing no knowledge of the provider's actual
      week-start-day convention (Monday vs. Sunday) — the last CLOSED week
      is simply one behind whichever week today falls inside, regardless of
      which weekday that week happens to start on (verified against both a
      Monday- and a Sunday-start fixture in `backtestIndexAsOf.test.ts`).
      All three engines (`backtest.ts`, `optionsBacktest.ts`,
      `combinedBacktest.ts`) take an optional `weeklyHistoryBySymbol` Map,
      precompute its indicator series once up front (mirrors the existing
      daily precompute), and only fetch it at all
      (`loadWeeklyBacktestHistory`, one calendar year of padding) when
      `cfg.screenerConfig?.filters?.requireWeeklyTrendAlignment` is set —
      omitted entirely, not just empty, for any backtest that doesn't use
      this feature.
    - **Config.** `AutotradeConfig.requireWeeklyTrendAlignment` (boolean,
      default `false`), routed through `PUT /api/autotrade/config` only, and
      — unlike `requireTrendAlignment`, which has no live-loop UI and is
      structurally unreachable from the autonomous loop today
      (`loop.ts` only ever passed `filters: { minRelVol }` to
      `runAutotradeScreen`) — this phase deliberately wires the new field
      into `loop.ts`'s own screen call too, so toggling it actually changes
      what the unattended loop trades, not only what a manual Screen+Decide
      preview shows. Backtests reach the same field through the already-
      generic `screenerConfig?: Partial<ScreenerConfig>` every backtest
      config already accepts — no new backtest-config field or route schema
      was needed.
    - **UI.** A **"Require weekly trend alignment"** checkbox on both the
      Screener page (mirroring the existing "Require trend alignment"
      checkbox) and the Auto page's Configuration card (saves immediately on
      toggle, no separate Save button — same pattern as **Auto-trading
      enabled**), placed after **Min relative volume (×)**.
    - **Verified:** every new/changed test — the pure filter (inactive, fails
      closed on missing data, blocks/passes on dis/agreement, mirrors for
      short, accumulates with other filter reasons), `closedWeeklyIndexAsOf`
      (including the "in-progress week's own start day" lookahead regression
      case and the Monday/Sunday-start-agnostic case), the config sanitizer,
      the live-loop wiring, `screen.ts`'s fetch gate (on/off), an end-to-end
      `simulateBacktest` run (blocks, passes, filter-off isolation, and
      fails closed when no weekly history was supplied at all), and both web
      checkboxes (render state, save-on-toggle, and — for the Screener page
      — the toggled value actually reaching the next `runScreener()` call) —
      confirmed genuinely failing on a reverted source change before being
      restored.

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
- Risk per trade: 1% of account equity *(narrowed 2026-07-10 — see the
  follow-ups below: this is no longer part of the profile preset)*
- Max daily drawdown (halt trading): 3% *(narrowed 2026-07-10 — see below)*
- Step-down sizing trigger: after 2 consecutive losing trades (cut size 50%)
  *(narrowed 2026-07-10 — see below)*
- Max concurrent open positions: 2 *(narrowed 2026-07-10 — see the follow-up
  below: this is no longer part of the profile preset)*
- Max aggregate open risk (see below): 2% *(narrowed 2026-07-10 — see below)*
- Max exposure to correlated tickers (capital, not risk): 6% of capital
  *(narrowed 2026-07-10 — see below)*
- Max trades per day: 6 *(narrowed 2026-07-10 — see below)*

**AGGRESSIVE:**
- Risk per trade: 1.5% of account equity *(narrowed 2026-07-10 — see below)*
- Max daily drawdown (halt trading): 5% *(narrowed 2026-07-10 — see below)*
- Step-down sizing trigger: after 2 consecutive losing trades (cut size 50%)
  *(narrowed 2026-07-10 — see below)*
- Max concurrent open positions: 3 *(narrowed 2026-07-10 — see the follow-up
  below: this is no longer part of the profile preset)*
- Max aggregate open risk (see below): 4.5% *(narrowed 2026-07-10 — see below)*
- Max exposure to correlated tickers (capital, not risk): 10% of capital
  *(narrowed 2026-07-10 — see below)*
- Max trades per day: 10 *(narrowed 2026-07-10 — see below)*

Default to MODERATE. Switching to AGGRESSIVE requires an explicit manual
confirmation in the UI (not just a config file edit), since it's the
higher-risk profile.

**Follow-up (2026-07-10) — max concurrent positions is now its own
user-configurable setting, not baked into the risk-profile preset.**
Requested directly ("configure the max allowed open positions... currently
it's hard coded to 3"). The two designs considered were (a) split it into
independent per-asset caps (a stocks cap and a separate options cap, no
cross-pooling) or (b) keep today's ONE combined budget (see "CRITICAL: MAX
AGGREGATE OPEN RISK" and the options phase's own combined-budget note below)
and just make that single number editable — chosen explicitly by the user.
`maxConcurrentPositions` moved out of `RiskProfileParams`
(`services/autotrading/riskProfiles.ts`) onto `AutotradeConfig` itself
(default 2, matching MODERATE's old baseline so an untouched config's
behavior doesn't silently change), editable in the Auto-Trade page's
Configuration section and threaded through `RiskCheckContext` — the same
place `equity` already comes from config rather than the profile table.
Switching MODERATE ↔ AGGRESSIVE no longer touches this cap at all, by
design: silently resetting a value the user explicitly set, just because
they changed an unrelated profile toggle, would be a worse surprise than
leaving profile-switching alone. Backtesting gets its own
`maxConcurrentPositions` input (mirrors `startingEquity`'s existing
convention — a backtest is a self-contained hypothetical, not coupled to the
live account's current setting).

**Follow-up (2026-07-10, continued) — the rest of the risk-profile preset is
now configurable too.** Reported directly, right after the above shipped:
raising `maxConcurrentPositions` alone (to 15) didn't unblock new entries with
only 2 positions open, because `maxAggregateOpenRiskPct` — 2% of equity at the
old MODERATE preset, about 2 positions' worth of risk at 1%/trade — was the
one actually binding, and had no independent lever at all. Asked directly to
"look at everything that is needed [for] the decision gates and make it all
configurable," so the remaining six fields (`riskPerTradePct`,
`maxDailyDrawdownPct`, `stepDownAfterLosses`, `stepDownSizeCutPct`,
`maxAggregateOpenRiskPct`, `maxCorrelatedExposurePct`, `maxTradesPerDay`) got
the exact same treatment as `maxConcurrentPositions` above: moved out of
`RiskProfileParams`/`RISK_PROFILES` (`services/autotrading/riskProfiles.ts`,
now deleted — the file just re-exports `CORRELATION_LOOKBACK_DAYS`/
`CORRELATION_THRESHOLD`, the two methodology constants that stayed fixed) onto
`AutotradeConfig` directly, each defaulting to its old MODERATE value so an
untouched config's behavior doesn't change, each independently editable (its
own field, its own Save button) on the Auto-Trade page. `riskProfile` itself
is kept on `AutotradeConfig` — switching MODERATE ↔ AGGRESSIVE still pops the
same confirmation dialog it always has — but it is now purely a label,
journaled with every trade, with **zero** computational effect anywhere: it no
longer resolves to a bundle of numbers at all outside of backtesting (see
below). `RiskCheckContext` (`riskCheck.ts`) and its options counterpart
(`optionsRiskCheck.ts`) carry all seven fields directly instead of a separate
`profile: RiskProfileParams` argument. Backtesting keeps its own
self-contained `riskProfile` — same reasoning as `maxConcurrentPositions`'s
own backtest treatment above — via a `LEGACY_BACKTEST_RISK_DEFAULTS`
MODERATE/AGGRESSIVE bundle that lives only in `backtest.ts` (unreachable from
live code), used to fill in whichever of the seven fields a given backtest
request doesn't explicitly override.

For a plain-English explanation of what each of these seven fields (plus
`maxConcurrentPositions`) actually does, with worked examples, see
[`docs/AUTOTRADE_RISK_SETTINGS.md`](./AUTOTRADE_RISK_SETTINGS.md) — this section
stays the engineering-level record of *why* each decision was made.

**Follow-up (2026-07-11) — the correlation methodology itself is now
configurable too, not just the exposure cap it feeds.** Prompted by a direct
follow-up question ("what else can and needs to be added or fixed to best
improve the app's functionality and accuracy specifically for the auto
trading and tracking") — the two remaining fixed constants,
`CORRELATION_LOOKBACK_DAYS` (30 trading days) and `CORRELATION_THRESHOLD`
(`|r| ≥ 0.7`), moved from `services/autotrading/riskProfiles.ts` (now deleted
entirely — its whole remaining purpose was these two constants) onto
`AutotradeConfig` as `correlationLookbackDays`/`correlationThreshold`, each
defaulting to the old constant's value so an untouched config's behavior
doesn't change. Unlike `maxCorrelatedExposurePct` (the % cap this feeds
into), these govern *how* correlation is measured, not a risk-tolerance
dial — still its own pair of editable fields on the Auto-Trade page, right
below "max correlated exposure." `correlatedNotional()` (`riskCheck.ts`) and
its two backtest counterparts (`backtestCorrelatedNotional()` in
`backtest.ts`, reused by `combinedBacktest.ts`; `optionsBacktest.ts`'s own
byte-for-byte duplicate) now take `lookbackDays`/`threshold` as explicit
trailing parameters instead of reading the module constants directly — the
same "pure function, config threaded in by the caller" convention the other
seven fields already followed. Backtesting resolves them the same way as
those seven: added to both `LEGACY_BACKTEST_RISK_DEFAULTS` bundles
(identical 30/0.7 in MODERATE and AGGRESSIVE, since they were never
profile-specific even before this change) and to `resolveBacktestRiskParams`,
so a backtest request can override them field-by-field exactly like the
other seven, even though no UI exposes a per-backtest override for any of
the nine today.

**Follow-up (2026-07-11) — max hold time for equity positions, the largest
single change in the "do everything except PDT" batch (the same direct
follow-up question that prompted the correlation-methodology change above).**
Equity positions previously held forever until their stop or target hit —
options already had a time-based force-close (`AUTOTRADE_TIME_EXIT_DAYS`),
equity had no analog. New `AutotradeConfig.maxHoldDays` (default 0 —
disabled, so an untouched config's behavior doesn't change): once a position
has been open this many CALENDAR days without a stop/target hit, force-close
it at the current price.

- **Paper** (`execute.ts`): `checkPaperExits()` gained a third trigger,
  checked last (stop and target keep priority), closing at the current quote
  — a time-exit has no declared level to close at, unlike stop/target.
- **Backtest** (`backtest.ts`, and `combinedBacktest.ts`'s duplicated equity
  leg): `maxHoldDays` is its OWN top-level `BacktestConfig` field, not part
  of the seven/nine-field risk-params bundle above (it's a position-
  management parameter, not a pre-trade risk-check gate) — mirrors
  `maxConcurrentPositions`'s own "self-contained hypothesis" treatment.
  Closes at the bar's CLOSE (the "what actually happened today" price),
  tagged a new `exitReason: 'time_exit'`.
- **Live — by far the riskiest piece, and the reason this took a direct
  question back to the user before proceeding.** Every OTHER equity live
  exit is 100% broker-side BRACKET-driven (`reconcileLiveOrders()` only ever
  *observes* a fill, never places one) — there was no existing mechanism to
  force-close a live position early, because there was never a reason to
  build one before. Implementing this meant new, genuinely unconfirmed
  broker-order-cancellation code: `checkLiveEquityTimeExits()`
  (`liveExecute.ts`) cancels the resting bracket via
  `webullCancelOrder(accountId, entryIntent.idempotencyKey)` — the MASTER
  leg's own id, the only id this codebase durably tracks for a bracket
  (Webull's own `combo_order_id` is generated fresh per-place in
  `providers/webull/orders.ts` and never persisted) — even though that leg
  is already terminal (`filled`). The working theory, per this codebase's
  own "combo" framing of a bracket (one `client_combo_order_id` grouping all
  three legs), is that this reaches the whole combo, not just the
  already-filled leg. **This is unconfirmed against a real account**, same
  posture as `WebullOrderLeg`'s own "best-effort... not yet probe-confirmed"
  caveat this mechanism builds directly on top of. It never trusts the
  theory blindly: it always re-polls immediately after cancelling and
  requires every non-MASTER leg to unambiguously show as no longer
  resting before proceeding — a leg that raced the cancel and already
  filled, or one still ambiguously "working," both fail closed (position
  left open, retried next cycle) rather than risk a double-close. Only once
  verified clear does it place a fresh MARKETABLE-LIMIT closing order (never
  a bracket) — `autotrade_live_orders` gained a `role` column (`'entry'` |
  `'exit'`, migrated via a plain `ALTER TABLE ... ADD COLUMN`, mirroring
  `autotrade_live_options_orders`'s existing split) so this new closing order
  can be tracked and reconciled the same way an options time-exit close
  already is. **A real live trade should be used to confirm the
  cancel-then-verify behavior before fully trusting it** — flagged
  explicitly to the user as part of the decision to build this now rather
  than deferring it.
- Web: a new **Max hold time (days)** field on the Configuration card, right
  after Target (R-multiple).

**Follow-up (2026-07-11) — trailing stop, breakeven, and partial
profit-taking, the last item in the "do everything except PDT" batch. PAPER
and BACKTEST equity positions only — LIVE is deliberately untouched.**
Equity positions previously had a fixed stop/target for their whole life;
this adds five new `AutotradeConfig` fields (`breakevenTriggerRMultiple`,
`trailStartRMultiple`, `trailStopRMultiple`, `partialExitRMultiple`,
`partialExitPct` — all default to 0/disabled, `partialExitPct` defaults to
50 for whenever its trigger gets turned on) so an open position can move its
own stop to breakeven, trail it behind the best price seen, and/or scale out
part of the position once, all measured in R-multiples of the position's
OWN original stop distance (a snapshot frozen at entry — `initialStopPrice`
in `execute.ts`, `initialStop` in `backtest.ts`/`combinedBacktest.ts` —
never the current, possibly-already-ratcheted stop, or every later R-multiple
reading would be inflated relative to what it should be).

- **Paper** (`execute.ts`): `checkPaperExits()`'s stop/target/time-exit
  checks are unchanged and still take priority; only once all three are
  ruled out does `applyPositionManagement()` get a turn. `stopPrice` is now
  MUTABLE while a position is open — `autotrade_paper_positions` gained
  `initial_stop_price` (frozen snapshot), `best_price_since_entry` (the
  running high/low-water mark trailing ratchets against), and
  `partial_exit_taken` (so the one-time partial-exit trigger doesn't re-fire
  every cycle). A partial exit reduces `quantity` in place — this table
  stays one row per position, not a split position/exits table; the
  partial fill itself is only journaled as an `autotradeEvent`
  (`paper_partial_exit`), not a second structured row. `riskAmount` stays
  fixed at its original full-size value for the position's whole life, same
  R-multiple-denominator reasoning as `initialStopPrice`.
- **Backtest** (`backtest.ts`, and `combinedBacktest.ts`'s duplicated equity
  leg): the five fields are their own top-level `BacktestConfig` fields,
  same "self-contained hypothesis, not part of the risk-params bundle"
  treatment as `maxHoldDays` above. Triggers are evaluated against the bar's
  CLOSE, deliberately NOT the intrabar high/low the stop/target check itself
  uses — these are dynamic R-multiple triggers, not a fixed price level that
  can legitimately be "hit" intrabar, so using the intrabar extreme here
  would let backtest detect a trigger a real paper check (one point-in-time
  quote per cycle) never could, overstating this specific feature's
  backtested performance. A partial exit pushes a SEPARATE `SimulatedTrade`
  row (`exitReason: 'partial_exit'`) for just the closed slice and keeps the
  position (reduced `quantity`, unchanged `initialStop`/`riskAmount`) in
  `openPositions` for a LATER trade row when it eventually fully closes —
  the one case where `report.trades.length` no longer equals the number of
  round-trip logical trades.
- **Live — deliberately scoped OUT, and NOT confirmed with the user (a
  scope-narrowing question didn't reach them; proceeded with the
  conservative default rather than guessing in the riskier direction).**
  Researching this surfaced that it's a strictly larger unknown than
  max-hold-days' own live piece above, not the same kind: `replaceIntent`
  (`services/trading/replaceOrder.ts`) categorically refuses to touch ANY
  bracket at all (`isComboOrder(rec)` — a pure no-op, never even reaches
  Webull), no individual bracket leg's own `client_order_id` is durably
  persisted anywhere (each is generated fresh inline in
  `providers/webull/orders.ts` and discarded), and — worst of all for a
  partial exit specifically — the only plausible live design (cancel the
  whole resting bracket, place a partial close, then place a NEW bracket
  sized to the remainder) has a genuinely dangerous failure mode
  max-hold-days' own cancel-and-close never had: a real window where the
  remaining position sits with NO resting stop at all if the third step
  fails after the first two succeed. Live equity positions keep their fixed
  stop/target for life, exactly as before this change. Revisit once the
  user can weigh in on this specific, elevated risk directly.
- Web: five new fields on the Configuration card, right after Max hold time
  (days) — **Breakeven trigger (R-multiple)**, **Trailing start
  (R-multiple)**, **Trailing distance (R-multiple)**, **Partial exit trigger
  (R-multiple)**, and **Partial exit size (%)**.

**Follow-up (2026-07-11) — dividend/stock-split handling, the last item in
the "do everything except PDT" batch. Split-detection only (Yahoo-only,
paper/live equity + options), plus an unrelated, more urgent bug this
research surfaced. NOT confirmed with the user (a scope-narrowing question
didn't reach them, same tool-level issue as the trailing-stop follow-up
above) — proceeded with the two most conservative, clearly-scoped pieces of
several genuinely different options this could have meant, rather than the
larger or lower-value ones.**

Researching this found "dividend/stock-split handling" wasn't really one
feature: a cash dividend needs no position-level adjustment at all for a
long equity position (it's cash into the account, decoupled from
quantity/cost-basis) — "handling" it would mean building a whole new
income-tracking ledger this app has zero concept of today, a different and
lower-value feature than splits for a day/swing-trading app that rarely
holds through an ex-dividend date. **Not built.** A stock split DOES need
position adjustment (quantity/entry/stop/target all rescale), but of the
three configured providers only Yahoo (`yahoo-finance2`'s `chart()`/
`historical()` modules, `events: 'split'`) exposes split history at all —
Tradier and Webull have no evidence of an equivalent endpoint, and the
`mock` provider can never produce a real one by construction. **Building
auto-adjustment of open autotrade positions was also not attempted** — no
mutation path exists today for autotrade paper/live positions' quantity or
price at all (only the manual journal's `positions` table has one, via
`PositionPatch`/`PATCH /positions/:id`, and even that isn't exposed in the
web UI yet) — that's new schema and routes, not just new logic, a
meaningfully bigger lift than detection.

- **Unadjusted-candle bug (`providers/YahooProvider.ts`) — not what was
  asked, but a more urgent, pre-existing correctness issue found while
  researching this.** `getCandles()` read raw `open/high/low/close` from
  Yahoo's `chart()` response and ignored the `adjclose` field the SAME
  response already carries — meaning a real split showed up as a fake
  overnight price cliff in this app's OWN candle data, feeding directly into
  `indicators.ts`'s ATR/RSI/SMA/EMA (corrupting them for as many bars as
  the lookback window) and, since `screen.ts`'s live Screen stage scores
  candidates off this exact same live-provider call, corrupting real
  autotrade entry/exit decisions for that symbol — not just chart display.
  This was a latent bug independent of whether any split-handling feature
  ever got built: it would fire the next time ANY screened symbol split,
  whether or not detection existed. Fixed by computing a per-bar adjustment
  factor (`adjclose / close`) and applying it to open/high/low/close alike
  — falls back to no adjustment (factor 1) when `adjclose` is missing, so
  existing behavior for data that never carried it is unchanged.
- **Split detection (`services/splits.ts`, `services/autotrading/
  splitCheck.ts`)** — mirrors `services/events.ts`'s own "standalone,
  provider-agnostic, always Yahoo" convention exactly, for the same reason:
  of the three configured providers, only Yahoo has this data at all.
  `getRecentSplits()` is the sibling to `getSymbolEvents()` but
  backward-looking (a split has to be caught AFTER it happens, not before) —
  a fixed 7-day lookback, cached 12 hours (splits are rare; no per-request
  config field for this, more ceremony than the feature's own value
  justifies). `checkForRecentSplits()` gathers every symbol with an open
  autotrade position (paper + live, equity + options — not the manual
  journal, out of scope for this pass) and checks once per ET calendar day
  (not every 60-second tick, unlike the stop/target-style checks — splits
  don't need that cadence), journaling a `split_detected` event and
  best-effort notifying any hit. **Detection only** — never touches the
  position's own quantity/price; the notification message says so
  explicitly and points the user to fix it manually.

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

**Follow-up, added 2026-07-11 — screening/decision thresholds are now
configurable too.** The bullets above (plus the screener's own relative-volume
floor, and the ATR-multiple stop/target sizing decide.ts implements the "hard
stop-loss" requirement with) shipped as hardcoded constants — `minRelVol`
(`screen.ts`'s `defaultAutotradeScreenerConfig()`), `maxTickerAtrPct`/
`maxMarketAtrPct` (`executionGuards.ts`'s `defaultVolatilityFilterConfig()`),
`stopAtrMultiple`/`targetRMultiple` (`decide.ts`'s `defaultDecisionConfig()`),
and the session buffer minutes (`loop.ts`'s own `SESSION_BUFFER_MINUTES`
constant, now deleted). Same treatment as the risk-check parameters' own
2026-07-10 follow-up above, for the same reason: no dial existed at all for
any of these. Moved onto `AutotradeConfig` directly (`minRelVol`,
`maxTickerAtrPct`, `maxMarketAtrPct`, `stopAtrMultiple`, `targetRMultiple`,
`sessionBufferMinutes`), each defaulting to its old hardcoded value.
`loop.ts` threads them through explicitly on every tick instead of calling
the now-unchanged `default*Config()` functions directly; those functions
keep their old hardcoded return values as the fallback backtesting still
uses (via `screenerConfig`/`decisionConfig` request overrides, unaffected by
live config — same "self-contained hypothesis" precedent as
`maxConcurrentPositions` and the risk-check parameters). The manual Screen/
Decision preview routes now default `minRelVol`/`stopAtrMultiple`/
`targetRMultiple` to the live persisted config too (previously always the
hardcoded value, regardless of what the loop was actually configured to
do), while still honoring an explicit per-request override the same way
they always did. `maxTickerAtrPct`/`maxMarketAtrPct`/`sessionBufferMinutes`
have no manual-preview or backtest equivalent at all — the volatility/session
guards only ever applied to the unattended loop (executionGuards.ts's own
header comment on why), and a historical daily-bar replay has no real-time
session clock to simulate.

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

**Follow-up, added 2026-07-11 — the last tick's diagnostics are now
persisted, not discarded.** `runAutotradeLoopTick()` (`loop.ts`) always
computed a full `LoopTickSummary` every cycle — candidates screened, signals
generated, entries opened, exactly why it skipped — but only ever returned
it to whichever caller triggered that one tick (the background timer, or a
manual "run once"); nothing kept it around, so "why isn't anything trading"
was answerable only by reading Recent Activity's full journal, one event at
a time. `db/autotradeLastTick.ts` adds a singleton-row table
(`autotrade_last_tick`), same upsert shape as `db/autotradeConfig.ts`'s own
config row, storing the JSON summary plus when it finished. `summary` is now
declared before `runAutotradeLoopTick()`'s try block (not inside it) so the
existing `finally` — already the home for the post-tick alert checks — can
persist it regardless of which of the function's several return points
actually fired, undefined only if something threw before a summary was ever
built. `getAutotradeDashboard()` (`dashboard.ts`) surfaces it as `lastTick`,
read directly rather than recomputed (this is the one dashboard figure with
no live-state equivalent to derive it from — it's a record of a PAST cycle,
not current state). The Monitoring UI shows it as a "Last cycle" summary
above the existing stat tiles: the screen → volatility → signals funnel,
entries opened per book, exits checked/closed, and the skip reason in place
of the funnel on a cycle that placed nothing.

Confirm the exact broker API I'll be integrating with (Alpaca, IBKR, etc.)
before wiring anything to a live connection.

**Follow-up (2026-07-13) — live equity stop/target legs were expiring
unfilled at the close, silently leaving the position unprotected. User bug
report, confirmed and fixed.** A live entry is placed as a broker-side
BRACKET (entry + linked STOP_LOSS + STOP_PROFIT legs, `liveExecute.ts`'s own
header comment), and all three legs were placed `time_in_force: 'DAY'`
(`providers/webull/orders.ts`). A DAY order unfilled at the close is
cancelled by the broker — including the stop and target, not just the entry
if it hadn't filled yet. Nothing in the reconcile loop (`reconcileLiveOrders`
→ `reconcileOneLiveOrder`) checked for a CANCELLED/EXPIRED exit leg — it only
ever watched for a FILLED one — so a position whose bracket expired this way
just sat open with literally no resting stop, for as long as `maxHoldDays`
allowed (0/disabled by default, i.e. potentially indefinitely), while the
`positions` table kept showing its original stop/target as if still live —
no schema field distinguishes "still resting at the broker" from "expired
hours ago." Paper trading was never affected: `checkPaperExits()` re-checks
price against the stop/target in-app every tick, independent of any broker
order or TIF.

Fixed by changing `bracketExit()`'s stock exit legs (stop-loss + take-profit)
from DAY to GTC — confirmed against Webull's own API docs that stock equity
orders support GTC on the sell side (their own trading-education pages state
this explicitly), unlike single-leg OPTION orders, which are DAY-only on the
sell side by broker restriction. The entry leg stays DAY (an unfilled entry
shouldn't keep trying at a stale price for days — nothing to protect yet).
GTC itself isn't unlimited: Webull auto-expires a GTC order after 90 calendar
days, so `maxHoldDays` is still worth configuring as a backstop, just no
longer the only thing standing between an open position and an entire
trading day of zero downside protection.

**Options are NOT fixed by this** — `optionBracketExit()`'s exit legs stay
DAY, since Webull's sell-side-DAY-only restriction genuinely applies to
options (confirmed in `docs/LIVE_TRADING_DESIGN.md`'s own API notes). A live
options position's bracket can still expire unfilled at the close the exact
same way stock's used to, with nothing detecting or re-arming it — a real,
currently-unaddressed gap. A proper fix needs a fundamentally different
approach (detect the gap, place a fresh bracket), which has its own
dangerous failure mode already flagged in this doc's own trailing-stop-for-
live deferral note above: a genuine window with NO resting stop at all if
the replace step fails after the cancel step succeeds. Deliberately not
attempted as part of this fix — revisit as its own, separately-discussed
piece of work.

**Follow-up (2026-07-13, continued) — the Auto page's live-positions table
was missing new opens/closes even though the general Positions page showed
them correctly. User bug report, confirmed and fixed; a related
duplicate-order risk was found and closed alongside it.** Two distinct gaps,
both in how a real Webull position can enter the `positions` table:

1. The normal path — `materializeEntryFill()`, reached once
   `reconcileOneLiveOrder()` observes the entry leg's fill — tags the new row
   `['live', 'autotrade']`. Both the Auto page's live-positions table
   (`listAutotradeLivePositions()`) and `getLivePortfolioSnapshot()` filter on
   that tag, by design (`Follow-up (2026-07-10)` above).
2. A second, generic path exists purely as a backstop:
   `runWebullPositionsSync()` → `importFromPreview()` →
   `mapWebullPosition()` (`providers/webull/positions.ts`) periodically
   imports whatever Webull reports as actually held, tagged `['webull']`
   only, with no link back to the order intent that produced it. This exists
   to catch positions the order-based reconcile path missed entirely — but
   when it's what ends up creating the row (e.g. a missed/late order-status
   poll let the sync backstop run before `reconcileOneLiveOrder` observed the
   fill), the result is a real, live position that's tag-invisible to
   everything autotrade-scoped: not on the Auto page, not counted in its
   aggregate open risk or P&L. It was still visible on the general Positions
   page, which has no such filter — matching exactly what was reported.

While tracing this, a second, more serious issue surfaced: `runLiveExecution`'s
`skipSymbols` "already holds this symbol" dedup check read from
`snapshot.openPositions`, which is *also* tag-scoped to `'autotrade'` — so
neither an orphaned position like the one above, nor a manually-placed one,
would stop the loop from placing a genuine duplicate live order on a symbol
already held. That risk is independent of whether the position is ever
"adopted" back into autotrade's own accounting, so it needed its own fix
regardless.

Fixed both, deliberately kept separate in scope:

- **Dedup (safety-critical, broadened beyond tag scope on purpose):**
  `skipSymbols` now comes from `listPositions({ status: 'open' })` — every
  open position for a symbol blocks a new entry, regardless of who or what
  created it. A human's manual position and the entry-order sizing/risk
  checks that decide what to skip.
- **Orphan adoption (bookkeeping, stays tag-scoped elsewhere on purpose):**
  new `adoptOrphanedLivePositions()` in `liveExecute.ts`, called every loop
  tick right after `runWebullPositionsSync()`. Matches an open,
  `'webull'`-only-tagged position against a still-pending autotrade ENTRY
  order (`role: 'entry'`, `positionId: null`) for the same symbol, then
  retags it (`'live'`, `'autotrade'` added) and backfills `stopPrice`/
  `targetPrice` from that order's intended levels if the position doesn't
  already have its own, along with the at-entry context the create path
  records (`grade`, `entryScore`, `marketRegime`, `marketAtrPct`,
  `entryVwap`) — those live on the order, not the fill, and nothing else ever
  backfills them, so an un-backfilled adopted position silently shrinks the
  datasets they exist to build. It deliberately does **not** try to set
  `sourceIntentId`: the order → position link is recorded on the order side
  instead (`autotrade_live_orders.position_id`, via
  `setLiveOrderPositionId`). Runs unconditionally each tick, so it also heals
  any position already orphaned before this fix existed, not just new ones
  going forward.

  **Anything that needs "which bracket owns this position" must therefore
  accept BOTH links** — `positions.source_intent_id` OR
  `getLiveEntryOrderForPosition(positionId)` — or an adopted position is
  invisible to it forever. This paragraph used to claim the missing
  `sourceIntentId` "isn't needed for correctness", on the grounds that the
  generic sync backstop closes an adopted position anyway. That was true
  while the sync was the only closing path, and stopped being true when the
  loop grew closing paths of its OWN that need the bracket. On 2026-08-24 an
  adopted CTVA position triggered the intraday stagnation exit and failed to
  close on every subsequent tick — 21 identical `live_time_exit_failed`
  events ("No source intent on this position — cannot locate its bracket to
  cancel") between 15:22 and 15:59 ET — because `checkLiveEquityTimeExits`
  looked up the bracket only through `source_intent_id`. `checkLiveScaleIns`
  had the same blind spot, failing silently rather than loudly. Both now fall
  back to the order-side link. `getPortfolioSnapshot()`'s own risk/P&L accounting is
  deliberately left as-is (tag-scoped) — once adopted, a position is tagged
  and counts normally; nothing needed to change there.

  **Entry stamp (added 2026-08-31) — and a correction to the sentence above.**
  "Once adopted, a position is tagged and counts normally" holds for the
  tag-scoped figures, and is wrong for every DATE-keyed one. Adoption backfilled
  the stop/target and the at-entry context but not `entry_date`/`entry_time`, and
  the route that creates the row cannot supply them: `mapWebullPosition()`
  deliberately records `entry_date` as NULL, because that endpoint returns an
  aggregate of current holdings — a quantity and an average cost — with no single
  open date to report (stamping the import date there was itself a bug, fixed
  earlier). The importer is honest about not knowing; the adopter *does* know, and
  never wrote it down.

  Three consumers read the resulting null as "not today" or "undated", all
  silently:
  - `getLivePortfolioSnapshot().tradesToday` counts `p.entryDate === today`, so it
    returned **0 every day** and `maxTradesPerDay` never bound. On 2026-08-31 five
    live entries were placed against a cap of four; only `liveMaxOrdersPerDay`
    (which counts order rows) was holding the line. The Auto page's **Trades
    today** monitoring tile reads the same figure and showed the same zero.
  - the same function's equity-curve de-risk history filters undated trades out,
    so live trades never reached that curve.
  - the Journal's time-of-day session buckets read `entry_time`, so that dataset
    was empty for the live book.

  Fixed by a shared `entryStampPatch(position, placedAtMs)` in `liveExecute.ts`,
  applied by **both** adoption paths — `adoptOrphanedLivePositions()` (dated from
  the matched order's `createdAt`) and `materializeEntryFill()` (dated from
  `getLiveOrder(intent.id).createdAt`) — rather than one deriving it and the other
  not, since either can reach the position first. Dated from the ORDER's placement
  moment for the same reason the create path is: a reconcile pass runs a minute or
  more after the fill and would drift every entry later than it happened. Each
  field is `??`-guarded, so a position that already carries a stamp keeps it. In
  `materializeEntryFill()` the stamp is applied outside the untagged-healing
  branch, because a position adoption already retagged still needs it. Same shape
  as the `initial_stop_price` gap: the create path sets the field, adoption forgot
  to. Not backfilled onto existing rows — positions opened before this stay
  undated and uncounted.

**Options are NOT affected by the orphan-adoption gap** — confirmed live
options positions (`autotrade_live_options_positions`) have no analogous
generic-import backstop; `syncLiveOptionsPositionsFromBroker` only closes
positions it already knows about, it never creates untracked ones. The
dedup broadening applies to equities only for the same reason (there's
nothing equivalent to broaden for options' own entry path, which was already
scoped correctly).

**Follow-up (2026-07-14) — a live position (SHPH) the loop opened still
wasn't showing on the Auto page's live-positions table even after the fix
above. User bug report; the exact scenario reported wasn't fully
reproduced, but investigating it via a reproduction test (not just reading
the code) surfaced a real, confirmed, more serious bug in the SAME
interaction, fixed here.** `materializeEntryFill()` (the normal fill →
`Position` path) had no awareness that `adoptOrphanedLivePositions()` might
already have adopted the real position for this exact fill under a
different route. Sequence that reproduces it: reconcile misses a fill on
tick N (order-status lags the broker's own positions feed); the generic
Webull sync backstop imports the orphan; adoption heals it the same tick
(as designed). On tick N+1, reconcile's order-status poll finally reports
FILLED — and `materializeEntryFill()`, with no way to know this fill was
already handled, unconditionally created a **second** `Position` row for
the same real shares. The generic sync's own close-detection half then saw
the journal double-booked against a single real holding and "cleaned up"
by auto-closing the *older* (adopted) position — with an ESTIMATED exit
price, since there was no real sale to read one from. Net effect: a
fabricated "closed trade" in the journal that never happened, at a price
that was never real.

This corrects an assumption in the entry directly above: adoption
deliberately leaving `sourceIntentId` unset was reasoned to be fine because
"an adopted position still closes correctly through the same generic sync
backstop that adopted it" — true only in isolation; it didn't account for
the normal reconcile path eventually catching up and duplicating first.

Fixed in `materializeEntryFill()`: before creating a position, it now
checks for an open, `autotrade`-tagged position for the same symbol with no
`sourceIntentId` (adoption's own signature, since it can't patch that field
— see `adoptOrphanedLivePositions()`'s doc comment) and links
`autotrade_live_orders.position_id` to it instead of creating a duplicate.
`materializeExitFill()` (the bracket-exit-leg path) is broadened to match a
position by EITHER `sourceIntentId` (the normal path) OR the metadata
table's own `positionId` (now also true for a linked position) — so a
linked position still closes via the PRECISE broker fill price when its
stop/target fires, not just the generic backstop's estimate. Verified with
a dedicated reconcile+sync+adopt interaction test (confirmed failing
without the fix — a genuine second position — before confirming it passes
with the fix).

Still open: this fix closes a real corruption bug in the adoption/reconcile
interaction, but doesn't conclusively confirm it explains 100% of the SHPH
report specifically — the reported symptom (nothing at all for the symbol
on the Auto page) wasn't exactly reproduced by the sequence above, which
predicts the correctly-linked position ends up visible. Continuing to
investigate the exact SHPH case with the user.

**Follow-up (2026-07-14, continued) — found the actual root cause of the
SHPH report: a THIRD, distinct way an autotrade fill can end up untagged.
Confirmed via direct evidence (the position's own tags, inspected in the
UI) rather than further guessing, then fixed at the source.** The tell:
SHPH's position had exactly `tags: ['live']` — no `'webull'`, no
`'autotrade'` — which doesn't match either of the two shapes the fixes
above already handle. Traced (with an exhaustive repo-wide sweep of every
`createPosition`/`updatePosition` call site, not just the autotrade-side
ones) to the ONE place in the codebase that writes that literal:
`services/trading/reconcile.ts`'s `recordFillAsPosition()` — the generic,
human-Trade-page-shaped order reconcile.

Root cause: `order_intents` has no "who placed this" column — autotrade and
the human Trade page share the one table. Autotrade's own reconcile
(`autotrading/liveExecute.ts`'s `reconcileLiveOrders()`) watches its own
orders via a side table on its own 60-second loop tick, but the GENERIC
reconcile (`reconcile.ts`'s `reconcileIntent()`/`reconcileAllWorking()`) —
reachable via a human's Trade-page Refresh/Refresh-all/Cancel/Replace, *or*
the independently-scheduled background Webull sync
(`webullPositionsScheduler.ts`, configurable down to a 60-second interval
of its own) — polls **every** non-terminal intent with no way to know some
of them are autotrade's. If it observed an autotrade-placed fill first, it
transitioned the intent to the TERMINAL `filled` state and recorded a plain
`['live']`-tagged position via `recordFillAsPosition()`. Because `filled`
has no further transitions, autotrade's own reconcile's own
`!isTerminal(intent.state)` guard then permanently locked it out of ever
materializing (or linking) that position itself — real, autotrade-opened
capital stuck invisible to `isAutotradePosition()` forever. This requires
no bad input, just two independently-scheduled reconcile loops racing over
one shared, unpartitioned table — entirely plausible in normal operation,
not an edge case.

Fixed at the source: `reconcileIntent()` now checks
`isAutotradeIntent(id)` (`db/autotradeLiveOrders.ts`, already existed) as
its very first step and, if true, returns immediately — no broker call, no
state transition, nothing. Autotrade's own intents are exclusively its own
reconcile's responsibility from here on; the generic path must defer
*entirely*, not just skip `recordFillAsPosition()` — transitioning the
intent's state here would independently trip the same terminal-state
lockout even without recording a position.

That prevents new occurrences, but doesn't retroactively heal a position
already stuck this way (like the real SHPH one). `adoptOrphanedLivePositions()`
is broadened with a second matching branch for exactly this shape: an open,
non-`autotrade`-tagged position tagged `'live'` **with `sourceIntentId`
set** (that path does set it, unlike the `'webull'`-import orphan) is
matched by `sourceIntentId` directly (precise — no symbol lookup needed)
against a still-pending autotrade entry, then retagged. Also now links
`autotrade_live_orders.positionId` during adoption itself (not deferred to
a later reconcile catching up, as the `'webull'`-orphan branch could rely
on) — necessary here specifically, because THIS orphan's intent is
terminal and will never be revisited by autotrade's own reconcile to do
that linking otherwise. Since adoption runs unconditionally every loop
tick, this means the already-affected SHPH position heals itself
automatically once this ships — no manual fix needed on the account.

Verified with dedicated tests at both layers: `reconcileIntent()`/
`reconcileAllWorking()` now proven to skip an autotrade-owned intent (no
broker call, no state change, no position — mixed in with a normal human
order to confirm only the human one still reconciles), and
`adoptOrphanedLivePositions()` proven to adopt the new orphan shape,
matched precisely by `sourceIntentId` and NOT falsely matched by symbol
alone. Confirmed both fail without the fix before confirming they pass
with it.

**Follow-up (2026-07-14, continued again) — the same race is possible on
the LIVE OPTIONS side too; closed it there as well.** The prevention fix
above (`isAutotradeIntent()` check in `reconcileIntent()`) only recognized
intents tracked in the EQUITY side table
(`db/autotradeLiveOrders.ts`) — but `autotrading/liveOptionsExecute.ts`
places its own live option orders into the exact same shared
`order_intents` table, tracked via a separate, parallel side table
(`db/autotradeLiveOptionsOrders.ts`), invisible to that check. An
autotrade-placed live option order was therefore still exposed to the
identical race, with no tag-based healing backstop available for it at all
(`autotrade_live_options_positions` has no `tags` column — options live
positions were never looked up by tag in the first place). No evidence
this has actually happened to a real position (unlike the equity case,
which was confirmed against a real one), but it's the same latent gap,
closed proactively rather than waiting for a matching report.

Added `isAutotradeOptionsIntent()` (`db/autotradeLiveOptionsOrders.ts`,
mirrors the equity-side function exactly) and check it alongside
`isAutotradeIntent()` in `reconcileIntent()`'s existing guard. Verified
with an analogous test (an autotrade-owned options intent, confirmed to
get zero broker calls and zero state change from the generic reconcile;
confirmed failing without the fix first).

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

---

## Level-aware exits: what the signal asks for vs. what gets booked (2026-08-31)

`levelPlan.ts` re-places an ATR stop/target against real structure, in three
steps: **widen** the stop to clear the nearest support (a stop resting inside
support is the worst place on the chart), **cap** the target short of the
nearest opposing wall, then **veto** if what remains is under `levelMinRewardR`.

The interaction between step 1 and step 2 was never written down, and it has a
consequence worth stating plainly. **When the stop widens, the target does not
move.** The target was computed as an R multiple off the *original* stop, so a
wider stop divides the same absolute reward by a larger risk and the R multiple
falls. A 2R signal is booked at 1.5R. This is by design — targets only ever move
DOWN, toward reachability, never out — and the resulting `rewardR` is computed
correctly against the risk actually taken and gated by the veto.

What was missing is the **ask**. Only the post-adjustment `rewardR` was
journaled, and on its own it cannot distinguish "a 2R signal cut to 1.5R" from
"a 1.5R signal taken whole" — the two write an identical row. So the cost of the
adjustment was unmeasurable, on both the applied and the vetoed populations.
`LevelPlan.intendedRewardR` now carries the signal's own target over its own
pre-widening stop, and both `level_exits_applied` and `level_veto` journal it
beside `rewardR`.

**Measurement only — no gate changed.** The 2026-08-31 session, the first read
that quantified this:

| | |
|---|---|
| plans adjusted | 285 across 5 symbols |
| stop widened, target untouched | 81 |
| stop widened **and** target capped | 136 |
| target capped only | 68 |
| vetoed outright | 715 |
| `rewardR` after adjustment | min 1.00, **median 1.53**, max 2.00 |
| share under 2.0R / under 1.5R | **100%** / 45% |

Every adjusted plan came out under the 2R its signal named. The live SLB entry
that prompted this: signal 2R, support at 56.75 widened the stop from 56.92 to
56.51, booked at 1.5R, scratched by the stagnation exit at +0.05R after 90m.

**One coupling to note before touching either parameter.** Widening is capped at
`levelMaxStopWidenPct` of the original risk, so a kR signal can fall no further
than `k / (1 + maxStopWidenPct/100)` — at 2R and 60% that is 1.25R, always above
a `levelMinRewardR` of 1.0. **The veto therefore cannot fire on widening alone**;
it only ever bites when a wall caps the target. The two numbers are configured
independently and currently cannot interact, which is exactly the "two places
deriving the same quantity" hazard in CLAUDE.md. Whether the answer is a higher
floor, a widening cap coupled to that floor, or nothing at all is a question
about the distribution above — which is why the distribution is now recorded
rather than a parameter guessed at.

Deliberately **not** done: re-deriving the target to preserve the signal's R when
no wall is in the way. It would push every target further out, against a measured
peak-R distribution in which 60.5% of trades reach 1.0R and only 28.9% reach
2.0R. Reachability is the scarce thing here, not nominal reward:risk.

### Pre-committed decision rules for the coupling above

Written **before** the data exists, for the same reason
`docs/OPTIONS_TUNING_PLAN.md` pre-commits its rules: a question left open until
the numbers arrive gets answered by whatever the numbers happen to look like
that week. The operator has agreed this needs fixing once there is data; these
rules say what "fixing" means, and what result would mean leaving it alone.

**Population.** Closed live autotrade trades whose entry carried a
`level_exits_applied` with `stopAdjusted: true` and `rewardR < intendedRewardR`.
Note the funnel: on 2026-08-31 there were 313 adjustments and 5 positions, so the
event count is NOT the sample — most adjusted plans never become trades.

**Minimum sample: 25 closed degraded trades, with ≥10 undegraded closed trades to
compare against.** At the observed ~4 closed trades/day across both buckets this
is roughly three weeks, so it is **not** reachable by the 2026-09-05 review. That
review should report the distribution and explicitly decline to act on it.

| # | Trigger | Response |
|---|---|---|
| R1 | Degraded trades reach their (lower) target at a rate **≥** the undegraded rate | The widening is buying reachability, which is exactly what it is for. **No change** — close the question rather than leaving it open to be re-litigated. |
| R2 | Degraded trades reach target at a materially lower rate **and** their median realized R is worse | The widening costs more than it buys. Couple the two parameters: refuse to widen past the point where `rewardR` would fall below `levelMinRewardR`, and **veto** instead of booking the degraded trade. One change, then re-measure. |
| R3 | No plan in the sample ever reaches `levelMaxStopWidenPct` | The cap is not the binding constraint, so coupling it to the floor changes nothing. Report and stop. |
| R4 | R2 fired and `levelMinRewardR` needs a number | Set it from the observed distribution of realized R on degraded trades. Never from a guess, and never to hit a target trade count. |

**The confound to respect.** A stop widens *because* support sits near the entry,
which is not a random property of a setup — it may correlate with quality in
either direction. So compare **target-hit rates**, not raw expectancy, and treat
a difference in raw P&L between the buckets as uninterpretable on its own. This
is the one place where the obvious comparison is the wrong one.

---

## Targets have to be reachable, not just well-proportioned (2026-09-01)

Prompted by a live DE entry given a **695.52** sell limit against a **670.49**
52-week high. Three separate defects, each of which alone would have produced it.

**1. The target had no idea what the stock can travel.** It is a multiple of the
STOP distance, and the stop is `min(stopAtrMultiple x ATR, maxStopDistancePct)`.
So a 2R target asks for a **3x ATR move**, and wherever the flat percentage cap
binds it asks for ~4.7% of price regardless of the name. Measured over the 22
live entries since level exits shipped:

| | |
|---|---|
| stop set by the flat 2.5% cap rather than 1.5x ATR | **16 / 22** |
| median target distance / the stock's own daily ATR | **1.06x** |
| entries needing more than one full day's range | 12 / 22 |
| entries needing more than two | 3 / 22 |

For a book that flattens at the close and scratches on stagnation at 90 minutes,
that is not ambition, it is arithmetic that cannot come true. Nothing about
reward:risk detects it — **R says nothing about whether the underlying can travel
the distance.** `LevelPlanConfig.targetReachAtrMultiple` (default 1.0) caps the
target at a plausible session move; `reachCapped` is journaled.

Applied even when the chart has NO detected structure. The old code returned
early on an empty level set, which skipped this on exactly the charts that most
need it — a name with no overhead level is one where nothing else was ever going
to catch an unreachable target.

**2. The level engine could not see a 52-week high.** It read `limit: 120` daily
bars and scanned `lookbackBars: 120` — ~5.7 months. DE's high sat 133 bars back,
so the highest thing in the window (660.70) was *below* the entry and the plan
found no resistance at all. XOM the same morning behaved correctly, because its
high happened to fall inside the window. Both numbers now come from
`levelLookbackBars` (default 252), since raising either alone does nothing.

**3. Even at 252, the high was found and then discarded.** Strength is touch
count blended with recency — right for a shelf tested repeatedly, wrong for an
extreme, which is touched once by definition and discounted further for age.
DE's 670.49 scored **0.28** against a 0.35 minimum. Widening the window also
*dilutes* ordinary levels, because touch score is relative to the most-touched
cluster in it: DE's 660.70 fell from 0.46 to 0.43 purely from looking further
back. `PriceLevel.isExtreme` now marks the window's highest/lowest pivot and
floors its strength at `EXTREME_STRENGTH_FLOOR` (0.5). A **floor, not a bypass** —
a caller that deliberately demands very strong structure can still exclude it.

**4. And the fix needed a brake, or it would have killed the strategy.** A
breakout trades AT its 52-week high, so the wall is always inches overhead,
leaving a fraction of an R and a veto every time — the reach cap alone would
refuse precisely the setup the screener is built to find. A 52-week high is a
ceiling right up until it is the thing being broken, and **volume is what tells
those apart.** `levelBreakoutRelVolPace` (default 2.0) lets a target price
through a level when participation supports it. DE drifted into its high at
1.87x pace on 0.06x relative volume — not a breakout. The reach cap still
applies to a breakout: conviction earns the right to price through structure,
never the right to ask for a move the name cannot make.

This required `relVolPace` to reach the signal. It was computed in `screen.ts`
and only journaled — and only when the pace GATE was on. It is now computed every
tick and carried on `ScreenCandidate` and `TradeSignal`, like `avgVolume` before
it. Tying a value's existence to an unrelated filter's setting is how it ends up
silently null in production.

### Verified against the case that prompted it

| DE signal (entry 662.40, stop 645.84, ask 695.52) | target | R | outcome |
|---|---|---|---|
| as shipped that morning | 695.52 | 2.00 | taken; scratched at +0.05R |
| after this change, actual 1.87x pace | **669.50** | 0.43 | **vetoed** — capped short of the 670.49 extreme |
| the same setup at 3x pace | 682.42 | 1.21 | taken, through the wall, inside 1x ATR |

### Impact, and its limits

Replaying all 22 live entries: **vetoes rise from 8 to 14 of 22**, and survivors'
median target falls from 1.06x to **0.85x** daily ATR. Trade frequency roughly
halves.

Two honest caveats. The replay uses *today's* candles for entries made up to a
week ago, so levels and ATR are not exactly what they were at the time —
directional, not exact. And it passes `relVolPace: null`, so **no** breakout
relief is applied; 14 is therefore an upper bound on the vetoes.

The refused trades are the ones whose targets were unreachable, and the observed
behaviour of that population is a stagnation scratch — on 2026-08-31 all five
positions peaked under 0.30R and four exited on stagnation at 90 minutes. Fewer
entries that can pay is the intended trade, not a side effect. Whether it is the
right one is a question for the accumulated record, not for this document.

---

## The live book's refusals were the only ones not written down (2026-09-01)

Asked why buying power sat idle while two positions were open, the honest answer
had to be **inferred from a dashboard gauge**, because no journal row anywhere
said why the live loop stopped entering.

`runLiveExecution()` dropped a blocked candidate with an `outcomes` entry reading
`'Risk check blocked'` and nothing else — no event, no failed rule. Every
`blocked` row in the journal comes from `runPaperExecution()` or the manual
preview route (`runAutotradeRiskCheck`), so the one book that moves real money
was the one book whose refusals were invisible. It also means earlier
explanations of "why live entries stopped" were read off PAPER rows and may have
been misattributed — including a claim that a session's blocks were dominated by
buying power.

`live_risk_blocked` (stage `risk_check`) now carries `failedRules`, the full
`checks`, and the intended `quantity`. A **distinct action**, not a reuse of
`blocked`: folding live refusals in with paper's would preserve exactly the
ambiguity this exists to remove. Only refusals are journaled — an approval
already produces `live_order_placed` (or a `live_entry_blocked` at the
guardrail), so logging passes would double the row count to say nothing new.

The answer it would have given directly, from that session:

```
max_concurrent_positions     FAIL  2 open vs cap 2
max_aggregate_open_risk      PASS  $141.00 vs cap $218.10 (4.28% of equity)
```

Buying power was never the constraint. `maxConcurrentPositions` was, and with
risk-based sizing producing ~$2,000-2,600 positions a cap of 2 bounds deployable
capital at ~$4,500 no matter how much margin exists behind it — which is why
`liveMaxExposurePct` at 155 was unreachable.

---

## Scale-out costs a third order per trade (2026-09-01)

`liveOrderCapForTrades()` multiplied the entry budget by `ORDERS_PER_TRADE = 2`
— one entry, one close. Turning on `liveScaleOutEnabled` makes a trade cost
**three**: entry, the partial exit at `partialExitRMultiple`, then the final
close. The constant did not know that, so enabling scale-out silently raised
every trade's order cost by 50% against an unchanged cap.

This is the 2026-08-24 GRMN failure reached from a new direction — there, entry
and exit budgets were set equal and a stagnation exit was refused 44 times on
`max_orders_per_day` while the position was carried overnight. **A partial exit
is a CLOSE, not an optional add-on** (unlike a scale-in, which the constant
deliberately does not multiply in): it is the half of the position that actually
banks the move, so it belongs inside the budget rather than competing with it.

`liveOrderCapForTrades(maxTradesPerDay, scaleOutEnabled)` now takes the flag,
threaded through `shapeToPatch`, `computeTargetTune` (from `input.config`),
`resetToModerate`, and `suggestLiveCaps` — every path that derives the cap, so
none of them can derive it a different way.

**Why this could not stay a hand-edit.** The live config was raised to 6 trades
with scale-out on, needing 18 orders. The formula still derived 12, so the 18
was a hand-set number sitting on top of a stale derivation: the next tune or
"Suggest from equity" would have quietly reset it and re-opened the hole, with
nothing failing loudly. Exactly the trap the dollar-cap re-anchor notes above
describe, and the reason the fix is in the formula rather than the config.

Live values at the time of writing: `maxTradesPerDay` 6, `liveMaxOrdersPerDay`
18, `maxConcurrentPositions` 3, with the aggregate open-risk cap (4.28% =
~$217) and the daily drawdown halt (6.42% = ~$325) as the real limits — five
full-stop losses trip the halt before the six-trade budget is spent.

---

## 1R has to be reachable on the name you are trading (2026-09-01)

The same arithmetic as the target-reachability section above, one layer down —
and the one that actually explains flat days.

`maxStopDistancePct` (2.5%) binds on nearly every candidate, so **1R is a fixed
~2.5% move**. But 2.5% is a quarter of a normal day on one stock and more than a
whole day on another:

| symbol | daily ATR | 1R as x ATR | MFE that day |
|---|---|---|---|
| XOM | 2.00% | **1.25x** | +0.19R |
| DG | 3.20% | 0.78x | +0.08R |
| DE | 3.16% | 0.79x | +0.27R |
| CF | 3.85% | 0.65x | +0.46R |
| HOOD | 5.91% | 0.42x | +0.29R |

A 2.0%-ATR name cannot produce a 1R winner in a session that flattens at the
close. No signal quality rescues that — it is arithmetic. The book was full of
those trades and behaved exactly as the arithmetic demands: six live entries on
2026-09-01 reached a **median MFE of 0.28R and not one reached 1.0R**, so both
the reach-capped target (~1R) and the new 1.0R scale-out trigger were above
anything the day could produce.

`maxRiskAtrFraction` (DecisionConfig + AutotradeConfig, 0 = off) refuses a
candidate when `stopDistance > atr * fraction`, in `generateSignal` — a property
of the SETUP, not the portfolio, so no sizing or slot decision could rescue it
later. Expressed against the stop **actually used** rather than as a minimum ATR
so it cannot drift apart from `maxStopDistancePct` / `stopAtrMultiple`: the two
are one quantity.

**Threshold chosen from the distribution, not a guess.** Over that day's 27
signalled names (median ATR 3.42%):

| bar | implied min ATR | names surviving |
|---|---|---|
| 0.9x | 2.78% | 22 / 27 |
| 0.8x | 3.12% | 18 / 27 |
| **0.7x** | **3.57%** | **13 / 27** |
| 0.6x | 4.17% | 9 / 27 |
| 0.5x | 5.00% | 4 / 27 |

0.7 halves the pool while still comfortably feeding a six-trade budget, and it
splits the day exactly where the outcomes did: out go XOM (1.25x), DE (0.79x),
DG (0.78x); in stay the day's two best, CF (0.65x) and HOOD (0.42x).

**Correcting the previous session'''s reading.** An earlier analysis concluded the
opposite — that positions DO move (median MFE 1.18R) and the failure was capture.
That rested on 38 excursion rows of which **29 predated 2026-08-24**, because the
`entry_date` gap (fixed the same morning) kept recent trades out of the excursion
dataset entirely. Split by era the sample says: older 1.21R, 08-24..08-31 0.26R,
2026-09-01 0.28R. The recent book is flat; the old one was not. Any future read
of excursion data should check its era mix before drawing a conclusion from the
median.

Ships **off** (0). Backtests, paper and the manual preview are unchanged until
live config opts in.

### Pre-committed reading of the ATR-floor experiment

Written 2026-09-01 **before** the first session under it, for the reason
`docs/OPTIONS_TUNING_PLAN.md` gives: a question left open until the numbers
arrive gets answered by whatever the numbers happen to look like. Eight config
changes and six merges landed the same day, so nothing tomorrow attributes
cleanly to one cause — which makes a pre-committed reading more necessary, not
less.

**The measurement.** Median MFE (`/api/journal/excursions`, rows filtered to the
session's `entryDate`) over the day's closed live trades. Baseline to beat:
**0.28R median, 0/6 reaching 1.0R** on 2026-09-01. Secondary: whether
`live_scale_out_placed` fires at all, which it never did on the baseline day
because nothing reached the 1.0R trigger.

**FILTER TO INTRADAY RESOLUTION — the correction that makes these numbers mean
anything.** `/api/journal/excursions` rows carry a `resolution`, and
daily-resolution rows measure MFE across a bar whose high spans hours the
position did not exist. The split on 2026-09-01: **intraday median 0.23R (n=14)
vs daily-resolution 1.23R (n=24)**, combined 0.91R. Every conclusion drawn from
the combined figure that day was wrong — including a counterfactual putting
+19.7R on a 1.0R target, computed against peaks that were never reachable while
the trades were open. **Compare intraday to intraday, always.**

The thresholds below were **corrected the same evening, before any data arrived**,
for exactly that reason: they were first written against the contaminated 1.18R
figure, which would have made A3 ("no effect") fire almost regardless of outcome
and sent the next session chasing entry timing on a change that was working.
Re-anchored on the honest intraday baseline of **0.23R historical / 0.28R on the
day**. Adjusting a threshold before the data exists is legitimate; adjusting it
after is moving the goalposts, and this is the last moment it can be done
honestly.

| # | Reading (intraday rows only) | Response |
|---|---|---|
| A1 | Median MFE **≥ 0.45R** and scale-out fires at least once | The floor is doing what it was built to do — roughly double the intraday norm. Change nothing; accumulate toward the 25-trade sample rule #19 needs. |
| A2 | Median MFE **0.33–0.45R** | Directionally right, sample far too thin to act on. No change, and say so plainly rather than reaching for a follow-up tweak. |
| A3 | Median MFE **still ≤ 0.33R** with the floor active | Selection is **not** the constraint. Do NOT loosen further and do NOT raise the floor again — look at ENTRY TIMING instead (measure MFE by entry hour before proposing anything). |
| A4 | Trade count **< 3** for two consecutive sessions | The floor plus the 3.57%–15% window is starving the book. Reconsider the 0.7 fraction against the measured distribution, not by feel. |

**Queued behind this read, deliberately not stacked onto it:**
`breakevenTriggerRMultiple` and `trailStartRMultiple` are both **1.0R**, and
**zero** stop ratchets fired on 2026-09-01 — the same diagnosis as the scale-out
trigger, one mechanism over. That leaves the current fix half-finished: half the
position banks at 0.30R and the remainder has no breakeven protection until a
level these trades do not reach. It is the strongest candidate for the NEXT
change, after the 3-session read, not alongside it.

**Minimum sample before any parameter moves on this: 3 sessions.** One day of
6–8 trades cannot separate a real effect from noise, and the whole reason this
block exists is that the previous conclusion ("positions do move, capture is the
problem") came from a 38-row sample whose recent portion was 8 rows.

**The trap to avoid specifically.** A profitable day is not evidence the floor
worked — 2026-09-01 finished **+$17.03** while every trade was flat and the
mechanism under test never engaged once. Judge the MFE distribution, not the
P&L.

### Pre-committed reading of the 0.30R scale-out (2026-09-01, same session)

Set alongside the ATR floor, so the two are tracked separately or neither is
interpretable. `partialExitRMultiple` went **1.0 -> 0.30** with
`partialExitPct` 50.

**Why 0.30 and not the eight-trade optimum.** A counterfactual over the recent
8 trades put the best single target at ~0.25R (+0.136 R/trade vs -0.027 as
traded). That number is NOT the justification — it is fitted to eight
observations drawn from a distribution the ATR floor changed hours earlier. The
justification is structural: at 1.0R the trigger sat **above the entire observed
MFE range** (max 0.92R), so it could not fire, and did not fire once on
2026-09-01. A trigger that is provably unreachable should move regardless of
where exactly the optimum sits.

**The ladder now:** +0.30R banks 50%, +1R moves the stop to breakeven on the
remainder, the reach-capped target (~0.77x ATR) takes the rest.

**The measurement.** `live_scale_out_placed` per session (baseline: **0**), and
mean realized R. The comparison that matters is against what the FULL position
would have returned — recoverable per trade from `mfeR` and the exit — because
banking half at 0.30R deliberately gives up upside on that half.

| # | Reading | Response |
|---|---|---|
| B1 | Fires on >=30% of trades **and** mean realized R beats the no-scale-out counterfactual | Keep. This is the intended effect. |
| B2 | Fires often but realized R is **no better** than the counterfactual | The partial is banking noise and capping winners. Raise the trigger back toward the observed MFE median rather than lowering it further. |
| B3 | Still does not fire | 0.30R is *also* above the distribution. That is an A3-class result — the constraint is selection or entry timing, not the exit ladder. Do not lower the trigger a third time. |

**The fragility to keep watching.** A small target against a 1R stop needs a high
hit rate to pay: at 0.30R, break-even is ~77%. The recent book only came out
positive because its LOSERS scratched near zero on the time exit (-0.02, -0.11,
-0.03) rather than taking full stops. **If losses start arriving at full -1R,
this ladder degrades fast** — so track the realized-loss distribution, not just
the win rate. That dependency is the whole risk of the change.

Same 3-session minimum as the ATR floor above.

---

## The loop kept going back to the name it had just exited (2026-09-01)

Measured over the 26 live entries since 2026-08-24: **four were re-entries into
a symbol already traded that same day** — ANF (08-26), ESTC (08-28), CRWD
(08-31), DE (09-01). 15% of the entry budget, on four of seven sessions.

**Why `symbolCooldown.ts` does not catch it, by design.** That gate needs
`symbolCooldownLosses` (>= 2) **losing** closed trades in a rolling window, and
its own header says *"wins and breakeven scratches never count"*. The exit doing
the damage is the STAGNATION exit, which by definition scratches near zero — so
it is not a loss, never counts, and the cooldown never engages. That module also
measures in calendar days, so it has no intraday opinion at all.

**And the re-entry contradicts the exit that produced it.** The stagnation exit
journals its own reason as *"recycling the slot for fresh signals"*. Handing the
freed slot straight back to the name that just failed to move is the opposite of
a fresh signal: the same thesis, at a worse time of day, with less of the session
left to work in.

`symbolReentryCooldownMinutes` (0 = off) blocks a NEW live entry for N minutes
after that symbol's own autotrade position closes. `reentryCooldown.ts` is pure;
`liveExecute` supplies autotrade-tagged closed positions only, so a human's
manual trade in the same name never gates the loop.

**Time-based, not rest-of-day.** `symbolCooldown`'s header records the
counter-case that keeps this honest: LVWR lost -0.98R at 12:30 and the same-day
re-entry won +1.93R. A genuine second setup hours later is a real thing. This
blocks the reflex and then gets out of the way.

**Journaled every time** as `symbol_reentry_cooldown_skipped`, not once per day
like the cheap skips — a re-entry the loop WANTED is exactly the population to
audit before trusting the gate, and these were invisible until now.

Ships **off**. Paper, backtests and the manual preview are unchanged until live
config opts in.

---

## The reachability gate was filtering the control book too (2026-09-01, same day)

`maxRiskAtrFraction` shipped inside `generateSignal` in `decide.ts`. That sits
**above the paper/live split**: `loop.ts` calls `runAutotradeDecision` ONCE and
both `runPaperExecution` and `runLiveExecution` consume the same
`decision.signals`. So the filter silently removed low-ATR names from **paper**
as well as live.

Every other entry gate is live-only, deliberately. `symbolCooldown.ts` states the
convention outright: *"Paper deliberately keeps trading the cooled name — it
stays the always-on sanity track, and its trades are the evidence that the name
has started behaving again."* The naked-short skip and `reentryCooldown` follow
it. This one did not, and nothing caught the asymmetry because the three config
guards check that a field is READ, not WHERE.

The cost was specific: it left the experiment set up the same evening with **no
control group**. Rule A3 asks whether excluding those names was right, and
answering it needs a book that still trades them.

Moved to `runLiveExecution`, beside the other gates. `generateSignal` now carries
the deriving `atr` on `TradeSignal` — the same pattern `avgVolume` and
`relVolPace` already use — and the live path does the refusing. Journaled as
`risk_atr_unreachable_skipped`.

**The regression test is at the property, not the placement:** a paper test
asserts `runPaperExecution` still takes a name whose 1R costs 5x its daily
range, which live refuses at 0.7. Asserting the gate's location would pass
again the next time it moves; asserting that paper stays a control cannot.

### The general lesson

A gate's PLACEMENT in the pipeline is part of its meaning. Above the split it
gates the experiment; below it, it gates one arm. The config guards cover
whether a field is read and by what — they say nothing about whether the reader
sits on the right side of a fork the whole evidence design depends on.

---

## A short entry was not buying-power checked at either layer (2026-09-01)

Found while auditing the short path **before** enabling `liveAllowNakedShort`,
rather than after. Both buying-power checks keyed on `side` and treated every
`sell` as closing a long:

- `buyingPowerSizing.buyingPowerMaxQuantity` — `if (side !== 'buy') return none`,
  i.e. no constraint at all.
- `guardrails.ts` — `if (intent.side === 'buy') { ...check... } else
  block('buying_power', true, 'n/a (sell frees buying power)')`.

"A sell frees cash" is true of **closing a long** and false of **opening a
short**, which consumes margin like any other opening order. `riskCheck` sizes
ENTRIES, so a `sell` reaching it is always a short entry, never a close.

Both now key on `openClose`: **opening consumes, closing frees — regardless of
side.** That is the correct rule for all four combinations, including covering a
short (a closing buy, which frees margin).

**This was inert only because shorts were disabled.** With `tradeDirection:
both` the screener was generating them the whole time — 723 of 1,000 signals on
2026-09-01, 72% — and the naked-short skip refused them at the live layer. The
day the flag flipped, every short entry would have been sized and cleared with
no buying-power check anywhere in the chain. The remaining backstops
(`liveMaxOrderUsd`, the exposure cap) would have caught the extreme cases and
nothing else.

Verified end to end on a synthetic short after the fix: stop above entry, target
below, R = 2.00, and `buying_power_sizing` now sizes 500 shares down to 49
against $5,000 of buying power and then skips it as a token position. Before the
fix that rule reported "inactive".

### The pattern this belongs to

A branch that cannot execute cannot be wrong yet. `liveAllowNakedShort` had been
false for the whole life of this code, so the short half of every side-keyed
decision was unexercised — by tests, by production, and by every previous audit.
**Turning on a long-disabled flag is not a config change; it is shipping an
untested code path into live money.** Audit the path first, and prefer rules
keyed on what the order DOES (open/close) over what it looks like (buy/sell).

---

## Pre-committed: what to do if trades START RUNNING

Written 2026-09-02, before the ATR floor has had a session. Every exit
parameter in force was tuned against a book whose median intraday peak was
**0.23R** — trades that went nowhere. If selection now works, those same
parameters become wrong in the opposite direction, and the failure mode flips
from "holds losers too long" to "cuts winners too early". That is a good
problem, and it needs a rule before it arrives, not after.

**The anti-stall machinery is already aggressive and already working.** The
stagnation exit cuts anything under `stagnationExitMinR` (0.5R) after
`stagnationExitMinutes` (90), and it fired on **16 of the last 25 exits**.
Trades were not being allowed to stall — they were stalling, and the exit was
cutting them correctly. That is why the 2026-09-01 fixes went upstream into
SELECTION rather than into the exit.

### The signal that trades have started running

Not P&L, and not the median alone. Two counts, together:

- median intraday MFE clears **0.45R** (task #20's A1), **and**
- the `time_exit` share of closed trades falls below **50%** (baseline: 16/25 = 64%).

The exit-reason mix is the more trustworthy half: it is a count, not an average,
so a single outlier cannot move it.

### The rules

| # | Reading | Response |
|---|---|---|
| T1 | Trades running, **and** ≥30% of stagnation exits show `progressR` between 0.35R and the 0.5R bar | They were cut just short while working. **Lower `stagnationExitMinR`** toward the observed cluster — the bar is wrong, not the clock. |
| T2 | Trades running, **and** stagnation exits show LOW `progressR` (<0.35R) but the surviving trades peak late in the hold | The trades need more time, not a lower bar. **Raise `stagnationExitMinutes`** (90 → 120). Never both knobs in one week. |
| T3 | Partials fire often **and** the remainder routinely reaches the target | The ladder is working as designed. **Change nothing** — this is the intended shape. |
| T4 | Partials fire often **and** the remainder routinely scratches | The partial is capturing the whole move and the runner is dead weight. Raise `partialExitRMultiple` toward the observed MFE median rather than lowering it again. |
| T5 | Trades reach 1.0R regularly, so `breakevenTriggerRMultiple` / `trailStartRMultiple` finally ARM | Measure whether the breakeven stop is cutting trades that continued, before assuming the ratchet helps. It has never once fired in production — an unexercised mechanism is not a proven one. |

**T1 and T2 are deliberately mutually exclusive** and keyed on the same
measurement, because the tempting move when winners get cut is to loosen both
the clock and the bar at once, which makes the result uninterpretable.

Minimum sample, as everywhere else: **3 sessions**, and one parameter per week.

---

## Full-path audit: long, short, options (2026-09-02)

Ordered sanity check of all three instruments against the standing goal — 3% of
starting ET-day equity, long/short stock plus calls/puts, without over-risking.

### Verified correct

| area | finding |
|---|---|
| Realized P&L | `realizedPnlOf` applies `sideSign`; `initialRiskOf` uses `abs`. Correct for both sides. |
| Excursions | `computeExcursion` picks the LOW as favourable for a short and the HIGH as adverse, with the sign applied to the dollar math. |
| Live options wiring | Short-dated ladder, combined risk via `combinedLiveOpenRisk`, daily target, end-of-day flatten, entry-window gate and the max-1 gate are all present and reached. |
| End-of-day flatten | Called by BOTH `liveExecute` and `liveOptionsExecute`. A 0DTE cannot be left to expire because one book forgot. |
| Daily target | Active and tracking: baseline, target equity, gain %, give-back arm/floor, `entriesHalted`. |

### Fixed by this audit

**A short entry was still not buying-power SIZED.** PR #460 taught
`buyingPowerMaxQuantity` that an opening sell consumes margin, and fixed the
guardrail. But `liveExecute.buyingPowerForSide` returned `undefined` for any
sell, so production handed the sizer no figure at all and `undefined` reads as
"no constraint". The guardrail still refused an unfundable short — *after* a
full-size order had been built, which is precisely the build-then-refuse loop
the buying-power sizer exists to end (627 refusals, zero entries, 2026-08-28).

The earlier "verified end to end" claim was wrong: that check passed
`buyingPowerUsd` into the risk context by hand and never exercised
`buyingPowerForSide`. **A fix verified by calling the fixed function is not
verified; it has to be reached the way production reaches it.**

The lazy-fetch optimisation the guard was protecting is intact — a short only
reaches that code when `liveAllowNakedShort` is ON, because the short-entry skip
returns first when it is off, so a disabled-shorts book still pays for no broker
round-trip. Both properties now have tests.

### Open gap — blocks enabling LIVE OPTIONS

**An options order is buying-power checked against the WRONG POOL.**
`liveOptionsExecute` passes `acct.state` to `evaluateGuardrails`, whose
`buying_power` rule compares premium notional against `buyingPowerUsd` — the
EQUITY/day figure. Options are bought from **option** buying power, a separate
and far smaller pool: measured 2026-08-27 at **$471.41 against a day BP of
$8,644.72**, an ~18x difference.

So a $600 premium order passes the check (600 < 8,644) and is then refused by
the broker (600 > 471). `webullAccountState` already returns
`optionBuyingPowerUsd` as its own field, so the data is in hand and simply not
used. `liveOptionsExecute` contains **zero** references to buying power.

**CLOSED 2026-09-02.** `liveOptionsExecute` now overrides `buyingPowerUsd` with
`acct.optionBuyingPowerUsd` on the AccountState it hands to `evaluateGuardrails`,
so an opening premium order is valued against the pool it actually draws on.

Fails **open**: the provider already falls back `option_buying_power ->
buying_power -> cash`, so a broker reporting no option pool yields the equity
figure and behaviour is exactly as before. The override only ever NARROWS the
check, never widens it. Exits are unaffected — the guardrail values only
OPENING orders since the open/close fix earlier the same day.

Fixed while live options was still OFF, deliberately: the same order as the
short buying-power hole, which was closed before `liveAllowNakedShort` was
turned on. A gap found is cheaper to fix than a gap remembered.

### The recurring pattern, third instance

Shorts, live options, and now the short sizer are all the same shape: **a branch
that cannot execute cannot be wrong yet.** The three config guards prove a field
is read; they say nothing about whether the path that reads it has ever run.
Before enabling any long-disabled flag, audit its path as untested code — because
that is what it is.

---

## 2026-09-02 — Movers discovery: working, contributing ~nothing, and unobservable

`universe_auto_promoted` had fired **zero times in 2+ weeks** while both
`moversDiscoveryEnabled` and `autoPromoteMoversEnabled` were on. Four separate
layers made the cause unknowable from inside the app:

1. The movers fetch swallowed every error with a bare `catch {}` — "provider
   broken for weeks" and "quiet premarket" produced the identical observation.
2. `discovery.moversCount` was returned by `runAutotradeScreen` and read by
   nothing.
3. `discoverySource` was computed per candidate, **drove real behaviour on both
   sides** (promotion counts only `'movers'`; the options decision considers only
   `'universe'`), and was journaled nowhere — absent from all 400 sampled
   `candidate_found` rows.
4. Promotions themselves were the only signal, and they were zero.

### What it actually was

Measured directly against the live book on 2026-09-02 via `POST /api/autotrade/screen`:

| Quantity | Value |
|---|---|
| Universe symbols | 528 |
| Movers fetched (unusual + gainers, deduped) | 35 |
| Symbols scanned | 563 |
| Candidates | 225 |
| **Candidates sourced from movers** | **1** (WETO, short) |

The provider works. The gappers it finds mostly don't clear screening: of the 35
movers, only 11 were priced **at or above the $5 `minPrice` floor** (sample
prices 0.24, 0.30, 0.32, 0.36, 0.75, 0.79, 0.83, 0.95, 1.34 …), and
`minAvgVolume` 1,000,000 cuts further. Webull's premarket movers skew hard
toward sub-$5 names by construction — that is what a premarket gapper list is.

So auto-promotion is not broken. `recordMoverOccurrence` fires only for
movers-sourced candidates that **passed** screening, and it needs the SAME symbol
on 3 distinct days inside a 10-day window. At roughly one surviving mover per
day, drawn from a set that rotates daily, three repeats is a rare coincidence
rather than a threshold anything approaches.

### Fixed

- `discoverSymbols` returns `moversError`; the bare catch keeps the screen
  running (movers remain an enhancement, never required) but no longer discards
  the reason.
- `candidate_found` journals `discoverySource`, so the fetched-vs-survived ratio
  is measurable over time instead of by hand.
- `LoopTickSummary` gains `moversDiscovered` / `moversCandidates` /
  `moversFetchError`, surfaced on the Monitoring **Last cycle** line.
- The loop journals `movers_fetch_failed`, throttled to once per ET day per
  distinct message — the loop ticks every 60s, so an unthrottled outage would
  write ~390 identical rows a session.

`moversDiscovered` and `moversCandidates` are derived from the **screen result**,
not from `processMoversForPromotion`'s return: the diagnostic's whole purpose is
answering "is movers discovery contributing", and reading it from the promotion
result would have made it go dark in the one case it exists for — a throwing
promotion call.

### Not changed, deliberately

`minPrice: 5` is the direct cause of the thin contribution and is **left alone**.
Lowering it to reach premarket gappers means routing real money into sub-$5
names, whose bid-ask/slippage tax is exactly what that floor exists to avoid —
that is a risk decision, not a bug fix. The observability above is what makes it
a decision that can now be made against measured numbers instead of a guess.

### The pattern, again — one layer up from config

CLAUDE.md's rule is *assert at the consumer, not the producer*. This is the same
disease at the observability layer: **a value that is computed, returned, and
read by nothing is indistinguishable from a value that is wrong.** `moversCount`
and `discoverySource` were both live, both correct, and both unable to answer
the one question anyone asked of them for two weeks.

---

## 2026-09-02 — The options book's refusals were invisible, and its size ceiling is $0.63

Two findings from auditing the live options path as untested code (it has never
executed — `liveOptionsEnabled` is off).

### 1. Every live options refusal was silent — FIXED

`runLiveOptionsExecution` pushed `{ok: false, reason}` into an `outcomes` array
the loop counts and discards. Only a **throw** wrote a journal row
(`live_options_entry_failed`). So the orderly refusals — the common ones — left
no trace anywhere:

- a blocked risk check became the bare string `'Risk check blocked'`, discarding
  *which rule* failed;
- `attemptLiveOptionsEntry`'s own refusals (probation flooring size to 0, a
  last-trade-only quote, a vanished net debit, a failed quote fetch) wrote
  nothing at all.

This is the third instance of the identical hole — the equity book's
`live_risk_blocked` and the options "max 1 at a time" gate were the first two.
Now journaled as `live_options_risk_blocked` (stage `risk_check`, carrying
`failedRules`, `checks`, `quantity`, `premium`) and `live_options_entry_refused`.

Both are **throttled to once per symbol per ET day** via
`journalEntrySkipOncePerDay`, unlike equity's unthrottled twin. The options
decision emitted **184 signals in one tick** on 2026-08-27 and the loop ticks
every 60s; the refusals here are steady-state conditions, not events, so
unthrottled they would be tens of thousands of rows a session saying one thing.
The helper gained an optional `stage` parameter for this — its dedupe read has
to look in the same stage it writes to, or the throttle silently never matches.

Refusals that already journal themselves carry `journaled: true` on the outcome
so the batch loop does not write a second row.

### 2. The risk model implies a $0.634 premium ceiling — REPORTED, NOT CHANGED

`optionsRiskCheck` sizes a single leg with `stopPrice: 0` — the full premium is
the risk, because a long option really can expire worthless. So:

> contracts = floor(riskBudget / (premium × 100))

At the live book — **$5,074.68 equity, `riskPerTradePct` 1.25%** — the budget is
**$63.43**, and the largest premium that sizes even one contract is
**$0.634/share**. Anything above it is refused on the `quantity` rule.

The paper options book confirms it exactly. Four positions, ever:

| Symbol | Contracts | Entry premium |
|---|---|---|
| INTC | 1 | 0.59 |
| MRVL | 1 | 0.62 |
| NOW  | 1 | 0.57 |
| RKLB | 1 | 0.54 |

All four under the ceiling; all four exactly 1 contract. With the configured
window (`optionsMinDte` 0 / `optionsMaxDte` 2, delta 0.25–0.40) a liquid
underlying's contract is routinely $1–$3 — sized to **zero**.

Note the model disagreement, in CLAUDE.md's "two places derive the same
quantity" family: the **sizer** assumes 100% of premium is at risk while the
**exit path** stops at `optionsStopLossPct` 40% (disaster stop 70%). They differ
by 2.5×. Sizing on the worst case is the safe direction to disagree in, so this
is left alone — but it is the reason the ceiling is where it is, and it is a
risk decision, not a bug fix.

Pinned as a characterization test (`autotradeOptionsRiskCheck.test.ts`) so a
change to the risk model, the budget, or the account size says out loud where
the ceiling moved rather than landing silently in a live book.

**And it makes the option-buying-power fix shipped hours earlier inert at this
size.** Read live the same day:

| Figure | Value |
|---|---|
| `optionBuyingPowerUsd` | $5,074.68 |
| `buyingPowerUsd` | $10,149.36 |
| `dayBuyingPowerUsd` | $20,298.72 |

The option pool is a real field, not a fallback — it is distinct from both of
the others (Webull extends no margin on long options, so it equals net
liquidation). But the largest premium order the sizer will ever build is
**$63.43**, which is **80× inside** the $5,074.68 pool. The buying-power check
is correct and worth having; it simply cannot bind until either the account
grows a great deal or the risk model changes. Worth writing down so the fix is
not mistaken for a change that will alter behaviour today.

### 3. Probation cannot cut a 1-contract size — REPORTED

`quantity = Math.floor(rawQuantity * probation.multiplier)`. Since the sizer can
only ever produce **1** contract at this account size, any multiplier below 1
floors to **0** and refuses the entry. With
`liveOptionsProbationSizeMultiplier` 0.5, turning options probation on — the
obvious careful thing to do before going live — would block **every** options
entry for the whole window, refused as *"Probation-adjusted quantity rounded to
0"*, which reads like a fluke rather than a permanent state.

It is inert today only because `liveOptionsProbationTrades` is **0**, so
probation never activates. The refusal is now journaled, so if it is ever turned
on the cause is visible on day one instead of looking like a quiet book.

---

## 2026-09-02 — The short buying-power fix was half a fix

PR #460/#462 moved `guardrails.ts` and `buyingPowerSizing.ts` off `side` and
onto `openClose`, and corrected `buyingPowerForSide` in `liveExecute` to hand a
short a real figure. All three were the READ side.

The **write-back** was left on the old premise:

```ts
// A filled BUY has spent this money — the next candidate in the same
// batch must not be sized against it too. (Sells free buying power rather
// than consuming it, matching guardrails.ts, so they leave it alone.)
if (availableBuyingPowerUsd !== undefined && signal.side === 'buy') {
  availableBuyingPowerUsd = Math.max(0, availableBuyingPowerUsd - notional);
}
```

"Sells free buying power" is true of a **closing** sell. `runLiveExecution` is
the **entry** batch — every signal reaching it is an OPEN, and `side: 'sell'`
means *open a short*, which consumes margin exactly as a buy consumes cash.

So a batch that opened a short decremented nothing, and the next candidate was
sized against money the short had already spent — the precise double-spend the
decrement exists to prevent, and one that could only ever fire once shorts were
enabled. **Fourth site of the same confusion.**

Fixed: both sides decrement. Covered by a two-sided test — short then long on
$25,000 (the long is correctly declined as only 25% fundable, under the
min-funded-size floor) and the same batch on $45,000 (both go out at full size,
so the first test cannot pass by the decrement over-subtracting). Reverting the
one-line change fails the first and passes the second.

### Why the guards did not catch it

The three config guards stop at config fields. `configReachability` proves
`liveAllowNakedShort` is *read*; it says nothing about whether every branch
that reads `side` reads it correctly. And the unit tests for
`buyingPowerSizing` and `guardrails` both pass either way — they test the
functions, not the batch loop that calls them.

CLAUDE.md already names this: **assert at the consumer.** The lesson this adds
is narrower and worth stating on its own — *when you fix a premise, grep for the
premise, not for the function.* The string `side === 'buy'` was the defect;
three of its four occurrences were fixed by reasoning about buying power, and
the fourth survived because it lived in a batch-accounting line nobody was
thinking about buying power in.

---

## 2026-09-02 — Making the options book actually tradable

Three changes, in descending order of how much they were blocking. The first is
a unit bug and dwarfs the other two.

### 1. The DTE window was measured in the wrong unit — FIXED

`optionsMinDte` / `optionsMaxDte` are configured in **whole days**. Both places
that gate on them compared against `daysToExpiration()`, which is **fractional
time-to-expiry**:

```ts
const dte = daysToExpiration(exp, now); // 2.27 on a Wednesday, for Friday
return dte >= minDte && dte <= maxDte;  // maxDte = 2  ->  rejected
```

On a Wednesday, every Friday weekly contract in the market scores between 2.00
(at the closing bell) and 2.83 (at midnight), so a `[0, 2]` window admitted it
**only from Thursday onward**. For a weekly-expiry name — which is nearly the
whole universe — options could open on **Thursday and Friday only**.

Measured on the live book, Wednesday 2026-09-02:

| Outcome | Count |
|---|---|
| Options candidates considered | 218 |
| **Skipped: "No expiration within the configured DTE window [0, 2] days"** | **214** |
| Skipped: IV/RV above max | 4 |
| Signals generated | **0** |

…while `GET /api/options/DE/expirations` and `/TXN/expirations` both listed
`2026-09-04` — the very contract the window was meant to admit.

`entryRules.ts` had been printing the contradiction on its own rule line the
whole time: the comparison used the fraction, but the detail string rendered
`dte.toFixed(0)`, so a failing rule displayed as **"2d ≤ 2d"**.

The four paper options positions this app has ever opened confirm the pattern
exactly — three opened on a **Friday** (same-day expiry) and one on a Tuesday
(INTC, which carries M/W/F expirations):

| Symbol | Entry (ET) | Weekday |
|---|---|---|
| RKLB | 2026-08-28 10:23 | Friday |
| NOW | 2026-08-28 11:04 | Friday |
| MRVL | 2026-08-28 12:00 | Friday |
| INTC | 2026-09-01 10:04 | Tuesday |

Fixed with a new `calendarDaysToExpiration()` used by **both** window gates —
`optionsDecide`'s expiration filter and `entryRules`' min/max DTE rules — so the
two agree by construction. It is anchored to the **ET** calendar day, not the
server's, so the answer doesn't shift with deployment timezone.

`daysToExpiration()` is untouched and still used for pricing, Greeks, and the
decay-sensitive exit rules, where a fraction of a day genuinely matters. Both
functions now carry doc comments saying which is for which, since reaching for
the wrong one is the entire bug.

### 2. Single-leg sizing assumed a 100% loss the exit path never allows — FIXED

Sizing passed `stopPrice: 0` — "the whole premium is at risk." That reads as
conservative and is really a **unit mismatch with the exit path**
(CLAUDE.md: two places deriving the same quantity must agree by construction).
`riskPerTradePct` is defined as *what you lose when the stop hits*, and the stop
that actually fires is `optionsDisasterStopPct` (70%), enforced by
`shortDatedOptionsExit`'s `disaster_stop` on **both** books.

So a position sized on a 100% assumption risked only 0.7x the stated appetite
when the real stop fired — and because a contract is indivisible, at a $63.43
budget that meant nothing above **$0.634/share** could be bought at all.

Now sized against the disaster stop. At $5,074.68 equity and 1.25%:

| | ceiling | loss if the disaster stop hits |
|---|---|---|
| before (100% of premium) | $0.634/share | 0.87% of account |
| after (70% disaster stop) | **$0.906/share** | **1.24% of account** |

The second column is the point: the new sizing *matches* the configured 1.25%
risk-per-trade instead of undershooting it. This is a correction, not a
loosening — a test asserts `approvedRiskAmount <= budget` across the premium
range, and `$1.00+` premiums are still refused.

The basis is deliberately the **disaster** stop (70%) and not the soft
`optionsStopLossPct` (40%) that usually fires first, nor the 0.5% underlying
stop that usually fires before either. The margin between 70% and 100% is what
absorbs a gap through the stop.

Fails **safe**: an absent, zero, or >=100 `optionsDisasterStopPct` all fall back
to the full-premium assumption — exactly the previous behaviour. Threaded from
config at all three options callers (preview route, paper, live).

### 3. Probation could not cut a one-contract size — FIXED

`Math.floor(rawQuantity * multiplier)` turned an approved 1 contract into **0**
at any multiplier below 1. Since the sizer produces roughly one contract at this
account size, switching options probation on — the obvious careful move before
going live — would have refused **every** options entry for the whole window,
reported as *"Probation-adjusted quantity rounded to 0"* as though it were an
arithmetic accident rather than a permanent state.

Clamped to the minimum tradeable size instead: probation's job is to cut size,
and at one contract there is nothing left to cut. The clamp journals
`options_probation_at_minimum` when it binds, so "probation is not actually
cutting anything" is visible rather than inferred from an order size. A signal
the risk check genuinely sized at zero still refuses, with a reason that no
longer blames probation for it.

### The coupling the sizing change broke — and the fix

`riskAmount` and notional were the **same number** for an options position while
sizing assumed the whole premium was at risk. Three correlated/sector-exposure
call sites relied on that identity:

```ts
positions: snapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount, ... }))
```

Sizing against the disaster stop makes `riskAmount` 70% of capital deployed, so
those sites would have silently understated every options position's exposure by
30% — with no test noticing, because each one was correct the day it was
written. Exactly CLAUDE.md's "when a derived struct grows a field, assert its
consumer reads *that* field rather than a sibling", except here the field did
not grow: its **meaning** changed underneath a consumer that had every reason to
trust it.

All three now call one exported `optionsPositionNotionalUsd(p)` — premium (or
net debit) paid x contracts x 100 — so both books compute it the same way. A
test asserts `approvedNotional` (1,200) and `approvedRiskAmount` (840) are no
longer equal, so they cannot quietly collapse back into one number.

### The likely NEXT constraint — measured, not changed

Of the four candidates that got *past* the DTE gate on 2026-09-02, **all four**
failed `optionsMaxIvRvRatio` (INTC 1.41, GOOGL 1.14, AVGO 4.86, AAPL 1.36).

That field **defaults to 0 (off)** and is set to **1** on this book, so it is a
deliberate choice, not a default — left alone for that reason. But note what it
asks of a 0-2 DTE contract: that its annualized implied vol be at or below the
symbol's **20-day realized** vol. Short-dated options carry an event/gamma
premium almost by definition, so this comparison is close to structurally
unsatisfiable in that DTE window, and it is not an apples-to-apples "is this
option expensive" test the way it is for a 30-60 day contract.

Whether it binds in practice is now measurable rather than theoretical: with the
DTE gate fixed, ~218 candidates a tick reach it instead of 4, and
`live_options_risk_blocked` records what refuses them. Re-measure before
changing it.


---

## 2026-09-02 (later) — Measuring the DTE fix in production, and what it exposed

Re-ran `POST /api/autotrade/decide` against the deployed build.

**The DTE fix works.** Skips for "No expiration within the configured DTE
window" went from **214 of 218 (98%)** to **1 of 17 (6%)** — the one remaining
being a name that genuinely has no expiry inside `[0, 2]`.

### The DTE bug had been starving IV-rank history

`recordAtmIv()` sits **downstream of the DTE gate** in `generateOptionsSignal`.
So for the whole period the window was broken, 98% of candidates returned early
and never recorded an IV sample. The observed sample counts match exactly —
TXN 1, SOFI 1, NCLH 3, AMD 3, MRVL 5, PLTR 5, INTC 6, NOW 7 — with the highest
counts on the names carrying M/W/F expirations, which slipped through the broken
window most often.

Self-healing now that the gate admits ~94%: every screened symbol records a
sample per session, and the 15-sample requirement clears in roughly 15 sessions.
No further code change needed for it.

### A failed candle fetch was reported as a short price history — FIXED

Eight symbols reported *"…and not enough price history for a realized-volatility
estimate either"*. That claim was **false**: `/api/candles/<SYM>?timeframe=daily`
returned **200 daily bars** for TXN, AMD, INTC, NOW and PLTR, and
`realizedVolSeries` over 200 bars yields ~170 samples against a requirement of
15.

The cause was `.catch(() => [])` on the daily-candle fetch, swallowing provider
rate limiting under batch load. Decided **alone**, TXN and AMD both cleared the
gate and moved on to the entry rules; decided in a 20-symbol batch, both
reported missing data that was never missing.

Same family as the movers `catch {}` fixed earlier the same day, with an extra
harm: the message did not merely omit the reason, it **asserted the wrong one**,
pointing the reader at absent history rather than at a failed request. Both skip
paths (IV-rank and the IV/RV gate) now distinguish the two, and say plainly when
it is a fetch failure that "usually clears on the next cycle".

This matters more in production than in the measurement: the loop decides the
whole universe in one tick, which is the batch condition, not the single-symbol
one.

### What is NOT concluded here

The largest remaining bucket was *"No contract passed entry rules
(liquidity/spread/delta/IV band)"* — 8 of 17, and both isolated re-runs.

**That measurement was taken at ~03:00 ET, with the market closed.**
`optionsMinVolume` is 10 and the day's contract volume is 0 outside the session,
so essentially every contract fails that rule at that hour regardless of how it
would look at 10:00. Nothing about the entry rules should be inferred from it.
Re-measure during market hours before touching delta band, spread cap, or the
liquidity floors.

---

## 2026-09-02 (session review) — Two profit-protection mechanisms had never once executed

Reviewing the live session — 8 trades, 4W/4L, **+$32.78 (+0.6%)** against a 3%
target, trade cap hit at 13:00 — found that **both** mechanisms designed to
protect gains on a winner were broken at the broker layer, and had been since
they shipped.

The pattern is the one this file already names: **a branch that cannot execute
cannot be wrong yet.** Lowering the scale-out trigger from 1.0R to 0.30R is what
finally made the code reachable, and it turned out never to have worked.

### 1. The scale-out — 89 broker rejections, 0 placements — FIXED

Every one:

> *"The number of take-profit orders and the number of stop-loss orders must be
> the same."*

`checkLiveEquityScaleOuts` reduced the resting bracket **one leg at a time**:

```ts
for (const leg of resting) await webullReplaceOrder(accountId, leg.clientOrderId!, { quantity: keepQty });
```

Webull validates an OCO group's balance **per request**, so reducing a
take-profit without its stop-loss in the same call unbalances the group and is
refused. `modify_orders` has always been an array in the API — every caller
simply sent one element.

Fixed with `webullReplaceOrders(accountId, patches[])`, which sends every leg in
one request; `webullReplaceOrder` is now a one-element call into it. Distribution
of the 89 refusals: DELL 74, GTLB 12, HPQ 3 — exactly the three trades that got
above the 0.30R trigger.

This also closes a real hole in the loop it replaces: that loop broke on the
first failure **without rolling back legs it had already modified**, so a partial
success would leave a bracket whose take-profit covered the reduced size while
the stop still covered the full one. One request cannot half-apply.

### 2. The trailing / breakeven stop — never moved a stop — FIXED

> *"no resting leg identifiable as STOP_LOSS among 2 exit order(s)"*

`restingStopLeg` filters the resting exit legs for `combo_type === 'STOP_LOSS'`
and matched **zero of two, every tick**. `mapOpenOrder` read `combo_type` off the
**sub-order**, but this file's own `WebullOrderLeg` comment already documents
the real shape:

> a bracket comes back as THREE SEPARATE top-level envelopes sharing a
> `combo_order_id`, each wrapping its own single leg, with `combo_type` carried
> on the **ENVELOPE** … `combo_type` was looked for one level below where it
> lives, so every `comboType` filter matched nothing.

That fix was applied to `webullOrderStatus` and **never to
`listWebullOpenOrders`**. So every `WebullOpenOrder.comboType` was `undefined`.
`mapOpenOrder` now falls back to the envelope (sub-order first, so a nested
response keeps working).

DELL asked to ratchet 434.52 → 449.58 on a position that ran to +2.07R, and was
refused on every tick.

### What it cost, measured

| Sym | MFE | realized | captured |
|---|---|---|---|
| HPQ | **+0.75R** | **−0.33R** | **−44%** |
| BBY | +0.29R | +0.20R | 69% |
| GTLB (2nd) | +0.10R | −0.51R | −510% |

HPQ went three-quarters of the way to target and gave all of it back. A working
0.30R scale-out makes it roughly breakeven instead of −$18.

Seven of the eight exits were the 90-minute stagnation cut at under 0.5R. Only
DELL cleared 0.5R inside 90 minutes, escaped the cut, and ran to target for
**+2.07R / +$67.62 — more than the entire day's net**. The other seven together
lost $34.84.

### Consequence for the open experiment

The plan to "judge the ATR floor and 0.30R scale-out after 3 sessions" was
measuring **nothing** on the scale-out half: the mechanism had never run. That
clock restarts from the first session after this deploy.

### Not a bug: capacity was the binding constraint

267 live risk blocks — `max_concurrent_positions` 189,
`max_aggregate_open_risk` 174, `max_trades_per_day` 69. The book ran out of
slots, risk budget and trades, not ideas. Worth revisiting only after the two
fixes above have a session's worth of evidence.

---

## 2026-09-02 (workflow audit) — The R denominator moves when the ratchet moves

Auditing the paths that PR #467 is about to make reachable. Both fixes there
mutate inputs that other code assumed were constant, and neither assumption had
ever been tested — because neither mechanism had ever run.

### `initialRiskOf` read the CURRENT stop — FIXED

```ts
const risk = Math.abs(p.entryPrice - p.stopPrice) * p.quantity * p.multiplier;
```

`p.stopPrice` is what the breakeven/trailing ratchet **mutates**. `p.quantity`
is what a scale-out leaves stale. So one function answered two opposite
questions and, from tomorrow, gets both wrong:

| question | wants | had |
|---|---|---|
| **R denominator** (what did I originally risk?) | initial stop, original qty | **current** stop, original qty |
| **open risk** (what am I risking now?) | current stop, remaining qty | current stop, **original** qty |

The magnitude is not cosmetic. DELL on 2026-09-02 asked to ratchet 434.52 →
449.58 against a 445.40 entry. Once that succeeds the denominator goes from
|445.40−434.52| = 10.88 to |445.40−449.58| = 4.18, and **every R figure on the
position inflates 2.6×** — its real +2.07R would report as +5.4R.

Four consumers read it as an R denominator: `rMultipleOf`, `methodSizing`,
`computeGradeExpectancyMultipliers` (twice — riskCheck and liveExecute), and
the journal's MAE/MFE excursions, which `computeExcursionTune` then feeds to
the auto-tuner. A fifth, `getLivePortfolioSnapshot`'s `openRisk`, wanted the
other question entirely.

Split into two functions:
- `initialRiskOf` — `initialStopPrice ?? stopPrice`, ORIGINAL quantity. Frozen.
- `openRiskOf` — `stopPrice ?? initialStopPrice`, REMAINING quantity. Current.

`openRisk` in the live snapshot now calls `openRiskOf`; everything else keeps
`initialRiskOf`, which is now genuinely frozen. `routes/journal.ts` passes
`initialStopPrice ?? stopPrice` into the excursion so `mfeR`/`maeR`/
`realizedR`/`capturedPct` stay measured against the risk actually taken.

`initialStopPrice` is backfilled from the first stop a position receives
(`db/positions.ts`), so the fallback only covers rows predating that column.

**Why this matters for the open experiment:** Task #20 judges the ATR floor and
the 0.30R scale-out by R and capturedPct. Left unfixed, the first successful
ratchet would have inflated exactly the numbers that experiment reads — and it
would have looked like the change worked.

### Paper is not a control for exits — REPORTED, not changed

The paper book has **no stagnation exit at all**: `PaperExitReason` is
`'stop' | 'target' | 'time_exit' | 'manual'`, and `execute.ts` computes only
stop / target / maxHoldDays. Live cut all seven of 2026-09-02's losers at ~91
minutes on the 90-minute / 0.5R stagnation rule; paper carried DDOG 322 minutes
and GTLB 140 and re-entered GTLB **one minute** after stopping out of it (the
90-minute re-entry cooldown is live-only too).

Entry gates are deliberately live-only so paper stays a clean counterfactual —
that reasoning is documented for the ATR reachability floor. The exit divergence
carries no such comment, so it reads as an omission rather than a decision.

Left alone for now because it is genuinely arguable both ways: a paper book that
runs positions to end-of-day IS the counterfactual for "does cutting at 90
minutes help?", which is a question worth having an answer to. But it should be
a written-down decision rather than an accident, and until it is, paper-vs-live
P&L comparisons are not measuring what they appear to.

Confirmed NOT contaminating live sizing: paper lives in
`autotrade_paper_positions`, while `methodSizing` and the expectancy
multipliers read `listPositions()` (the live `positions` table) filtered to the
`autotrade` tag.

---

## 2026-09-02 — Auditing `liveScaleInEnabled` BEFORE turning it on

The flag is off and its code has never executed. Given that four of the day's
bugs were in exactly that shape, this audits it in advance instead of finding
out on the session it is enabled.

`placeLiveScaleInAddOn` gives the added shares their **own** bracket rather than
resizing the original one. That is a good decision on its own terms — it
sidesteps the OCO-modify problem entirely, and the original shares stay
protected while the add is placed. But it means a scaled-in position rests
**two brackets / four exit legs**, and two mechanisms assume one.

### 1. The scale-out would oversell into a short — FIXED

`checkLiveEquityScaleOuts` computes ONE whole-position number:

```ts
const keepQty = pos.remainingQuantity - decision.quantity;
```

…and applies it to every resting leg. With a single bracket (take-profit +
stop-loss, exactly one of which fills) that is correct. With **two** brackets it
leaves each protecting `keepQty`, so when the stop fills **both** stop legs sell
`keepQty` against a position of `keepQty` — and the account ends up **short by
`keepQty`**. That is the accidental short the function's own
reduce-legs-before-selling ordering exists to prevent, arriving through a door
that ordering does not cover.

Splitting `keepQty` across lots correctly would require knowing which bracket
protects which shares, which nothing tracks. So the scale-out now **refuses**
when more than two exit legs are resting, journaling
`live_scale_out_blocked` with the leg ids — the same fail-closed posture
`restingStopLeg` already takes for the same ambiguity.

Guarded by a pair: a four-leg book must resize nothing and sell nothing, and a
two-leg book must still scale out normally. Reverting the guard fails the first
and passes the second.

### 2. Scale-in and the trailing stop are mutually exclusive — DOCUMENTED

`restingStopLeg` requires exactly one identifiable STOP_LOSS leg and otherwise
returns:

> `${stops.length} resting STOP_LOSS legs — ambiguous, not guessing which protects this lot`

A scaled-in position has two. So **any position that scales in permanently loses
its breakeven and trailing stop** — the mechanism repaired hours earlier in
PR #467.

This one is left as-is deliberately. The refusal is fail-closed: it declines to
move a stop, which costs a feature but never risks money, and the alternative
(guessing which lot a stop protects) is how you drag a target down onto the
price. Fixing it properly means per-lot bracket tracking, which is a real piece
of work and should not be smuggled in beside a safety fix.

**The consequence to hold onto: turning on `liveScaleInEnabled` silently turns
off trailing stops for exactly the positions doing best** — the winners that
earned an add-on. That trade is very unlikely to be worth it until per-lot
tracking exists.

### The general lesson

Both findings come from the same root: a dormant flag whose code was written
against a one-bracket world, while the rest of the system has since grown
mechanisms that walk the resting legs. Nothing here was wrong when it was
written. It became wrong when the scale-out and the ratchet started reading
brackets — and neither could notice, because both were themselves broken until
today.

---

## 2026-09-02 (post-close) — The entry runway asked the wrong question

Raising `maxTradesPerDay` 8 → 14 mid-session had a measurable negative effect,
and it uncovered a real gap rather than creating one.

| entries before the raise (~15:26) | 8 | **+$32.78** |
|---|---|---|
| entries after (MOS, BBY, SWKS) | 3 | **−$36.29** |
| **day** | **11** | **−$3.51 (−0.11%)** |

All three landed at 15:26–15:27 and were force-closed by the 15:57 flatten
about 30 minutes later.

### Not a missing gate — a mis-sized one

An entry cutoff already existed (2026-08-28, `evaluateEntryCutoff`), derived as
`endOfDayFlattenMinutes + ENTRY_RUNWAY_MINUTES` = 5 + 15 = **20 minutes**. The
three entries had 33–34 minutes left, so they cleared it correctly. Adding a
second, parallel no-entry config field — the first thing tried here — would have
been exactly the duplicated-quantity mistake CLAUDE.md warns about; it was
reverted before going further.

The bug is in the runway's *size*, and specifically in the question it asked.
Its comment said:

> with maxStopDistancePct 2.5 and a 2R target, a position needs a ~5% move to
> pay out, and 15 minutes is already generous for that

Both halves have stopped holding. `maxStopDistancePct` is now **0**, and far
more importantly **the target is not what closes these trades**. The stagnation
exit is: 10 of 11 exits on 2026-09-02, 7 of 8 the day before. That rule gives a
position **90 session-minutes** to reach 0.5R and cuts it otherwise — so a trade
opened with less than 90 minutes left can never reach its own verdict. The
flatten decides it on the clock rather than on the thesis.

### Fixed by derivation, not by a new number

`entryRunwayMinutes(cfg)` = `max(ENTRY_RUNWAY_MINUTES, stagnationExitMinutes)`.
At the live config that is `max(15, 90)` = 90, so the cutoff becomes 95 minutes
and the last entry of the day is **14:25 ET**.

Derived for the same reason the cutoff is already derived from the flatten
window: two numbers that must agree should not be able to disagree. Change
`stagnationExitMinutes` and the runway follows. The 15-minute constant survives
as the floor, which is also the whole runway when stagnation is off.

Checked against the actual session: the new cutoff blocks exactly the three late
entries and allows all eight earlier ones — including GTLB's 13:00 entry, which
ran 93 minutes and was closed by the stagnation rule on its merits. A gate that
swallowed that one would just be an afternoon shutdown.

A test pins the counterfactual too: under the old flat runway those same three
instants are NOT blocked, so the change is demonstrably what bites.

### Note on attribution

The three trades lost money, but that is not the argument — fitting a rule to
one day's P&L is how you overfit. The argument is structural: a position that
cannot survive to its own decision rule is decided by the clock, and that is
true whichever way the three had gone. The cap raise did not cause this; it
removed the accident that had been hiding it, since the 8-trade limit had been
exhausting itself by 13:00 every day.

---

## 2026-09-02 — Storing the per-component scores, and why

### What the trade record actually says

54 closed live autotrade positions over 14 sessions. Split by era, because the
July cohort predates the entryDate/entryTime fix and a different parameter set:

| | July (n=29) | since 07-29 (n=25) |
|---|---|---|
| mean R | −0.134 | **+0.053** |
| win rate | 24% | **44%** |
| trades worse than −1R | **5** | **0** |

Stop discipline works now. That is real progress and nothing here should undo
it.

But the gap to the goal is wide: 3%/day is **+2.40R/day**, and the modern
cohort runs about **+0.42R/day** — roughly **18% of target**.

### The finding: the score shows no edge

Joining the intraday excursions to the positions that produced them (n=22
modern trades with both a score and a peak):

- **corr(entryScore, peak R) = −0.083** — indistinguishable from zero
- score **< 75** → mean peak **0.46R**
- score **≥ 75** → mean peak **0.21R**

The higher-scoring half moved *less*. Individual rows agree: GTLB scored 92.8
(the day's highest) and peaked at 0.10R before realizing −0.51R, the worst trade
of the day; DELL scored 74.8 and peaked at 2.24R.

**Caveat, held firmly:** n=22, one session supplies half of it, and this is not
statistically conclusive. It is the absence of evidence for edge, not proof of
its absence.

### Why that outranks every exit parameter

The exit apparatus sits above where these trades live:

| mechanism | fires at | share of trades reaching it |
|---|---|---|
| scale-out | 0.30R | ~40% |
| stagnation bar | 0.50R | 25% |
| breakeven + trail | 1.00R | **16.7%** |
| target | 2.00R | **8.3%** |

Median intraday peak is **0.25R**. Tuning exits redistributes a distribution; it
cannot manufacture edge. If selection is uncorrelated with movement, better
exits reduce bleed but never reach +2.40R/day.

### The blocker, and the fix

The screener computes **8 component scores** per candidate. `entry_score` — the
weighted total — has been stored on the position all along. The components have
been journaled on `candidate_found` since 2026-08-26. But the events endpoint is
newest-first with **no backward paging**, so a component could never be joined
to the trade it produced once it scrolled out of reach. The attribution that
would say *which* component predicts a move was unreachable by construction.

Same shape as this file's other findings: a value computed, journaled, and not
available where the question is asked.

Now stored as `entry_components` (JSON `{componentKey: score}`) on `positions`,
`autotrade_paper_positions` and `autotrade_live_orders`, carried on
`TradeSignal.components` from the candidate, and written to the position at
materialization — the same three-hop path `entry_score` already travels. Added
to the CSV export so the attribution can be run outside the app.

A malformed blob parses to null rather than throwing: this is an analysis field,
and one bad row must never make a position unreadable.

Covered at the **end** of the chain, not the middle — a test drives
`attemptLiveEntry` → `reconcileLiveOrders` and asserts the components arrive on
the materialized position. Breaking any single hop fails it; verified by
nulling the first one.

### What this does NOT do

It stores nothing retroactively. Positions opened before today have
`entry_components` null, so the attribution starts accumulating from the next
session. At ~8 trades a day a usable sample is a few weeks out — and the rule
below should hold when it arrives.

**Pre-committed:** do not drop or reweight a component on fewer than 30 closed
trades carrying components, and compare **peak-R by component decile**, not
realized P&L — realized outcome confounds selection with the exit ladder, which
is itself mid-change. If no component separates, the honest conclusion is that
the screen does not predict intraday movement on this universe, and the answer
is a different signal rather than a reweighting of this one.

---

## 2026-09-03 — the protective stack sat above the distribution

Measured over the 24 closed autotrade trades with genuine intraday-candle
excursion data. The 14 rows the excursions endpoint returns at `daily`
resolution were excluded: a daily bar's high includes hours the position was not
open, and including them inflates the endpoint's headline `avgMfeR` from 0.482
to 1.09 — more than double.

**The book, restricted to measurable day trades: 24 trades, −0.72R.** The
all-time autotrade figure of +$109.78 is carried by older multi-day holds. Of
these 24, exactly one (DELL, 2026-09-02) reached its target; without it the
other 23 lose 2.79R between them.

**The leak.** Mean MFE +0.482R, mean realized −0.030R — a mean giveback of
0.512R per trade, or 12.3R of favourable movement across the sample converted
into nothing.

**Why.** Every protective threshold was set above the range these trades reach:

| Rule | Setting | Reached by |
| --- | --- | --- |
| `partialExitRMultiple` | 0.30R | 38% |
| `stagnationExitMinR` | 0.50R | 25% |
| `breakevenTriggerRMultiple` / `trailStartRMultiple` | 1.00R | 17% |
| `targetRMultiple` | 2.00R | 8% |

Median MFE is +0.25R. With breakeven at 1.00R the stop never moved on 83% of
trades. The trail was worse still: 1.5R behind the best price starting at 1.0R
locks in nothing until +1.5R, which 8% of trades reach.

**Counterfactual.** Because MFE is a high-water mark measured to the actual
exit, any threshold below a trade's peak did trade, so a resting order fills —
this is a simulation rather than a fit. Taking the whole position at +X beats
the actual result for **every** X from 0.15R to 2.0R, worst case +1.87R over 24
trades, and leave-one-out does not break it. The argmax (0.75R, +3.50R) rests on
six trades and the row-to-row wobble is noise; the robust claim is that taking
something beats taking nothing. Holding past +0.25R has been worth −0.22R on
average (−0.16R excluding DELL).

Partial-plus-breakeven beats the actual result in every cell tested, including
under a pessimistic assumption where the breakeven stop whipsaws out at zero on
every trade that ever dipped below entry.

### The bug this surfaced

`evaluateScaleOut` measured R against `pos.stopPrice`; `evaluateStopAdjust`
measures against `pos.initialStopPrice`. The loop ratchets stops **before** it
scales out (deliberately — see the ordering comment in `loop.ts`), so once the
breakeven rule fires, `stopPrice === entryPrice`, risk is 0, and the scale-out
returns "degenerate risk" for the life of that position.

This was invisible while the triggers were 1.0R and 0.3R apart, because the
scale-out effectively always ran first. Setting both to the same R — which is
what the recalibration does — would have killed the scale-out outright on every
position that ratcheted. A pre-existing test actively encoded the bug, asserting
that a position whose stop sits at the entry price can never scale out.

Both paths now derive R from the initial stop. This is the CLAUDE.md invariant
"when two places derive the same quantity, they must agree by construction",
and the trigger for it was a *config change*, not a code change — worth noting,
because a settings edit is not usually treated as something that can expose a
latent code bug.

### What this does NOT claim

The recalibration produces roughly +0.046R to +0.090R per trade on this sample.
At 14 trades a day that is 0.7%–1.4%, against a 3% daily target that needs
+0.19R per trade. **It roughly triples a system sitting at zero and still lands
at about half the target.** The gap cannot be closed with size.

It has to close on the entry side, and the entry score currently has no
detectable relationship with how far a trade travels: corr(entryScore, MFE) =
−0.083 over 22 scored trades, negative across every leave-one-out subsample,
with the above-median half averaging +0.366R of MFE against +0.378R for the
below-median half. The best trade in the sample scored 74.8; the highest-scoring
trade, at 92.8, realized −0.51R. That is what the `entry_components` work above
exists to interrogate, and it needs its 30 closed trades first.

---

## 2026-09-03 (later) — what the recalibration made reachable

Lowering the breakeven trigger from 1.0R to 0.25R moved the stop ratchet from
firing on 17% of trades to roughly 50%. Three defects downstream of a ratcheted
stop had been latent behind that rarity. All three are the same mistake as
PR #472: deriving R from the CURRENT stop, which the ratchet moves, instead of
the frozen initial one.

The correct rule was already written down. `execute.ts`'s
`applyPositionManagement` has carried it since the paper ratchet shipped —
"measured in R-multiples of the position's OWN initialStopPrice, never the
current, possibly-already-ratcheted stopPrice". The paper path obeyed it; the
live modules did not.

### 1. The stagnation exit switched itself off at breakeven (high)

`stagnationExit.progressR` divided by `entryPrice - stopPrice`. At breakeven
that distance is exactly zero, so `risk > 0` fails and progress returns null —
and `evaluateStagnation` reads null as "no measurable R progress ... never
scratched on a guess" and declines to act, permanently, for that position.

A breakeven-ratcheted position that then went nowhere would have held its slot
until the end-of-day flatten. With `maxConcurrentPositions` at 3, that is a
third of the book's capacity lost to one zombie — and the module exists
specifically to stop slot starvation. The failure was also silent and its
journalled reason actively misleading: it says "no stop on this position" about
a position that has a stop, at breakeven.

Now derives from the initial stop. "No stop" now means neither stop is usable.

### 2. `live_stop_adjusted` is not an event this system emits (high)

The post-close review had been counting `live_stop_adjusted` and reading zero as
"the stop ratchet has never fired". No code has ever emitted that name. The
success event is `live_stop_ratcheted`; the failures are
`live_stop_adjust_blocked` and `live_stop_adjust_failed` — the verb changes
between the failure and success cases, and the plausible-looking symmetric name
belongs to neither.

The conclusion happened to be right (`live_stop_ratcheted` is genuinely 0 across
the whole journal, verified), but it was right by luck: the query could not have
returned anything else. Tonight's review would have reported the ratchet as
still broken no matter what it did, and that verdict feeds the shorts gate.

`/api/autotrade/events` and `/events/summary` now return `actionsNeverSeen`
listing any requested action the journal has never recorded, so a zero says
which kind of zero it is. The key is omitted when every name has been seen, so
a healthy response is unchanged. It deliberately does not distinguish "typo"
from "real action that has never fired" — both are things a caller must not read
as a measured zero.

### 3. `overrunR` degraded once stops ratcheted (medium)

`/api/journal/stop-overrun` compared the exit against the live stop (correct —
that is the stop that was in force) but also used it as the R denominator. On a
trailed trade that inflates `overrunR`; on a breakeven-ratcheted one the
denominator is zero and the row reports null. `StopOverrunInput` now carries
both stops, with a comment on each saying which question it answers.

### Not bugs, checked and left alone

- `riskCheck.ts` and `dashboard.ts` derive open risk from the CURRENT stop and
  `remainingQuantity`. That is right: a breakeven position genuinely risks
  nothing, and the aggregate cap is about live exposure, not historical R.
  Expect `max_aggregate_open_risk` to bind less often now — 174 blocks on
  09-02 — with `maxConcurrentPositions` (3) becoming the binding constraint.
- `excursion.ts` looks like it divides by the live stop, but its caller passes
  `initialStopPrice ?? stopPrice` with a comment explaining why. Correct.
- The ratchet writes the DB only after the broker confirms the replace, and
  treats an ambiguous replace as a failure. So a stop that exists only locally
  cannot make `openRiskOf` under-report real exposure.

---

## 2026-09-03 (session) — the scale-out, second refusal

The recalibration worked. `live_stop_ratcheted` went from 0 to **6**, the first
successful stop ratchet in this system's history, with zero refusals against 62
the day before. Three of four trades exited at or above their entry — TSLA and
NOW both closed via `stop` for roughly nothing, where the same shape of trade
had bled −0.33R to −0.61R the previous session.

The scale-out did NOT work: 9 attempts, 0 placed, and the refusal was the same
sentence PR #467 was supposed to have fixed — "The number of take-profit orders
and the number of stop-loss orders must be the same."

### Batching was necessary but not sufficient

The two replace calls this system makes differ in what they carry:

| call | payload | 2026-09-03 |
| --- | --- | --- |
| ratchet | `{ client_order_id, stop_price }` | 6 accepted, 0 refused |
| scale-out | `{ client_order_id, quantity }` × 2 | 0 accepted, 9 refused |

The accepted one names the price that DEFINES its leg. The refused one names
nothing identifying either leg — and it could not, because
`restingExitOrders()` filtered on symbol and side alone, and **both legs of a
long bracket are `sell`**. `WebullOpenOrder` carried no `order_type` and no
prices, so this code genuinely could not tell a take-profit from a stop-loss.
The broker's complaint was literally true of the request being sent.

### The fix

`WebullOpenOrder` now carries `orderType`, `limitPrice`, `stopPrice` and
`quantity`, parsed as leniently as the rest of that mapper.
`buildBracketResizePatches()` classifies each leg — `combo_type`
(STOP_PROFIT / STOP_LOSS, confirmed to sit on the envelope of a real
`/order/open`) first, `order_type` (LIMIT / STOP_LOSS, how `bracketExit` places
them) as fallback — and restates each leg's own defining price alongside the new
quantity. The price sent is the one just read back from the broker, so it is an
exact echo: **this identifies a leg, it does not move a stop.**

One leg is legitimate (a filled target leaves the stop resting alone) and is
resized on its own. Two must be exactly one of each. Anything else returns null
and the caller refuses.

### Then the API reference arrived, and moved one thing and sharpened another

CONFIRMED — the payload shape. Webull's own `/order/replace` sample is:

```python
modify_orders = [{ "client_order_id": client_order_id, "quantity": "2", "limit_price": "179" }]
```

A quantity change carries the order's defining price alongside it, which is
exactly what `buildBracketResizePatches` now sends. The vendor's example is the
shape; the previous quantity-only call was not.

CORRECTION (same day, from the real Stock Orders page rather than a partial HTML
dump): **`combo_type` IS documented**, with the enum NORMAL / MASTER /
STOP_PROFIT / STOP_LOSS / OTO / OCO / OTOCO, and the reference's own bracket
example uses STOP_PROFIT and STOP_LOSS exactly as this client sends them. An
earlier note here claimed STOP_PROFIT appeared nowhere in the docs. That was
read off an incomplete extraction and it was wrong.

The classifier still leads with `order_type`, but for a narrower and honest
reason: `order_type` is fixed by the order itself rather than by its role in a
group. It does NOT distinguish MASTER from STOP_PROFIT — the documented example
gives both `order_type: LIMIT` — so it is only safe because the caller has
already filtered to the EXIT side and a long bracket's MASTER is a BUY.
`combo_type` is the more discriminating field. What actually makes either choice
safe is the guard that returns null when the two disagree.

ALSO CONFIRMED — replace covers quantity. The documented order lifecycle is
Preview / Place / **Replace — modify price or quantity while the order is
open** / Cancel / Query. A search summary circulating elsewhere claims combo
legs must instead be cancelled and re-placed to change price or quantity; that
is contradicted both by this line and by the 6 successful in-place `stop_price`
modifies on resting bracket legs on 2026-09-03. It was not acted on.

STILL INFERRED — the OCO balance rule itself. The error string "the number of
take-profit orders and the number of stop-loss orders must be the same" appears
nowhere in the reference, so *why* the group check fires is still deduced from
which call the broker accepts.

A HOLE THE COMBO EXAMPLES EXPOSED. Every documented combo request carries
`client_combo_order_id` at the REQUEST level — a sibling of `new_orders`, not a
per-leg field — and a bracket comes back as several envelopes sharing one
`combo_order_id`. Meanwhile `restingExitOrders` matches on symbol and side
alone. So a stale resting order on the same symbol (a leftover from an earlier
position, or one placed by hand) could be picked up as though it were the
current bracket's take-profit and silently resized. `WebullOpenOrder` now
carries `comboOrderId` off the envelope, and two legs whose group ids are
readable and DIFFERENT are refused. An unreadable id still resizes — only a
positive mismatch refuses, so lenient parsing cannot disable the ordinary case.

NEXT HYPOTHESIS, deliberately NOT acted on yet. `client_combo_order_id` is
documented as **required when `combo_type` is not NORMAL**, and this client
generates one at placement (`buildOrderRequest`) and then throws it away — it is
persisted nowhere. Neither it nor `combo_type` appears in the modify entries the
scale-out sends. If the replace endpoint wants a combo leg identified by its
group the way placement does, that is the missing piece. It is not being added
now on purpose: one experiment is already in flight, and changing the payload
again before it runs would test two things at once. The refusal journal will
show the leg shapes either way. So the refusal path now journals the full leg shapes
— `comboType`, `orderType`, both prices, quantity, status — with absent values
recorded as **null rather than undefined**, because `JSON.stringify` drops
undefined keys and a missing field is exactly the evidence being collected.

That is the part that matters regardless of whether the fix lands. Today's
failure was indistinguishable from the one already fixed, because the journal
held only order ids and the broker's message. The next one names the field.

---

## 2026-09-03 — SPY and QQQ were in the universe and never once scored

Added 2026-08-27 to give the book an index instrument, after a hand-taken SPY
0DTE call carried a whole day while the loop screened 34 names and no index ETF.
Six sessions later, every journal row for both was `skipped_unknown_sector` —
200 of 200 for each, right through 15:54 on 09-03. Neither was ever scored.

The universe addition itself was fine:

```
{'symbol': 'SPY', 'name': None, 'sector': None, 'addedAt': 1787849233852}
{'symbol': 'QQQ', 'name': None, 'sector': None, 'addedAt': 1787849233852}
```

`classifySector` reads the universe row's own `sector` FIRST and short-circuits.
With it NULL it fell through to the Yahoo fundamentals fallback, which returns
no sector or industry for an ETF, so the classification came back `unknown` —
and the screen skips every unknown, a conservative default that is right for a
company it cannot verify is not a REIT.

**A NULL sector is normal and self-healing for an ordinary company** — 21 of 528
rows have one, including names that have traded (ADVB, PGY, NWL, VALE, SKYQ),
because fundamentals fills it in. For an ETF it can never heal.

### Why the sector could not simply be corrected

`addSymbols` was `INSERT OR IGNORE`, so a POST carrying a sector for an existing
symbol was discarded silently and returned `added: 0` — indistinguishable from a
duplicate. There is no update route. The only ways to set it were DELETE and
re-add, or `replaceUniverse`, which wipes all 528 rows.

So the data fix was unreachable through the API, which is why the condition
survived six sessions of daily reviews.

`addSymbols` now backfills a NULL `name`/`sector` on an existing row and reports
`backfilled` alongside `added`. **COALESCE, never overwrite:** a stored value
always wins, so re-adding a symbol cannot clobber a curated sector with a blank
or a guess.

### Label ETFs by what they track, never generically

`classify()` tests the sector/industry string against `/real estate|\breit\b/i`.
A generic "ETF" label on everything would walk VNQ, XLRE or IYR straight past
the real-estate exclusion — the one thing that filter exists to stop. SPY and
QQQ take an index label; a real-estate ETF takes "Real Estate" and is correctly
excluded. `isExcluded()`'s explicit list is a second line of defence and should
not be the first.

### What this does not settle

Whether an index ETF actually clears a screen built for single-name volatility
breakouts is still open — `minChangePct` 1 alone is a percent move an index
rarely makes. Reaching the screen is not the same as passing it. The next
sessions measure how far SPY and QQQ get now that they are evaluated at all;
per docs/OPTIONS_TUNING_PLAN.md no gate is loosened to make room for them.

---

## 2026-09-04 — the price-restating payload was refused too

First session with #474/#475/#476 live. The diagnostic did its job on the very
first refusal, at 09:37 ET:

```
sent: [
  {"clientOrderId": "43aa…", "quantity": 31, "limitPrice": 43.89},   take-profit
  {"clientOrderId": "e425…", "quantity": 31, "stopPrice":  42.09}    stop-loss
]
reason: "…The number of take-profit orders and the number of stop-loss orders
         must be the same."
```

Leg classification worked — one leg took `limitPrice`, the other `stopPrice`,
`keepQty` 31 of 92 is a correct 67% partial, the pair is balanced and batched in
one request, and the shape matches the vendor's own `modify_orders` sample.
**Everything on this side was right and the broker still refused it.** The
hypothesis that restating the defining price is what the group check wants is
therefore wrong.

Without the `sent` array this would have been an identical error string for the
third session running, and the natural conclusion would have been "the fix did
not deploy". That is what the diagnostic bought.

### The dichotomy the journal now shows

| call | modifies | result across 3 sessions |
| --- | --- | --- |
| ratchet | `stop_price` | **9 accepted, 0 refused** |
| scale-out | `quantity` | **0 accepted, 101 refused** |

Price modifies on a resting bracket leg work. Quantity modifies have never
worked, under three payload shapes: leg-by-leg (89), batched quantity-only (9),
batched with each leg's defining price (3).

### What is being tried next, and why

`combo_type` is listed in the reference's Key Parameters as required on an
order, with `client_combo_order_id` required alongside whenever combo_type is
not NORMAL. Every modify this client has ever sent omitted **both** — and the
broker's complaint is precisely that it cannot tell one leg's role from the
other's, which is what `combo_type` states.

So each modify entry now carries `combo_type` (STOP_PROFIT / STOP_LOSS, from the
classification that already works), and the request carries
`client_combo_order_id` at the REQUEST level — a sibling of `modify_orders`,
where every documented combo request puts it, never inside a leg.

Getting that id required keeping it: `buildOrderRequest` mints one per bracket
and it was spread straight into the place request and discarded.
`webullPlaceOrder` now returns it, `autotrade_live_orders.client_combo_order_id`
stores it, and the scale-out reads it back for the position. It is stored on the
AMBIGUOUS placement path too — an order whose outcome is unknown may well have
reached the broker, and a later modify would still need its group.

Brackets opened before this deploys have no id and send the request without one,
exactly as before. Only the `combo_type` half applies to them.

### A test gap this exposed, of the exact kind CLAUDE.md warns about

`bracketResize.test.ts` and `liveEquityTimeExit.test.ts` both pin the PATCH
objects. Deleting the two lines that copy `comboType` and `clientComboOrderId`
into the HTTP body left **all 77 of those tests green** — a field the broker
never receives, invisible to every test that exercises the thing which builds
it. `webullReplaceBody.test.ts` now asserts the request body itself, and both
new cases were verified to fail with those lines removed.

### If this one is refused too

The remaining explanation is that quantity modification of a combo leg is simply
unsupported, and the route is cancel-and-replace. That carries a real cost and
is not to be taken silently: between cancelling the legs and placing the
replacement the position is UNPROTECTED, and `checkLiveBracketProtection` only
REPORTS a naked position — it journals `live_position_unprotected` and says to
re-arm by hand. Today's failure mode is a missed scale-out with the position
fully protected; that one's is a naked live position. It needs an explicit
decision, plus a forced close if the re-place fails.

## 2026-09-04 (intraday) — `combo_type` alone is not enough, and the retry loop is now latched

Two findings, one of them a non-result that matters as much as a result.

### The combo-id half of #478 has not run yet

SMCI refused six times between 11:07 and 11:21 ET, all after the 11:01:39 ET
deploy, and the message is byte-identical to the previous 101:

> The number of take-profit orders and the number of stop-loss orders must be
> the same.

The new code IS live — each leg now carries its `comboType`:

```json
"sent": [
  { "clientOrderId": "df80304c…", "quantity": 15, "limitPrice": 41.56, "comboType": "STOP_PROFIT" },
  { "clientOrderId": "c8e31a03…", "quantity": 15, "stopPrice":  39.48, "comboType": "STOP_LOSS"   }
],
"clientComboOrderId": null
```

`clientComboOrderId` is **null**, and correctly so. SMCI (position 589) was
created at 10:41:37 ET, twenty minutes BEFORE the deploy that started persisting
the group id, so there was no id to read back — exactly what #478 predicted for
brackets opened before it shipped.

So what these six refusals establish is narrower than it looks: **`combo_type`
on its own does not satisfy the group check.** Whether the group ID does is
still untested, because it has never been on the wire. The first post-deploy
bracket is IOT (position 590, created 11:15:11 ET); its scale-out attempt is the
real test, and its refusal detail will carry a non-null `clientComboOrderId`
which simultaneously proves the placement-side plumbing persisted.

Do not read the growing refusal count as accumulating evidence against the combo
id. It is evidence against `combo_type` alone, repeated.

### The retry loop was inflating that count

`checkLiveEquityScaleOuts` runs every tick, so a triggered position re-attempted
the resize roughly every two minutes for the rest of its life. Since the refusal
is deterministic in the request, every retry after the first cost a broker
round-trip and a journal row and taught us nothing. SMCI: 6 identical refusals
in 12 minutes. DELL on 2026-09-03: 31 in an hour. The headline "101 refusals"
was never 101 pieces of evidence — it was three distinct requests in a loop.

`resizeRetryLatch.ts` keys on the REQUEST rather than the position:

```
signature = JSON({ comboId, patches })
```

An identical request is skipped without calling the broker. A request that
differs in ANY way is always attempted. That second half is the design, not a
nicety — a blanket per-position latch would have suppressed the IOT test above,
which is the one attempt we actually want. The signature changes when the stop
ratchets a leg price, when keepQty changes, when the combo id appears, and when
a patch grows a field it did not carry before.

Four of the eleven tests assert exactly that non-suppression, and all four fail
if the latch is mutated to ignore the signature — verified, not assumed.

State is per-process, so a deploy clears every latch and each open position gets
one fresh attempt against the newly deployed payload. That is the wanted
behaviour from a restart rather than an accident of where the state lives.

Journal consequence, and it is a real one: `live_scale_out_blocked` rows now
count DISTINCT refused requests, not ticks. The detail carries `attempt` and
`identicalRetriesSuppressed: true` so a later reader cannot mistake the row
count for the number of times the condition was hit. The per-tick count is still
visible in the outcome each sweep returns, which reports how many identical
retries the latch has absorbed.

## 2026-09-04 (12:04 ET) — the combo group id was sent, and refused

IOT (position 590), the first bracket opened after the id started persisting,
reached its scale-out trigger and produced the decisive attempt:

```
clientComboOrderId: 840fc47a8c85412fbca47eebffa5d374   <- real, not null
sent: [{ clientOrderId: 1461775e…, quantity: 15, limitPrice: 42.55, comboType: "STOP_PROFIT" },
       { clientOrderId: faed9520…, quantity: 15, stopPrice:  40.50, comboType: "STOP_LOSS"   }]
reason: The number of take-profit orders and the number of stop-loss orders must be the same.
```

A balanced take-profit/stop-loss pair, each leg restating its own defining
price, each tagged with its `comboType`, and a genuine `client_combo_order_id`
at request level — every field the vendor's reference names for a combo modify.
The rejection is byte-identical to the one produced with none of them.

The placement-side plumbing is confirmed working by the same event: a non-null
id came back on the first post-deploy bracket, so #478's mint → store → read-back
chain is sound. That was untestable until a post-deploy position triggered.

**The elimination is now complete.** Across four sessions:

| modify | result |
|---|---|
| `stop_price` on a resting bracket leg | 9 accepted, 0 refused |
| `quantity`, bare | refused |
| `quantity` + restated defining price | refused |
| `quantity` + `combo_type` | refused |
| `quantity` + `combo_type` + `client_combo_order_id` | refused |

Four distinct payload shapes, one unchanging message. The remaining explanation
is the plain one: **Webull does not support changing the quantity of a resting
combo leg**, and its error text is generic rather than diagnostic — it names the
group-balance rule regardless of what actually failed.

The latch shipped an hour earlier is what made this attempt happen. It fired
with `attempt: 1` because the signature changed the moment a real group id
appeared; a blanket per-position latch would have suppressed the single most
informative request in four sessions. That was the stated design argument and it
paid off in production the same day.

### What remains, and why it is not built

Cancel-and-replace is the only route left, and it INVERTS the risk. Today's
failure mode is a missed partial with the position fully protected. Cancel and
re-place leaves it NAKED between the two calls, and `checkLiveBracketProtection`
only reports that — it journals `live_position_unprotected` and says to re-arm by
hand. It needs an explicit decision plus a forced close if the re-place fails,
so it stays unbuilt pending that decision.

## 2026-09-04 — entry extension, as an observer

The book's read was that entries land at the top of the day and then spend the
session playing catch-up. Measured against 5-minute candles for every closed
intraday trade's entry day, the literal claim does not hold:

```
entry position in the range formed so far:  mean 60.2   median 65.9
  lower half 6 | 50-80% 6 | 80-95% 4 | 95-100% 2
room left above entry: median 2.41%; trades with <0.25% room: 0/18
room above entry as a share of the full day range: median 53%
```

Only 2 of 18 entered in the top 5% of the range, every trade had room above it,
and the median trade still had over half the day's eventual range ahead of it.

What IS true is weaker and real:

```
entered in the lower 60% of range   n=9   avg realR +0.183   avg mfeR 0.794
entered in the upper 40% of range   n=9   avg realR -0.066   avg mfeR 0.317
corr(position in range, mfeR) = -0.501
```

The same effect appears independently against VWAP — 68% of entries are above
it, and those average mfeR 0.32 against 0.75 for entries at or below. Both
splits survive leave-one-out at **0/18 sign flips** on both metrics, and both
stay positive with the single big winner (BIAF) dropped entirely.

So the accurate statement is not "we buy the top" but "we buy the upper middle,
after the first half of the move, and what is left does not pay for a 2.5% stop
plus a 2R target."

### A correlation checked and REJECTED

Day range looked like the strongest predictor of realised R — corr +0.588, and
names with >8% day range averaged +0.300R, which would argue for an ATR floor.
Under leave-one-out that gap is **+0.004 with 9/18 sign flips**: one trade was
carrying all of it. Recorded so it is not rediscovered and believed. No range
floor on this evidence.

### Why this ships as a shadow, not a gate

1. n=18 over four sessions is a direction, not a season.
2. Position-in-range is confounded with time of day — 8 of the 10 near-VWAP
   entries were before 10:00, when VWAP has barely diverged from price. "Enter
   cheap" and "enter early" cannot be separated at this sample size, and they
   imply different fixes.

`entryExtension.ts` measures and `entry_extension_shadow` journals; nothing
blocks. The RAW `vwapExtPct` and `pctOfRange` are recorded alongside the verdict
precisely so the cut can be re-chosen from the journal without a deploy, rather
than letting this session's guess at 60% / 0.4% quietly become the answer. The
event also names the thresholds that produced its verdict.

`fetchTodaySessionContext` derives VWAP and the session range from ONE candle
fetch. Two fetches could straddle a bar boundary and describe slightly different
sessions — the same class of quiet disagreement between two derivations of one
quantity that this codebase's invariants already warn about.

When this does gate, it has to MOVE: the live path computes session context
deliberately AFTER the broker placement so measurement can never delay or fail a
real order. A blocking version must run ahead of placement.

## 2026-09-04 — per-lot bracket tracking, first slice (observer)

`restingExitOrders` matches on symbol and exit side alone. That is fine while a
position rests exactly one bracket and wrong the moment it rests two — nothing
downstream can say which legs protect which shares. Three mechanisms paper over
it by assuming a single bracket:

- the **scale-out** refuses outright above two legs, because one whole-position
  `keepQty` applied to two brackets would leave each protecting `keepQty`, and a
  stop fill would then sell 2x the holding — the accidental short the
  reduce-first ordering exists to prevent;
- the **close path** cancels every resting exit leg on the symbol;
- **bracket protection** reads "any leg resting" as "protected", which is true of
  the symbol and says nothing about whether a given lot is covered.

Two brackets on one symbol are not hypothetical: the 2026-07-09 cross-tick
double-open put two OCO pairs on a real account, `placeLiveScaleInAddOn` creates
them by design, and the two-lot entry under consideration for the scale-out would
create them deliberately.

`bracketGroups.ts` groups resting legs by the broker's `combo_order_id` — the id
off the ENVELOPE, which two legs of one bracket share and two legs of different
brackets do not. Pure function of already-parsed data, 14 tests.

### The attribution assumption, kept explicit

Attributing a group to a POSITION rests on something no live account has
confirmed: a bracket is several envelopes sharing one `combo_order_id`, and
`webullPlaceOrder` resolves the placed order's `brokerOrderId` as
`order_id ?? combo_order_id`, so the entry intent's stored `brokerOrderId`
SHOULD equal its exit legs' `comboOrderId`.

"Should" is doing real work there. Four payload shapes were refused this week on
reasoning equally sound on paper. So `attributeByEntryOrder` matches only on a
positive equality, returns null on every ambiguity (no id, no group, or more than
one group carrying it — which would itself disprove the premise), and **nothing
in the live path is switched over to it.**

Instead `bracket_groups_observed` journals, once per position per ET day, what
the grouping actually looks like and whether `attributedByEntryOrderId` came back
true. A false on a one-group book with a non-null id says the two ids are not the
same key and the plan needs a different link — which is exactly what has to be
known before any consumer depends on it.

Fail-closed throughout: a leg whose group id cannot be read is `unattributable`
and is never folded into the nearest group, because mis-attributing a stop leg is
how a bracket gets resized or cancelled against the wrong lot. `isSingleBracket`
is false for a parse miss even with one readable group, so the old single-bracket
assumptions cannot be satisfied by unreadable data.

### Note on the entry link

The id comes from the INTENT (`orders.broker_order_id`, set by placeOrder), not
from `autotrade_live_orders` — `LiveOrderMeta` has no such field, which the
typecheck caught on the first wiring attempt. `positions.sourceIntentId` is the
route, and it is non-null by the same candidate filter bracket protection already
applies.

## 2026-09-04 — the naked-position alarm had been checking nothing since 09-01

Found while investigating why `bracket_groups_observed` produced no rows: it
hangs off `checkLiveBracketProtection`, and that function had no candidates at
all.

Its filter required `p.sourceIntentId !== null`. Every open live position has it
null, so `candidates.length === 0` and the function returned **before** calling
`listWebullOpenOrders` — it did not merely skip those positions, it never asked
the broker anything.

```
live stock positions by entry date:
  2026-07-23:  intent-linked  4   NULL  0
  ...
  2026-08-24:  intent-linked  2   NULL  0
  2026-09-01:  intent-linked  0   NULL  6     <-- flips here
  2026-09-02:  intent-linked  1   NULL 10
  2026-09-03:  intent-linked  0   NULL  4
  2026-09-04:  intent-linked  1   NULL  8
```

`positions.source_intent_id` is set only when a fill materializes through
materializeEntryFill's CREATE path. A position ADOPTED from the broker sync
never gets one, and that is deliberate: a null source_intent_id is itself the
"orphan, needs linking" signal the adoption path matches on. From 2026-09-01 the
book flipped to almost entirely adopted rows (`notes: "Imported from Webull"`),
and the alarm went silent.

The last `live_position_unprotected` event is **2026-08-25**. Ten days of silence
that read exactly like "no naked positions" and actually meant "nothing was
eligible to be checked". Worth being precise about severity: positions were NOT
unprotected — brackets rested at Webull throughout, SMCI ratcheted and IOT's stop
filled the same day. What was dead is the DETECTOR.

### The fix, and the precedent for it

Adoption does establish a link, just the reverse one: `setLiveOrderPositionId`
writes `position_id` onto the entry order row. So `entryIntentIdForPosition`
prefers `source_intent_id` when present and falls back to
`getLiveEntryOrderForPosition(pos.id)?.intentId`.

This is the SECOND time this exact lookup has cost something. The first is
recorded in `getLiveEntryOrderForPosition`'s own doc comment: an adopted CTVA
position failed its stagnation close on 21 consecutive ticks "because the only
lookup was via source_intent_id". That function was written to fix this disease;
`checkLiveBracketProtection` was simply never migrated to it. `placeLiveScaleInAddOn`
had the same weakness in its `riskProfile` lookup — degrading silently to the
config default rather than the profile the entry was sized under — and is fixed
here too.

Regression test asserts an adopted position (no `sourceIntentId`, linked only via
its entry order) is CONSIDERED; reverting the filter to the `source_intent_id`
form fails it. Verified, not assumed.

### Consequence for the observer

`bracket_groups_observed` could not have fired on the current book. Its
attribution was also routed through `getIntent(pos.sourceIntentId!)`, null for
every one of these positions, so it would have recorded
`attributedByEntryOrderId: false` across the board and looked like the broker ids
disagreeing rather than a null link. Both now use the either-link lookup.

### Correction, same day: the latch signature was wrong

The latch shipped keyed on `JSON({comboId, patches})` — any change at all
re-attempts — on the reasoning that a payload experiment must never be
suppressed. Right about experiments, wrong about this request. The patches
restate each leg's defining price READ BACK from the broker: identification, not
a change. On a trailing position the ratchet moves the stop nearly every tick:

```
11:45 stop=39.51   12:02 stop=39.55   12:08 stop=39.97   12:24 stop=40.11
12:00 stop=39.53   12:06 stop=39.75   12:16 stop=40.10
```

Twenty-four refusals after the latch shipped, **every one `attempt: 1`** — the
signature moved with the stop, so nothing was ever suppressed. (The single
genuine repeat, at 12:20:09, coincides exactly with deploy #389 completing at
12:20:09 ET: a restart clearing latches, which is documented behaviour.) The
latch did what it was told; what it was told was wrong.

Reported to the user as a correction, because the earlier "latch is working"
claim had been made off a three-minute quiet window rather than the session.

The signature now carries the request's SHAPE: the combo group id's value, and
per leg the clientOrderId, quantity, comboType, and the sorted KEY NAMES
present. It omits the numeric `limitPrice` / `stopPrice` values. Keys in, values
out — a new field appearing (comboType in #478) changes the key set and is
attempted; a stop ratcheting 39.51 → 39.53 does not and is suppressed.

**`keys` was nearly dead on arrival.** The existing "gains a new field" test used
`comboType`, which the signature names individually, so deleting
`Object.keys(p).sort()` left all 13 tests green. A future patch field the
signature does not name would have been invisible, and the first request
carrying it skipped as a duplicate — the exact failure the module exists to
prevent. A test now covers a field the signature does NOT name, and deleting
`keys` fails it. Same disease as the invariants warn about: a value computed and
consumed by nothing, caught only by asserting at the consumer.

## 2026-09-04 — the live options gate was account-blind

`getLiveOptionsPortfolioSnapshot` read `listOpenLiveOptionsPositions()` with no
filter, while `syncLiveOptionsPositionsFromBroker` 1800 lines below in the same
file already scoped strictly to one account. So the "max 1 short-dated at a
time" gate and the open-risk budget counted options positions from **every
account on the login**.

A cash and a margin account on one Webull login is the ordinary case — the
equity path's own comment says so, and it scopes accordingly. The operator held
a SMCI 0DTE call in the CASH account on 2026-09-04 while the loop traded the
MARGIN account. Had live options been enabled, that contract would have held the
gate shut against an account it has nothing to do with.

Latent rather than fired: `liveOptionsEnabled` was off, and that holding lived in
`positions` (a plain `['webull']` broker import) rather than in
`autotrade_live_options_positions`, which is the table this gate reads. Both
options tables were empty of open rows. Fixed before it could be reached.

### The parameter is required, and null means "every account"

Not optional — an optional parameter is how the unscoped read got here, and a
future caller omitting it would silently reintroduce the bug. `null` is
available and means the whole book, which is right for the dashboard and the
portfolio-greeks route and wrong for anything gating an order. The execution
path and the loop's risk seed pass `cfg.liveAccountId`.

### Unassigned rows: the OPPOSITE of the close path, deliberately

Both fail closed; "closed" points in different directions:

| | ambiguity means |
|---|---|
| closing a position | **don't** — acting on a row we cannot attribute risks closing someone else's holding |
| gating a new entry | **do count it** — ignoring it risks opening a second position against exposure we already have |

So this read passes `includeUnassignedAccount: true` while the close path
deliberately does not. A legacy row with no `account_id` still holds the gate
shut and still consumes open-risk budget.

Getting this backwards first — excluding unassigned rows here by symmetry with
the close path — broke the existing "allows only ONE short-dated position at a
time" test, whose fixture has no account. That test earned its keep.

Regression tests: a cash-account contract does not gate the margin account,
an unassigned row does, and reverting to the account-blind read fails the first.

## 2026-09-04 — the sync/reconcile race, through the door the 2026-08-24 fix left open

`closePositionsFromPreview` already defers to the loop when the loop PLACED the
closing order (`role='exit'`) — that guard exists because on 2026-08-24 the
stagnation exit closed VALE, the broker filled it, and this sync booked a quoted
estimate with no exit reason seconds before the loop's own reconcile could book
the real fill.

It does not cover the ORDINARY exit. A resting bracket leg is placed inside the
entry's OTOCO and lives under the `role='entry'` row, so when a stop fills,
`loopClosingPositionIds` is empty for that position and this sync closes it at an
estimate tagged `manual`.

Measured 2026-09-04 on DELL 587:

```
09:46:35  live_order_placed  7 @ limit 531.30, stop 513.21, target 553.35
10:30     5-min bar  low 512.03   <-- the 513.21 stop is taken out
10:32:06  broker sync: no longer held -> closed at an ESTIMATED 514.995, 'manual'
```

The recorded 514.995 sits ABOVE the stop it filled through, flattering the day's
largest loss by roughly $12, and files a `stop` as a `manual`. One of eleven
exits that day — the other ten, including four stops, were booked correctly by
`reconcileLiveOrders` with real intent ids and confirmed prices. So this is a
RACE the sync usually loses, not a systematic failure.

### Bounded, because deferring forever is its own bug

The entry order's own reconcile knows which leg filled and at what price, so the
sync now defers to it — but only for `BRACKET_RECONCILE_GRACE_SYNCS` (2) extra
passes beyond `MISS_CONFIRM_THRESHOLD`. If the broker never reports the leg
FILLED, an unbounded defer would leave the row open permanently — exactly the
"stuck open FOREVER" failure the expired-option branch immediately above was
written to end. After the window the position closes at the estimate as before:
strictly today's behaviour, just later.

No new state: `webull_miss_streak` already climbs on every sync the contract
stays absent, so it IS the "how long have we been waiting" counter.

Both halves are mutation-verified — removing the defer fails the deferral test,
making it unbounded fails the bound test.

## 2026-09-04 — cancel-and-replace, built and left OFF

In-place quantity modification of a resting combo leg is closed: four payload
shapes, 100+ refusals, confirmed when IOT's attempt carried per-leg `combo_type`
AND a real `client_combo_order_id` and drew the byte-identical rejection.

Cancel-and-replace is the only other route, and it exists now behind
`liveScaleOutCancelReplaceEnabled`, **default false**.

### Why a second flag rather than reusing liveScaleOutEnabled

It changes the FAILURE MODE from safe to unsafe, so it has to be a separate
decision:

| | worst case |
|---|---|
| today (in-place refuses) | a missed partial — measured at **+0.183R** on IOT — with the position **fully protected** |
| cancel-and-replace | the position is **NAKED** between the cancel and the new bracket, and `checkLiveBracketProtection` only REPORTS that |

### The ordering rule, which is stricter than the in-place path's

1. cancel BOTH legs
2. **RE-READ the broker and confirm both are gone.** A cancel is an accepted
   REQUEST, not a completed action; selling against a leg that is still resting
   is the accidental short the whole scale-out design exists to prevent
3. only then sell the partial
4. immediately re-bracket the remainder
5. if 4 fails, force-close the remainder rather than leave unhedged exposure

Step 2 cannot be skipped for latency. If the confirmation read fails or is
ambiguous the correct move is to abandon — back to a protected position and a
missed partial, exactly where the in-place path already leaves us. `verifyLegsGone`
treats an unreadable book identically to a still-resting leg: unknown is never
"probably fine" here.

`safePartialQuantity` re-derives the sell quantity from what the broker says is
held NOW rather than the number computed before the cancel, because the cancel
window is precisely when a racing fill would change the holding, and selling a
stale quantity is how a partial becomes an oversell.

### This is NOT the preferred route

Two brackets placed at entry — 67% with a 0.25R target, 33% with the full target
— needs no modification and never leaves the position naked. That waits only on
whether the broker accepts two simultaneous OTOCO groups on one symbol, which a
one-share test settles. **Turn this flag on only if that answer is no.** It is
built so the decision is available, not because it is the right one.

## 2026-09-04 — exit geometry: the target HOLDS, and the real lever is elsewhere

Operator decision, recorded so a later review does not re-litigate it: **leave
`targetRMultiple` at 2.0 until there are 20 winning trades with excursion data.**

### First, a correction the reviews should stop repeating

The post-close routine's prompt says "breakevenTriggerRMultiple and
trailStartRMultiple are both 1.0R". That is STALE. Live config is:

```
partialExitRMultiple  0.25    partialExitPct  67
breakevenTrigger      0.25    trailStart/Stop 0.5 / 0.5
targetRMultiple       2.0
```

The claim that "the protective apparatus sits above where these trades live" was
true of the pre-recalibration config and is no longer true of breakeven or the
trail. Only the TARGET is still misaligned.

### The geometry is calibrated; it does not execute

A 0.25R partial against a 0.32R median intraday peak is the right shape — it
would fire on **13 of 18** trades. The breakeven ratchet at 0.25R demonstrably
works (36 ratchets). The scale-out has **never executed once in 141 attempts**.

Counterfactual over the 18 intraday trades with excursion data:

```
ACTUAL                      sum +1.06R   avg +0.059R   wins  9/18
WITH the scale-out working  sum +1.76R   avg +0.098R   wins 12/18
difference                      +0.70R        +0.039R per trade
```

Three losers become winners. **Fixing the scale-out IS the exit-geometry fix**,
it needs no larger sample, and it is what the two-lot OTOCO test unlocks.

### Why the target waits

`autoTuneExitsEnabled` needs 20 winners with excursion data; there are **16**
intraday (20 combined, but daily-resolution rows overstate MFE for an intraday
trade and must not be counted). When the gate opens, report what the tuner
PROPOSES — 0.8 x winners' average peak, ~0.67R on today's numbers — and
recommend enabling it. Do not hand-set the multiple from a sim.

The sensitivity curves are why. At n=18 the partial trigger scores +1.76R at
0.25R but only +1.37R at 0.30R, WORSE than +1.32R at 0.20R — non-monotone, i.e.
noise. And the fraction table's apparent optimum of banking **100%** (+2.10R) is
curve-fitting to a window containing no large runner: it optimises away exactly
the BIAF-shaped trade (+2.60R peak) that pays for a month of scratches. 67% is
defensible from reasoning; 100% is fitted to 18 rows.

## 2026-09-04 — reading the vendor docs properly, and what it changes

`developer.webull.com` serves machine-readable docs that this project had not been
using: an index at `developer.webull.com/apis/llms.txt`, and **any page fetchable
as raw markdown by appending `.md`** (e.g.
`/apis/docs/reference/common-order-place.md`). Every earlier conclusion here came
from HTML dumps or pasted excerpts, which is how #475 came to assert that
`STOP_PROFIT` was undocumented when it is in the enum.

### The standalone bracket is DOCUMENTED — the two-lot design gets simpler

Place Order, verbatim:

> "To sell and close an existing position with take-profit/stop-loss, submit only
> STOP_PROFIT/STOP_LOSS sub-orders (side = SELL)… no MASTER order is required."

This was treated on 2026-09-04 as an unverified assumption to design around, and
the two-lot plan was shaped to avoid it by splitting the ENTRY into two bracketed
orders. That was unnecessary, and worse:

| | |
|---|---|
| split entry (planned) | two fills, two entry prices, a blended entry every R calculation downstream has to agree on |
| **one entry + two standalone bracket groups** | one fill, one entry price, no modification, no naked window |

The second is what the docs endorse. It also confirms cancel-and-replace's step 4
(re-bracketing the remainder) is a supported call rather than a hope.

### What the docs still cannot answer

**Whether two concurrent combo groups on ONE symbol are accepted.** Neither
permitted nor forbidden — Place Order documents no per-symbol combo limit, and
Open Orders is silent: two groups "would appear as separate array items with
different `combo_order_id` values", but nothing says the broker will create them.
The Tuesday test stands; the docs narrowed the design, not the unknown.

### Two corrections to things already built

**`client_combo_order_id` is NOT in the Open Orders response schema.** The
envelope carries `combo_order_id`; the id we generate does not come back. Parsing
it back from open orders was the designated fallback if
`bracket_groups_observed` reports `attributedByEntryOrderId: false` — that
fallback is a dead end and must not be attempted.

**`combo_type` is an ORDER-level field, not a leg field.** `WebullOpenOrder`'s
mapper reads it and `exitLegKind` corroborates with it, which is safe because
that function leads with `order_type` — but the corroboration may be ABSENT
rather than disagreeing. Read a refusal accordingly: a null `comboType` on a leg
is the documented shape, not evidence of a parse failure.

### Standing instruction

Fetch the `.md` reference before reasoning about this API. Four payload shapes
were burned on inference this week; the authoritative schema was one URL away.
